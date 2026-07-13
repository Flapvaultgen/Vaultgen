/**
 * Client for the chat-history + generation-run API.
 *
 * All chat data flows through the server (/api routes) — the frontend never
 * talks to Supabase directly and never sees the service role key. When the
 * server runs without Supabase env it uses an in-memory store; the UI learns
 * about that via getChatConfig() and shows a "history not persisted" hint.
 */
import { apiUrl, initApiBase } from "./api-base";
import { getSessionToken } from "./current-user";
import type { ApproximationConsent, CodegenResult } from "./codegen";

// ── types (mirror server/chat-types.ts) ─────────────────────────────────────

/** One row per connected wallet (identification only — no signature auth yet). */
export type User = {
  id: string;
  walletAddress: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
};

export type Chat = {
  id: string;
  userId: string | null;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  archivedAt: string | null;
};

export type ChatMessage = {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  status: "pending" | "streaming" | "completed" | "failed";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type GenerationRun = {
  id: string;
  chatId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  model: string | null;
  status: "pending" | "running" | "completed" | "failed";
  deliverable: string | null;
  scope: unknown | null;
  mechanicSpec: unknown | null;
  simulationReport: unknown | null;
  economicCritique: unknown | null;
  approximationReport: unknown | null;
  repairAttempts: unknown | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GenerationEventType =
  | "run_started"
  | "status"
  | "heartbeat"
  | "mechanic_spec"
  | "scope"
  | "design_questions"
  | "consent_required"
  | "code_delta"
  | "code_complete"
  | "scanner_result"
  | "simulation_report"
  | "economic_critique"
  | "repair_attempt"
  | "run_completed"
  | "run_failed";

export type GenerationEvent = {
  id: string;
  runId: string;
  chatId: string;
  eventType: GenerationEventType;
  sequence: number;
  message: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type GeneratedArtifact = {
  id: string;
  chatId: string;
  runId: string;
  artifactType:
    | "solidity"
    | "mechanic_spec"
    | "test_file"
    | "simulation_report"
    | "economic_critique"
    | "approximation_report"
    | "vault_ui"
    | "launch_status";
  name: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type StartGenerationResponse = {
  chatId: string;
  runId: string;
  userMessageId: string;
  assistantMessageId: string;
  streamUrl: string;
};

/** Live SSE wire shape from GET /api/runs/:runId/stream. */
export type RunStreamEvent = {
  type: GenerationEventType;
  sequence: number;
  message?: string;
  payload?: {
    result?: CodegenResult;
    delta?: string;
    [key: string]: unknown;
  };
};

export type ChatConfig = { supabaseConfigured: boolean; storage: "supabase" | "memory" };

// ── fetch helpers ────────────────────────────────────────────────────────────

/**
 * Signed session token (proof of wallet ownership, see connectUser) rides on
 * every request. The server derives identity exclusively from this token —
 * plain userId values in a query/body are ignored server-side.
 */
function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson<T>(path: string): Promise<T> {
  await initApiBase();
  const res = await fetch(apiUrl(path), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  await initApiBase();
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
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

// ── API surface ──────────────────────────────────────────────────────────────

export function getChatConfig(): Promise<ChatConfig> {
  return getJson("/api/chat-config");
}

/**
 * Sign-in flow: fetch a single-use nonce, have the wallet sign it, then
 * exchange the signature for the user row + a session token. The signature
 * is what makes the identity trustworthy — a bare wallet address is public
 * info anyone could replay.
 */
export async function connectUser(
  walletAddress: string,
  signMessage: (message: string) => Promise<string>
): Promise<User & { sessionToken: string }> {
  const { nonce, message } = await postJson<{ nonce: string; message: string }>("/api/auth/nonce", {
    walletAddress,
  });
  const signature = await signMessage(message);
  return postJson("/api/users/connect", { walletAddress, nonce, signature });
}

export function startGeneration(input: {
  prompt: string;
  chatId?: string;
  approximationConsent?: ApproximationConsent;
  metadata?: Record<string, unknown>;
}): Promise<StartGenerationResponse> {
  // Ownership is derived server-side from the session token on this request.
  return postJson("/api/chats/start-generation", input);
}

/** Lists the signed-in wallet's chats (identity comes from the session token). */
export function listChats(): Promise<Chat[]> {
  return getJson("/api/chats");
}

/** Attaches an anonymous chat to the signed-in wallet; no-ops if already owned by it. */
export function claimChat(chatId: string): Promise<Chat> {
  return postJson(`/api/chats/${chatId}/claim`, {});
}

/** Persists register/launch progress as a launch_status artifact (survives reloads/devices). */
export function saveLaunchStatus(
  chatId: string,
  runId: string,
  metadata: Record<string, unknown>
): Promise<GeneratedArtifact> {
  return postJson(`/api/chats/${chatId}/launch-status`, { runId, metadata });
}

export { mergeVaultState, type PersistedVaultState } from "./vault-state";

/**
 * Chats visible to the current visitor: scoped strictly to their wallet user
 * when one is connected (never another wallet's chats). Without a connected
 * wallet, only chats this browser created are shown (see localAnonymousChats)
 * — the server is never asked for the unscoped/global chat list.
 */
export async function listVisibleChats(userId?: string): Promise<Chat[]> {
  if (userId) return listChats();
  const ids = localAnonymousChatIds();
  if (ids.length === 0) return [];
  const results = await Promise.allSettled(ids.map((id) => getChat(id)));
  return results
    .filter((r): r is PromiseFulfilledResult<Chat> => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const ANON_CHATS_KEY = "flapVaultGen.anonymousChatIds";

/** Chat ids created by this browser before any wallet was connected. */
export function localAnonymousChatIds(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(ANON_CHATS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function rememberLocalAnonymousChat(chatId: string): void {
  if (typeof localStorage === "undefined") return;
  const ids = localAnonymousChatIds();
  if (ids.includes(chatId)) return;
  localStorage.setItem(ANON_CHATS_KEY, JSON.stringify([chatId, ...ids].slice(0, 50)));
}

export function clearLocalAnonymousChats(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(ANON_CHATS_KEY);
}

/*
 * Chats owned by a connected wallet only return data when a valid session
 * token for that wallet rides on the request (see chat-routes.ts
 * canAccessChat) — getJson/postJson attach it automatically. Anonymous chats
 * (userId null) stay readable by id.
 */

export function getChat(chatId: string): Promise<Chat> {
  return getJson(`/api/chats/${chatId}`);
}

export function getChatMessages(chatId: string): Promise<ChatMessage[]> {
  return getJson(`/api/chats/${chatId}/messages`);
}

export function getChatRuns(chatId: string): Promise<GenerationRun[]> {
  return getJson(`/api/chats/${chatId}/runs`);
}

export function getRunEvents(runId: string): Promise<GenerationEvent[]> {
  return getJson(`/api/runs/${runId}/events`);
}

export function getChatArtifacts(chatId: string, runId?: string): Promise<GeneratedArtifact[]> {
  return getJson(
    runId ? `/api/chats/${chatId}/artifacts?runId=${encodeURIComponent(runId)}` : `/api/chats/${chatId}/artifacts`
  );
}

export function archiveChat(chatId: string): Promise<Chat> {
  return postJson(`/api/chats/${chatId}/archive`, {});
}

/**
 * Consume the run SSE stream; resolves when the run reaches a terminal event.
 *
 * Hosting proxies (Railway cuts any request at ~990s) can drop the SSE
 * connection long before a slow generation finishes, while the pipeline keeps
 * running server-side. So this reconnects automatically until it sees a
 * terminal event (run_completed / run_failed). On reconnect the server replays
 * the full event buffer; already-seen events are skipped by sequence number so
 * progress logs and streamed code never duplicate.
 */
export async function streamRunEvents(
  runId: string,
  onEvent: (ev: RunStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  await initApiBase();

  let lastSequence = -1;
  let sawTerminal = false;
  let connectionsWithoutProgress = 0;

  const deliver = (ev: RunStreamEvent) => {
    if (ev.type === "heartbeat") return;
    if (typeof ev.sequence === "number" && ev.sequence >= 0) {
      if (ev.sequence <= lastSequence) return; // replayed event after reconnect
      lastSequence = ev.sequence;
    }
    if (ev.type === "run_completed" || ev.type === "run_failed") sawTerminal = true;
    onEvent(ev);
  };

  for (;;) {
    let res: Response;
    try {
      res = await fetch(apiUrl(`/api/runs/${runId}/stream`), { signal, headers: authHeaders() });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Never connected at all — only worth an error on the first attempt.
      if (lastSequence < 0) throw new Error("Can't reach the AI server. Start it with `npm run dev:all`.");
      res = null as unknown as Response;
    }

    if (res) {
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Stream failed (${res.status})`);
      }

      const before = lastSequence;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 2);
            if (raw.startsWith("data:")) {
              try {
                deliver(JSON.parse(raw.slice(5).trim()) as RunStreamEvent);
              } catch {
                /* ignore malformed chunk */
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Connection dropped mid-stream (proxy timeout, network blip) — reconnect below.
      }

      if (sawTerminal) return;
      connectionsWithoutProgress = lastSequence > before ? 0 : connectionsWithoutProgress + 1;
      if (connectionsWithoutProgress >= 5) {
        throw new Error("Stream lost — the run may still be finishing. Reload the page to check.");
      }
    } else {
      connectionsWithoutProgress++;
      if (connectionsWithoutProgress >= 5) {
        throw new Error("Can't reach the AI server. Check your connection and reload the page.");
      }
    }

    if (signal?.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (signal?.aborted) return;
  }
}
