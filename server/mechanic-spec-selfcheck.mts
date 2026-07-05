/**
 * Self-check for the plan-first MechanicSpec (Phase 2).
 *
 * Proves: every prompt path creates a MechanicSpec (no keyword gate), rule
 * analysis is derived from mechanic structure (not VaultKind), the generation
 * message is spec-first (no "Vault kind:" framing), and VaultKind survives
 * only as transitional compatibility.
 *
 * Run: npx tsx mechanic-spec-selfcheck.mts   (no network, no Foundry)
 */

import {
  planMechanicSpec,
  inferMechanicSpecFromPrompt,
  deriveRuleAnalysis,
  deriveMechanicDesignFromSpec,
  formatMechanicSpecForPrompt,
  summarizeMechanicSpec,
  normalizeMechanicSpec,
  type MechanicSpec,
} from "./mechanic-spec.js";
import { buildGenerationUserMessage } from "./codegen.js";
import { buildVaultPlanPromptAppendix, inferVaultPlanFromPrompt } from "./vault-plan.js";
import { FLAP_RULE_IDS } from "./constitution.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`OK ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function specIsComplete(name: string, spec: MechanicSpec): void {
  check(`${name}:has-summary`, spec.productSummary.length > 10);
  check(`${name}:has-contract-name`, /^[A-Za-z][A-Za-z0-9]*$/.test(spec.contractName));
  check(`${name}:has-actors`, spec.actors.length > 0);
  check(`${name}:has-funds-in`, spec.fundsIn.length > 0);
  check(`${name}:has-buckets`, spec.buckets.length > 0);
  check(`${name}:has-ui-methods`, spec.uiMethods.length > 0);
  check(`${name}:has-test-scenarios`, spec.testScenarios.length > 0);
  check(`${name}:has-invariants`, spec.invariants.length > 0);
  check(
    `${name}:rule-analysis-covers-all-9`,
    FLAP_RULE_IDS.every((id) => spec.ruleAnalysis[id] && typeof spec.ruleAnalysis[id].applies === "boolean")
  );
  check(`${name}:rule-005-always-applies`, spec.ruleAnalysis["005"].applies === true);
  check(`${name}:rule-001-always-applies`, spec.ruleAnalysis["001"].applies === true);
}

// ── 1. Every prompt path creates a MechanicSpec (planner without API key
//       falls back deterministically — no keyword gate, no template requirement) ──
const classicStaking = await planMechanicSpec(
  "Holders stake tokens and earn a share of tax BNB proportional to their stake",
  undefined,
  "test-model"
);
specIsComplete("classic-staking", classicStaking);
check("classic-staking:no-template-needed", classicStaking.userActions.length > 0);
check("classic-staking:user-token-funds", classicStaking.fundsIn.some((f) => f.source === "user_token"));
check("classic-staking:payout-rule-003", classicStaking.ruleAnalysis["003"].applies === true);

// ── 2. Lottery-style prompt → Rule 007 analysis from structure ──────────────
const lottery = inferMechanicSpecFromPrompt(
  "Burn lottery: every deposit buys and burns, and one random burner wins a weekly jackpot"
);
specIsComplete("lottery", lottery);
check("lottery:oracle-actions-planned", lottery.oracleActions.length > 0);
check("lottery:rule-007-applies", lottery.ruleAnalysis["007"].applies === true);
check("lottery:rule-008-applies-weekly", lottery.ruleAnalysis["008"].applies === true);

// ── 3. Epoch/keeper prompt → Rule 008 analysis ───────────────────────────────
const epoch = inferMechanicSpecFromPrompt(
  "Every epoch the vault distributes the accumulated tax to registered participants via a keeper"
);
specIsComplete("epoch", epoch);
check("epoch:scheduled-actions-planned", epoch.scheduledActions.length > 0);
check("epoch:rule-008-applies", epoch.ruleAnalysis["008"].applies === true);

// ── 4. Novel prompt (no archetype) gets real lifecycle without keyword-gated
//       expandMechanicDesign ─────────────────────────────────────────────────
const charity = inferMechanicSpecFromPrompt(
  "Holders vote weekly on which charity wallet receives the treasury bucket"
);
specIsComplete("charity-vote", charity);
check("charity-vote:has-user-actions", charity.userActions.length > 0, JSON.stringify(charity.userActions.map((a) => a.name)));
check("charity-vote:has-vote-action", charity.userActions.some((a) => /vote/i.test(a.name)));
check("charity-vote:has-manager-actions", charity.managerActions.length > 0);
check("charity-vote:has-payout-rules", charity.payoutRules.length > 0);
check("charity-vote:rule-003-applies", charity.ruleAnalysis["003"].applies === true);
check("charity-vote:rule-008-applies-weekly", charity.ruleAnalysis["008"].applies === true);
// No oracle in this mechanic — 007 must NOT be forced on.
check("charity-vote:rule-007-not-applied", charity.ruleAnalysis["007"].applies === false);

// ── 5. Rule analysis is derived from structure, not vault kind ───────────────
const bare = deriveRuleAnalysis({ payoutRules: [], oracleActions: [], scheduledActions: [] });
check("bare:003-off", bare["003"].applies === false);
check("bare:007-off", bare["007"].applies === false);
check("bare:008-off", bare["008"].applies === false);
for (const id of ["001", "002", "004", "005", "006", "009"] as const) {
  check(`bare:${id}-always-on`, bare[id].applies === true);
}
const withOracle = deriveRuleAnalysis({
  payoutRules: [{ trigger: "settle", source: "pool", recipients: "users", mode: "pull" }],
  oracleActions: [{ request: "r", callback: "c", refundPath: "f" }],
  scheduledActions: [{ action: "settle", interval: "weekly", via: "trigger_service" }],
});
check("structure:003-on", withOracle["003"].applies === true);
check("structure:007-on", withOracle["007"].applies === true);
check("structure:008-on", withOracle["008"].applies === true);

// ── 6. Generation message is spec-first, never kind-first ────────────────────
const genMessage = buildGenerationUserMessage(
  "Holders stake tokens and earn a share of tax BNB",
  classicStaking
);
check("gen-message:no-vault-kind", !genMessage.includes("Vault kind:"), "generation message still says 'Vault kind:'");
check("gen-message:no-commit-vaultplan", !genMessage.includes("Commit to the VaultPlan invariants"));
check("gen-message:mentions-mechanic-spec", genMessage.includes("MechanicSpec"));
check("gen-message:mentions-constitution", genMessage.includes("Rules 001–009"));
check("gen-message:preserve-mechanic", /preserve/i.test(genMessage) && /do not silently approximate/i.test(genMessage));
check("gen-message:follows-rule-analysis", genMessage.includes("ruleAnalysis") && genMessage.includes("testScenarios"));
check("gen-message:contains-spec-json", genMessage.includes(JSON.stringify(classicStaking, null, 2)));

const specBlock = formatMechanicSpecForPrompt(charity);
check("spec-block:lists-applicable-rules", /Applicable Flap rules/.test(specBlock) && specBlock.includes("Rule 003"));

// ── 7. VaultKind survives only as transitional compatibility ─────────────────
const plan = inferVaultPlanFromPrompt("Holders stake tokens and earn tax BNB");
const appendix = buildVaultPlanPromptAppendix(plan);
check("appendix:framed-transitional", appendix.includes("TRANSITIONAL COMPATIBILITY HINTS"));
check("appendix:spec-authoritative", /MechanicSpec[\s\S]*authoritative/.test(appendix));
check("appendix:no-kind-mandate", !appendix.includes("mandatory — you are generating kind"));
check("appendix:no-vault-kind-order", !appendix.includes("Vault kind:"));

// ── 8. MechanicDesign compatibility derivation (no keyword gate) ─────────────
const design = deriveMechanicDesignFromSpec(charity);
check("design:user-actions-carried", design.userActions.includes(charity.userActions[0]!.name));
check("design:credit-paths-from-payouts", design.creditPaths.length > 0);
// Scanner stability: planner-invented names must not become blocking schema requirements yet.
check("design:no-required-schema-methods", design.requiredSchemaMethods.length === 0);
const pureSpec = inferMechanicSpecFromPrompt("Accumulate all tax into a treasury the manager can withdraw");
const pureDesign = deriveMechanicDesignFromSpec(pureSpec);
check("design:pure-accounting-mode", pureDesign.mode === "pure_accounting" || pureDesign.mode === "manager_only");

// ── 9. Normalization: partial/garbage LLM output falls back safely ────────────
const fallback = inferMechanicSpecFromPrompt("test mechanic");
check("normalize:garbage-returns-fallback", normalizeMechanicSpec(null, fallback) === fallback);
const partial = normalizeMechanicSpec(
  {
    productSummary: "A quest vault where users complete quests for BNB bounties",
    contractName: "quest vault!!",
    userActions: [{ name: "submitQuestProof", caller: "holder" }],
    oracleActions: [],
    payoutRules: [{ trigger: "approveQuest", source: "bountyPool", recipients: "quest completers", mode: "pull" }],
    ruleAnalysis: { "007": { applies: true, strategy: "should not be forced off" } },
  },
  fallback
);
check("normalize:free-form-action-name", partial.userActions.some((a) => a.name === "submitQuestProof"));
check("normalize:contract-name-sanitized", /^[A-Za-z][A-Za-z0-9]*$/.test(partial.contractName));
check("normalize:payout-implies-003", partial.ruleAnalysis["003"].applies === true);
check("normalize:llm-may-add-rules", partial.ruleAnalysis["007"].applies === true);
check("normalize:always-rules-kept", partial.ruleAnalysis["005"].applies === true);

// ── 10. Summary helper for failure memory ────────────────────────────────────
const summary = summarizeMechanicSpec(charity);
check("summary:has-actions-and-rules", summary.userActions.length > 0 && summary.applicableRules.includes("Rule 003"));

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} mechanic-spec self-check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll mechanic-spec self-checks passed.");
