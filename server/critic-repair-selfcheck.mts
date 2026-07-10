/**
 * Cleanup pass — critic-driven auto-repair selfchecks (deterministic, no network).
 *
 * Proves:
 *  1. High/blocking critic findings trigger a repair attempt; clean/low-only
 *     reports and unreviewed reports do not.
 *  2. Medium findings join the repair context only when fund/lifecycle/UI
 *     relevant — and never trigger repair alone.
 *  3. The repair prompt carries finding names, severities, rule IDs,
 *     explanations, suggested fixes, MechanicSpec expectations, and test
 *     failure excerpts (test failures share ONE repair context).
 *  4. Bug-class guidance: pause-freezes-claims → remove pause guard from
 *     claim/withdraw; cancelled-resource-stuck-user → user-callable exit after
 *     closure; missing status view → expose lifecycle states + update schema.
 *  5. Repair attempts are capped (2 normal + 1 escalation only when
 *     AI_ESCALATION_MODEL is set).
 *  6. Model routing stays environment-driven — no expensive model literal in
 *     repair logic; escalation/cheap models resolve from env only.
 *  7. The critic remains advisory: deploy-gate and pipeline gating never
 *     consult critic findings directly; repair rollback keeps hard gates.
 *
 * Run: npx tsx critic-repair-selfcheck.mts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CRITIC_REPAIR_ATTEMPTS,
  buildCriticRepairPrompt,
  buildRepairGuidance,
  extractAffectedFunctions,
  repairReason,
  selectRepairFindings,
  shouldTriggerCriticRepair,
  summarizeRemainingIssues,
} from "./critic-repair.js";
import type { CriticFinding, EconomicCriticReport } from "./economic-critic.js";
import { DEFAULT_MODEL, resolveCheapModel, resolveEscalationModel, resolveAiModel } from "./ai-model.js";
import { inferMechanicSpecFromPrompt } from "./mechanic-spec.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`OK ${name}`);
  else {
    console.error(`FAIL ${name}`);
    failures++;
  }
}

function report(findings: CriticFinding[], reviewed = true): EconomicCriticReport {
  return { reviewed, model: "test-model", summary: "test", findings };
}

const pauseFinding: CriticFinding = {
  severity: "high",
  ruleIds: ["001", "009"],
  finding: "pause-freezes-approved-claims",
  explanation: "claimReward() has whenNotPaused, so the manager can pause and freeze already-reserved user funds.",
  suggestedRepair: "Remove whenNotPaused from claimReward(); keep it on submit/approve.",
};
const stuckFinding: CriticFinding = {
  severity: "blocking",
  ruleIds: ["001", "003"],
  finding: "cancelled-resource-traps-pending-user",
  explanation: "cancelQuest() closes the quest while submitProof() users have pending submissions with no exit path.",
  suggestedRepair: "Add a user-callable abandonSubmission() that works after cancellation.",
};
const statusFinding: CriticFinding = {
  severity: "medium",
  ruleIds: ["004"],
  finding: "missing-lifecycle-status-view",
  explanation: "Internal state tracks submitted/approved/claimed but getStatus() only returns a bool; vaultUISchema hides it.",
  suggestedRepair: "Expose an enum-like status view and update vaultUISchema.",
};
const lowFinding: CriticFinding = {
  severity: "low",
  ruleIds: [],
  finding: "cosmetic-description-wording",
  explanation: "description() wording could be clearer.",
  suggestedRepair: "Reword description().",
};
const irrelevantMedium: CriticFinding = {
  severity: "medium",
  ruleIds: [],
  finding: "verbose-event-naming",
  explanation: "Event names are verbose but harmless.",
  suggestedRepair: "Rename events.",
};

// ── 1. Trigger conditions ────────────────────────────────────────────────────
check("high finding triggers repair", shouldTriggerCriticRepair(report([pauseFinding])));
check("blocking finding triggers repair", shouldTriggerCriticRepair(report([stuckFinding])));
check("clean report does not trigger repair", !shouldTriggerCriticRepair(report([])));
check("low-only report does not trigger repair", !shouldTriggerCriticRepair(report([lowFinding])));
check("medium-only report does not trigger repair alone", !shouldTriggerCriticRepair(report([statusFinding])));
check("unreviewed report never triggers repair", !shouldTriggerCriticRepair(report([pauseFinding], false)));
check("null report never triggers repair", !shouldTriggerCriticRepair(null));

// ── 2. Finding selection ─────────────────────────────────────────────────────
const selected = selectRepairFindings(report([pauseFinding, stuckFinding, statusFinding, lowFinding, irrelevantMedium]));
check("selection keeps blocking + high findings", selected.includes(pauseFinding) && selected.includes(stuckFinding));
check("selection keeps fund/lifecycle/UI-relevant medium findings", selected.includes(statusFinding));
check("selection drops low findings", !selected.includes(lowFinding));
check("selection drops irrelevant medium findings", !selected.includes(irrelevantMedium));

// ── 3. Repair prompt content ─────────────────────────────────────────────────
const spec = inferMechanicSpecFromPrompt(
  "Quest vault: holders submit quest proof, manager approves each submission, approved users claim BNB from the reward bucket"
);
const prompt = buildCriticRepairPrompt({
  contractName: "QuestVault",
  findings: [pauseFinding, stuckFinding, statusFinding],
  mechanicSpec: spec,
  attempt: 1,
  escalated: false,
  testErrors: "[FAIL: testClaimAfterCancel] EvmError: Revert — quest not open",
  failingScenarioSummary: "- Fix failing scenario `user claims after cancellation` (actor: user).",
  compiled: true,
  scannersPassed: true,
  testsPassed: false,
});
check(
  "prompt includes finding names",
  prompt.includes("pause-freezes-approved-claims") && prompt.includes("cancelled-resource-traps-pending-user")
);
check("prompt includes severities", prompt.includes("[high]") && prompt.includes("[blocking]"));
check("prompt includes rule IDs", prompt.includes("001") && prompt.includes("009"));
check("prompt includes explanations", prompt.includes("whenNotPaused") && prompt.includes("pending submissions"));
check("prompt includes suggested fixes", prompt.includes("abandonSubmission"));
check("prompt includes test failure excerpt in the SAME context", prompt.includes("EvmError: Revert"));
check("prompt includes failing scenario summary", prompt.includes("user claims after cancellation"));
check("prompt includes MechanicSpec lifecycle/payout expectations", prompt.includes("payoutRules") && prompt.includes("lifecycle"));
check("prompt states current gate status", /compile PASS/.test(prompt) && /tests FAILING/.test(prompt));
check("prompt demands smallest safe patch", /SMALLEST SAFE PATCH/i.test(prompt));
check("prompt preserves launch gating language", /hard gates/i.test(prompt));
check(
  "prompt carries core preservation rules",
  ["receive() cheap", "bilingual require", "per-user accounting", "BEFORE native transfers", "vaultUISchema"].every((s) =>
    prompt.includes(s)
  )
);
check("prompt forbids templates/archetypes", /templates or archetypes/i.test(prompt));
check("affected functions extracted from explanations", extractAffectedFunctions([pauseFinding]).includes("claimReward"));

// ── 4. Bug-class guidance ────────────────────────────────────────────────────
const pauseGuidance = buildRepairGuidance([pauseFinding], "");
check(
  "pause-freezes-claims → guidance to remove pause guard from claim/withdraw",
  /remove the pause guard/i.test(pauseGuidance) && /claim\/withdraw/i.test(pauseGuidance)
);
check(
  "pause guidance keeps guard on submissions/approvals/manager actions",
  /submissions, approvals/i.test(pauseGuidance)
);
const stuckGuidance = buildRepairGuidance([stuckFinding], "");
check(
  "cancelled-resource-stuck-user → user-callable exit after cancellation/closure",
  /user-callable exit/i.test(stuckGuidance) && /AFTER cancellation\/closure/i.test(stuckGuidance)
);
check("stuck-user guidance forbids requiring Open status for exit", /not require the resource status to be Open/i.test(stuckGuidance));
check("stuck-user guidance forbids unbounded clear-all loops", /unbounded loop/i.test(stuckGuidance));
const statusGuidance = buildRepairGuidance([statusFinding], "");
check(
  "missing-status-view → expose lifecycle states and update schema",
  /enum-like status/i.test(statusGuidance) && /vaultUISchema/.test(statusGuidance)
);
check("no guidance sections for unrelated findings", buildRepairGuidance([lowFinding], "") === "");

// ── 5. Budget + reason bookkeeping ───────────────────────────────────────────
check("normal repair budget is exactly 2", MAX_CRITIC_REPAIR_ATTEMPTS === 2);
check("reason: critic only", repairReason(true, false) === "critic_finding");
check("reason: test only", repairReason(false, true) === "test_failure");
check("reason: combined", repairReason(true, true) === "critic_and_test");
const remaining = summarizeRemainingIssues(report([pauseFinding]), true, true, false);
check(
  "remaining issues list failing tests + critic findings",
  remaining.includes("integration tests still failing") && remaining.some((r) => r.includes("pause-freezes-approved-claims"))
);

// ── 6. Env-driven model routing ──────────────────────────────────────────────
check("default model resolves from env", resolveAiModel({ AI_MODEL: "custom-model" }) === "custom-model");
check("default model falls back to central default", resolveAiModel({}) === DEFAULT_MODEL);
check("escalation model is null when env missing (no escalation)", resolveEscalationModel({}) === null);
check(
  "escalation model resolves only from env",
  resolveEscalationModel({ AI_ESCALATION_MODEL: "expensive-model" }) === "expensive-model"
);
check("cheap model falls back to default model when unset", resolveCheapModel({ AI_MODEL: "base-x" }) === "base-x");
check("cheap model resolves from env when set", resolveCheapModel({ AI_CHEAP_MODEL: "tiny-x" }) === "tiny-x");

const criticRepairSource = await readFile(path.join(SERVER_DIR, "critic-repair.ts"), "utf8");
check(
  "critic-repair.ts contains no hardcoded model literal",
  !/["'`](gpt-\d|o\d-|claude|gemini)[^"'`]*["'`]/i.test(criticRepairSource)
);

const codegenSource = await readFile(path.join(SERVER_DIR, "codegen.ts"), "utf8");
check(
  "pipeline escalates only via resolveEscalationModel()",
  codegenSource.includes("resolveEscalationModel()") &&
    /escalated \? escalationModel! : model/.test(codegenSource)
);
check(
  "pipeline repair budget derives from MAX_CRITIC_REPAIR_ATTEMPTS",
  /MAX_CRITIC_REPAIR_ATTEMPTS \+ \(escalationModel \? 1 : 0\)/.test(codegenSource)
);
check(
  "repair triggers on serious critic findings via shouldTriggerCriticRepair",
  /shouldTriggerCriticRepair\(economicCritique\)/.test(codegenSource)
);
check(
  "failed repairs roll back to the last hard-gate-passing state",
  /rolled back to previous good code/.test(codegenSource)
);
check("repair reruns compile + scanners + tests + critic", /runIntegrationGate\(\)/.test(codegenSource) && /runEconomicCriticPass\(contractName, fullSource/.test(codegenSource));

// ── 7. Critic remains advisory for launch gating ─────────────────────────────
const deployGate = await readFile(path.join(SERVER_DIR, "..", "web", "src", "lib", "deploy-gate.ts"), "utf8");
check("web deploy-gate never consults economicCritique", !deployGate.includes("economicCritique"));
check("web deploy-gate never consults repairAttempts", !deployGate.includes("repairAttempts"));
check(
  "pipelineSuccess gating stays compile/safety/tests only",
  /return result\.compiled && result\.safety\.level !== "fail" && result\.integrationTestsPassed;/.test(codegenSource)
);
check(
  "autoFixExhausted logic does not consult the critic",
  !/autoFixExhausted[\s\S]{0,400}economicCritique/.test(codegenSource.slice(codegenSource.indexOf("autoFixExhausted:")))
);

if (failures > 0) {
  console.error(`\n${failures} critic-repair selfcheck failure(s).`);
  process.exit(1);
}
console.log("\nAll critic-repair selfchecks passed.");
