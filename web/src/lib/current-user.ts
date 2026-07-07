/**
 * Current wallet-backed user for chat ownership.
 *
 * WalletUserSync (mounted inside the wagmi provider) runs the sign-in flow
 * (nonce → wallet signature → session token, see chat-api.ts connectUser)
 * and calls setCurrentUser; API callers read getCurrentUserId() and the
 * session token is attached to requests automatically by chat-api. Cached
 * per wallet in localStorage so reloads don't need a fresh signature while
 * the session token is still valid (server re-checks expiry on every call).
 */
import type { User } from "./chat-api";

const CACHE_KEY = "flapVaultGen.user";

type CachedUser = { id: string; walletAddress: string; sessionToken?: string };

let currentUser: CachedUser | null = readCache();
const listeners = new Set<(user: CachedUser | null) => void>();

function readCache(): CachedUser | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUser;
    return parsed?.id && parsed?.walletAddress ? parsed : null;
  } catch {
    return null;
  }
}

export function getCurrentUserId(): string | undefined {
  return currentUser?.id;
}

export function getCurrentUser(): CachedUser | null {
  return currentUser;
}

/** Signed session token proving wallet ownership — attached to API requests. */
export function getSessionToken(): string | undefined {
  return currentUser?.sessionToken;
}

export function setCurrentUser(user: (User & { sessionToken?: string }) | null): void {
  currentUser = user
    ? {
        id: user.id,
        walletAddress: user.walletAddress,
        // Keep the existing token when a refresh doesn't carry a new one.
        sessionToken: user.sessionToken ?? currentUser?.sessionToken,
      }
    : null;
  if (typeof localStorage !== "undefined") {
    if (currentUser) localStorage.setItem(CACHE_KEY, JSON.stringify(currentUser));
    else localStorage.removeItem(CACHE_KEY);
  }
  for (const listener of listeners) listener(currentUser);
}

/** Cached user for a wallet (avoids a fresh signature on reload). */
export function getCachedUserForWallet(walletAddress: string): CachedUser | null {
  const cached = readCache();
  return cached && cached.walletAddress === walletAddress.toLowerCase() ? cached : null;
}

export function subscribeCurrentUser(listener: (user: CachedUser | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
