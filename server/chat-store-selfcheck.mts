/**
 * Chat persistence + streaming-plumbing self-check (no network, no Supabase).
 *
 * Proves:
 *  1. supabase/schema.sql exists and defines all six tables, the required
 *     indexes, and the updated_at trigger helper.
 *  2. SUPABASE_SERVICE_ROLE_KEY is never referenced in frontend source, and
 *     no web file imports the server supabase helper.
 *  3. Missing Supabase env does not crash: getChatStore() falls back to the
 *     in-memory store.
 *  4. MemoryChatStore CRUD works end-to-end (chats, messages, runs, events,
 *     artifacts, repair attempts) with correct ordering and archive filter.
 *  5. RunManager: run_started is the first event, progress statuses stream,
 *     run_completed carries the result, major events are persisted while
 *     code_delta stays ephemeral, run/message rows are updated, artifacts and
 *     repair rows are created, and chat titles adopt the contract name.
 *  6. Failure path: generator throw → run_failed event, failed run + assistant
 *     message, user prompt still saved.
 *  7. start-generation returns chatId/runId/messageIds/streamUrl immediately
 *     (route mounted on a real express instance, no LLM work), and the run
 *     stream sends an initial status event before any pipeline output.
 *  8. Wallet auth: /api/users/connect only issues a session after a valid
 *     nonce signature; identity is derived from the session token only —
 *     a plain userId in query/body is never trusted.
 *
 * Run: npx tsx chat-store-selfcheck.mts
 */
import { readFile } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Force the memory fallback regardless of the developer's local env, and
// clear the API key so the HTTP stream test exercises the fast stub path
// instead of a real LLM call (this selfcheck must stay networkless).
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ANTHROPIC_API_KEY;

import { getChatStore, MemoryChatStore, setChatStoreForTests } from "./chat-store.ts";
import { getSupabaseAdmin, isSupabaseConfigured } from "./supabase.ts";
import { RunManager, type RunStreamEvent } from "./run-manager.ts";
import { createChatRouter } from "./chat-routes.ts";
import type { CodegenEvent, CodegenResult } from "./codegen.ts";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SERVER_DIR, "..");
const WEB_SRC = path.join(ROOT, "web", "src");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`OK ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

// ── 1. schema.sql ────────────────────────────────────────────────────────────

const schema = await readFile(path.join(ROOT, "supabase", "schema.sql"), "utf8").catch(() => null);
check("schema.sql exists", schema !== null);

if (schema) {
  for (const table of [
    "users",
    "chats",
    "chat_messages",
    "generation_runs",
    "generation_events",
    "generated_artifacts",
    "repair_attempts",
  ]) {
    check(`schema defines table ${table}`, new RegExp(`create table if not exists ${table}\\b`).test(schema));
  }
  for (const index of [
    "idx_chats_user_updated",
    "idx_chat_messages_chat_created",
    "idx_generation_runs_chat_created",
    "idx_generation_events_run_sequence",
    "idx_generation_events_chat_created",
    "idx_generated_artifacts_chat_created",
    "idx_repair_attempts_run_attempt",
  ]) {
    check(`schema defines index ${index}`, schema.includes(index));
  }
  check("schema has updated_at trigger helper", schema.includes("create or replace function set_updated_at()"));
  check("schema users.wallet_address unique + validated", /wallet_address text not null unique check/.test(schema));
  check("schema chats.user_id references users", /user_id\s+uuid references users \(id\) on delete set null/.test(schema));
  check("schema uses uuid primary keys", /id\s+uuid primary key default gen_random_uuid\(\)/.test(schema));
  check("schema uses jsonb for payloads", /payload\s+jsonb/.test(schema) && /mechanic_spec\s+jsonb/.test(schema));
  check(
    "schema events cover required types in comments",
    ["run_started", "heartbeat", "consent_required", "repair_attempt", "run_failed"].every((t) => schema.includes(t))
  );
}

// ── 2. service role key stays server-only ───────────────────────────────────

const webFiles = listFiles(WEB_SRC).filter((f) => /\.(ts|tsx|css|json)$/.test(f));
const serviceKeyLeaks = webFiles.filter((f) => readFileSync(f, "utf8").includes("SERVICE_ROLE"));
check("web src never references SERVICE_ROLE key", serviceKeyLeaks.length === 0, serviceKeyLeaks.join(", "));
const supabaseImports = webFiles.filter((f) => /from ["'].*server\/supabase/.test(readFileSync(f, "utf8")));
check("web src never imports server supabase helper", supabaseImports.length === 0, supabaseImports.join(", "));

// ── 3. missing env falls back to memory store ────────────────────────────────

check("isSupabaseConfigured() false without env", !isSupabaseConfigured());
check("getSupabaseAdmin() null without env (no crash)", getSupabaseAdmin() === null);
const store = getChatStore();
check("getChatStore() falls back to memory store", store.kind === "memory");

// ── 4. MemoryChatStore CRUD ──────────────────────────────────────────────────

const mem = new MemoryChatStore();

const wallet = "0xCEC6B3C84D0158fca7B3b326e0E8F7798bCb3e39";
const user1 = await mem.upsertUserByWallet(wallet);
check("upsertUserByWallet creates user with lowercase address", user1.walletAddress === wallet.toLowerCase());
const user1Again = await mem.upsertUserByWallet(wallet.toUpperCase().replace("0X", "0x"));
check("upsertUserByWallet is idempotent per wallet", user1Again.id === user1.id);
check("getUser finds created user", (await mem.getUser(user1.id))?.id === user1.id);

const ownedChat = await mem.createChat({ title: "Owned chat", userId: user1.id });
const anonChat = await mem.createChat({ title: "Anon chat" });
check("chat carries userId", ownedChat.userId === user1.id && anonChat.userId === null);
const userChats = await mem.listChats({ userId: user1.id });
check("listChats filters by userId", userChats.length === 1 && userChats[0]!.id === ownedChat.id);

const chat = await mem.createChat({ title: "Test chat" });
check("createChat returns uuid id", /^[0-9a-f-]{36}$/.test(chat.id));

const userMsg = await mem.createMessage({ chatId: chat.id, role: "user", content: "Build a burn lottery" });
const asstMsg = await mem.createMessage({ chatId: chat.id, role: "assistant", content: "", status: "pending" });
const messages = await mem.listMessages(chat.id);
check("listMessages ordered user→assistant", messages.length === 2 && messages[0]!.id === userMsg.id);
check("chat lastMessageAt set by createMessage", (await mem.getChat(chat.id))!.lastMessageAt !== null);

const run = await mem.createRun({ chatId: chat.id, userMessageId: userMsg.id, assistantMessageId: asstMsg.id });
check("createRun starts pending", run.status === "pending");
await mem.updateRun(run.id, { status: "running" });
check("updateRun persists status", (await mem.getRun(run.id))!.status === "running");

await mem.appendEvent({ runId: run.id, chatId: chat.id, eventType: "run_started", sequence: 1 });
await mem.appendEvent({ runId: run.id, chatId: chat.id, eventType: "status", sequence: 2, message: "Compiling…" });
const events = await mem.listEvents(run.id);
check("listEvents ordered by sequence", events.length === 2 && events[0]!.eventType === "run_started");

await mem.createArtifact({
  chatId: chat.id,
  runId: run.id,
  artifactType: "solidity",
  name: "TestVault.sol",
  content: "contract TestVault {}",
});
check("listArtifacts by chat", (await mem.listArtifacts({ chatId: chat.id })).length === 1);
check("listArtifacts by run", (await mem.listArtifacts({ runId: run.id }))[0]!.name === "TestVault.sol");

await mem.createRepairAttempt({ runId: run.id, attemptNumber: 1, reason: "critic_finding" });
check("repair attempts stored", (await mem.listRepairAttempts(run.id)).length === 1);

await mem.updateChat(chat.id, { status: "archived", archivedAt: new Date().toISOString() });
check("archived chats excluded by default", (await mem.listChats()).every((c) => c.id !== chat.id));
check("archived chats included on request", (await mem.listChats({ includeArchived: true })).some((c) => c.id === chat.id));

// ── 5. RunManager success path ───────────────────────────────────────────────

function fakeResult(overrides: Partial<CodegenResult> = {}): CodegenResult {
  return {
    contractName: "FakeVault",
    explanation: "A fake vault for the selfcheck.",
    source: "contract FakeVault {}",
    compiled: true,
    compileErrors: "",
    safety: { level: "pass", findings: [] },
    specAudit: { level: "skipped", summary: "", items: [], mode: "skipped" },
    abi: [],
    creationBytecode: "0xdeadbeef",
    bytecodeSize: 4,
    attempts: 1,
    integrationTestPath: null,
    integrationTestsPassed: true,
    repairAttempts: [
      {
        attempt: 1,
        reason: "critic_finding",
        model: "test-model",
        escalated: false,
        findingsAddressed: ["f1"],
        compileResult: "pass",
        scannerResult: "pass",
        testResult: "skip",
        criticResult: "clean",
        remainingIssues: [],
      },
    ],
    fixLog: [],
    autoFixExhausted: false,
    mode: "stub",
    ...overrides,
  };
}

{
  const memStore = new MemoryChatStore();
  const chat2 = await memStore.createChat({ title: "New vault chat" });
  const user2 = await memStore.createMessage({ chatId: chat2.id, role: "user", content: "prompt here" });
  const asst2 = await memStore.createMessage({ chatId: chat2.id, role: "assistant", content: "", status: "pending" });
  const run2 = await memStore.createRun({ chatId: chat2.id, userMessageId: user2.id, assistantMessageId: asst2.id });

  const generator = async (_prompt: string, emit: (ev: CodegenEvent) => void) => {
    emit({ type: "status", phase: "classifying", attempt: 0 });
    emit({ type: "code_delta", delta: "contract " });
    emit({ type: "code_delta", delta: "FakeVault {}" });
    emit({ type: "status", phase: "compiling", attempt: 1 });
    emit({ type: "result", result: fakeResult() });
  };

  const manager = new RunManager(() => memStore, generator);
  manager.register({ runId: run2.id, chatId: chat2.id, assistantMessageId: asst2.id, prompt: "prompt here" });

  const received: RunStreamEvent[] = [];
  const done = new Promise<void>((resolve) => {
    manager.subscribe(run2.id, (ev) => {
      received.push(ev);
      if (ev.type === "run_completed" || ev.type === "run_failed") resolve();
    });
  });
  await done;

  check("run_started is first stream event", received[0]?.type === "run_started");
  check(
    "progress statuses streamed with friendly copy",
    received.some((e) => e.type === "status" && e.message === "Planning your vault mechanic…") &&
      received.some((e) => e.type === "status" && e.message === "Compiling…")
  );
  check("code_delta events streamed", received.filter((e) => e.type === "code_delta").length === 2);
  check("run_completed is last event", received[received.length - 1]?.type === "run_completed");
  const completed = received[received.length - 1]!;
  check(
    "run_completed payload carries full result",
    (completed.payload as { result?: CodegenResult })?.result?.contractName === "FakeVault"
  );

  const persisted = await memStore.listEvents(run2.id);
  check("major events persisted through store", persisted.some((e) => e.eventType === "run_started"));
  check("code_delta not persisted", persisted.every((e) => e.eventType !== "code_delta"));
  check("heartbeat not persisted", persisted.every((e) => e.eventType !== "heartbeat"));
  check(
    "persisted run_completed payload trims source",
    !JSON.stringify(persisted.find((e) => e.eventType === "run_completed")?.payload ?? {}).includes("contract FakeVault {}")
  );

  const finishedRun = await memStore.getRun(run2.id);
  check("run marked completed with jsonb fields", finishedRun?.status === "completed");
  const finishedMsg = (await memStore.listMessages(chat2.id)).find((m) => m.id === asst2.id);
  check("assistant message completed with explanation", finishedMsg?.status === "completed" && finishedMsg.content.includes("fake vault"));
  const arts = await memStore.listArtifacts({ runId: run2.id });
  check("solidity artifact created", arts.some((a) => a.artifactType === "solidity" && a.name === "FakeVault.sol"));
  const repairs = await memStore.listRepairAttempts(run2.id);
  check("repair attempt row created from result", repairs.length === 1 && repairs[0]!.reason === "critic_finding");
  check("chat title adopts contract name", (await memStore.getChat(chat2.id))?.title === "FakeVault");
}

// ── 6. RunManager failure path ───────────────────────────────────────────────

{
  const memStore = new MemoryChatStore();
  const chat3 = await memStore.createChat({});
  const user3 = await memStore.createMessage({ chatId: chat3.id, role: "user", content: "will fail" });
  const asst3 = await memStore.createMessage({ chatId: chat3.id, role: "assistant", content: "", status: "pending" });
  const run3 = await memStore.createRun({ chatId: chat3.id, userMessageId: user3.id, assistantMessageId: asst3.id });

  const manager = new RunManager(() => memStore, async () => {
    throw new Error("boom");
  });
  manager.register({ runId: run3.id, chatId: chat3.id, assistantMessageId: asst3.id, prompt: "will fail" });

  const received: RunStreamEvent[] = [];
  await new Promise<void>((resolve) => {
    manager.subscribe(run3.id, (ev) => {
      received.push(ev);
      if (ev.type === "run_failed") resolve();
    });
  });

  check("failure emits run_failed", received[received.length - 1]?.type === "run_failed");
  check("failed run persisted", (await memStore.getRun(run3.id))?.status === "failed");
  const failedMsg = (await memStore.listMessages(chat3.id)).find((m) => m.id === asst3.id);
  check("assistant message marked failed", failedMsg?.status === "failed");
  const savedUser = (await memStore.listMessages(chat3.id)).find((m) => m.id === user3.id);
  check("user prompt survives failure", savedUser?.content === "will fail");
  const persisted = await memStore.listEvents(run3.id);
  check("run_failed event persisted", persisted.some((e) => e.eventType === "run_failed"));
}

// ── 7. HTTP routes: start-generation + stream initial event ─────────────────

{
  setChatStoreForTests(new MemoryChatStore());
  const app = express();
  app.use(express.json());
  app.use(createChatRouter());
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  // Wallet auth flow with a real (throwaway) keypair: nonce → sign → session.
  const account = privateKeyToAccount(generatePrivateKey());
  async function signIn(addressAccount: ReturnType<typeof privateKeyToAccount>) {
    const nonceRes = await fetch(`${base}/api/auth/nonce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: addressAccount.address }),
    });
    const { nonce, message } = (await nonceRes.json()) as { nonce: string; message: string };
    const signature = await addressAccount.signMessage({ message });
    const res = await fetch(`${base}/api/users/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: addressAccount.address, nonce, signature }),
    });
    return { res, body: (await res.json()) as { id: string; walletAddress: string; sessionToken: string } };
  }

  const { res: connectRes, body: connectedUser } = await signIn(account);
  check(
    "users/connect creates user + session for a valid signature",
    connectRes.ok && /^[0-9a-f-]{36}$/.test(connectedUser.id) && connectedUser.sessionToken.length > 0
  );
  const auth = { Authorization: `Bearer ${connectedUser.sessionToken}` };

  const { res: reconnectRes, body: reconnectedUser } = await signIn(account);
  check("users/connect reuses user on reconnect", reconnectRes.ok && reconnectedUser.id === connectedUser.id);

  const badConnectRes = await fetch(`${base}/api/users/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: "not-an-address" }),
  });
  check("users/connect rejects invalid address", badConnectRes.status === 400);

  // Impersonation attempts fail: no signature, and a signature from a
  // different key over a valid nonce.
  const noSigRes = await fetch(`${base}/api/users/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: account.address }),
  });
  check("users/connect rejects a bare wallet address (no signature)", noSigRes.status === 401);

  const victimNonceRes = await fetch(`${base}/api/auth/nonce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: account.address }),
  });
  const victimNonce = (await victimNonceRes.json()) as { nonce: string; message: string };
  const attacker = privateKeyToAccount(generatePrivateKey());
  const forgedSig = await attacker.signMessage({ message: victimNonce.message });
  const forgedRes = await fetch(`${base}/api/users/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress: account.address, nonce: victimNonce.nonce, signature: forgedSig }),
  });
  check("users/connect rejects a signature from the wrong key", forgedRes.status === 401);

  const t0 = Date.now();
  const startRes = await fetch(`${base}/api/chats/start-generation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      prompt: "Selfcheck vault prompt for the start-generation route.",
    }),
  });
  const elapsed = Date.now() - t0;
  const startBody = (await startRes.json()) as Record<string, unknown>;

  check("start-generation returns 200", startRes.ok);
  check(
    "start-generation returns all IDs",
    ["chatId", "runId", "userMessageId", "assistantMessageId", "streamUrl"].every(
      (k) => typeof startBody[k] === "string" && (startBody[k] as string).length > 0
    )
  );
  check("start-generation streamUrl points at run stream", String(startBody.streamUrl).endsWith(`/runs/${startBody.runId}/stream`));
  check("start-generation responds immediately (<2s, no LLM work)", elapsed < 2000, `${elapsed}ms`);

  // Security: a wallet-owned chat must never be readable without proving you
  // are that wallet's user (signed session token). Anyone knowing/guessing
  // the chatId — and anyone replaying a plain userId, which is not a secret —
  // must be rejected. See chat-routes.ts canAccessChat.
  const noSessionListRes = await fetch(`${base}/api/chats`);
  check("GET /api/chats with no session is rejected (no global chat leak)", noSessionListRes.status === 401);
  const plainUserIdListRes = await fetch(`${base}/api/chats?userId=${connectedUser.id}`);
  check("GET /api/chats ignores a plain userId (not authentication)", plainUserIdListRes.status === 401);

  const chatNoAuthRes = await fetch(`${base}/api/chats/${startBody.chatId}`);
  check("GET /api/chats/:id with no session is forbidden for an owned chat", chatNoAuthRes.status === 403);
  const chatPlainUserIdRes = await fetch(`${base}/api/chats/${startBody.chatId}?userId=${connectedUser.id}`);
  check(
    "GET /api/chats/:id with only a plain userId is still forbidden (id replay)",
    chatPlainUserIdRes.status === 403
  );
  const chatForgedTokenRes = await fetch(`${base}/api/chats/${startBody.chatId}`, {
    headers: { Authorization: "Bearer forged.token" },
  });
  check("GET /api/chats/:id with a forged token is forbidden", chatForgedTokenRes.status === 403);
  const messagesNoAuthRes = await fetch(`${base}/api/chats/${startBody.chatId}/messages`);
  check("GET /api/chats/:id/messages with no session is forbidden", messagesNoAuthRes.status === 403);
  const streamNoAuthRes = await fetch(`${base}/api/runs/${startBody.runId}/stream`);
  check(
    "run stream with no session is forbidden (no SSE opened)",
    streamNoAuthRes.status === 403 &&
      !(streamNoAuthRes.headers.get("content-type")?.includes("text/event-stream") ?? false)
  );

  const chatOkRes = await fetch(`${base}/api/chats/${startBody.chatId}`, { headers: auth });
  check("GET /api/chats/:id succeeds with the owning wallet's session", chatOkRes.ok);

  const userChatsRes = await fetch(`${base}/api/chats`, { headers: auth });
  const userChatsBody = (await userChatsRes.json()) as { id: string; userId: string }[];
  check(
    "GET /api/chats scopes to the session's wallet user",
    userChatsBody.length === 1 && userChatsBody[0]!.id === startBody.chatId && userChatsBody[0]!.userId === connectedUser.id
  );

  const messagesRes = await fetch(`${base}/api/chats/${startBody.chatId}/messages`, { headers: auth });
  const messagesBody = (await messagesRes.json()) as { role: string; status: string }[];
  check(
    "messages include user + pending assistant placeholder",
    messagesBody.some((m) => m.role === "user") && messagesBody.some((m) => m.role === "assistant" && m.status === "pending")
  );

  // Stream: the very first SSE frame must arrive before pipeline work.
  const streamController = new AbortController();
  const streamRes = await fetch(`${base}/api/runs/${startBody.runId}/stream`, {
    signal: streamController.signal,
    headers: auth,
  });
  check("stream route sets SSE content type", streamRes.headers.get("content-type")?.includes("text/event-stream") === true);
  const reader = streamRes.body!.getReader();
  const first = await Promise.race([
    reader.read().then(({ value }) => new TextDecoder().decode(value)),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 3000)),
  ]);
  check("stream sends initial status event immediately", first.includes('"type":"status"') && first.includes("Connected"));
  streamController.abort();

  const config = await (await fetch(`${base}/api/chat-config`)).json();
  check("chat-config reports memory storage without env", config.storage === "memory" && config.supabaseConfigured === false);

  // Claiming an anonymous chat: allowed while unowned, idempotent for the
  // owner, rejected for anyone else once claimed (privacy — own chats only).
  const anonStart = await fetch(`${base}/api/chats/start-generation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Anonymous chat for claim-route selfcheck." }),
  });
  const anonBody = (await anonStart.json()) as { chatId: string };

  const otherAccount = privateKeyToAccount(generatePrivateKey());
  const { body: otherUser } = await signIn(otherAccount);
  const otherAuth = { Authorization: `Bearer ${otherUser.sessionToken}` };

  const claimNoSessionRes = await fetch(`${base}/api/chats/${anonBody.chatId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  check("claim without a session is rejected", claimNoSessionRes.status === 401);

  const claimRes = await fetch(`${base}/api/chats/${anonBody.chatId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({}),
  });
  const claimedChat = (await claimRes.json()) as { userId: string };
  check("claim attaches an unowned anonymous chat", claimRes.ok && claimedChat.userId === connectedUser.id);

  const reclaimRes = await fetch(`${base}/api/chats/${anonBody.chatId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({}),
  });
  check("claim is idempotent for the same owner", reclaimRes.ok);

  const stealRes = await fetch(`${base}/api/chats/${anonBody.chatId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...otherAuth },
    body: JSON.stringify({}),
  });
  check("claim rejects a different user once owned (no chat theft)", stealRes.status === 403);

  const scopedAfterClaim = (await (await fetch(`${base}/api/chats`, { headers: auth })).json()) as {
    id: string;
  }[];
  check(
    "claimed chat appears in owner's scoped list",
    scopedAfterClaim.some((c) => c.id === anonBody.chatId)
  );
  const scopedOtherUser = (await (await fetch(`${base}/api/chats`, { headers: otherAuth })).json()) as {
    id: string;
  }[];
  check(
    "claimed chat is invisible to a different user's scoped list",
    !scopedOtherUser.some((c) => c.id === anonBody.chatId)
  );

  // Launch-status persistence: register/launch progress is stored as a
  // launch_status artifact and comes back via the chat's artifact list.
  const launchStatusRes = await fetch(`${base}/api/chats/${startBody.chatId}/launch-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      runId: startBody.runId,
      metadata: {
        status: "launched",
        tokenAddress: "0x7777000000000000000000000000000000000001",
        vaultAddress: "0x7777000000000000000000000000000000000002",
        txHash: "0xabc",
        chainId: 97,
        launchUrl: "https://testnet.flap.sh/bnb/token/0x7777000000000000000000000000000000000001",
      },
    }),
  });
  const launchStatusBody = (await launchStatusRes.json()) as {
    artifactType: string;
    metadata: Record<string, unknown>;
  };
  check(
    "launch-status route stores a launch_status artifact",
    launchStatusRes.ok &&
      launchStatusBody.artifactType === "launch_status" &&
      launchStatusBody.metadata.status === "launched"
  );
  const launchStatusStrangerRes = await fetch(`${base}/api/chats/${startBody.chatId}/launch-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...otherAuth },
    body: JSON.stringify({
      runId: startBody.runId,
      metadata: { status: "launched" },
    }),
  });
  check("launch-status route rejects writes from a different wallet", launchStatusStrangerRes.status === 403);
  const chatArtifacts = (await (
    await fetch(`${base}/api/chats/${startBody.chatId}/artifacts`, { headers: auth })
  ).json()) as { artifactType: string; metadata: Record<string, unknown> }[];
  check(
    "launch_status artifact is returned with chat artifacts",
    chatArtifacts.some(
      (a) => a.artifactType === "launch_status" && a.metadata.tokenAddress === "0x7777000000000000000000000000000000000001"
    )
  );
  const launchStatusMissingBody = await fetch(`${base}/api/chats/${startBody.chatId}/launch-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ metadata: { status: "launched" } }),
  });
  check("launch-status route rejects a missing runId", launchStatusMissingBody.status === 400);

  // Launched tokens: writes need a session and are attributed to its wallet.
  const launchedNoSessionRes = await fetch(`${base}/api/launched-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chainId: 97, tokenName: "X", tokenSymbol: "X" }),
  });
  check("POST /api/launched-tokens without a session is rejected", launchedNoSessionRes.status === 401);
  const launchedRes = await fetch(`${base}/api/launched-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      // Body claims someone else's wallet — the server must ignore it and
      // attribute the row to the session's wallet.
      walletAddress: "0x2222222222222222222222222222222222222222",
      chainId: 97,
      tokenName: "Selfcheck Token",
      tokenSymbol: "SELF",
      status: "launched",
      launchUrl: "https://testnet.flap.sh/tax/0x7777000000000000000000000000000000000001",
    }),
  });
  const launchedBody = (await launchedRes.json()) as { walletAddress: string };
  check(
    "POST /api/launched-tokens attributes the row to the session wallet",
    launchedRes.ok && launchedBody.walletAddress === account.address.toLowerCase()
  );
  const badUrlRes = await fetch(`${base}/api/launched-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      chainId: 97,
      tokenName: "Bad",
      tokenSymbol: "BAD",
      launchUrl: "javascript:alert(1)",
    }),
  });
  check("POST /api/launched-tokens rejects non-https launchUrl", badUrlRes.status === 400);

  server.close();
  setChatStoreForTests(null);
}

// ── result ───────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat-store selfchecks passed");
