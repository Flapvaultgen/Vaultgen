/**
 * Selfchecks for the AI cost-reduction layer:
 *  - native Anthropic request shaping (system hoisting, cache_control placement, max_tokens)
 *  - usage normalization + per-model cost estimation
 *  - AsyncLocalStorage per-run usage accumulation
 *  - retry-history pruning (codegen.ts)
 *  - static wiring: max_tokens caps present at every call site, cheap-model routing
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildAnthropicRequest,
  createAiUsageTotals,
  estimateCallCostUsd,
  recordAiUsage,
  runWithAiUsage,
  usageFromAnthropic,
} from "./ai-client.js";
import { pruneRetryHistory } from "./codegen.js";

const SERVER_DIR = path.dirname(new URL(import.meta.url).pathname);

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`OK ${name}`);
  else {
    console.error(`FAIL ${name}`);
    failures++;
  }
}

// ── Request shaping + cache_control placement ─────────────────────────────────
const req = buildAnthropicRequest({
  model: "claude-sonnet-5",
  temperature: 0.2,
  response_format: { type: "json_object" },
  max_tokens: 32_000,
  cache_conversation: true,
  messages: [
    { role: "system", content: "BIG STATIC PROMPT" },
    { role: "user", content: "initial request" },
    { role: "assistant", content: "draft 1" },
    { role: "user", content: "fix prompt" },
  ],
});
check("system message hoisted out of messages", req.system?.length === 1 && req.system[0]!.text === "BIG STATIC PROMPT");
check("cache breakpoint on last system block", req.system?.[0]?.cache_control?.type === "ephemeral");
check("messages preserve order and roles", req.messages.length === 3 && req.messages[0]!.role === "user" && req.messages[1]!.role === "assistant");
check(
  "cache breakpoint on the LAST message block only",
  req.messages[2]!.content[0]!.cache_control?.type === "ephemeral" &&
    req.messages[0]!.content[0]!.cache_control === undefined &&
    req.messages[1]!.content[0]!.cache_control === undefined
);
check("max_tokens passed through", req.max_tokens === 32_000);
check(
  "temperature and response_format are NOT sent to Anthropic",
  !("temperature" in req) && !("response_format" in req)
);

const noSystem = buildAnthropicRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
check("no system field when no system message", !("system" in noSystem));
check("default max_tokens applied when unset", noSystem.max_tokens > 0);

const oneShot = buildAnthropicRequest({
  model: "m",
  messages: [
    { role: "system", content: "SYS" },
    { role: "user", content: "one-shot call" },
  ],
});
check(
  "one-shot calls cache only the system prompt (no wasted conversation cache write)",
  oneShot.system?.[0]?.cache_control?.type === "ephemeral" && oneShot.messages[0]!.content[0]!.cache_control === undefined
);
check(
  "codegen retry calls opt into conversation caching",
  await readFile(path.join(SERVER_DIR, "codegen.ts"), "utf8").then((s) => (s.match(/cache_conversation: true/g) ?? []).length === 2)
);

// ── JSON extractor resilience (critic replies with fenced code INSIDE strings) ─
const { extractJsonPayload } = await import("./ai-client.js");
const nested = 'Here you go:\n```json\n{"summary":"x","findings":[{"suggestedRepair":"use ```solidity fences``` here"}]}\n```\nDone.';
check("extractJsonPayload survives code fences inside JSON strings", (() => {
  try {
    return JSON.parse(extractJsonPayload(nested)).summary === "x";
  } catch {
    return false;
  }
})());

// ── Usage normalization + pricing ─────────────────────────────────────────────
const usage = usageFromAnthropic({
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 8000,
  cache_read_input_tokens: 40_000,
});
check(
  "anthropic usage normalized",
  usage.inputTokens === 1000 && usage.outputTokens === 500 && usage.cacheWriteInputTokens === 8000 && usage.cacheReadInputTokens === 40_000
);
check("usage tolerates missing fields", usageFromAnthropic(undefined).inputTokens === 0);

// sonnet: $3/MTok in, $15/MTok out; cache read 0.1x, cache write 1.25x
const cost = estimateCallCostUsd("claude-sonnet-5", usage)!;
const expected = (1000 * 3 + 40_000 * 3 * 0.1 + 8000 * 3 * 1.25 + 500 * 15) / 1_000_000;
check("sonnet cost estimate matches formula (cache read 0.1x, write 1.25x)", Math.abs(cost - expected) < 1e-9);
check("haiku priced cheaper than sonnet", estimateCallCostUsd("claude-haiku-4-5", usage)! < cost);
check("unknown model returns null cost", estimateCallCostUsd("gpt-5.4", usage) === null);

// ── Per-run accumulation via AsyncLocalStorage ────────────────────────────────
{
  const totals = createAiUsageTotals();
  await runWithAiUsage(totals, async () => {
    recordAiUsage("claude-sonnet-5", { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
    await Promise.resolve(); // usage must survive async hops
    recordAiUsage("claude-haiku-4-5", { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 20, cacheWriteInputTokens: 0 });
  });
  check("usage accumulates across calls in run context", totals.calls === 2 && totals.inputTokens === 150 && totals.outputTokens === 15);
  check("estCostUsd accumulated for priced models", totals.estCostUsd !== null && totals.estCostUsd > 0);
  const outside = createAiUsageTotals();
  recordAiUsage("claude-sonnet-5", { inputTokens: 999, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
  check("recording outside a run context is a no-op (does not leak between runs)", outside.calls === 0 && totals.calls === 2);
}

// ── Retry-history pruning ─────────────────────────────────────────────────────
type Msg = { role: "system" | "user" | "assistant"; content: string };
const head: Msg[] = [
  { role: "system", content: "SYSTEM" },
  { role: "user", content: "INITIAL" },
];
const fixLog = [
  { phase: "compile_fix" as const, attempt: 1, message: "Error A" },
  { phase: "safety_fix" as const, attempt: 2, rule: "schema-method-not-implemented", message: "Error B" },
  { phase: "test_fix" as const, attempt: 3, message: "Error C" },
];
{
  // 3 failed drafts accumulated, a 4th fix prompt pending.
  const msgs: Msg[] = [
    ...head,
    { role: "assistant", content: "DRAFT 1 (huge)" },
    { role: "user", content: "fix 1" },
    { role: "assistant", content: "DRAFT 2 (huge)" },
    { role: "user", content: "fix 2" },
    { role: "assistant", content: "DRAFT 3 (huge)" },
    { role: "user", content: "fix 3 (current)" },
  ];
  const pruned = pruneRetryHistory(msgs, 2, fixLog);
  check("pruning keeps the head untouched", pruned[0]!.content === "SYSTEM" && pruned[1]!.content === "INITIAL");
  check(
    "pruning keeps only the latest draft + current fix",
    pruned.some((m) => m.content === "DRAFT 3 (huge)") &&
      pruned.some((m) => m.content === "fix 3 (current)") &&
      !pruned.some((m) => m.content === "DRAFT 1 (huge)") &&
      !pruned.some((m) => m.content === "DRAFT 2 (huge)")
  );
  const summary = pruned.find((m) => m.content.includes("earlier failed draft"));
  check("dropped drafts collapsed into a failure summary", summary !== undefined && summary.role === "user");
  check("summary cites dropped failure rules", (summary?.content ?? "").includes("schema-method-not-implemented"));
  check("pruned conversation is bounded", pruned.length === 5);
}
{
  // First retry (one draft, one fix) — nothing to prune.
  const msgs: Msg[] = [...head, { role: "assistant", content: "DRAFT 1" }, { role: "user", content: "fix 1" }];
  const pruned = pruneRetryHistory(msgs, 2, fixLog.slice(0, 1));
  check("first retry left untouched (nothing before latest draft)", pruned.length === 4 && pruned === msgs);
}
{
  // Initial call — no assistant messages at all.
  const pruned = pruneRetryHistory([...head], 2, []);
  check("initial call left untouched", pruned.length === 2);
}

// ── Static wiring checks ──────────────────────────────────────────────────────
const codegenSource = await readFile(path.join(SERVER_DIR, "codegen.ts"), "utf8");
check("codegen retry loops apply pruning", (codegenSource.match(/messages = pruneRetryHistory\(/g) ?? []).length >= 3);
check("codegen generations set an output cap", /max_tokens: CODEGEN_MAX_OUTPUT_TOKENS/.test(codegenSource));
check("scope classifier routed to the advisory (cheap) model", /classifyVaultScope\(userPrompt, apiKey, advisoryModel\)/.test(codegenSource));
check("spec audit routed to the advisory (cheap) model", /runSpecAudit\(fullSource, contractName, apiKey, advisoryModel/.test(codegenSource));
check("integration-test reuse keyed on interface hash", /interfaceHash/.test(codegenSource) && /reused — interface unchanged/.test(codegenSource));
check("per-run usage attached to results", /tokenUsage/.test(codegenSource) && /runWithAiUsage/.test(codegenSource));

for (const [file, cap] of [
  ["vault-scope.ts", /max_tokens: 2000/],
  ["test-gen.ts", /max_tokens: 20_000/],
  ["spec-audit.ts", /max_tokens: 4000/],
  ["economic-critic.ts", /max_tokens: 8000/],
  ["mechanic-spec.ts", /max_tokens: 24000/],
] as const) {
  const src = await readFile(path.join(SERVER_DIR, file), "utf8");
  check(`${file} sets an output cap`, cap.test(src));
}

if (failures > 0) {
  console.error(`\n${failures} ai-cost selfcheck failure(s).`);
  process.exit(1);
}
console.log("\nAll ai-cost selfchecks passed.");
