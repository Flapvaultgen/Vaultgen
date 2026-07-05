/**
 * Chat history + generation-run HTTP API.
 *
 * Works with or without Supabase: getChatStore() transparently falls back to
 * an in-memory store when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset,
 * so local dev never crashes. GET /api/chat-config reports which mode is live.
 */
import { Router, type Request, type Response } from "express";
import { generateVaultCodeStream, type ApproximationConsent, type CodegenEvent } from "./codegen.js";
import { resolveOpenAiModel } from "./openai-model.js";
import { getChatStore } from "./chat-store.js";
import { isSupabaseConfigured } from "./supabase.js";
import { RunManager, type RunStreamEvent } from "./run-manager.js";
import type { StartGenerationResponse } from "./chat-types.js";
import {
  createSessionToken,
  isValidWalletAddress,
  issueNonce,
  sessionFromAuthHeader,
  verifySessionToken,
  verifySignIn,
} from "./auth.js";

function parseConsent(value: unknown): ApproximationConsent | undefined {
  return value === "closest_draft" || value === "spec_only" ? value : undefined;
}

/**
 * Chat ownership guard.
 *
 * A user identity is only trusted when it arrives as a signed session token
 * (see auth.ts — nonce + wallet signature + HMAC session). A client-supplied
 * plain userId is NEVER trusted: wallet addresses and user ids are not
 * secrets, so accepting them as identity would let anyone read another
 * wallet's chats by replaying a public id.
 *
 * Anonymous chats (created before a wallet was connected, userId null)
 * stay reachable by id alone — that's the pre-wallet-connect flow (browsers
 * track their own anonymous chat ids locally); "anyone with the link" is the
 * model those always had until they're claimed by a wallet.
 */
function requesterUserId(req: Request): string | null {
  const session =
    sessionFromAuthHeader(req.headers.authorization) ??
    // EventSource/SSE can't set headers — allow the token via query for streams.
    (typeof req.query.sessionToken === "string" ? verifySessionToken(req.query.sessionToken) : null);
  return session?.userId ?? null;
}

function canAccessChat(chat: { userId: string | null } | null, requester: string | null): boolean {
  if (!chat) return false;
  if (!chat.userId) return true;
  return chat.userId === requester;
}

function sendForbidden(res: Response): void {
  sendError(res, 403, "This chat belongs to a different wallet.");
}

/** Model routing stays in openai-model.ts — never hardcoded here. */
const defaultGenerator = (
  prompt: string,
  emit: (ev: CodegenEvent) => void,
  approximationConsent?: ApproximationConsent
) => generateVaultCodeStream(prompt, process.env.OPENAI_API_KEY, resolveOpenAiModel(), emit, approximationConsent);

export const runManager = new RunManager(getChatStore, defaultGenerator);

const HEARTBEAT_MS = 15_000;

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

async function guard(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error("chat route failed:", err);
    sendError(res, 500, err instanceof Error ? err.message : "Chat storage error");
  }
}

export function createChatRouter(): Router {
  const router = Router();

  router.get("/api/chat-config", (_req, res) => {
    res.json({
      supabaseConfigured: isSupabaseConfigured(),
      storage: getChatStore().kind,
    });
  });

  // ── auth: prove wallet ownership with a signature ─────────────────────────

  // Step 1: get a single-use nonce + the exact message to sign.
  router.post("/api/auth/nonce", (req, res) => {
    void guard(res, async () => {
      const walletAddress = String(req.body?.walletAddress ?? "").trim();
      if (!isValidWalletAddress(walletAddress)) {
        sendError(res, 400, "walletAddress must be a 0x-prefixed 20-byte hex address.");
        return;
      }
      res.json(issueNonce(walletAddress));
    });
  });

  // Step 2: verify the signature, find-or-create the user, return a session.
  // A wallet address alone is public info — without the signature check anyone
  // could impersonate any wallet and read its chats.
  router.post("/api/users/connect", (req, res) => {
    void guard(res, async () => {
      const walletAddress = String(req.body?.walletAddress ?? "").trim();
      if (!isValidWalletAddress(walletAddress)) {
        sendError(res, 400, "walletAddress must be a 0x-prefixed 20-byte hex address.");
        return;
      }
      const nonce = String(req.body?.nonce ?? "").trim();
      const signature = String(req.body?.signature ?? "").trim();
      if (!nonce || !signature) {
        sendError(res, 401, "nonce and signature are required — request one at /api/auth/nonce and sign it.");
        return;
      }
      if (!(await verifySignIn(walletAddress, nonce, signature))) {
        sendError(res, 401, "Signature verification failed. Request a new nonce and try again.");
        return;
      }
      const user = await getChatStore().upsertUserByWallet(walletAddress);
      res.json({ ...user, sessionToken: createSessionToken(user.id, user.walletAddress) });
    });
  });

  // ── start-generation: create rows, return IDs immediately ────────────────
  // Registered before /api/chats/:chatId so "start-generation" never matches
  // as a chatId.
  router.post("/api/chats/start-generation", (req, res) => {
    void guard(res, async () => {
      const prompt = String(req.body?.prompt ?? "").trim();
      if (prompt.length < 8 || prompt.length > 4000) {
        sendError(res, 400, "Prompt must be 8–4000 characters.");
        return;
      }

      const store = getChatStore();
      const requestedChatId = typeof req.body?.chatId === "string" ? req.body.chatId : null;

      // Identity comes from the signed session only — never the request body.
      const userId = requesterUserId(req);

      let chatId: string;
      if (requestedChatId) {
        const existing = await store.getChat(requestedChatId);
        if (!existing) {
          sendError(res, 404, "Chat not found.");
          return;
        }
        if (!canAccessChat(existing, userId)) {
          sendForbidden(res);
          return;
        }
        chatId = existing.id;
      } else {
        const title = prompt.length > 64 ? `${prompt.slice(0, 61)}…` : prompt;
        chatId = (await store.createChat({ title, userId })).id;
      }

      const metadata =
        req.body?.metadata && typeof req.body.metadata === "object"
          ? (req.body.metadata as Record<string, unknown>)
          : {};

      const userMessage = await store.createMessage({
        chatId,
        role: "user",
        content: prompt,
        status: "completed",
        metadata,
      });
      const assistantMessage = await store.createMessage({
        chatId,
        role: "assistant",
        content: "",
        status: "pending",
      });
      const run = await store.createRun({
        chatId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        model: process.env.OPENAI_API_KEY ? resolveOpenAiModel() : null,
      });

      // Pipeline starts lazily on first stream subscription — this response
      // never waits on the LLM.
      runManager.register({
        runId: run.id,
        chatId,
        assistantMessageId: assistantMessage.id,
        prompt,
        approximationConsent: parseConsent(req.body?.approximationConsent),
      });

      const payload: StartGenerationResponse = {
        chatId,
        runId: run.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        streamUrl: `/api/runs/${run.id}/stream`,
      };
      res.json(payload);
    });
  });

  // ── chats CRUD ────────────────────────────────────────────────────────────

  router.post("/api/chats", (req, res) => {
    void guard(res, async () => {
      const chat = await getChatStore().createChat({
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
        userId: requesterUserId(req),
      });
      res.json(chat);
    });
  });

  router.get("/api/chats", (req, res) => {
    void guard(res, async () => {
      const includeArchived = req.query.includeArchived === "true";
      // Scope strictly to the authenticated session — never a client-supplied
      // userId, and never the unscoped/global chat list.
      const userId = requesterUserId(req);
      if (!userId) {
        sendError(res, 401, "A signed-in wallet session is required to list chats.");
        return;
      }
      res.json(await getChatStore().listChats({ includeArchived, userId }));
    });
  });

  router.get("/api/chats/:chatId", (req, res) => {
    void guard(res, async () => {
      const chat = await getChatStore().getChat(req.params.chatId);
      if (!chat) {
        sendError(res, 404, "Chat not found.");
        return;
      }
      if (!canAccessChat(chat, requesterUserId(req))) {
        sendForbidden(res);
        return;
      }
      res.json(chat);
    });
  });

  // Attaches an anonymous chat (created before wallet connect) to a wallet
  // user — only when it is currently unowned, so a chat can never be taken
  // from whichever user already owns it.
  router.post("/api/chats/:chatId/claim", (req, res) => {
    void guard(res, async () => {
      const userId = requesterUserId(req);
      if (!userId) {
        sendError(res, 401, "A signed-in wallet session is required to claim a chat.");
        return;
      }
      const store = getChatStore();
      const chat = await store.getChat(req.params.chatId);
      if (!chat) {
        sendError(res, 404, "Chat not found.");
        return;
      }
      if (chat.userId && chat.userId !== userId) {
        sendError(res, 403, "Chat already belongs to another user.");
        return;
      }
      const updated = chat.userId === userId ? chat : await store.updateChat(chat.id, { userId });
      res.json(updated ?? chat);
    });
  });

  router.post("/api/chats/:chatId/archive", (req, res) => {
    void guard(res, async () => {
      const store = getChatStore();
      const existing = await store.getChat(req.params.chatId);
      if (!existing) {
        sendError(res, 404, "Chat not found.");
        return;
      }
      if (!canAccessChat(existing, requesterUserId(req))) {
        sendForbidden(res);
        return;
      }
      const chat = await store.updateChat(req.params.chatId, {
        status: "archived",
        archivedAt: new Date().toISOString(),
      });
      res.json(chat ?? existing);
    });
  });

  router.get("/api/chats/:chatId/messages", (req, res) => {
    void guard(res, async () => {
      const store = getChatStore();
      const chat = await store.getChat(req.params.chatId);
      if (!chat) {
        sendError(res, 404, "Chat not found.");
        return;
      }
      if (!canAccessChat(chat, requesterUserId(req))) {
        sendForbidden(res);
        return;
      }
      res.json(await store.listMessages(req.params.chatId));
    });
  });

  router.get("/api/chats/:chatId/runs", (req, res) => {
    void guard(res, async () => {
      const store = getChatStore();
      const chat = await store.getChat(req.params.chatId);
      if (!chat) {
        sendError(res, 404, "Chat not found.");
        return;
      }
      if (!canAccessChat(chat, requesterUserId(req))) {
        sendForbidden(res);
        return;
      }
      res.json(await store.listRuns(req.params.chatId));
    });
  });

  router.get("/api/chats/:chatId/artifacts", (req, res) => {
    void guard(res, async () => {
      const store = getChatStore();
      const chat = await store.getChat(req.params.chatId);
      if (!chat) {
        sendError(res, 404, "Chat not found.");
        return;
      }
      if (!canAccessChat(chat, requesterUserId(req))) {
        sendForbidden(res);
        return;
      }
      const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
      res.json(await store.listArtifacts({ chatId: req.params.chatId, runId }));
    });
  });

  // Persists register/launch progress (tx hashes, addresses, launch URL) as a
  // launch_status artifact so the launch state survives reloads and devices.
  router.post("/api/chats/:chatId/launch-status", (req, res) => {
    void guard(res, async () => {
      const runId = typeof req.body?.runId === "string" ? req.body.runId : "";
      const metadata =
        req.body?.metadata && typeof req.body.metadata === "object"
          ? (req.body.metadata as Record<string, unknown>)
          : null;
      if (!runId || !metadata) {
        sendError(res, 400, "runId and metadata are required.");
        return;
      }
      const store = getChatStore();
      const chat = await store.getChat(req.params.chatId);
      if (!chat) {
        sendError(res, 404, "Chat not found.");
        return;
      }
      if (!canAccessChat(chat, requesterUserId(req))) {
        sendForbidden(res);
        return;
      }
      const artifact = await store.createArtifact({
        chatId: chat.id,
        runId,
        artifactType: "launch_status",
        name: typeof req.body?.name === "string" ? req.body.name : "launch-status",
        content: "",
        metadata,
      });
      res.json(artifact);
    });
  });

  router.get("/api/runs/:runId/events", (req, res) => {
    void guard(res, async () => {
      const store = getChatStore();
      const run = await store.getRun(req.params.runId);
      if (!run) {
        sendError(res, 404, "Run not found.");
        return;
      }
      const chat = await store.getChat(run.chatId);
      if (!canAccessChat(chat, requesterUserId(req))) {
        sendForbidden(res);
        return;
      }
      res.json(await store.listEvents(req.params.runId));
    });
  });

  // ── launched tokens ───────────────────────────────────────────────────────

  router.get("/api/launched-tokens", (req, res) => {
    void guard(res, async () => {
      const walletAddress =
        typeof req.query.walletAddress === "string" ? req.query.walletAddress : undefined;
      const chainId =
        typeof req.query.chainId === "string" && /^\d+$/.test(req.query.chainId)
          ? Number(req.query.chainId)
          : undefined;
      const chatId = typeof req.query.chatId === "string" ? req.query.chatId : undefined;
      res.json(await getChatStore().listLaunchedTokens({ walletAddress, chainId, chatId }));
    });
  });

  router.get("/api/launched-tokens/:id", (req, res) => {
    void guard(res, async () => {
      const token = await getChatStore().getLaunchedToken(req.params.id);
      if (!token) {
        sendError(res, 404, "Launched token not found.");
        return;
      }
      res.json(token);
    });
  });

  router.post("/api/launched-tokens", (req, res) => {
    void guard(res, async () => {
      // These rows feed the public /tokens gallery, so writes must come from
      // an authenticated wallet and are always attributed to THAT wallet —
      // a client can't publish rows under someone else's address.
      const session =
        sessionFromAuthHeader(req.headers.authorization) ??
        (typeof req.query.sessionToken === "string" ? verifySessionToken(req.query.sessionToken) : null);
      if (!session) {
        sendError(res, 401, "A signed-in wallet session is required to record a launch.");
        return;
      }
      const walletAddress = session.walletAddress;
      const launchUrl = typeof req.body?.launchUrl === "string" ? req.body.launchUrl.trim() : null;
      const gmgnUrl = typeof req.body?.gmgnUrl === "string" ? req.body.gmgnUrl.trim() : null;
      // Rendered as links on the public gallery — refuse anything that isn't
      // plain https (blocks javascript: and data: URLs at the source).
      for (const url of [launchUrl, gmgnUrl]) {
        if (url && !/^https:\/\/[^\s]+$/i.test(url)) {
          sendError(res, 400, "launchUrl and gmgnUrl must be https:// URLs.");
          return;
        }
      }
      const chainId = Number(req.body?.chainId);
      if (!Number.isInteger(chainId) || chainId <= 0) {
        sendError(res, 400, "chainId must be a positive integer.");
        return;
      }
      const tokenName = String(req.body?.tokenName ?? "").trim();
      const tokenSymbol = String(req.body?.tokenSymbol ?? "").trim();
      if (!tokenName || !tokenSymbol) {
        sendError(res, 400, "tokenName and tokenSymbol are required.");
        return;
      }
      const status = req.body?.status;
      if (
        status !== undefined &&
        status !== "registered" &&
        status !== "launch_pending" &&
        status !== "launched" &&
        status !== "failed"
      ) {
        sendError(res, 400, "Invalid status.");
        return;
      }
      const metadata =
        req.body?.metadata && typeof req.body.metadata === "object"
          ? (req.body.metadata as Record<string, unknown>)
          : {};
      const row = await getChatStore().createLaunchedToken({
        chatId: typeof req.body?.chatId === "string" ? req.body.chatId : null,
        runId: typeof req.body?.runId === "string" ? req.body.runId : null,
        artifactId: typeof req.body?.artifactId === "string" ? req.body.artifactId : null,
        walletAddress,
        chainId,
        tokenName,
        tokenSymbol,
        tokenAddress: typeof req.body?.tokenAddress === "string" ? req.body.tokenAddress : null,
        vaultAddress: typeof req.body?.vaultAddress === "string" ? req.body.vaultAddress : null,
        registeredVaultId: typeof req.body?.registeredVaultId === "string" ? req.body.registeredVaultId : null,
        registeredVaultHash: typeof req.body?.registeredVaultHash === "string" ? req.body.registeredVaultHash : null,
        factoryAddress: typeof req.body?.factoryAddress === "string" ? req.body.factoryAddress : null,
        launchContractAddress:
          typeof req.body?.launchContractAddress === "string" ? req.body.launchContractAddress : null,
        registerTxHash: typeof req.body?.registerTxHash === "string" ? req.body.registerTxHash : null,
        launchTxHash: typeof req.body?.launchTxHash === "string" ? req.body.launchTxHash : null,
        buyTaxBps: typeof req.body?.buyTaxBps === "number" ? req.body.buyTaxBps : null,
        sellTaxBps: typeof req.body?.sellTaxBps === "number" ? req.body.sellTaxBps : null,
        status,
        launchUrl,
        gmgnUrl,
        metadata,
      });
      res.json(row);
    });
  });

  // ── run stream (SSE) ──────────────────────────────────────────────────────

  router.get("/api/runs/:runId/stream", (req, res) => {
    void streamRun(req, res);
  });

  return router;
}

async function streamRun(req: Request, res: Response): Promise<void> {
  const runId = String(req.params.runId ?? "");

  // Ownership check before opening the SSE stream — the run row is persisted
  // synchronously when generation starts (before the pipeline itself runs),
  // so this lookup works whether the run is still active or long finished.
  const store = getChatStore();
  const run = await store.getRun(runId);
  if (!run) {
    sendError(res, 404, "Run not found.");
    return;
  }
  const chat = await store.getChat(run.chatId);
  if (!canAccessChat(chat, requesterUserId(req))) {
    sendForbidden(res);
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (ev: RunStreamEvent | Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  // Initial event goes out before any store/pipeline work.
  send({ type: "status", sequence: 0, message: "Connected — preparing your run…", payload: { connected: true } });

  const heartbeat = setInterval(() => {
    send({ type: "heartbeat", sequence: -1, payload: { at: new Date().toISOString() } });
  }, HEARTBEAT_MS);

  const finish = () => {
    clearInterval(heartbeat);
    res.end();
  };

  const unsubscribe = runManager.subscribe(runId, (ev) => {
    send(ev);
    if (ev.type === "run_completed" || ev.type === "run_failed") {
      // Give the last write a tick to flush before closing.
      setTimeout(finish, 25);
    }
  });

  if (unsubscribe) {
    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
    return;
  }

  // Run not active in this process (server restarted or old run): replay
  // persisted events so the chat page can still render history, then close.
  try {
    const events = await store.listEvents(runId);
    for (const ev of events) {
      send({ type: ev.eventType, sequence: ev.sequence, message: ev.message ?? undefined, payload: ev.payload });
    }
    if (run.status === "pending" || run.status === "running") {
      send({
        type: "run_failed",
        sequence: events.length + 1,
        message: "Run is no longer active (server restarted). Retry to start a new run.",
        payload: { stale: true },
      });
    }
  } catch (err) {
    send({
      type: "run_failed",
      sequence: 1,
      message: err instanceof Error ? err.message : "Failed to load run history.",
      payload: {},
    });
  }
  finish();
}
