/**
 * Ledger solvency — deterministic money-flow extraction + the blocking rule it
 * makes provable, plus the critic's proof obligation.
 *
 * The fixture at the centre of this file is a vault that really was generated,
 * really passed every gate (compile, scanners, fork tests, spec audit, economic
 * critic) and was still insolvent by construction. Everything here exists so
 * that shape can never pass again, and so the rule that catches it cannot start
 * firing on the legitimate shapes that look superficially similar.
 *
 * Proves:
 *  1. The ledger table classifies buckets, per-user liabilities and counters,
 *     and does not mistake a reward index for a balance.
 *  2. Every write to every money variable is attributed to its function.
 *  3. Free-balance expressions are captured with the terms they subtract.
 *  4. The shipped-broken vault is BLOCKED, with a detail naming the function,
 *     the released counter and the stale availability math.
 *  5. Both accepted remedies scan clean.
 *  6. The index-based staking shape scans clean (no false positive).
 *  7. The rule is registered under Rule 001 with repair guidance.
 *  8. The critic prompt carries the ledger and the proof obligation, and the
 *     critic escalates to the stronger model only for pooled-BNB vaults.
 *
 * Run: npx tsx money-flow-selfcheck.mts   (no network, no forge, no fork)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMoneyFlowTable,
  scanLedgerSolvency,
  formatMoneyFlowTable,
  hasNontrivialLedger,
} from "./money-flow.js";
import {
  BROKEN_QUEST_PROOF_REWARD_VAULT,
  FIXED_BY_DEBITING_BUCKET,
  FIXED_BY_AGGREGATE_COUNTER,
  STAKING_INDEX_VAULT_CLEAN,
} from "./fixtures/quest-proof-reward-vault.js";
import { getFlapRule, mapScannerFindingToRuleId } from "./constitution.js";
import {
  buildEconomicCriticPrompt,
  buildSolvencyObligation,
  ledgerWarrantsStrongCritic,
  CRITIC_CHECKLIST,
} from "./economic-critic.js";
import { inferMechanicSpecFromPrompt } from "./mechanic-spec.js";
import { CODEGEN_SYSTEM_PROMPT } from "./codegen-prompts.js";

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

const RULE = "bucket-liability-not-tracked";

// ── 1-3. The table ───────────────────────────────────────────────────────────

const broken = buildMoneyFlowTable(BROKEN_QUEST_PROOF_REWARD_VAULT);
const role = (name: string) => broken.variables.find((v) => v.name === name)?.role;

check("rewardBucket is a bucket (credited by receive, spent on claim)", role("rewardBucket") === "bucket");
check("_claimableRewards is a per-user liability", role("_claimableRewards") === "liability");
check("totalReservedForQuests is a counter, not a bucket", role("totalReservedForQuests") === "counter");
check(
  "constants are not tracked as money",
  !broken.variables.some((v) => v.name === "MAX_SUBMITTERS_PER_QUEST")
);
check(
  "struct fields are not mistaken for state",
  !broken.variables.some((v) => ["rewardPerApproval", "maxApprovals", "approvalsCount", "deadline"].includes(v.name))
);

const stakingTable = buildMoneyFlowTable(STAKING_INDEX_VAULT_CLEAN);
check(
  "a reward index bumped in receive() is NOT labelled a bucket",
  stakingTable.variables.find((v) => v.name === "accRewardPerShare")?.role !== "bucket",
  `got ${stakingTable.variables.find((v) => v.name === "accRewardPerShare")?.role}`
);

const wrote = (fn: string, variable: string, kind: string) =>
  broken.writes.some((w) => w.fn === fn && w.variable === variable && w.kind === kind);
check("receive credits the bucket", wrote("receive", "rewardBucket", "credit"));
check("createQuest reserves budget", wrote("createQuest", "totalReservedForQuests", "credit"));
check("approveSubmission credits the liability", wrote("approveSubmission", "_claimableRewards", "credit"));
check("approveSubmission releases the reservation", wrote("approveSubmission", "totalReservedForQuests", "debit"));
check("claimReward zeroes the liability and debits the bucket",
  wrote("claimReward", "_claimableRewards", "zero") && wrote("claimReward", "rewardBucket", "debit"));
check(
  "a require(bucket >= x) comparison is not read as a write",
  !broken.writes.some((w) => w.variable === "rewardBucket" && w.kind === "assign")
);

const availability = broken.freeBalance.find((e) => e.fn === "createQuest" && e.subtracted.includes("totalReservedForQuests"));
check("createQuest's availability math is captured with its terms", Boolean(availability));
check("the captured math omits the liability", Boolean(availability) && !availability!.subtracted.includes("_claimableRewards"));

// ── 4-6. The rule ────────────────────────────────────────────────────────────

const brokenFindings = scanLedgerSolvency(broken);
const finding = brokenFindings.find((f) => f.rule === RULE);
check("the shipped-broken vault is blocked", finding?.level === "block", `findings: ${brokenFindings.length}`);
check("detail names the crediting function", Boolean(finding?.detail.includes("approveSubmission")));
check("detail names the released reservation counter", Boolean(finding?.detail.includes("totalReservedForQuests")));
check("detail names the stale availability expression", Boolean(finding?.detail.includes("rewardBucket - totalReservedForQuests")));
check(
  "detail offers both accepted remedies",
  Boolean(finding?.detail.includes("-= amount")) && Boolean(finding?.detail.toLowerCase().includes("aggregate"))
);

for (const [name, source] of [
  ["remedy (a) debit the bucket at credit time", FIXED_BY_DEBITING_BUCKET],
  ["remedy (b) aggregate owed, subtracted from availability", FIXED_BY_AGGREGATE_COUNTER],
  ["index-based staking vault (credits now, debits at claim)", STAKING_INDEX_VAULT_CLEAN],
] as const) {
  const found = scanLedgerSolvency(buildMoneyFlowTable(source));
  check(`clean: ${name}`, found.length === 0, found.map((f) => f.detail.slice(0, 120)).join(" / "));
}

// ── 6b. The real thing, verbatim ─────────────────────────────────────────────
// The fixtures above are trimmed for readability, which means a regex change
// could keep them passing while quietly losing the source they were derived
// from. This reads the actual generated child source off disk.

const realSource = await readFile(path.join(SERVER_DIR, "fixtures", "QuestProofRewardVault.broken.sol"), "utf8");
const realFindings = scanLedgerSolvency(buildMoneyFlowTable(realSource));
check(
  "the verbatim shipped contract is blocked",
  realFindings.some((f) => f.rule === RULE && f.level === "block"),
  `findings: ${realFindings.map((f) => f.rule).join(", ") || "none"}`
);
check(
  "its ledger survives 300 lines of comments and bilingual strings",
  (() => {
    const t = buildMoneyFlowTable(realSource);
    return (
      t.variables.find((v) => v.name === "rewardBucket")?.role === "bucket" &&
      t.variables.find((v) => v.name === "_claimableRewards")?.role === "liability" &&
      t.writes.some((w) => w.fn === "abandonApproval" && w.variable === "totalReservedForQuests" && w.kind === "credit")
    );
  })()
);

// ── 7. Registration ──────────────────────────────────────────────────────────

check("rule maps to Rule 001", mapScannerFindingToRuleId(RULE) === "001");
check("rule is listed on Rule 001", getFlapRule("001").scannerRuleNames.includes(RULE));
check(
  "Rule 001 carries bucket-solvency repair guidance",
  getFlapRule("001").fixGuidance.some((g) => /totalOwedToUsers|free-balance/i.test(g))
);

// ── 8. The critic ────────────────────────────────────────────────────────────

const obligation = buildSolvencyObligation(formatMoneyFlowTable(broken));
check("obligation includes the extracted ledger", obligation.includes("_claimableRewards[...] += reward"));
check("obligation demands the per-bucket identity", /sum\(all claims on the bucket\) <= bucket/.test(obligation));
check(
  "obligation rejects 'a claimable mapping exists' as sufficient",
  /NOT sufficient/.test(obligation) && /do the arithmetic/i.test(obligation)
);
check(
  "obligation calls out the release-at-approval shape",
  /releasing that reservation at the moment it\s*becomes owed/.test(obligation)
);

const spec = inferMechanicSpecFromPrompt("users submit quest proofs and approved users claim BNB rewards");
const withLedger = buildEconomicCriticPrompt("QuestProofRewardVault", spec, formatMoneyFlowTable(broken));
const withoutLedger = buildEconomicCriticPrompt("QuestProofRewardVault", spec);
check("prompt embeds the obligation when a ledger is supplied", withLedger.includes("PROOF OBLIGATION"));
check("prompt omits it when there is no ledger", !withoutLedger.includes("PROOF OBLIGATION"));
check("prompt requires the per-bucket solvency enumeration in its JSON", withLedger.includes('"solvency"'));
check(
  "an unsound bucket must produce a blocking finding",
  /unsound.*MUST have a matching "blocking" finding/s.test(withLedger)
);
check(
  "checklist covers free-balance omission",
  CRITIC_CHECKLIST.some((c) => /free\/available balance is computed without subtracting everything already owed/.test(c))
);

// ── 9. Taught up front, not only caught after the fact ───────────────────────
// A blocking rule costs a full rewrite pass every time it fires, so the codegen
// prompt has to teach the remedy before the model writes the contract.

check(
  "codegen prompt requires a bucket debit or a tracked aggregate at credit time",
  /WHAT A BUCKET ALREADY OWES MUST STAY VISIBLE/.test(CODEGEN_SYSTEM_PROMPT) &&
    /totalOwedToUsers \+= amount/.test(CODEGEN_SYSTEM_PROMPT)
);
check(
  "codegen prompt names the release-at-approval trap",
  /stops counting as reserved at the exact moment it starts being owed/.test(CODEGEN_SYSTEM_PROMPT)
);

check("pooled-BNB vault escalates the critic model", ledgerWarrantsStrongCritic(BROKEN_QUEST_PROOF_REWARD_VAULT));
check("nontrivial ledger requires both a bucket and a liability", hasNontrivialLedger(broken));
check(
  "a vault with no per-user liability does not escalate",
  !ledgerWarrantsStrongCritic(`contract BuybackVault is CodegenVaultBase {
    uint256 public buybackBucket;
    receive() external payable { buybackBucket += msg.value; }
    function executeBuyback(uint256 minOut) external onlyManager {
      uint256 amount = buybackBucket;
      buybackBucket = 0;
      _buyAndBurn(amount, minOut);
    }
  }`)
);

console.log(failures === 0 ? "\nAll money-flow selfchecks passed." : `\n${failures} money-flow selfcheck(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
