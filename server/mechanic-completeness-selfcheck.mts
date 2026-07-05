/**
 * Self-check for novel-mechanic completeness scanners.
 * Run: npx tsx server/mechanic-completeness-selfcheck.mts
 */
import { scanMechanicCompleteness } from "./mechanic-completeness.ts";
import type { MechanicSpec, PayoutRuleSpec } from "./mechanic-spec.ts";

const BASE = `contract TestVault is CodegenVaultBase {
    constructor(address a, address b, address c) CodegenVaultBase(a, b, c) {}
`;

function assert(name: string, code: string, prompt: string, expectRules: string[], mechanicSpec?: MechanicSpec) {
  const rules = scanMechanicCompleteness(code, prompt, undefined, mechanicSpec).map((f) => f.rule);
  const missing = expectRules.filter((r) => !rules.includes(r));
  if (missing.length) {
    console.error(`FAIL ${name}: missing [${missing.join(", ")}]; got [${rules.join(", ")}]`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK ${name}`);
}

function assertAbsent(name: string, code: string, prompt: string, absentRules: string[], mechanicSpec?: MechanicSpec) {
  const rules = scanMechanicCompleteness(code, prompt, undefined, mechanicSpec).map((f) => f.rule);
  const present = absentRules.filter((r) => rules.includes(r));
  if (present.length) {
    console.error(`FAIL ${name}: false positive on [${present.join(", ")}]; got [${rules.join(", ")}]`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK ${name} (no false positive)`);
}

/** Minimal but valid MechanicSpec fixture builder for Phase 7 economic-correctness tests. */
function specWithPayout(overrides: Partial<PayoutRuleSpec>): MechanicSpec {
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
  return {
    productSummary: "Quest proof vault",
    contractName: "QuestProofVault",
    actors: [],
    fundsIn: [],
    buckets: [{ name: "rewardBucket", asset: "BNB", creditedBy: ["receive()"], debitedBy: ["claimReward"] }],
    userActions: [],
    managerActions: [],
    scheduledActions: [],
    oracleActions: [],
    payoutRules: [payoutRule],
    fairnessModel: "",
    emergencyControls: "",
    trustAssumptions: [],
    uiMethods: [],
    viewMethods: [],
    ruleAnalysis: {} as MechanicSpec["ruleAnalysis"],
    launchCompatibility: { notes: [] },
    testScenarios: [],
    invariants: [],
  };
}

assert(
  "dead-claim-mapping",
  `${BASE}
    mapping(address => uint256) public claimableRewards;
    function claimReward() external { uint256 r = claimableRewards[msg.sender]; claimableRewards[msg.sender] = 0; }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`,
  "milestone vault",
  ["claim-mapping-never-credited"]
);

assert(
  "missing-register-in-schema",
  `${BASE}
    function registerInterest() external {}
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`,
  "register interest",
  ["write-method-not-in-uischema"]
);

assert(
  "phantom-schema-method",
  `${BASE}
    uint256 public weeklyDrawTimestamp;
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](1);
      s.methods[0].name = "viewPendingPayout";
    }
}`,
  "timed milestone vault",
  ["schema-method-not-implemented", "missing-time-until-view"]
);

assert(
  "manager-trigger-missing-from-schema",
  `${BASE}
    uint256 public weeklyDrawTimestamp;
    function advanceEpoch() external onlyManager {}
    function registerInterest() external {}
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](1);
      s.methods[0].name = "registerInterest";
      s.methods[0].isWriteMethod = true;
    }
}`,
  "epoch milestone vault",
  ["write-method-not-in-uischema", "design-schema-method-missing"]
);

assert(
  "refund-doubles-balance",
  `${BASE}
    function _onFlapAIRequestRefunded(uint256 requestId) internal {
      rewardPool += rewardPool;
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`,
  "oracle callback vault",
  ["refund-doubles-balance"]
);

assert(
  "status-view-first-array-element",
  `${BASE}
    address[] public participants;
    function getCurrentLeader() public view returns (address) {
      return participants.length > 0 ? participants[0] : address(0);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`,
  "competition vault",
  ["status-view-first-array-element"]
);

// ── Phase 4 novel-mechanic fixtures ─────────────────────────────────────────
// Empty prompts throughout: completeness checks must fire from source structure
// and dataflow alone — no prompt keywords, no VaultKind, no fixed method names.

// Quest submission vault: free-form action + generic (non-"claimable*") credit mapping.
assert(
  "quest-submission-free-form-names",
  `${BASE}
    mapping(address => string) public questProofs;
    mapping(address => uint256) public questRewards;
    function submitQuestProof(string calldata uri) external {
        questProofs[msg.sender] = uri;
    }
    function redeemQuestReward() external nonReentrant {
        uint256 r = questRewards[msg.sender];
        require(r > 0, unicode"x / x");
        questRewards[msg.sender] = 0;
        _sendNative(msg.sender, r);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`,
  "",
  ["claim-mapping-never-credited", "participation-never-consumed", "write-method-not-in-uischema"]
);

// Same quest vault but complete: manager approval credits rewards, submissions consumed.
assertAbsent(
  "quest-submission-complete-lifecycle",
  `${BASE}
    mapping(address => string) public questProofs;
    mapping(address => uint256) public questRewards;
    function submitQuestProof(string calldata uri) external {
        questProofs[msg.sender] = uri;
    }
    function approveQuest(address user, uint256 amount) external onlyManager {
        require(bytes(questProofs[user]).length > 0, unicode"x / x");
        questRewards[user] += amount;
    }
    function redeemQuestReward() external nonReentrant {
        uint256 r = questRewards[msg.sender];
        require(r > 0, unicode"x / x");
        questRewards[msg.sender] = 0;
        _sendNative(msg.sender, r);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](2);
      s.methods[0].name = "submitQuestProof";
      s.methods[1].name = "redeemQuestReward";
    }
}`,
  "",
  ["claim-mapping-never-credited", "participation-never-consumed", "write-method-not-in-uischema"]
);

// Referral split vault: no "register" wording anywhere — lifecycle check still fires.
assert(
  "referral-mapping-no-name-gate",
  `${BASE}
    mapping(address => address) public referrerOf;
    function setMyReferrer(address ref) external {
        require(ref != address(0), unicode"x / x");
        referrerOf[msg.sender] = ref;
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](1);
      s.methods[0].name = "setMyReferrer";
    }
}`,
  "",
  ["participation-never-consumed"]
);

// Referral vault with settlement consuming the mapping: no lifecycle finding.
assertAbsent(
  "referral-mapping-consumed",
  `${BASE}
    mapping(address => address) public referrerOf;
    mapping(address => uint256) public referralRewards;
    function setMyReferrer(address ref) external {
        require(ref != address(0), unicode"x / x");
        referrerOf[msg.sender] = ref;
    }
    function settleReferralReward(address buyer, uint256 amount) external onlyManager {
        address ref = referrerOf[buyer];
        if (ref != address(0)) referralRewards[ref] += amount;
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](1);
      s.methods[0].name = "setMyReferrer";
    }
}`,
  "",
  ["participation-never-consumed"]
);

// Time-decay reward vault: scheduled window detected structurally (no epoch/draw keyword).
assert(
  "time-decay-needs-countdown-view",
  `${BASE}
    uint256 public rewardBucket;
    uint256 public lastAccrualAt;
    receive() external payable { rewardBucket += msg.value; }
    function accrueDecay() external onlyManager {
        require(block.timestamp >= lastAccrualAt + DECAY_WINDOW, unicode"x / x");
        lastAccrualAt = block.timestamp;
        rewardBucket = rewardBucket - rewardBucket / 10;
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`,
  "",
  ["missing-time-until-view"]
);

// Time-decay vault with a free-form countdown view listed in the schema: clean.
assertAbsent(
  "time-decay-with-countdown-view",
  `${BASE}
    uint256 public rewardBucket;
    uint256 public lastAccrualAt;
    receive() external payable { rewardBucket += msg.value; }
    function accrueDecay() external onlyManager {
        require(block.timestamp >= lastAccrualAt + DECAY_WINDOW, unicode"x / x");
        lastAccrualAt = block.timestamp;
        rewardBucket = rewardBucket - rewardBucket / 10;
    }
    function secondsUntilDecay() public view returns (uint256) {
        uint256 next = lastAccrualAt + DECAY_WINDOW;
        return block.timestamp >= next ? 0 : next - block.timestamp;
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](2);
      s.methods[0].name = "secondsUntilDecay";
      s.methods[1].name = "rewardBucket";
    }
}`,
  "",
  ["missing-time-until-view", "time-until-not-in-uischema"]
);

// Destructive bucket reset with a free-form name: funds erased without distribution.
assert(
  "bucket-reset-without-distribution",
  `${BASE}
    uint256 public communityPot;
    receive() external payable { communityPot += msg.value; }
    function resetSeason() external onlyManager {
        communityPot = 0;
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`,
  "",
  ["pool-erased-no-payout"]
);

// Oracle/trigger callbacks must not be exposed as user UI methods.
assert(
  "oracle-callback-not-user-ui",
  `${BASE}
    function trigger(uint256 id) external {
        require(msg.sender == _getFlapTriggerService(), unicode"x / x");
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](1);
      s.methods[0].name = "trigger";
    }
}`,
  "",
  ["oracle-callback-in-uischema"]
);

// ── Phase 7: economic correctness (QuestProofVault fixtures) ───────────────

// Bad: submitQuestProof is event-only, approveQuestProof grants eligibility
// without reserving anything, claimReward pays the WHOLE rewardBucket to
// msg.sender. First approved claimant drains everyone else's reward.
const BAD_QUEST_PROOF_VAULT = `${BASE}
    uint256 public rewardBucket;
    mapping(address => bool) public approvedProofs;
    receive() external payable { rewardBucket += msg.value; }
    event QuestProofSubmitted(address indexed user, bytes proof);
    function submitQuestProof(bytes calldata proof) external {
        emit QuestProofSubmitted(msg.sender, proof);
    }
    function approveQuestProof(address user) external onlyManager {
        approvedProofs[user] = true;
    }
    function claimReward() external nonReentrant {
        require(approvedProofs[msg.sender], unicode"Not approved / 未批准");
        uint256 rewardAmount = rewardBucket;
        rewardBucket = 0;
        approvedProofs[msg.sender] = false;
        _sendNative(msg.sender, rewardAmount);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](3);
      s.methods[0].name = "submitQuestProof";
      s.methods[1].name = "approveQuestProof";
      s.methods[2].name = "claimReward";
    }
}`;

assert(
  "quest-proof-vault-bad-shared-pool-drain",
  BAD_QUEST_PROOF_VAULT,
  "users submit quest proofs, the manager approves valid proofs, and approved users claim from a reward bucket",
  [
    "first-claimer-can-drain-shared-pool",
    "approval-without-reserved-liability",
    "claim-amount-from-global-bucket-without-winner-semantics",
    "event-only-user-action-without-trust-disclosure",
    "approval-not-linked-to-submitted-state",
  ],
  specWithPayout({})
);

// Same bad shape, but the MechanicSpec has NO payoutRules at all (older/missing
// spec). Phase 7's conservative default must still block the shared-pool drain —
// absence of a spec must never be read as "winner takes all is fine".
assert(
  "quest-proof-vault-bad-no-spec-still-blocked",
  BAD_QUEST_PROOF_VAULT,
  "",
  ["first-claimer-can-drain-shared-pool", "approval-without-reserved-liability"],
  undefined
);

// Good: submission stores a proof hash, approval checks it and reserves the
// amount, claim pays only the caller's own claimableRewards — clean.
const GOOD_QUEST_PROOF_VAULT = `${BASE}
    uint256 public rewardBucket;
    mapping(address => bytes32) public latestProofHash;
    mapping(address => uint256) public claimableRewards;
    receive() external payable { rewardBucket += msg.value; }
    event QuestProofSubmitted(address indexed user, bytes32 indexed proofHash);
    event QuestProofApproved(address indexed user, bytes32 proofHash, uint256 amount);
    function submitQuestProof(bytes calldata proof) external {
        bytes32 proofHash = keccak256(proof);
        latestProofHash[msg.sender] = proofHash;
        emit QuestProofSubmitted(msg.sender, proofHash);
    }
    function approveQuestProof(address user, bytes32 proofHash, uint256 amount) external onlyManager {
        require(latestProofHash[user] == proofHash, unicode"Proof mismatch / 证明不匹配");
        require(rewardBucket >= amount, unicode"Insufficient bucket / 资金不足");
        rewardBucket -= amount;
        claimableRewards[user] += amount;
        emit QuestProofApproved(user, proofHash, amount);
    }
    function claimReward() external nonReentrant {
        uint256 amount = claimableRewards[msg.sender];
        require(amount > 0, unicode"No reward / 没有奖励");
        claimableRewards[msg.sender] = 0;
        _sendNative(msg.sender, amount);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](3);
      s.methods[0].name = "submitQuestProof";
      s.methods[1].name = "approveQuestProof";
      s.methods[2].name = "claimReward";
    }
}`;

assertAbsent(
  "quest-proof-vault-good-per-user-accounting",
  GOOD_QUEST_PROOF_VAULT,
  "",
  [
    "first-claimer-can-drain-shared-pool",
    "approval-without-reserved-liability",
    "claim-amount-from-global-bucket-without-winner-semantics",
    "multi-user-payout-without-per-user-accounting",
    "event-only-user-action-without-trust-disclosure",
    "approval-not-linked-to-submitted-state",
  ],
  specWithPayout({
    distributionMode: "manager_assigned_amount",
    liabilityModel: "reserved_on_approval",
    claimAmountSource: "claimableRewards[user] mapping",
    winnerTakesAll: false,
    perUserAccountingRequired: true,
  })
);

// Winner-takes-all: same "pay the whole bucket to msg.sender" shape as the bad
// fixture, but the MechanicSpec EXPLICITLY declares winner-takes-all/single-
// winner-pool semantics — this must be clean.
const WINNER_TAKES_ALL_VAULT = `${BASE}
    uint256 public prizePool;
    mapping(address => bool) public isSelectedWinner;
    receive() external payable { prizePool += msg.value; }
    function selectWinner(address user) external onlyManager {
        isSelectedWinner[user] = true;
    }
    function claimPrize() external nonReentrant {
        require(isSelectedWinner[msg.sender], unicode"Not the winner / 不是获胜者");
        uint256 amount = prizePool;
        prizePool = 0;
        isSelectedWinner[msg.sender] = false;
        _sendNative(msg.sender, amount);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](2);
      s.methods[0].name = "selectWinner";
      s.methods[1].name = "claimPrize";
    }
}`;

assertAbsent(
  "winner-takes-all-explicit-spec-clean",
  WINNER_TAKES_ALL_VAULT,
  "",
  ["first-claimer-can-drain-shared-pool", "approval-without-reserved-liability", "claim-amount-from-global-bucket-without-winner-semantics"],
  specWithPayout({
    trigger: "selectWinner",
    source: "prizePool",
    recipients: "a single selected winner",
    distributionMode: "winner_takes_all",
    liabilityModel: "single_winner_pool",
    claimAmountSource: "the entire prizePool, paid once to the selected winner",
    winnerTakesAll: true,
    perUserAccountingRequired: false,
  })
);

// Same winner-takes-all SHAPE but WITHOUT an explicit spec declaration — must
// still be blocked (the shape alone never implies winner-takes-all).
assert(
  "winner-takes-all-shape-without-explicit-spec-still-blocked",
  WINNER_TAKES_ALL_VAULT,
  "",
  ["first-claimer-can-drain-shared-pool"],
  undefined
);

if (process.exitCode) {
  console.error("\nMechanic completeness self-check FAILED.");
  process.exit(1);
}
console.log("\nMechanic completeness self-checks passed.");
