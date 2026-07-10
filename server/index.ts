import dotenv from "dotenv";
// .env.local must win over a stale ANTHROPIC_API_KEY in the shell (common dev pitfall).
dotenv.config({ path: ".env.local", override: true });
dotenv.config();
import cors from "cors";
import express from "express";
import {
  generateVaultCode,
  generateVaultCodeStream,
  generateVaultCodeRefineStream,
  type RefineSession,
  type ApproximationConsent,
} from "./codegen.js";

/** Phase 6: explicit approximation consent — only the two known choices are accepted. */
function parseConsent(value: unknown): ApproximationConsent | undefined {
  return value === "closest_draft" || value === "spec_only" ? value : undefined;
}
import { runSpecAudit } from "./spec-audit.js";
import { resolveAiModel } from "./ai-model.js";
import { createChatRouter } from "./chat-routes.js";
import { isSupabaseConfigured } from "./supabase.js";

const app = express();
const port = Number(process.env.PORT ?? 3002);

const corsOrigins = process.env.CORS_ORIGIN?.split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

function corsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (!corsOrigins?.length) return true;
  if (corsOrigins.includes(origin)) return true;
  // Vercel production + preview URLs (avoids "offline" when alias or preview domain changes).
  return /^https:\/\/flapvaultgen(-[a-z0-9-]+)?\.vercel\.app$/i.test(origin);
}

app.use(
  cors({
    origin(origin, callback) {
      callback(null, corsOriginAllowed(origin));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({
    service: "Flap Vault Gen API",
    health: "/api/health",
    ok: true,
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    aiMode: process.env.ANTHROPIC_API_KEY ? "anthropic" : "stub",
    model: resolveAiModel(),
    chatStorage: isSupabaseConfigured() ? "supabase" : "memory",
  });
});

// Chat history + generation runs (Supabase-backed when configured, in-memory otherwise).
app.use(createChatRouter());

app.post("/api/codegen-vault", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt ?? "").trim();
    if (prompt.length < 8) {
      res.status(400).json({ error: "Prompt must be at least 8 characters." });
      return;
    }
    if (prompt.length > 4000) {
      res.status(400).json({ error: "Prompt too long (max 4000 chars)." });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = resolveAiModel();

    const result = await generateVaultCode(prompt, apiKey, model, parseConsent(req.body?.approximationConsent));
    res.json(result);
  } catch (err) {
    console.error("codegen failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Codegen failed" });
  }
});

app.post("/api/codegen-vault-stream", async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (prompt.length < 8 || prompt.length > 4000) {
    res.status(400).json({ error: "Prompt must be 8–4000 characters." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (ev: unknown) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = resolveAiModel();
    await generateVaultCodeStream(prompt, apiKey, model, send, parseConsent(req.body?.approximationConsent));
  } catch (err) {
    console.error("codegen stream failed:", err);
    send({ type: "error", error: err instanceof Error ? err.message : "Codegen failed" });
  } finally {
    res.end();
  }
});

app.post("/api/codegen-vault-refine-stream", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  const session = req.body?.session as RefineSession | undefined;

  if (message.length < 2 || message.length > 2000) {
    res.status(400).json({ error: "Message must be 2–2000 characters." });
    return;
  }
  if (!session?.initialPrompt || !session?.contractName || !session?.source) {
    res.status(400).json({ error: "Invalid session — regenerate the vault first." });
    return;
  }
  if (!Array.isArray(session.chatHistory)) {
    res.status(400).json({ error: "session.chatHistory must be an array." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (ev: unknown) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = resolveAiModel();
    await generateVaultCodeRefineStream(message, session, apiKey, model, send);
  } catch (err) {
    console.error("codegen refine stream failed:", err);
    send({ type: "error", error: err instanceof Error ? err.message : "Refine failed" });
  } finally {
    res.end();
  }
});

app.post("/api/spec-audit", async (req, res) => {
  try {
    const source = String(req.body?.source ?? "");
    const contractName = String(req.body?.contractName ?? "GeneratedVault").trim();
    if (source.length < 32) {
      res.status(400).json({ error: "source must be at least 32 characters." });
      return;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = resolveAiModel();
    const audit = await runSpecAudit(source, contractName, apiKey, model, { compiled: true });
    res.json(audit);
  } catch (err) {
    console.error("spec-audit failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Spec audit failed" });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Flap Vault Gen API http://localhost:${port}`);
  console.log(`Mode: ${process.env.ANTHROPIC_API_KEY ? "Anthropic" : "stub (set ANTHROPIC_API_KEY)"}`);
});
