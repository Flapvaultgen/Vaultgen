import dotenv from "dotenv";
// Load .env.local first (developer secrets, gitignored), then .env as fallback.
dotenv.config({ path: ".env.local" });
dotenv.config();
import cors from "cors";
import express from "express";
import { generateVaultCode, generateVaultCodeStream, generateVaultCodeRefineStream, type RefineSession } from "./codegen.js";
import { runSpecAudit } from "./spec-audit.js";

const app = express();
const port = Number(process.env.PORT ?? 3002);

const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors(
    corsOrigins?.length
      ? { origin: corsOrigins, credentials: true }
      : { origin: true }
  )
);
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    aiMode: process.env.OPENAI_API_KEY ? "openai" : "stub",
    model: process.env.OPENAI_MODEL ?? "gpt-4o",
  });
});

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

    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL ?? "gpt-4o";

    const result = await generateVaultCode(prompt, apiKey, model);
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
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL ?? "gpt-4o";
    await generateVaultCodeStream(prompt, apiKey, model, send);
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
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL ?? "gpt-4o";
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
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL ?? "gpt-4o";
    const audit = await runSpecAudit(source, contractName, apiKey, model, { compiled: true });
    res.json(audit);
  } catch (err) {
    console.error("spec-audit failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Spec audit failed" });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Origin Vault AI server http://localhost:${port}`);
  console.log(`Mode: ${process.env.OPENAI_API_KEY ? "OpenAI" : "stub (set OPENAI_API_KEY)"}`);
});
