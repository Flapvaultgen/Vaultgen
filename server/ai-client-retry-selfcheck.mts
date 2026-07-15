/**
 * Functional selfcheck for the transient-error retry logic in ai-client.ts.
 *
 * Patches @anthropic-ai/sdk's Messages.prototype.create (shared across all
 * instances) to simulate real failure shapes seen in production logs, then
 * drives the real createAiClient()/streamChunks() retry loop through it —
 * no reimplementation of the retry logic under test.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createAiClient, describeAiError } from "./ai-client.js";

let failures = 0;
let calls = 0;
let mode: "retryable-before-yield" | "retryable-after-yield" | "non-retryable" | "success" = "success";

type FakeEvent =
  | { type: "message_start"; message: { usage: { input_tokens: number; output_tokens: number } } }
  | { type: "content_block_delta"; delta: { type: "text_delta"; text: string } }
  | { type: "message_delta"; usage: { output_tokens: number }; delta: { stop_reason: string } };

function transientError(): Error {
  const err = new Error("Overloaded") as Error & { status?: number; error?: unknown };
  err.error = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
  return err;
}

function nonRetryableError(): Error {
  const err = new Error("Bad request") as Error & { status?: number; error?: unknown };
  err.status = 400;
  err.error = { type: "error", error: { type: "invalid_request_error", message: "Bad request" } };
  return err;
}

async function* fakeAnthropicStream(): AsyncGenerator<FakeEvent> {
  calls++;
  if (mode === "non-retryable") throw nonRetryableError();
  if (mode === "retryable-after-yield") {
    yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
    yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial-" } };
    throw transientError();
  }
  if (mode === "retryable-before-yield" && failures > 0) {
    failures--;
    throw transientError();
  }
  yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
  yield { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } };
  yield { type: "content_block_delta", delta: { type: "text_delta", text: "world" } };
  yield { type: "message_delta", usage: { output_tokens: 5 }, delta: { stop_reason: "end_turn" } };
}

// Messages.prototype is shared by every Anthropic client instance (verified:
// same constructor, same prototype object) — patching it once here safely
// intercepts calls made by createAiClient()'s own internal instance.
const probe = new Anthropic({ apiKey: "test-key" });
const messagesProto = Object.getPrototypeOf(probe.messages) as { create: (...a: unknown[]) => unknown };
messagesProto.create = () => fakeAnthropicStream();

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

async function collectText(client: ReturnType<typeof createAiClient>): Promise<string> {
  const stream = (await client.chat.completions.create({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  })) as AsyncIterable<{ choices: { delta?: { content?: string | null } }[] }>;
  let text = "";
  for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";
  return text;
}

const client = createAiClient("test-key");

// ── Scenario 1: transient failure BEFORE any content — retried transparently.
mode = "retryable-before-yield";
failures = 1;
calls = 0;
const text1 = await collectText(client);
check("retries a pre-content transient failure and succeeds", text1 === "hello world");
check("exactly one retry happened (2 calls)", calls === 2);

// ── Scenario 2: transient failure AFTER content already streamed — must NOT
//    retry silently (would duplicate/corrupt already-emitted output).
mode = "retryable-after-yield";
calls = 0;
let threw = false;
try {
  await collectText(client);
} catch {
  threw = true;
}
check("does not retry after partial content was already yielded", threw && calls === 1);

// ── Scenario 3: non-retryable error — fails immediately, no retry attempted.
mode = "non-retryable";
calls = 0;
threw = false;
let caught: unknown;
try {
  await collectText(client);
} catch (err) {
  threw = true;
  caught = err;
}
check("non-retryable errors are not retried", threw && calls === 1);
check("non-retryable error message is not overload-flavored", describeAiError(caught).includes("Codegen failed") || !describeAiError(caught).includes("overloaded"));

// ── describeAiError mapping ───────────────────────────────────────────────
check(
  "describeAiError maps overloaded_error to a friendly retry message",
  describeAiError(transientError()).toLowerCase().includes("overloaded")
);
check(
  "describeAiError maps invalid_request_error to the raw SDK message (not mislabeled as overload)",
  !describeAiError(nonRetryableError()).toLowerCase().includes("overloaded")
);
check("describeAiError falls back to Error.message for plain errors", describeAiError(new Error("boom")) === "boom");

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.error("FAILED: ai-client retry selfcheck");
  process.exit(1);
}
console.log("All ai-client retry selfchecks passed.");
