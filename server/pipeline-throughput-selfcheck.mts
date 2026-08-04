/**
 * Self-check for pipeline throughput: the guards that stop a generation run
 * from spending passes (and the user's patience) on work that cannot converge,
 * plus the timing instrumentation that makes a slow run diagnosable.
 *
 * Proves:
 *  1. formatRunTimings reports per-pass lines plus a totals line ordered by
 *     time spent, so the dominant phase is obvious in the logs.
 *  2. The expensive phases (model call, compile, test generation, fork run)
 *     are actually wrapped in the timer.
 *  3. A blocking rule that repeats escalates straight to the surgical patch
 *     prompt, and a rule that keeps blocking ends the loop instead of eating
 *     the whole pass budget — reported honestly as an exhausted auto-fix.
 *  4. A fork-test failure that repeats identically ends the test-fix loop,
 *     and its signature ignores run-to-run noise (addresses, numbers).
 *  5. The prompt tells the model not to pad every pass with comment banners.
 *  6. The chat UI drops the previous draft when a rewrite starts, so passes
 *     are not shown concatenated into one giant contract.
 *
 * Run: npx tsx pipeline-throughput-selfcheck.mts   (no network, no Foundry)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatRunTimings, timePhase, withRunTimings, type PhaseTiming } from "./run-timing.js";
import { testFailureSignature } from "./codegen.js";
import { CODEGEN_SYSTEM_PROMPT } from "./codegen.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`OK ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const codegenSrc = await readFile(path.join(HERE, "codegen.ts"), "utf8");
const chatPageSrc = await readFile(path.join(HERE, "..", "web", "src", "ChatPage.tsx"), "utf8");

// ── 1. Timing summary ────────────────────────────────────────────────────────
const timings: PhaseTiming[] = [
  { pass: 1, phase: "llm", ms: 40_000 },
  { pass: 1, phase: "compile", ms: 8_000 },
  { pass: 2, phase: "llm", ms: 50_000 },
  { pass: 2, phase: "forktest", ms: 30_000 },
];
const lines = formatRunTimings(timings, 130_000);
check("timing:one line per pass plus totals", lines.length === 3, `got ${lines.length}`);
check("timing:pass line names its phases", /pass 1: 48\.0s — llm 40\.0s · compile 8\.0s/.test(lines[0]!), lines[0]);
check("timing:totals line reports the run total", /total=130\.0s/.test(lines[2]!), lines[2]);
check(
  "timing:totals ordered by time spent",
  lines[2]!.indexOf("llm ") < lines[2]!.indexOf("forktest ") &&
    lines[2]!.indexOf("forktest ") < lines[2]!.indexOf("compile "),
  lines[2]
);
check("timing:empty run still logs a total", /no phases recorded/.test(formatRunTimings([], 500)[0]!));

// Recording plumbing: phases must land in the right run's store, be tagged with
// the pass that was current, and still be recorded when the phase throws.
const recorded: PhaseTiming[] = [];
let pass = 1;
await withRunTimings(recorded, async () => {
  await timePhase("llm", () => pass, async () => undefined);
  pass = 2;
  await timePhase("compile", () => pass, async () => undefined).catch(() => undefined);
  await timePhase("forktest", () => pass, async () => {
    throw new Error("fork test blew up");
  }).catch(() => undefined);
});
check("timing:records every phase", recorded.length === 3, `got ${recorded.length}`);
check("timing:tags the current pass", recorded.map((t) => t.pass).join(",") === "1,2,2");
check("timing:records a phase that threw", recorded.some((t) => t.phase === "forktest"));
const outsideRun: PhaseTiming[] = [];
await timePhase("llm", () => 1, async () => undefined);
check("timing:no store means no crash", outsideRun.length === 0);

// ── 2. The expensive phases are measured ─────────────────────────────────────
for (const phase of ["llm", "compile", "testgen", "forktest", "audit", "critic", "uigen", "plan"]) {
  check(`timing:phase-${phase}-wrapped`, new RegExp(`timed\\("${phase}"`).test(codegenSrc));
}
check(
  "timing:summary logged for every entry point",
  (codegenSrc.match(/logRunTimings\(/g) ?? []).length >= 3,
  `${(codegenSrc.match(/logRunTimings\(/g) ?? []).length} call(s)`
);

// ── 3. Blocking-rule convergence ─────────────────────────────────────────────
check("converge:repeat goes surgical immediately", /repeated\.length > 0\s*\?\s*surgicalSafetyFixPrompt/.test(codegenSrc));
check(
  "converge:repeat measured before recording the pass",
  codegenSrc.indexOf("const repeated = blocking.filter((b) => previousFailures.has(b.rule))") <
    codegenSrc.indexOf("blockCountByRule.set(b.rule")
);
check("converge:per-rule pass cap exists", /const MAX_BLOCKS_PER_RULE = \d+;/.test(codegenSrc));
check(
  "converge:cap ends the loop",
  /blockCountByRule\.get\(b\.rule\) \?\? 0\) >= MAX_BLOCKS_PER_RULE/.test(codegenSrc) &&
    /autoFixGaveUp = true;\s*\n\s*break;/.test(codegenSrc)
);
check("converge:giving up is reported as exhausted", /autoFixExhausted:\s*\n?\s*autoFixGaveUp \|\|/.test(codegenSrc));
check("converge:stall skips the test-fix loop entirely", /!autoFixGaveUp &&/.test(codegenSrc));

// ── 4. Fork-test failure convergence ─────────────────────────────────────────
check("converge:identical test failure cap exists", /const MAX_IDENTICAL_TEST_FAILURES = \d+;/.test(codegenSrc));
check(
  "converge:both gate paths check the stall",
  (codegenSrc.match(/testFixStalled\(gate\.errors\)/g) ?? []).length === 2
);
check(
  "converge:infra failures are not counted as stalls",
  /!gate\.generationFailed && testFixStalled/.test(codegenSrc)
);
const failA = "[FAIL: assertion failed] test_claim() (gas: 123456) 0xAbCdEf0123456789 balance 1000";
const failB = "[FAIL: assertion failed] test_claim() (gas: 987654) 0xFedCba9876543210 balance 2500";
const failC = "[FAIL: revert: pool empty] test_settle() (gas: 111111)";
check("signature:same failure with different numbers matches", testFailureSignature(failA) === testFailureSignature(failB));
check("signature:different failures do not match", testFailureSignature(failA) !== testFailureSignature(failC));

// ── 5. Output economy in the prompt ──────────────────────────────────────────
check("prompt:has an output economy section", /OUTPUT ECONOMY/.test(CODEGEN_SYSTEM_PROMPT));
check("prompt:forbids comment banners", /NO decorative comment banners/.test(CODEGEN_SYSTEM_PROMPT));
check("prompt:forbids restating the rules in comments", /Never annotate a line with the rule number/.test(CODEGEN_SYSTEM_PROMPT));
check("prompt:caps schema description length", /aim under 200 characters/.test(CODEGEN_SYSTEM_PROMPT));
check(
  "prompt:brevity never drops a required disclosure",
  /NEVER at the cost of a required disclosure/.test(CODEGEN_SYSTEM_PROMPT)
);

// ── 6. The chat UI shows one draft, not every pass concatenated ──────────────
check("web:rewrite clears the streamed draft", /codeReset\) setLiveCode\(""\)/.test(chatPageSrc));
check(
  "web:code_delta still appends within a pass",
  /case "code_delta":\s*\n\s*setLiveCode\(\(c\) => c \+ String/.test(chatPageSrc)
);

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} pipeline-throughput self-check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll pipeline-throughput self-checks passed.");
