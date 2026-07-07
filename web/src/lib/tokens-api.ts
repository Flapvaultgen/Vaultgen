/**
 * Client for launched token records — all persistence goes through the server
 * API (/api/launched-tokens). The frontend never talks to Supabase directly.
 */
import { apiUrl, initApiBase } from "./api-base";
import { getSessionToken } from "./current-user";
import type { Dictionary } from "./i18n/types";

export type LaunchedTokenStatus = "registered" | "launch_pending" | "launched" | "failed";

export type LaunchedTokenRecord = {
  id: string;
  chatId: string | null;
  runId: string | null;
  artifactId: string | null;
  walletAddress: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string | null;
  vaultAddress: string | null;
  registeredVaultId: string | null;
  registeredVaultHash: string | null;
  factoryAddress: string | null;
  launchContractAddress: string | null;
  registerTxHash: string | null;
  launchTxHash: string | null;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  status: LaunchedTokenStatus;
  launchUrl: string | null;
  gmgnUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

async function getJson<T>(path: string): Promise<T> {
  await initApiBase();
  const res = await fetch(apiUrl(path));
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  await initApiBase();
  // Writes require a signed-in wallet session; the server attributes the row
  // to the session's wallet regardless of what the body claims.
  const token = getSessionToken();
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error("Can't reach the AI server. Start it with `npm run dev:all`.");
  }
  if (!res.ok) {
    const parsed = await res.json().catch(() => null);
    throw new Error(parsed?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function listLaunchedTokens(opts?: {
  walletAddress?: string;
  chainId?: number;
  chatId?: string;
}): Promise<LaunchedTokenRecord[]> {
  const params = new URLSearchParams();
  if (opts?.walletAddress) params.set("walletAddress", opts.walletAddress);
  if (opts?.chainId !== undefined) params.set("chainId", String(opts.chainId));
  if (opts?.chatId) params.set("chatId", opts.chatId);
  const q = params.toString();
  return getJson(`/api/launched-tokens${q ? `?${q}` : ""}`);
}

export function getLaunchedToken(id: string): Promise<LaunchedTokenRecord> {
  return getJson(`/api/launched-tokens/${encodeURIComponent(id)}`);
}

export function createLaunchedTokenRecord(input: {
  chatId?: string | null;
  runId?: string | null;
  artifactId?: string | null;
  walletAddress: string;
  chainId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress?: string | null;
  vaultAddress?: string | null;
  registeredVaultId?: string | null;
  registeredVaultHash?: string | null;
  factoryAddress?: string | null;
  launchContractAddress?: string | null;
  registerTxHash?: string | null;
  launchTxHash?: string | null;
  buyTaxBps?: number | null;
  sellTaxBps?: number | null;
  status?: LaunchedTokenStatus;
  launchUrl?: string | null;
  gmgnUrl?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<LaunchedTokenRecord> {
  return postJson("/api/launched-tokens", input);
}

/** Human-friendly label + color for a launched token's status — never surface raw enum values like "launch_pending". */
export function launchedTokenStatusPresentation(
  status: LaunchedTokenStatus,
  dict: Dictionary
): { label: string; className: string } {
  switch (status) {
    case "launched":
      return { label: dict.tokensPage.status.live, className: "bg-emerald-500/15 text-emerald-400" };
    case "failed":
      return { label: dict.tokensPage.status.failed, className: "bg-destructive/15 text-destructive" };
    case "launch_pending":
      return { label: dict.tokensPage.status.launching, className: "bg-amber-500/15 text-amber-300" };
    case "registered":
      return { label: dict.tokensPage.status.registered, className: "bg-secondary text-muted-foreground" };
    default:
      return { label: dict.tokensPage.status.pending, className: "bg-secondary text-muted-foreground" };
  }
}

/** Builds a GMGN chart URL only when VITE_GMGN_BASE_URL is configured. */
export function gmgnTokenUrl(chainId: number, tokenAddress: string): string | null {
  const base = (import.meta.env.VITE_GMGN_BASE_URL ?? "").trim().replace(/\/$/, "");
  if (!base) return null;
  // Common GMGN path pattern — override via env if your deployment differs.
  const chainSlug = chainId === 97 || chainId === 56 ? "bsc" : null;
  if (!chainSlug) return null;
  return `${base}/${chainSlug}/token/${tokenAddress}`;
}
