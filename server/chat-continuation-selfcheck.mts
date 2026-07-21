/**
 * Chat continuation self-check (no network).
 *
 * The codegen pipeline itself is one-shot: generateVaultCodeStream() starts a
 * brand-new mechanic from just the text it receives. A chat, however, is
 * multi-turn — a short follow-up like "continue" must not be sent as the
 * ENTIRE prompt for a fresh, context-free generation (that produces nonsense
 * like a contract literally named "Continue").
 *
 * makeContinuationAwareGenerator() in chat-routes.ts is what picks the right
 * codegen entry point per message. This proves each branch:
 *  1. First message in a chat → plain fresh generation, prompt unchanged.
 *  2. approximationConsent set (design-question / consent choice) → plain
 *     fresh generation regardless of prior history.
 *  3. Follow-up after a completed run that produced real Solidity → refine
 *     generation, seeded with the prior source/contractName/chat history —
 *     and the follow-up text itself is passed through unmodified (not
 *     rewritten), since the refine prompt already carries the context.
 *  4. Follow-up after a run that stopped at a spec/consent stage (no code
 *     yet) → fresh generation, but with the original idea + what was
 *     already decided folded into the prompt instead of the bare follow-up.
 *
 * Run: npx tsx chat-continuation-selfcheck.mts
 */
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.ANTHROPIC_API_KEY = "test-key-not-used";

import { MemoryChatStore, setChatStoreForTests } from "./chat-store.ts";
import { makeContinuationAwareGenerator } from "./chat-routes.ts";
import type { CodegenEvent } from "./codegen.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`OK ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function noopEmit(_ev: CodegenEvent): void {}

// ── 1. First message in a chat → plain fresh generation ────────────────────
{
  const store = new MemoryChatStore();
  setChatStoreForTests(store);

  const chat = await store.createChat({ title: "New vault chat" });
  await store.createMessage({ chatId: chat.id, role: "user", content: "A vault that burns tax BNB every day" });

  let freshCalls: unknown[] = [];
  const generator = makeContinuationAwareGenerator({
    freshGenerate: async (prompt) => {
      freshCalls.push(prompt);
    },
    refineGenerate: async () => {
      throw new Error("refine should not be called for a first message");
    },
  });

  await generator(chat.id, "A vault that burns tax BNB every day", noopEmit, undefined);
  check("first message uses fresh generation", freshCalls.length === 1);
  check("first message prompt is unchanged", freshCalls[0] === "A vault that burns tax BNB every day");

  setChatStoreForTests(null);
}

// ── 2. approximationConsent set → always fresh, regardless of history ──────
{
  const store = new MemoryChatStore();
  setChatStoreForTests(store);

  const chat = await store.createChat({ title: "New vault chat" });
  await store.createMessage({ chatId: chat.id, role: "user", content: "Epoch reward vault, 7 day cycles" });
  const run = await store.createRun({ chatId: chat.id });
  await store.updateRun(run.id, { status: "completed", deliverable: "design_questions" });
  await store.createMessage({ chatId: chat.id, role: "assistant", content: "Needs 1 design decision.", status: "completed" });
  // Resend of the original idea with an explicit consent choice.
  await store.createMessage({ chatId: chat.id, role: "user", content: "Epoch reward vault, 7 day cycles" });

  let freshCalls: { prompt: string; consent?: string }[] = [];
  const generator = makeContinuationAwareGenerator({
    freshGenerate: async (prompt, _apiKey, _model, _emit, consent) => {
      freshCalls.push({ prompt, consent });
    },
    refineGenerate: async () => {
      throw new Error("refine should not be called on a consent resend");
    },
  });

  await generator(chat.id, "Epoch reward vault, 7 day cycles", noopEmit, "spec_only");
  check("consent resend uses fresh generation", freshCalls.length === 1);
  check("consent resend keeps the original prompt verbatim", freshCalls[0]?.prompt === "Epoch reward vault, 7 day cycles");
  check("consent resend passes the consent flag through", freshCalls[0]?.consent === "spec_only");

  setChatStoreForTests(null);
}

// ── 3. Follow-up after a real contract → refine generation ─────────────────
{
  const store = new MemoryChatStore();
  setChatStoreForTests(store);

  const chat = await store.createChat({ title: "New vault chat" });
  await store.createMessage({ chatId: chat.id, role: "user", content: "A vault that burns tax BNB every day" });
  const run1 = await store.createRun({ chatId: chat.id });
  await store.updateRun(run1.id, { status: "completed", deliverable: "contract" });
  await store.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: "Generated DailyBurnVault.",
    status: "completed",
  });
  await store.createArtifact({
    chatId: chat.id,
    runId: run1.id,
    artifactType: "solidity",
    name: "DailyBurnVault.sol",
    content: "contract DailyBurnVault is CodegenVaultBase { /* ... */ }",
  });
  // The follow-up message itself (already persisted by start-generation
  // before the generator runs, same as production).
  await store.createMessage({ chatId: chat.id, role: "user", content: "continue" });

  let refineCalls: { message: string; session: unknown }[] = [];
  const generator = makeContinuationAwareGenerator({
    freshGenerate: async () => {
      throw new Error("fresh generation should not run when a real contract already exists");
    },
    refineGenerate: async (message, session) => {
      refineCalls.push({ message, session });
    },
  });

  await generator(chat.id, "continue", noopEmit, undefined);
  check("follow-up after real code uses refine generation", refineCalls.length === 1);
  const session = refineCalls[0]?.session as {
    initialPrompt: string;
    contractName: string;
    source: string;
    chatHistory: { role: string; content: string }[];
  };
  check("refine message is the raw follow-up, not rewritten", refineCalls[0]?.message === "continue");
  check("refine session carries the original idea", session?.initialPrompt === "A vault that burns tax BNB every day");
  check("refine session carries the contract name", session?.contractName === "DailyBurnVault");
  check("refine session carries the prior source", session?.source.includes("DailyBurnVault"));
  check(
    "refine session chat history excludes the current follow-up message",
    session?.chatHistory.every((t) => t.content !== "continue")
  );
  check(
    "refine session chat history includes the prior assistant reply",
    session?.chatHistory.some((t) => t.role === "assistant" && t.content === "Generated DailyBurnVault.")
  );

  setChatStoreForTests(null);
}

// ── 4. Follow-up after a spec-only run (no code yet) → composed fresh prompt
{
  const store = new MemoryChatStore();
  setChatStoreForTests(store);

  const chat = await store.createChat({ title: "New vault chat" });
  await store.createMessage({
    chatId: chat.id,
    role: "user",
    content: "Epoch vault where tax BNB accumulates for 7 days, then settles pro-rata",
  });
  const run1 = await store.createRun({ chatId: chat.id });
  await store.updateRun(run1.id, { status: "completed", deliverable: "spec_only" });
  await store.createMessage({
    chatId: chat.id,
    role: "assistant",
    content: "Draft spec only: a 7-day reward epoch vault distributed pro-rata to registered holders.",
    status: "completed",
  });
  await store.createMessage({ chatId: chat.id, role: "user", content: "continue" });

  let freshCalls: string[] = [];
  const generator = makeContinuationAwareGenerator({
    freshGenerate: async (prompt) => {
      freshCalls.push(prompt);
    },
    refineGenerate: async () => {
      throw new Error("refine should not be called when no code exists yet");
    },
  });

  await generator(chat.id, "continue", noopEmit, undefined);
  check("follow-up after spec-only run uses fresh generation", freshCalls.length === 1);
  check("composed prompt is not the bare follow-up text", freshCalls[0] !== "continue");
  check("composed prompt carries the original idea", (freshCalls[0] ?? "").includes("Epoch vault where tax BNB accumulates"));
  check(
    "composed prompt carries what was already decided",
    (freshCalls[0] ?? "").includes("7-day reward epoch vault distributed pro-rata")
  );
  check("composed prompt carries the follow-up message", (freshCalls[0] ?? "").includes('"continue"'));

  setChatStoreForTests(null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll chat continuation selfchecks passed");
}
