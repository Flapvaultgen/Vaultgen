/**
 * Critic-driven auto-repair (cleanup pass).
 *
 * The economic critic (economic-critic.ts) is ADVISORY for launch gating —
 * its findings never flip safety.level and never block isDeployReady on their
 * own. What this module adds: when the critic reports serious findings
 * (blocking / high / fund-or-lifecycle-relevant medium) on code that already
 * compiled and passed the deterministic scanners, the pipeline attempts a
 * bounded automatic repair BEFORE showing the final result:
 *
 *   critic findings (+ any remaining test failures)
 *     → repair prompt → regenerate → recompile → rescan → retest
 *     → rerun critic → adopt repaired code only if hard gates still pass
 *
 * Hard launch blockers are unchanged: compile failure, deterministic scanner
 * failure, integration/simulation failure, unsafe scope verdict, missing
 * bytecode. A repair attempt that regresses any hard gate is ROLLED BACK.
 *
 * Model routing stays environment-driven (ai-model.ts): normal repair
 * attempts use the pipeline's configured default model; one optional final
 * escalation attempt uses AI_ESCALATION_MODEL only when that env is set.
 * No model name literal lives in this module.
 */
import type { CriticFinding, EconomicCriticReport } from "./economic-critic.js";
import type { MechanicSpec } from "./mechanic-spec.js";

/** Max normal repair attempts; one extra escalation attempt only when AI_ESCALATION_MODEL is set. */
export const MAX_CRITIC_REPAIR_ATTEMPTS = 2;

export type RepairAttempt = {
  attempt: number;
  reason: "critic_finding" | "test_failure" | "critic_and_test";
  /** Model used for THIS attempt (default pipeline model, or the env-configured escalation model). */
  model: string;
  escalated: boolean;
  findingsAddressed: string[];
  compileResult: "pass" | "fail";
  scannerResult: "pass" | "fail" | "skip";
  testResult: "pass" | "fail" | "skip";
  criticResult: "clean" | "findings_remain" | "not_rerun";
  remainingIssues: string[];
};

/** Medium-severity findings only join repair when they touch user funds, stuck states, lifecycle, or UI safety. */
const MEDIUM_RELEVANCE_RE =
  /fund|claim|withdraw|payout|reward|liabilit|stuck|trap|frozen|freeze|pause|cancel|clos(e|ed|ure)|abandon|exit|lifecycle|status|view|uischema|schema|assign/i;

export function selectRepairFindings(report: EconomicCriticReport | null | undefined): CriticFinding[] {
  if (!report?.reviewed) return [];
  return report.findings.filter(
    (f) =>
      f.severity === "blocking" ||
      f.severity === "high" ||
      (f.severity === "medium" && MEDIUM_RELEVANCE_RE.test(`${f.finding} ${f.explanation}`))
  );
}

/** Repair triggers only on high/blocking critic findings — mediums ride along in the prompt, never trigger alone. */
export function shouldTriggerCriticRepair(report: EconomicCriticReport | null | undefined): boolean {
  if (!report?.reviewed) return false;
  return report.findings.some((f) => f.severity === "blocking" || f.severity === "high");
}

/** Best-effort function names cited in critic explanations (e.g. "claimReward()"). */
export function extractAffectedFunctions(findings: CriticFinding[]): string[] {
  const names = new Set<string>();
  for (const f of findings) {
    for (const m of `${f.explanation} ${f.suggestedRepair}`.matchAll(/\b([a-zA-Z_]\w{2,})\s*\(/g)) {
      const name = m[1]!;
      if (!/^(require|mapping|keccak256|function|returns|if|for|while|emit|revert|new|address|uint\d*|payable)$/.test(name)) {
        names.add(name);
      }
    }
  }
  return [...names].slice(0, 12);
}

/* ── Generic bug-class guidance (no vault-specific hardcoding) ─────────────── */

const PAUSE_FREEZE_RE = /pause|whenNotPaused|frozen|freeze/i;
const STUCK_USER_RE = /cancel|clos(e|ed|ure)|stuck|trap|abandon|pending|exit/i;
const STATUS_VIEW_RE = /status|view|uischema|schema|lifecycle|state/i;

export const PAUSE_FREEZE_GUIDANCE = `Claims must not be frozen after rewards are reserved:
- If a function ONLY withdraws already-reserved per-user funds (claim/withdraw paying claimable[msg.sender]), remove the pause guard (whenNotPaused) from it — reserved user funds must stay withdrawable during pause.
- Keep the pause guard on new submissions, approvals, cancellations, and manager actions.
- If pausing claims is genuinely required by the mechanic, disclose it explicitly in description() and vaultUISchema and treat it as a higher-risk trust assumption.`;

export const STUCK_USER_GUIDANCE = `Cancellation or closure must not trap pending users:
- When a resource (bounty/task/quest/entry) is cancelled or closed while a user has a pending submission/assignment, that user needs a user-callable exit: an abandon/clear function that works AFTER cancellation/closure for unapproved submissions.
- Do not require the resource status to be Open for the user's own exit path.
- Do not clear all users with an unbounded loop — prefer per-user, user-callable exit paths.`;

export const STATUS_VIEW_GUIDANCE = `Status views must expose meaningful lifecycle states:
- If internal state tracks submitted/approved/rejected/claimed/abandoned/claimableAmount, expose those in a user-facing view (an enum-like status or per-state getters), not just a bare bool.
- If any public/view method signature changes, update vaultUISchema.methods to match — never leave the schema describing the old signature.`;

export function buildRepairGuidance(findings: CriticFinding[], testErrors: string): string {
  const haystack = `${findings.map((f) => `${f.finding} ${f.explanation} ${f.suggestedRepair}`).join(" ")} ${testErrors}`;
  const sections: string[] = [];
  if (PAUSE_FREEZE_RE.test(haystack)) sections.push(PAUSE_FREEZE_GUIDANCE);
  if (STUCK_USER_RE.test(haystack)) sections.push(STUCK_USER_GUIDANCE);
  if (STATUS_VIEW_RE.test(haystack)) sections.push(STATUS_VIEW_GUIDANCE);
  return sections.length > 0 ? `\nBug-class guidance (apply only where the pattern exists in YOUR code):\n${sections.join("\n\n")}\n` : "";
}

/* ── Repair prompt ─────────────────────────────────────────────────────────── */

export type CriticRepairPromptOpts = {
  contractName: string;
  findings: CriticFinding[];
  mechanicSpec: MechanicSpec;
  attempt: number;
  escalated: boolean;
  /** Raw integration-test failure excerpt ("" when tests pass/skipped). */
  testErrors: string;
  /** Human summary of failing simulation scenarios ("" when none). */
  failingScenarioSummary: string;
  compiled: boolean;
  scannersPassed: boolean;
  testsPassed: boolean;
};

export function buildCriticRepairPrompt(opts: CriticRepairPromptOpts): string {
  const {
    contractName,
    findings,
    mechanicSpec,
    attempt,
    escalated,
    testErrors,
    failingScenarioSummary,
    compiled,
    scannersPassed,
    testsPassed,
  } = opts;

  const findingLines = findings
    .map(
      (f) =>
        `- [${f.severity}] ${f.finding} (Rules ${f.ruleIds.join(", ") || "001-009"})\n  Problem: ${f.explanation}\n  Suggested fix: ${f.suggestedRepair}`
    )
    .join("\n");

  const affected = extractAffectedFunctions(findings);
  const affectedLine = affected.length > 0 ? `\nLikely affected functions: ${affected.join(", ")}.\n` : "";

  const testBlock =
    testErrors || failingScenarioSummary
      ? `\nIntegration/simulation failures to fix in the SAME patch (do not treat separately from the critic findings):
${failingScenarioSummary}${testErrors ? `\nTest error excerpt:\n${testErrors.slice(0, 1500)}\n` : ""}`
      : "";

  const specExpectations = JSON.stringify(
    {
      productSummary: mechanicSpec.productSummary,
      lifecycle: mechanicSpec.lifecycle,
      payoutRules: mechanicSpec.payoutRules,
      userActions: mechanicSpec.userActions.map((a) => a.name),
      managerActions: mechanicSpec.managerActions.map((a) => a.name),
    },
    null,
    1
  );

  const statusLine = `Current status: compile ${compiled ? "PASS" : "FAIL"}, deterministic scanners ${scannersPassed ? "PASS" : "FAIL"}, integration tests ${testsPassed ? "PASS/SKIPPED" : "FAILING"}.`;

  return `You are auto-repairing ${contractName}, a generated Flap vault that COMPILES and passed the deterministic safety scanners, but the advisory economic critic flagged serious issues${escalated ? " (final escalation attempt — previous repairs did not resolve them)" : ""}. This is repair attempt ${attempt}.

${statusLine}

Economic critic findings to repair (advisory for launch, but fix them now):
${findingLines}
${affectedLine}${testBlock}
MechanicSpec expectations (the code must honor THIS lifecycle and payout plan):
${specExpectations}
${buildRepairGuidance(findings, `${testErrors} ${failingScenarioSummary}`)}
Repair rules — make the SMALLEST SAFE PATCH:
- Preserve existing working logic; do not rewrite unrelated architecture.
- Do not remove the Flap base inheritance or redeclare base wiring.
- Keep receive() cheap (Rule 005) — bucket accounting only.
- Preserve bilingual require() strings (Rule 004).
- Preserve per-user accounting and reserved-reward liability accounting (never regress to shared-pool drains).
- Keep state updates BEFORE native transfers.
- No unbounded loops over user-controlled arrays.
- Do not hide manager/guardian trust assumptions — description() and vaultUISchema must stay honest.
- Update vaultUISchema whenever public methods or outputs change.
- Do not introduce templates or archetypes; keep the mechanic as specified.
- Launch gating is unchanged — deterministic scanners and tests remain the hard gates.`;
}

/* ── Attempt bookkeeping ───────────────────────────────────────────────────── */

export function repairReason(hasCriticFindings: boolean, hasTestFailure: boolean): RepairAttempt["reason"] {
  if (hasCriticFindings && hasTestFailure) return "critic_and_test";
  if (hasTestFailure) return "test_failure";
  return "critic_finding";
}

export function summarizeRemainingIssues(
  report: EconomicCriticReport | null,
  compiled: boolean,
  scannersPassed: boolean,
  testsPassed: boolean
): string[] {
  const issues: string[] = [];
  if (!compiled) issues.push("compile failed");
  if (!scannersPassed) issues.push("deterministic safety scanners still blocking");
  if (!testsPassed) issues.push("integration tests still failing");
  for (const f of selectRepairFindings(report)) {
    issues.push(`critic: [${f.severity}] ${f.finding}`);
  }
  return issues;
}
