/**
 * Self-check for the generic, spec-first codegen prompt (Phase 3).
 *
 * Proves: the rendered generation prompt is MechanicSpec-first and
 * constitution-driven, contains NO vault-archetype reference implementations,
 * no kind-to-shape guidance, and no hardcoded reference vocabulary — except
 * inside the clearly-marked transitional VaultPlan compatibility appendix,
 * which is not part of the main generation instructions.
 *
 * Run: npx tsx codegen-prompt-selfcheck.mts   (no network, no Foundry)
 */

import {
  CODEGEN_SYSTEM_PROMPT,
  STREAM_SYSTEM_PROMPT,
  REFINE_STREAM_SYSTEM_PROMPT,
  buildGenerationUserMessage,
} from "./codegen.js";
import { inferMechanicSpecFromPrompt } from "./mechanic-spec.js";
import { buildVaultPlanPromptAppendix, inferVaultPlanFromPrompt } from "./vault-plan.js";
import { formatConstitutionForPrompt, FLAP_RULE_IDS, formatRuleLabel } from "./constitution.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`OK ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const basePrompts: [string, string][] = [
  ["codegen-system", CODEGEN_SYSTEM_PROMPT],
  ["stream-system", STREAM_SYSTEM_PROMPT],
  ["refine-system", REFINE_STREAM_SYSTEM_PROMPT],
];

// Hardcoded reference vocabulary from the removed archetype implementations.
const BANNED_VOCABULARY: [string, RegExp][] = [
  ["jackpot", /jackpot/i],
  ["drawSnapshot", /drawSnapshot/],
  ["accRewardPerShare", /accRewardPerShare/],
  ["weeklyJackpot", /weeklyJackpot/i],
  ["MAX_ENTRANTS", /MAX_ENTRANTS/],
  ["executeBuyback", /executeBuyback/],
  ["requestDraw", /requestDraw/],
  ["requestElimination", /requestElimination/],
  ["survivor", /survivor/i],
  ["lottery", /lottery/i],
  ["raffle", /raffle/i],
  ["entrants", /entrants/],
  ["hasEntered", /hasEntered/],
  ["claimablePrize", /claimablePrize/],
  ["lastDrawTime", /lastDrawTime/],
  ["lastDrawFee", /lastDrawFee/],
];

// Language that would make the model pick a vault archetype instead of the spec.
const BANNED_INSTRUCTIONS: [string, RegExp][] = [
  ["vault-kind-framing", /Vault kind:/],
  ["vaultplan-commitment", /Commit to the VaultPlan invariants/],
  ["kind-to-shape-staking", /staking\s*->/i],
  ["kind-to-shape-lottery", /lottery\/raffle\s*->/i],
  ["kind-to-shape-buyback", /buyback\s*->/i],
  ["choose-archetype", /choose (?:from )?(?:a )?(?:staking|lottery|buyback|survivor|treasury|hybrid)/i],
  ["implement-this-kind", /implement this kind/i],
];

// Markers of the removed full Solidity reference implementations. Small
// interface facts (override signatures, 3-line countdown view) are allowed;
// full mechanic bodies are not.
const REFERENCE_IMPLEMENTATION_MARKERS: [string, RegExp][] = [
  ["full-draw-flow", /pendingRequestId\s*=\s*p\.reason\{value: fee\}/],
  ["full-winner-payout", /uint256 prize = /],
  ["full-elimination-flow", /address eliminated = /],
  ["full-staking-accrual", /rewardDebt/],
  ["undistributed-roll", /undistributedRewards/],
  ["reference-user-info", /struct UserInfo/],
];

// ── 1. Base system prompts: spec-first + constitution-driven ────────────────
for (const [name, prompt] of basePrompts) {
  check(`${name}:mechanic-spec-framing`, prompt.includes("MechanicSpec") && /AUTHORITATIVE/i.test(prompt));
  check(`${name}:no-template-menu`, /NO menu of vault types/.test(prompt));
  check(`${name}:preserve-mechanic`, /Preserve the user's mechanic/.test(prompt));
  check(`${name}:constitution-block`, prompt.includes("FLAP CONSTITUTION"));
  check(
    `${name}:all-9-rules-present`,
    FLAP_RULE_IDS.every((id) => prompt.includes(formatRuleLabel(id))),
    FLAP_RULE_IDS.filter((id) => !prompt.includes(formatRuleLabel(id))).join(",")
  );
  check(`${name}:constitution-not-duplicated`, prompt.includes(formatConstitutionForPrompt()));

  for (const [word, re] of BANNED_VOCABULARY) {
    check(`${name}:no-vocab-${word}`, !re.test(prompt));
  }
  for (const [label, re] of BANNED_INSTRUCTIONS) {
    check(`${name}:no-instruction-${label}`, !re.test(prompt));
  }
  for (const [label, re] of REFERENCE_IMPLEMENTATION_MARKERS) {
    check(`${name}:no-reference-impl-${label}`, !re.test(prompt));
  }
}

// ── 2. Conditional guidance is present (generic, spec-keyed) ────────────────
const p = CODEGEN_SYSTEM_PROMPT;
check("conditional:deposit-guidance", /IF USERS DEPOSIT OR COMMIT TOKENS/.test(p));
check("conditional:payout-guidance", /IF THE MECHANIC HAS PAYOUTS TO USERS/.test(p));
check("conditional:participant-guidance", /IF PARTICIPANTS JOIN A SET/.test(p));
check("conditional:oracle-guidance", /IF THE MECHANIC HAS RANDOM OR AI-DECIDED OUTCOMES/.test(p));
check("conditional:scheduled-guidance", /IF THE MECHANIC HAS SCHEDULED OR AUTOMATED ACTIONS/.test(p));
check("conditional:interval-guidance", /IF THE MECHANIC IS INTERVAL-GATED/.test(p));
check("conditional:no-extra-machinery", /Mechanics with none of the above/.test(p));
// Oracle interface facts must survive (needed to compile), framed generically.
check("oracle:override-signatures-present", /_fulfillReasoning\(uint256 requestId, uint8 choice\) internal override/.test(p));
check("oracle:refund-signature-present", /_onFlapAIRequestRefunded\(uint256 requestId\) internal override/.test(p));
check("trigger:receiver-signature-present", /trigger\(uint256 requestId\) external override nonReentrant/.test(p));

// ── 3. Neutral schema guidance ───────────────────────────────────────────────
check("schema:neutral-example-flagged", /shape template, NOT a product suggestion/.test(p));
check("schema:names-from-spec", /method names from the MechanicSpec/.test(p) || /REAL view\/write method names from the MechanicSpec/.test(p));
check("schema:every-write-in-schema", /Every external user write MUST appear in vaultUISchema\.methods/.test(p));
check("schema:bilingual-requires", /unicode"English \/ 中文"/.test(p));

// ── 4. Transitional appendix: kind vocabulary allowed ONLY there ────────────
const plan = inferVaultPlanFromPrompt("Weekly lottery: holders enter and a random winner takes the jackpot");
const appendix = buildVaultPlanPromptAppendix(plan);
const rendered = CODEGEN_SYSTEM_PROMPT + appendix;
const marker = rendered.indexOf("TRANSITIONAL COMPATIBILITY HINTS");
check("appendix:transitional-marker-present", marker >= 0);
for (const [word, re] of BANNED_VOCABULARY) {
  const m = re.exec(rendered);
  check(
    `rendered:vocab-${word}-only-in-transitional-block`,
    m === null || m.index > marker,
    m ? `found at ${m.index}, marker at ${marker}` : ""
  );
}
check("rendered:no-vault-kind-order", !rendered.includes("Vault kind:"));

// ── 5. Message assembly: classic and novel prompts ──────────────────────────
const classicPrompt = "Holders stake tokens and earn a share of tax BNB proportional to their stake";
const novelPrompt = "A quest vault where users submit quest proofs and approved quests earn BNB bounties";
for (const [name, userPrompt] of [
  ["classic", classicPrompt],
  ["novel", novelPrompt],
] as const) {
  const spec = inferMechanicSpecFromPrompt(userPrompt);
  const msg = buildGenerationUserMessage(userPrompt, spec);
  check(`${name}-message:contains-user-prompt`, msg.includes(userPrompt));
  check(`${name}-message:contains-spec-json`, msg.includes(JSON.stringify(spec, null, 2)));
  check(`${name}-message:spec-authoritative`, /authoritative/i.test(msg));
  check(`${name}-message:no-silent-approximation`, /do not silently approximate/i.test(msg));
  check(`${name}-message:follows-rule-analysis`, msg.includes("ruleAnalysis") && msg.includes("testScenarios"));
  check(`${name}-message:schema-from-ui-methods`, msg.includes("uiMethods"));
  check(`${name}-message:no-vault-kind`, !msg.includes("Vault kind:"));
  check(`${name}-message:no-vaultplan-commitment`, !msg.includes("Commit to the VaultPlan invariants"));
}

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} codegen-prompt self-check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll codegen-prompt self-checks passed.");
