/**
 * Phase 5 test-gen self-check: prove Foundry test generation is
 * MechanicSpec-derived and Rules 001–009 driven, never VaultKind-derived.
 *
 * Proves:
 *  1. The rendered test-generation prompt includes the MechanicSpec and
 *     Rules 001–009 framing, and never says "Vault kind:" or "kindHint".
 *  2. `invariantPromptForKind` / `mechanicInvariantTests` are gone from the
 *     test-gen source, along with VaultKind/VaultPlan imports.
 *  3. Classic staking-like prompts get journeys from SPEC ACTIONS (stake /
 *     claimPayout), not from a staking template.
 *  4. Lottery-like prompts get oracle tests because oracleActions / Rule 007
 *     require them — not because a kind is "lottery".
 *  5. Vote-allocation, quest, referral, and scheduled specs each get
 *     scenario coverage for their free-form action names.
 *  6. Universal Flap smoke journeys are always present.
 *  7. Every journey's rule metadata maps to Rules 001–009.
 *  8. buildSimulationReport normalizes forge output into the structured
 *     scenario report (pass/fail/skipped + rule attribution).
 *
 * Run: npx tsx test-gen-selfcheck.mts   (no network, no forge, no fork)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  synthesizeTestJourneys,
  buildIntegrationTestPrompt,
  fallbackTestSource,
  extractWriteMethods,
  buildSimulationReport,
  type TestJourney,
} from "./test-gen.ts";
import { inferMechanicSpecFromPrompt, deriveRuleAnalysis, type MechanicSpec } from "./mechanic-spec.ts";
import { FLAP_RULE_IDS } from "./constitution.ts";

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

const hasScenario = (journeys: TestJourney[], re: RegExp): boolean =>
  journeys.some((j) => re.test(j.scenario) || j.methods.some((m) => re.test(m)));

/** Build a planner-shaped spec with free-form action names (simulates LLM planner output). */
function specWithActions(
  summary: string,
  userActions: { name: string; caller?: "holder" | "manager" | "keeper" | "oracle" }[],
  managerActions: { name: string }[],
  opts: Partial<Pick<MechanicSpec, "scheduledActions" | "oracleActions" | "payoutRules" | "buckets" | "viewMethods">> = {}
): MechanicSpec {
  const base = inferMechanicSpecFromPrompt(summary);
  const spec: MechanicSpec = {
    ...base,
    productSummary: summary,
    userActions: userActions.map((a) => ({
      name: a.name,
      caller: a.caller ?? "holder",
      description: `${a.name} action`,
      preconditions: [],
      effects: [`${a.name} state updated`],
      schemaExposed: true,
      events: [],
    })),
    managerActions: managerActions.map((a) => ({
      name: a.name,
      caller: "manager",
      description: `${a.name} action`,
      preconditions: [],
      effects: [`${a.name} applied`],
      schemaExposed: true,
      events: [],
    })),
    scheduledActions: opts.scheduledActions ?? [],
    oracleActions: opts.oracleActions ?? [],
    payoutRules: opts.payoutRules ?? [],
    buckets: opts.buckets ?? base.buckets,
    viewMethods: opts.viewMethods ?? base.viewMethods,
  };
  spec.ruleAnalysis = deriveRuleAnalysis(spec);
  return spec;
}

// ── 1. Prompt content: MechanicSpec-first, Rules-framed, kind-free ──────────
const stakingSpec = inferMechanicSpecFromPrompt(
  "holders stake the token and earn BNB dividends from trading tax, claimable weekly"
);
const stakingJourneys = synthesizeTestJourneys(stakingSpec, "", "StakeDividends");
const stakingPrompt = buildIntegrationTestPrompt("StakeDividends", stakingSpec, stakingJourneys, ["stake", "claimPayout"]);

check("prompt includes MechanicSpec block", /MECHANIC SPEC/.test(stakingPrompt) && stakingPrompt.includes(stakingSpec.productSummary.slice(0, 60)));
check(
  "prompt includes Rules 001–009 framing",
  /Implement Foundry tests for this MechanicSpec under Flap Rules 001–009/.test(stakingPrompt) &&
    /Rule/.test(stakingPrompt)
);
check("prompt never says 'Vault kind:'", !/Vault kind:/i.test(stakingPrompt));
check("prompt never says 'kindHint'", !/kindHint/.test(stakingPrompt));
check(
  "prompt forbids fixed vault categories",
  /there are no fixed vault kinds/i.test(stakingPrompt)
);
check(
  "prompt does not request per-kind archetype tests",
  !/staking-specific|lottery-specific|survivor|per vault kind/i.test(stakingPrompt)
);

// ── 2. Static source: kind machinery removed from test-gen.ts ────────────────
const testGenSource = (await readFile(path.join(SERVER_DIR, "test-gen.ts"), "utf8"))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check("invariantPromptForKind removed", !/invariantPromptForKind/.test(testGenSource));
check("mechanicInvariantTests removed", !/mechanicInvariantTests/.test(testGenSource));
check("no VaultKind/VaultPlan import in test-gen", !/from "\.\/vault-plan\.js"/.test(testGenSource) && !/VaultKind|VaultPlan/.test(testGenSource));
check("no 'Vault kind:' literal in test-gen", !/Vault kind:/.test(testGenSource));
check("no treasury fallback kind in test-gen", !/"treasury"/.test(testGenSource));

// ── 3. Classic staking-like prompt → journeys from spec actions ──────────────
check(
  "staking spec: journeys cover the stake action",
  hasScenario(stakingJourneys, /\bstake\b/i),
  JSON.stringify(stakingJourneys.map((j) => j.scenario))
);
check("staking spec: journeys cover the claim action", hasScenario(stakingJourneys, /claimPayout/i));
check(
  "staking journeys are action-derived, not template-derived",
  !stakingJourneys.some((j) => /staking lifecycle|staking template/i.test(j.scenario))
);

// ── 4. Lottery-like prompt → oracle tests from oracleActions / Rule 007 ─────
const lotterySpec = inferMechanicSpecFromPrompt("weekly lottery: holders enter, a random winner takes the jackpot");
check("lottery spec has oracleActions (structure, not kind)", lotterySpec.oracleActions.length > 0);
check("lottery spec ruleAnalysis marks Rule 007", lotterySpec.ruleAnalysis["007"].applies);
const lotteryJourneys = synthesizeTestJourneys(lotterySpec, "", "WeeklyJackpot");
const oracleJourneys = lotteryJourneys.filter((j) => j.ruleIds.includes("007"));
check("lottery journeys include oracle lifecycle test", hasScenario(lotteryJourneys, /oracle request\/callback lifecycle/i));
check("lottery journeys include callback authorization test", hasScenario(lotteryJourneys, /callback rejects unauthorized/i));
check("lottery journeys include no-block-entropy test", hasScenario(lotteryJourneys, /no block entropy/i));
check("lottery journeys hide oracle callback from UI schema", hasScenario(lotteryJourneys, /not exposed as user UI/i));
check("oracle journeys carry Rule 007 metadata", oracleJourneys.length >= 3);

// Control: a spec WITHOUT oracleActions gets no oracle lifecycle tests.
const noOracleSpec = specWithActions("simple treasury accumulator", [], [{ name: "withdrawTreasury" }]);
const noOracleJourneys = synthesizeTestJourneys(noOracleSpec, "", "PlainVault");
check(
  "oracle tests come from oracleActions, not keywords/kind",
  !hasScenario(noOracleJourneys, /oracle request\/callback lifecycle/i)
);

// ── 5. Novel mechanics: vote / quest / referral / scheduled ─────────────────
const voteSpec = specWithActions(
  "holders vote weekly on which charity receives the donation pool",
  [{ name: "voteForCharity" }],
  [{ name: "settleVotingRound" }],
  { scheduledActions: [{ action: "settleVotingRound", interval: "weekly", via: "manager" }] }
);
const voteJourneys = synthesizeTestJourneys(voteSpec, "", "CharityVote");
check("vote spec: vote action journey", hasScenario(voteJourneys, /voteForCharity/));
check("vote spec: settle action journey", hasScenario(voteJourneys, /settleVotingRound/));

const questSpec = specWithActions(
  "holders submit quest proofs and redeem rewards once verified",
  [{ name: "submitQuestProof" }, { name: "redeemQuestReward" }],
  [{ name: "verifyQuestBatch" }],
  {
    payoutRules: [
      {
        trigger: "verifyQuestBatch",
        source: "rewardBucket",
        recipients: "multiple approved users",
        mode: "pull",
        distributionMode: "manager_assigned_amount",
        liabilityModel: "reserved_on_approval",
        eligibilitySource: "manager approval of a submitted quest proof",
        claimAmountSource: "claimableRewards[user] mapping",
        winnerTakesAll: false,
        perUserAccountingRequired: true,
      },
    ],
  }
);
const questJourneys = synthesizeTestJourneys(questSpec, "", "QuestVault");
check("quest spec: submitQuestProof journey", hasScenario(questJourneys, /submitQuestProof/));
check("quest spec: redeemQuestReward journey", hasScenario(questJourneys, /redeemQuestReward/));
check(
  "quest journeys include invalid-caller/input revert coverage",
  voteJourneys.concat(questJourneys).some((j) => j.expectKind === "revert" && /rejects invalid/i.test(j.scenario))
);

// ── Phase 7: adversarial multi-user journeys for per-user-accounting payouts ─
check(
  "quest journeys include a two-user (Alice/Bob) eligibility journey",
  hasScenario(questJourneys, /Alice and Bob/i)
);
check(
  "quest journeys assert claims pay only the caller's own amount, never the whole bucket",
  questJourneys.some((j) => /pays only the caller's own reserved\/credited amount/i.test(j.scenario))
);
check(
  "quest journeys assert Bob cannot claim Alice's reward and no double-claim",
  questJourneys.some((j) => /Bob cannot claim Alice's reward/i.test(j.scenario))
);
check(
  "quest journeys assert approval reserves/credits a per-user amount",
  questJourneys.some((j) => /reserves or credits a per-user amount/i.test(j.scenario))
);
check(
  "quest journeys check submission/approval linkage or off-chain disclosure",
  questJourneys.some((j) => /off-chain review is disclosed/i.test(j.scenario))
);

// Winner-takes-all payouts must NOT get the adversarial multi-user journeys —
// two-user fairness is meaningless for a genuine single-winner mechanic.
const winnerTakesAllSpec = specWithActions(
  "an oracle selects a single winner who takes the entire prize pool",
  [],
  [{ name: "requestOutcome" }],
  {
    payoutRules: [
      {
        trigger: "requestOutcome",
        source: "prizePool",
        recipients: "a single selected winner",
        mode: "pull",
        distributionMode: "winner_takes_all",
        liabilityModel: "single_winner_pool",
        eligibilitySource: "oracle-selected winner from the frozen snapshot",
        claimAmountSource: "the entire prizePool paid once to the winner",
        winnerTakesAll: true,
        perUserAccountingRequired: false,
      },
    ],
  }
);
const winnerTakesAllJourneys = synthesizeTestJourneys(winnerTakesAllSpec, "", "DrawVault");
check(
  "winner-takes-all payout gets no two-user fairness journey",
  !hasScenario(winnerTakesAllJourneys, /Alice and Bob/i)
);

const referralSpec = specWithActions(
  "holders register a referrer; referral rewards are settled from the tax pool",
  [{ name: "setMyReferrer" }],
  [{ name: "settleReferralRewards" }]
);
const referralJourneys = synthesizeTestJourneys(referralSpec, "", "ReferralVault");
check("referral spec: setMyReferrer journey", hasScenario(referralJourneys, /setMyReferrer/));
check("referral spec: settleReferralRewards journey", hasScenario(referralJourneys, /settleReferralRewards/));

const scheduledSpec = specWithActions(
  "every day the vault buys and burns tokens automatically",
  [],
  [{ name: "executeDailyBurn" }],
  {
    scheduledActions: [{ action: "executeDailyBurn", interval: "daily", via: "trigger_service" }],
    viewMethods: ["timeUntilNextExecution"],
  }
);
const scheduledJourneys = synthesizeTestJourneys(scheduledSpec, "", "DailyBurn");
check("scheduled spec: too-early execution journey", hasScenario(scheduledJourneys, /too-early executeDailyBurn/i));
check("scheduled spec: eligible execution journey", hasScenario(scheduledJourneys, /eligible executeDailyBurn/i));
check("scheduled spec: countdown view journey", hasScenario(scheduledJourneys, /timeUntilNextExecution/));
check(
  "scheduled journeys carry Rule 008 metadata",
  scheduledJourneys.some((j) => j.ruleIds.includes("008"))
);

// ── 6. Universal Flap smoke is always present (even with no spec) ────────────
for (const [label, journeys] of [
  ["staking", stakingJourneys],
  ["lottery", lotteryJourneys],
  ["no-spec", synthesizeTestJourneys(undefined, "", "BareVault")],
] as const) {
  check(`${label}: factory deploy smoke journey`, hasScenario(journeys, /factory deploys vault/i));
  check(`${label}: tax dispatch receive smoke journey`, hasScenario(journeys, /tax BNB dispatch reaches receive/i));
  check(`${label}: vaultUISchema existence journey`, hasScenario(journeys, /vaultUISchema\(\) methods exist/i));
  check(`${label}: permission boundary journey`, hasScenario(journeys, /manager-gated actions revert/i));
}

// ── 7. All journey rule metadata maps to Rules 001–009 ──────────────────────
const allJourneys = [...stakingJourneys, ...lotteryJourneys, ...voteJourneys, ...questJourneys, ...referralJourneys, ...scheduledJourneys];
const validRules = new Set<string>(FLAP_RULE_IDS);
check(
  "every journey ruleId maps to Rules 001–009",
  allJourneys.every((j) => j.ruleIds.length > 0 && j.ruleIds.every((id) => validRules.has(id))),
  JSON.stringify([...new Set(allJourneys.flatMap((j) => j.ruleIds))])
);

// ── Spec ↔ source drift becomes a journey (tests catch, never adapt) ────────
const questSource = `contract QuestVault {
    function submitQuestProof(bytes32 proof) external {}
    function surpriseAdminSweep() external {}
}`;
check("extractWriteMethods finds actual source methods", extractWriteMethods(questSource).includes("surpriseAdminSweep"));
const driftJourneys = synthesizeTestJourneys(questSpec, questSource, "QuestVault");
check("missing planned action becomes a failing-journey", hasScenario(driftJourneys, /redeemQuestReward is missing from the generated source/i));
check("unplanned source method becomes a schema/smoke journey", hasScenario(driftJourneys, /beyond the spec/i));

// ── Fallback test file: kind-free, journey-documented, universal smoke ───────
const fallback = fallbackTestSource("QuestVault", extractWriteMethods(questSource), driftJourneys.slice(0, 10));
check("fallback keeps factory deploy smoke test", /test_QuestVault_factoryDeploysVault/.test(fallback));
check("fallback keeps buy+dispatch smoke test", /test_QuestVault_buyAndDispatch/.test(fallback));
check("fallback documents journeys with Rule IDs", /Scenario: .*\(Rules 00\d/.test(fallback));
check("fallback has no vault-kind labeling", !/Vault kind|staking_rewards|ai_lottery|survivor_elimination|\(treasury\)/i.test(fallback));

// ── 8. Simulation report normalization ───────────────────────────────────────
const forgeOut = `
Ran 3 tests for test/_codegen/QuestVault.mainnet.t.sol:QuestVaultMainnetTest
[PASS] test_QuestVault_factoryDeploysVault() (gas: 123)
[FAIL: revert: Not authorized / 无权限] test_QuestVault_journey1_holder_can_submitQuestProof() (gas: 456)
[PASS] test_QuestVault_buyAndDispatch() (gas: 789)
Suite result: FAILED. 2 passed; 1 failed;
`;
const report = buildSimulationReport("QuestVault", "test/_codegen/QuestVault.mainnet.t.sol", forgeOut, driftJourneys, { ok: false });
check("report parses pass/fail per scenario", report.scenarios.filter((s) => s.status === "pass").length === 2 && report.scenarios.filter((s) => s.status === "fail").length === 1);
check("report is spec-attributed", report.generatedFrom === "mechanic-spec");
const failScenario = report.scenarios.find((s) => s.status === "fail")!;
check("failing scenario maps back to the journey", /submitQuestProof/i.test(failScenario.scenario) || /submitQuestProof/i.test(failScenario.notes));
check("failing scenario blocks launch + has failure summary", failScenario.blocksLaunch && failScenario.failureSummary.length > 0);
check(
  "report rule metadata maps to Rules 001–009",
  report.scenarios.every((s) => s.ruleIds.every((id) => validRules.has(id)))
);
const skippedReport = buildSimulationReport("QuestVault", "t.sol", "", driftJourneys, { ok: true, skipped: true });
check("skipped run marks planned journeys as skipped", skippedReport.skipped && skippedReport.scenarios.every((s) => s.status === "skipped" && !s.blocksLaunch));

// ── Summary ──────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} test-gen selfcheck failure(s).`);
  process.exit(1);
}
console.log("\nAll test-gen selfchecks passed — test generation is MechanicSpec-derived and Rules 001–009 driven.");
