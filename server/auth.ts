/**
 * Wallet signature auth (SIWE-lite).
 *
 * Why this exists: a wallet address is public information, so "connect by
 * address" is identification, not authentication — anyone could POST a
 * victim's address to /api/users/connect, receive their user id, and read
 * their chats. To actually own an identity the client must prove control of
 * the wallet's private key:
 *
 *   1. POST /api/auth/nonce { walletAddress }  → { nonce, message }
 *   2. wallet personal_sign(message)
 *   3. POST /api/users/connect { walletAddress, nonce, signature }
 *      → server verifies the signature, upserts the user, and returns a
 *        session token
 *   4. subsequent requests send  Authorization: Bearer <token>
 *
 * Session tokens are stateless HMAC tokens (no DB table): payload is
 * userId + wallet + expiry, signed with AUTH_SECRET. If AUTH_SECRET is not
 * set a random per-process secret is used — fine for dev, but sessions then
 * reset on every server restart (set AUTH_SECRET in production).
 *
 * Nonces are single-use, expire after 5 minutes, and are stored in memory
 * (they only need to survive the seconds between steps 1 and 3).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "viem";

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded so a nonce-request flood can't grow memory unboundedly. */
const MAX_PENDING_NONCES = 10_000;

type PendingNonce = { walletAddress: string; expiresAt: number };

const pendingNonces = new Map<string, PendingNonce>();

let secret: Buffer | null = null;

function getSecret(): Buffer {
  if (secret) return secret;
  const fromEnv = (process.env.AUTH_SECRET ?? "").trim();
  secret = fromEnv ? Buffer.from(fromEnv, "utf8") : randomBytes(32);
  if (!fromEnv) {
    console.warn(
      "[auth] AUTH_SECRET not set — using a random per-process secret. Sessions will not survive server restarts."
    );
  }
  return secret;
}

function prunePendingNonces(now: number): void {
  for (const [nonce, entry] of pendingNonces) {
    if (entry.expiresAt <= now) pendingNonces.delete(nonce);
  }
  // Still over the cap after pruning expired ones → drop oldest entries.
  while (pendingNonces.size >= MAX_PENDING_NONCES) {
    const oldest = pendingNonces.keys().next().value;
    if (oldest === undefined) break;
    pendingNonces.delete(oldest);
  }
}

export function isValidWalletAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

/** Step 1: issue a nonce + the exact message the wallet must sign. */
export function issueNonce(walletAddress: string): { nonce: string; message: string } {
  const now = Date.now();
  prunePendingNonces(now);
  const nonce = randomBytes(16).toString("hex");
  pendingNonces.set(nonce, {
    walletAddress: walletAddress.toLowerCase(),
    expiresAt: now + NONCE_TTL_MS,
  });
  return { nonce, message: buildSignInMessage(walletAddress, nonce) };
}

/** Deterministic so client and server always agree on the signed bytes. */
export function buildSignInMessage(walletAddress: string, nonce: string): string {
  return [
    "Flap Vault Gen wants you to sign in with your wallet.",
    "",
    `Wallet: ${walletAddress.toLowerCase()}`,
    `Nonce: ${nonce}`,
    "",
    "This signature proves you own this wallet. It does not send a transaction or cost gas.",
  ].join("\n");
}

/**
 * Step 3: verify the signature for a previously issued nonce.
 * The nonce is consumed whether or not verification succeeds (single-use).
 */
export async function verifySignIn(
  walletAddress: string,
  nonce: string,
  signature: string
): Promise<boolean> {
  const entry = pendingNonces.get(nonce);
  pendingNonces.delete(nonce);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) return false;
  if (entry.walletAddress !== walletAddress.toLowerCase()) return false;
  try {
    return await verifyMessage({
      address: walletAddress as `0x${string}`,
      message: buildSignInMessage(walletAddress, nonce),
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

// ── stateless session tokens ─────────────────────────────────────────────────

export type Session = { userId: string; walletAddress: string; expiresAt: number };

function hmac(payload: string): Buffer {
  return createHmac("sha256", getSecret()).update(payload).digest();
}

export function createSessionToken(userId: string, walletAddress: string): string {
  const session: Session = {
    userId,
    walletAddress: walletAddress.toLowerCase(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const mac = hmac(payload).toString("base64url");
  return `${payload}.${mac}`;
}

/** Returns the session when the token is authentic and unexpired, else null. */
export function verifySessionToken(token: string): Session | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = hmac(payload);
    provided = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (
      typeof session.userId !== "string" ||
      typeof session.walletAddress !== "string" ||
      typeof session.expiresAt !== "number"
    ) {
      return null;
    }
    if (session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

/** Extracts and verifies the Bearer session from an Authorization header. */
export function sessionFromAuthHeader(header: string | undefined): Session | null {
  if (!header?.startsWith("Bearer ")) return null;
  return verifySessionToken(header.slice("Bearer ".length).trim());
}

/** Test hook: reset module state so env changes take effect. */
export function resetAuthForTests(): void {
  secret = null;
  pendingNonces.clear();
}
