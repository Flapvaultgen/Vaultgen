/**
 * Self-check for the Flap constitution module (Rules 001–009).
 *
 * Proves: all 9 rules exist with prompt+fix guidance, the formatted prompt block
 * covers every rule without embedding vault templates/reference contracts, and
 * scanner finding names map to the expected Flap rule IDs.
 *
 * Run: npx tsx constitution-selfcheck.mts   (no network, no Foundry)
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLAP_RULE_IDS,
  getAllFlapRules,
  getFlapRule,
  getFlapRuleBySlug,
  formatConstitutionForPrompt,
  formatRuleFixGuidance,
  formatRuleLabel,
  groupFindingsByRule,
  mapScannerFindingToRuleId,
  flapRuleIdsForFindings,
  describeViolatedRules,
  type FlapRuleId,
} from "./constitution.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`OK ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. All 9 rule IDs exist with complete metadata ──────────────────────────
const rules = getAllFlapRules();
check("nine-rules-exist", rules.length === 9 && FLAP_RULE_IDS.length === 9);

for (const id of FLAP_RULE_IDS) {
  const r = getFlapRule(id);
  check(`rule-${id}-exists`, !!r && r.id === id);
  check(`rule-${id}-has-title-summary`, r.title.length > 0 && r.summary.length > 10);
  check(`rule-${id}-has-prompt-guidance`, r.promptGuidance.length > 0);
  check(`rule-${id}-has-fix-guidance`, r.fixGuidance.length > 0);
  check(`rule-${id}-slug`, r.slug.startsWith(`${id}-`));
  check(`rule-${id}-by-slug`, getFlapRuleBySlug(r.slug)?.id === id);
}

// Corpus files exist for every rule (bundled copy).
for (const r of rules) {
  const rel = r.corpusPath ?? "";
  if (!rel) {
    check(`rule-${r.id}-corpus-file`, false, "corpusPath not set");
    continue;
  }
  try {
    await access(path.join(SERVER_DIR, rel));
    check(`rule-${r.id}-corpus-file`, true);
  } catch {
    check(`rule-${r.id}-corpus-file`, false, `missing ${rel}`);
  }
}

// ── 2. Formatted constitution prompt covers all 9 rules ─────────────────────
const prompt = formatConstitutionForPrompt();
for (const id of FLAP_RULE_IDS) {
  check(`prompt-includes-rule-${id}`, prompt.includes(formatRuleLabel(id)));
}
// Scoped variant only includes the requested rules.
const scoped = formatConstitutionForPrompt(["005", "007"]);
check(
  "prompt-scoped-variant",
  scoped.includes(formatRuleLabel("005")) && scoped.includes(formatRuleLabel("007")) && !scoped.includes(formatRuleLabel("003"))
);

// ── 3. Prompt contains no reference contracts / templates ───────────────────
check("prompt-no-solidity-bodies", !/function\s+\w+\s*\([^)]*\)\s*(external|public|internal)\s*[({]/.test(prompt));
check("prompt-no-contract-decl", !/contract\s+\w+\s+is\s+\w+\s*\{/.test(prompt));
// No archetype vocabulary that tells the model to pick a fixed vault product:
const templateWords = [
  /choose (?:a |one of )?(?:staking|lottery|buyback|survivor|treasury)/i,
  /staking vault template/i,
  /lottery template/i,
  /\bjackpot\b/i,
  /\baccRewardPerShare\b/,
  /\bdrawSnapshot\b/,
  /\bexecuteBuyback\b/,
  /\bweeklyJackpot\b/,
  /vault kind/i,
  /staking_rewards|ai_lottery|survivor_elimination/,
];
for (const re of templateWords) {
  check(`prompt-no-template:${re.source.slice(0, 32)}`, !re.test(prompt), `matched ${re}`);
}

// ── 4. Scanner finding → rule ID mapping ────────────────────────────────────
// Expected attributions per the constitution's canonical lists (intentional
// improvements over the legacy spec-audit regex mapping are noted inline).
const expectedMappings: [string, FlapRuleId][] = [
  // Rule 005 — receive gas
  ["receive-no-external-call", "005"],
  ["receive-no-loop", "005"],
  ["receive-no-transfer", "005"],
  ["receive-reverts", "005"],
  ["receive-msg-sender", "005"],
  ["must-have-receive", "005"],
  // Rule 004 — UI friendly (schema integrity lives here)
  ["custom-error", "004"],
  ["require-not-bilingual", "004"],
  ["uischema-incomplete", "004"],
  ["schema-method-not-implemented", "004"],
  ["write-method-not-in-uischema", "004"],
  ["public-state-not-in-uischema", "004"],
  ["missing-time-until-view", "004"],
  // Rule 003 — fairness
  ["balance-based-payout", "003"],
  // Rule 007 — AI oracle (wording + snapshot/refund lifecycle attributed here)
  ["no-block-randomness", "007"],
  ["block-difficulty", "007"],
  ["ai-callback-no-auth", "007"],
  ["wrong-ai-address", "007"],
  ["draw-not-frozen", "007"],
  ["refund-doubles-balance", "007"],
  ["ai-lottery-push-payout", "007"],
  ["uint8-cast-uncapped", "007"],
  ["secure-random-overclaim", "007"],
  ["ai-random-wording", "007"],
  ["survivor-stale-snapshot-win", "007"],
  // Rule 008 — trigger service
  ["trigger-no-auth", "008"],
  ["wrong-trigger-address", "008"],
  // Rule 009 — emergency
  ["emergency-not-guardian", "009"],
  ["excess-only-emergency-override", "009"],
  ["staking-guardian-trust-undisclosed", "009"],
  // Rule 006 — tests
  ["integration-test-failure", "006"],
  ["integration-test-infra", "006"],
  // Rule 002 — factory/deployment compatibility
  ["must-extend-base", "002"],
  ["contract-name", "002"],
  // Rule 001 — vault rules / fund flow (default bucket)
  ["bucket-balance-desync", "001"],
  ["claim-mapping-never-credited", "001"],
  ["register-never-consumed", "001"],
  ["placeholder-code", "001"],
  ["stake-claim-double-harvest", "001"],
  ["lottery-no-entrant-cap", "001"],
  ["totally-unknown-scanner-rule", "001"],
];
for (const [name, expected] of expectedMappings) {
  const got = mapScannerFindingToRuleId(name);
  check(`map:${name}->${expected}`, got === expected, `got ${got}`);
}

// Every scannerRuleName is claimed by exactly one rule (no double attribution).
const seen = new Map<string, FlapRuleId>();
let duplicates = 0;
for (const r of rules) {
  for (const name of r.scannerRuleNames) {
    if (seen.has(name) && seen.get(name) !== r.id) {
      duplicates++;
      console.error(`  duplicate scanner rule "${name}" in ${seen.get(name)} and ${r.id}`);
    }
    seen.set(name, r.id);
  }
}
check("no-duplicate-scanner-rule-names", duplicates === 0);

// ── 5. Fix guidance formatting ───────────────────────────────────────────────
const fix = formatRuleFixGuidance(["005", "007", "005"]);
check("fix-guidance-includes-rules", fix.includes("Fix Rule 005") && fix.includes("Fix Rule 007"));
check("fix-guidance-dedupes", (fix.match(/Fix Rule 005/g) ?? []).length === 1);
check("fix-guidance-empty-input", formatRuleFixGuidance([]) === "");

// ── 6. Finding helpers ───────────────────────────────────────────────────────
const findings = [
  { rule: "receive-no-loop", detail: "a" },
  { rule: "custom-error", detail: "b" },
  { rule: "receive-reverts", detail: "c" },
];
const grouped = groupFindingsByRule(findings);
check(
  "grouping-by-rule",
  grouped.length === 2 &&
    grouped.find((g) => g.ruleId === "005")?.findings.length === 2 &&
    grouped.find((g) => g.ruleId === "004")?.findings.length === 1
);
check(
  "rule-ids-for-findings-sorted-unique",
  JSON.stringify(flapRuleIdsForFindings(findings)) === JSON.stringify(["004", "005"])
);
check("describe-violated-rules", describeViolatedRules(findings).every((s) => /^Rule 00[45] — /.test(s)));

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} constitution self-check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll constitution self-checks passed.");
