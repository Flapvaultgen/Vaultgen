/**
 * Phase 7 — Economic Correctness, Multi-User Invariants, and Critic Pass.
 *
 * Proves:
 *  1. MechanicSpec payoutRules carry explicit distribution/liability semantics,
 *     normalized conservatively when missing/older.
 *  2. The bad QuestProofVault (first-claimer drains the shared pool) is blocked.
 *  3. The corrected per-user claimable pattern is clean.
 *  4. Winner-takes-all global-bucket payout is clean ONLY when the MechanicSpec
 *     explicitly declares it — the same code shape without an explicit spec is
 *     still blocked.
 *  5. A fixed-per-user reward amount (no shared-bucket drain) is clean even
 *     without a winner-takes-all declaration.
 *  6. Findings map to Rule 001/003/004.
 *  7. test-gen synthesizes two-user adversarial journeys for per-user payouts.
 *  8. The economic critic prompt cites the checklist + MechanicSpec + Rules
 *     001-009, and normalizeCriticFindings produces the documented report shape.
 *  9. GPT-4o routing is unchanged — the critic module never hardcodes a model
 *     name and only uses the model string passed in by the caller.
 *
 * Run: npx tsx economic-hardening-selfcheck.mts   (no network, no forge, no fork)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanMechanicCompleteness } from "./mechanic-completeness.js";
import { normalizeMechanicSpec, inferMechanicSpecFromPrompt, type MechanicSpec, type PayoutRuleSpec } from "./mechanic-spec.js";
import { mapScannerFindingToRuleId } from "./constitution.js";
import { synthesizeTestJourneys } from "./test-gen.js";
import { buildEconomicCriticPrompt, normalizeCriticFindings, CRITIC_CHECKLIST } from "./economic-critic.js";

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

const BASE = `contract QuestProofVault is CodegenVaultBase {
    constructor(address a, address b, address c) CodegenVaultBase(a, b, c) {}
`;

function specWithPayout(overrides: Partial<PayoutRuleSpec>): MechanicSpec {
  const base = inferMechanicSpecFromPrompt("quest proof vault");
  const payoutRule: PayoutRuleSpec = {
    trigger: "approveQuestProof",
    source: "rewardBucket",
    recipients: "multiple approved users",
    mode: "pull",
    distributionMode: "manager_assigned_amount",
    liabilityModel: "reserved_on_approval",
    eligibilitySource: "manager approval of a submitted proof",
    claimAmountSource: "claimableRewards[user] mapping",
    winnerTakesAll: false,
    perUserAccountingRequired: true,
    ...overrides,
  };
  return { ...base, contractName: "QuestProofVault", payoutRules: [payoutRule] };
}

// ── 1. MechanicSpec payoutRules carry explicit semantics ────────────────────

const heuristicLottery = inferMechanicSpecFromPrompt("holders enter a weekly lottery and a single winner is randomly selected");
check(
  "heuristic lottery spec declares winner-takes-all",
  heuristicLottery.payoutRules.some((p) => p.winnerTakesAll && p.distributionMode === "winner_takes_all")
);

const heuristicStaking = inferMechanicSpecFromPrompt("holders stake tokens and earn BNB rewards pro rata to their stake");
check(
  "heuristic staking spec requires per-user accounting, not winner-takes-all",
  heuristicStaking.payoutRules.every((p) => p.perUserAccountingRequired && !p.winnerTakesAll)
);

const heuristicGeneric = inferMechanicSpecFromPrompt(
  "users submit quest proofs, the manager approves valid proofs, and approved users claim from a reward bucket"
);
check(
  "heuristic generic multi-user spec defaults to per-user accounting",
  heuristicGeneric.payoutRules.every((p) => p.perUserAccountingRequired && !p.winnerTakesAll)
);

// Older/missing-field LLM output must be normalized conservatively (never
// silently promoted to winner-takes-all just because fields were omitted).
const legacyRaw = {
  contractName: "LegacyVault",
  payoutRules: [{ trigger: "claimReward", source: "rewardBucket", recipients: "approved users", mode: "pull" }],
};
const normalizedLegacy = normalizeMechanicSpec(legacyRaw, inferMechanicSpecFromPrompt("legacy vault"));
check(
  "normalizeMechanicSpec backfills missing payout semantics conservatively (not winner-takes-all)",
  normalizedLegacy.payoutRules.length > 0 && normalizedLegacy.payoutRules.every((p) => !p.winnerTakesAll && p.perUserAccountingRequired)
);

const explicitWinnerRaw = {
  contractName: "DrawVault",
  payoutRules: [
    {
      trigger: "requestOutcome",
      source: "prizePool",
      recipients: "a single winner",
      mode: "pull",
      winnerTakesAll: true,
      distributionMode: "winner_takes_all",
      liabilityModel: "single_winner_pool",
    },
  ],
};
const normalizedWinner = normalizeMechanicSpec(explicitWinnerRaw, inferMechanicSpecFromPrompt("draw vault"));
check(
  "normalizeMechanicSpec honors an explicit winner-takes-all declaration",
  normalizedWinner.payoutRules[0]?.winnerTakesAll === true && normalizedWinner.payoutRules[0]?.perUserAccountingRequired === false
);

// ── 2/3/4/5. Bad / good / winner-takes-all / fixed-per-user fixtures ────────

const BAD_QUEST_PROOF_VAULT = `${BASE}
    uint256 public rewardBucket;
    mapping(address => bool) public approvedProofs;
    receive() external payable { rewardBucket += msg.value; }
    function submitQuestProof(bytes calldata proof) external { emit QuestProofSubmitted(msg.sender, proof); }
    event QuestProofSubmitted(address indexed user, bytes proof);
    function approveQuestProof(address user) external onlyManager { approvedProofs[user] = true; }
    function claimReward() external nonReentrant {
        require(approvedProofs[msg.sender], unicode"Not approved / 未批准");
        uint256 rewardAmount = rewardBucket;
        rewardBucket = 0;
        approvedProofs[msg.sender] = false;
        _sendNative(msg.sender, rewardAmount);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`;

const badFindings = scanMechanicCompleteness(BAD_QUEST_PROOF_VAULT, "", undefined, specWithPayout({}));
check(
  "bad QuestProofVault is blocked (default level = block)",
  badFindings.some((f) => f.rule === "first-claimer-can-drain-shared-pool" && (f.level ?? "block") === "block")
);
check(
  "bad QuestProofVault mapping to Rules 001/003/004",
  ["first-claimer-can-drain-shared-pool", "approval-without-reserved-liability", "claim-amount-from-global-bucket-without-winner-semantics"]
    .map(mapScannerFindingToRuleId)
    .every((r) => ["001", "003"].includes(r)) &&
    mapScannerFindingToRuleId("event-only-user-action-without-trust-disclosure") === "004" &&
    mapScannerFindingToRuleId("approval-not-linked-to-submitted-state") === "004"
);
check(
  "bad QuestProofVault event-only submission is a warn (advisory), not a hard block",
  badFindings.find((f) => f.rule === "event-only-user-action-without-trust-disclosure")?.level === "warn"
);

const GOOD_QUEST_PROOF_VAULT = `${BASE}
    uint256 public rewardBucket;
    mapping(address => bytes32) public latestProofHash;
    mapping(address => uint256) public claimableRewards;
    receive() external payable { rewardBucket += msg.value; }
    function submitQuestProof(bytes calldata proof) external {
        latestProofHash[msg.sender] = keccak256(proof);
    }
    function approveQuestProof(address user, bytes32 proofHash, uint256 amount) external onlyManager {
        require(latestProofHash[user] == proofHash, unicode"Proof mismatch / 证明不匹配");
        rewardBucket -= amount;
        claimableRewards[user] += amount;
    }
    function claimReward() external nonReentrant {
        uint256 amount = claimableRewards[msg.sender];
        require(amount > 0, unicode"No reward / 没有奖励");
        claimableRewards[msg.sender] = 0;
        _sendNative(msg.sender, amount);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`;
const goodFindings = scanMechanicCompleteness(
  GOOD_QUEST_PROOF_VAULT,
  "",
  undefined,
  specWithPayout({ claimAmountSource: "claimableRewards[user] mapping" })
);
check(
  "fixed per-user QuestProofVault is clean",
  !goodFindings.some((f) =>
    ["first-claimer-can-drain-shared-pool", "approval-without-reserved-liability", "claim-amount-from-global-bucket-without-winner-semantics"].includes(
      f.rule
    )
  )
);

const WINNER_TAKES_ALL_VAULT = `${BASE}
    uint256 public prizePool;
    mapping(address => bool) public isSelectedWinner;
    receive() external payable { prizePool += msg.value; }
    function selectWinner(address user) external onlyManager { isSelectedWinner[user] = true; }
    function claimPrize() external nonReentrant {
        require(isSelectedWinner[msg.sender], unicode"Not the winner / 不是获胜者");
        uint256 amount = prizePool;
        prizePool = 0;
        isSelectedWinner[msg.sender] = false;
        _sendNative(msg.sender, amount);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`;
const explicitWinnerSpec = specWithPayout({
  trigger: "selectWinner",
  source: "prizePool",
  recipients: "a single selected winner",
  distributionMode: "winner_takes_all",
  liabilityModel: "single_winner_pool",
  winnerTakesAll: true,
  perUserAccountingRequired: false,
});
check(
  "winner-takes-all is clean ONLY when MechanicSpec declares it explicitly",
  !scanMechanicCompleteness(WINNER_TAKES_ALL_VAULT, "", undefined, explicitWinnerSpec).some(
    (f) => f.rule === "first-claimer-can-drain-shared-pool"
  )
);
check(
  "the same winner-takes-all-shaped code is still blocked without an explicit spec",
  scanMechanicCompleteness(WINNER_TAKES_ALL_VAULT, "", undefined, undefined).some((f) => f.rule === "first-claimer-can-drain-shared-pool")
);

// Fixed-per-user amount, no shared bucket drain, no winner-takes-all needed.
const FIXED_PER_USER_VAULT = `${BASE}
    uint256 public rewardBucket;
    uint256 public constant REWARD_PER_QUEST = 0.01 ether;
    mapping(address => bool) public approvedProofs;
    receive() external payable { rewardBucket += msg.value; }
    function approveQuestProof(address user) external onlyManager {
        require(rewardBucket >= REWARD_PER_QUEST, unicode"Insufficient bucket / 资金不足");
        rewardBucket -= REWARD_PER_QUEST;
        approvedProofs[user] = true;
    }
    function claimReward() external nonReentrant {
        require(approvedProofs[msg.sender], unicode"Not approved / 未批准");
        approvedProofs[msg.sender] = false;
        _sendNative(msg.sender, REWARD_PER_QUEST);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`;
check(
  "fixed-per-user reward (no shared-bucket drain) is clean without a winner-takes-all declaration",
  !scanMechanicCompleteness(FIXED_PER_USER_VAULT, "", undefined, specWithPayout({ distributionMode: "fixed_per_user" })).some((f) =>
    ["first-claimer-can-drain-shared-pool", "claim-amount-from-global-bucket-without-winner-semantics"].includes(f.rule)
  )
);

// ── 7. test-gen creates two-user adversarial journeys ───────────────────────

const questSpec = specWithPayout({});
const journeys = synthesizeTestJourneys(questSpec, "", "QuestProofVault");
check("test-gen: two-user (Alice/Bob) eligibility journey exists", journeys.some((j) => /Alice and Bob/i.test(j.scenario)));
check(
  "test-gen: no-double-claim / cannot-claim-others-reward journey exists",
  journeys.some((j) => /Bob cannot claim Alice's reward/i.test(j.scenario))
);
check(
  "test-gen: winner-takes-all payouts skip the two-user fairness journeys",
  !synthesizeTestJourneys(explicitWinnerSpec, "", "DrawVault").some((j) => /Alice and Bob/i.test(j.scenario))
);

// ── 8. Economic critic prompt/report shape ──────────────────────────────────

const criticPrompt = buildEconomicCriticPrompt("QuestProofVault", questSpec);
check("critic prompt cites the MechanicSpec", criticPrompt.includes("MechanicSpec") && criticPrompt.includes("QuestProofVault"));
check("critic prompt includes the economic review checklist", CRITIC_CHECKLIST.every((c) => criticPrompt.includes(c)));
check("critic prompt does not block/replace deterministic scanners", /do not block|advisory/i.test(criticPrompt));
check(
  "critic prompt requests structured JSON with severity/ruleIds/finding/explanation/suggestedRepair",
  ["severity", "ruleIds", "finding", "explanation", "suggestedRepair"].every((k) => criticPrompt.includes(k))
);

const parsedFindings = normalizeCriticFindings([
  {
    severity: "blocking",
    ruleIds: ["001", "003"],
    finding: "first-claimer-drains-shared-pool",
    explanation: "claimReward() pays the whole rewardBucket to msg.sender.",
    suggestedRepair: "Add claimableRewards[user] and pay only that.",
  },
  { severity: "not-a-real-severity", finding: "" }, // malformed — must be dropped/normalized, not throw
]);
check("normalizeCriticFindings keeps well-formed findings", parsedFindings.length === 1 && parsedFindings[0]!.severity === "blocking");
check(
  "normalizeCriticFindings normalizes ruleIds to known Flap rule ids",
  parsedFindings[0]!.ruleIds.every((id) => ["001", "002", "003", "004", "005", "006", "007", "008", "009"].includes(id))
);
check("normalizeCriticFindings drops findings with no finding name", normalizeCriticFindings([{ severity: "high" }]).length === 0);
check("normalizeCriticFindings tolerates non-array input", normalizeCriticFindings(undefined).length === 0);

// ── 9. Model routing — critic module never hardcodes a model name ───────────

const criticSource = await readFile(path.join(SERVER_DIR, "economic-critic.ts"), "utf8");
check(
  "economic-critic.ts never hardcodes a model name literal (uses the caller-supplied `model` param)",
  !/["'`](gpt-4|gpt-3|o1-|claude|gemini)[^"'`]*["'`]/i.test(criticSource)
);
check("economic-critic.ts passes through the caller's model to chat.completions.create", /model,\s*\n\s*temperature/.test(criticSource));

const codegenSource = await readFile(path.join(SERVER_DIR, "codegen.ts"), "utf8");
check(
  "codegen.ts wires the critic pass with the pipeline apiKey and the advisory (cheap) model",
  /runEconomicCriticPass\(contractName, fullSource, mechanicSpec, apiKey, advisoryModel\)/.test(codegenSource)
);
check(
  "codegen.ts resolves the advisory model via resolveCheapModel (falls back to the main model)",
  /const advisoryModel = resolveCheapModel\(\)/.test(codegenSource)
);

// ── 10. Web UI — advisory panel wired, deploy gate unchanged ────────────────

const webRoot = path.join(SERVER_DIR, "..", "web", "src");
const criticPanel = await readFile(path.join(webRoot, "components", "EconomicCriticPanel.tsx"), "utf8");
check("EconomicCriticPanel.tsx exists and marks advisory-only", /advisory only/i.test(criticPanel));
check("EconomicCriticPanel renders severity + suggestedRepair", /suggestedRepair|Suggested fix/i.test(criticPanel));

const codegenStudio = await readFile(path.join(webRoot, "CodegenStudio.tsx"), "utf8");
check("CodegenStudio handles economic_critique SSE event", /case "economic_critique"/.test(codegenStudio));
check("CodegenStudio renders EconomicCriticPanel", /EconomicCriticPanel/.test(codegenStudio));

const deployGate = await readFile(path.join(webRoot, "lib", "deploy-gate.ts"), "utf8");
check("deploy-gate does NOT block launch on economicCritique", !deployGate.includes("economicCritique"));

if (failures > 0) {
  console.error(`\n${failures} economic-hardening selfcheck failure(s).`);
  process.exit(1);
}
console.log("\nAll Phase 7 economic-hardening selfchecks passed.");
