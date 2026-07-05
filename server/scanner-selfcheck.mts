/**
 * Static self-check: prove scanners catch known bad patterns and allow good patterns.
 * Run: npx tsx scanner-selfcheck.mts
 */
import { scanSafety } from "./codegen.ts";

type Case = {
  name: string;
  prompt: string;
  code: string;
  expectRules?: string[];
  expectAbsent?: string[];
};

const BASE = `contract TestVault is CodegenVaultBase {
    constructor(address a, address b, address c) CodegenVaultBase(a, b, c) {}
`;

const AI_BASE = `contract TestVault is CodegenVaultBase, FlapAIConsumerBase {
    constructor(address a, address b, address c) CodegenVaultBase(a, b, c) {}
    receive() external payable {}
`;

function scan(code: string, prompt: string) {
  return scanSafety(code, "TestVault", prompt).findings.filter((f) => f.level === "block").map((f) => f.rule);
}

function assertCase(c: Case) {
  const rules = scan(c.code, c.prompt);
  if (c.expectAbsent?.length) {
    const present = c.expectAbsent.filter((r) => rules.includes(r));
    if (present.length) {
      console.error(`FAIL ${c.name}: false positive on [${present.join(", ")}]; got [${rules.join(", ")}]`);
      return false;
    }
    console.log(`OK ${c.name} (no false positive: ${c.expectAbsent.join(", ")})`);
    return true;
  }
  const missing = (c.expectRules ?? []).filter((r) => !rules.includes(r));
  if (missing.length) {
    console.error(`FAIL ${c.name}: missing rules [${missing.join(", ")}]; got [${rules.join(", ")}]`);
    return false;
  }
  console.log(`OK ${c.name} (caught ${(c.expectRules ?? []).join(", ")})`);
  return true;
}

const cases: Case[] = [
  {
    name: "bad-stake-tax-lost",
    prompt: "stake to earn dividends",
    code: `${BASE}
    uint256 public totalStaked; uint256 public accRewardPerShare;
    struct UserInfo { uint256 amount; uint256 rewardDebt; }
    mapping(address => UserInfo) public userInfo;
    receive() external payable {
        if (totalStaked > 0) accRewardPerShare += msg.value * 1e18 / totalStaked;
    }
    function stake(uint256 amount) external { totalStaked += amount; }
    function claimReward() external {}
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["stake-rewards-lost-no-stakers", "vault-logic"],
  },
  {
    name: "bad-claim-double-harvest",
    prompt: "stake rewards",
    code: `${BASE}
    uint256 public totalStaked; uint256 public accRewardPerShare; uint256 public pendingRewards;
    struct UserInfo { uint256 amount; uint256 rewardDebt; }
    mapping(address => UserInfo) public userInfo;
    receive() external payable { if (totalStaked == 0) pendingRewards += msg.value; }
    function _updateReward(address u) internal { _sendNative(u, 1); }
    function claimReward() external { _updateReward(msg.sender); require(pending > 0, unicode"x / x"); }
    function stake(uint256) external { if (pendingRewards > 0) { pendingRewards = 0; } }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["stake-claim-double-harvest", "vault-logic"],
  },
  {
    name: "bad-emergency-drains-buckets",
    prompt: "buyback vault",
    code: `${BASE}
    uint256 public buybackBudget; uint256 public treasury;
    receive() external payable { buybackBudget += msg.value / 2; treasury += msg.value / 2; }
    function emergencyWithdrawNative(address to) external override onlyGuardian nonReentrant {
        uint256 reserved = buybackBudget + treasury;
        uint256 excess = address(this).balance;
        require(excess > reserved, unicode"x / x");
        excess -= reserved;
        _sendNative(to, excess);
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["excess-only-emergency-override"],
  },
  {
    name: "bad-staking-no-balance-delta",
    prompt: "stake to earn",
    code: `${BASE}
    uint256 public totalStaked; uint256 public accRewardPerShare; uint256 public pendingRewards;
    struct UserInfo { uint256 amount; uint256 rewardDebt; }
    mapping(address => UserInfo) public userInfo;
    receive() external payable { if (totalStaked == 0) pendingRewards += msg.value; }
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, unicode"x / x");
        IERC20(taxToken).safeTransferFrom(msg.sender, address(this), amount);
        userInfo[msg.sender].amount += amount; totalStaked += amount;
    }
    function claimReward() external { }
    function pendingReward(address) external view returns (uint256) { return 0; }
    function description() public view override returns (string memory) { return unicode"Stake / Guardian Rule 009 / 质押"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
        s.vaultType = "T"; s.description = unicode"Guardian emergency / 应急"; s.methods = new VaultMethodSchema[](0);
    }
}`,
    expectRules: ["stake-no-balance-delta", "vault-logic"],
  },
  {
    name: "bad-staking-autopay",
    prompt: "stake rewards",
    code: `${BASE}
    uint256 public totalStaked; uint256 public accRewardPerShare;
    struct UserInfo { uint256 amount; uint256 rewardDebt; }
    mapping(address => UserInfo) public userInfo;
    receive() external payable { if (totalStaked > 0) accRewardPerShare += msg.value * 1e18 / totalStaked; }
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, unicode"x / x");
        uint256 pending = (userInfo[msg.sender].amount * accRewardPerShare) / 1e18 - userInfo[msg.sender].rewardDebt;
        if (pending > 0) _sendNative(msg.sender, pending);
        IERC20(taxToken).safeTransferFrom(msg.sender, address(this), amount);
        userInfo[msg.sender].amount += amount; totalStaked += amount;
    }
    function claimReward() external nonReentrant {
        uint256 pending = (userInfo[msg.sender].amount * accRewardPerShare) / 1e18 - userInfo[msg.sender].rewardDebt;
        userInfo[msg.sender].rewardDebt = (userInfo[msg.sender].amount * accRewardPerShare) / 1e18;
        _sendNative(msg.sender, pending);
    }
    function pendingReward(address) external view returns (uint256) { return 0; }
    function description() public view override returns (string memory) { return unicode"Guardian Rule 009 stake / 质押"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
        s.vaultType = "T"; s.description = unicode"Guardian emergency / 应急"; s.methods = new VaultMethodSchema[](0);
    }
}`,
    expectRules: ["stake-autopay-with-claim", "vault-logic"],
  },
  {
    name: "bad-secure-random-wording",
    prompt: "AI lottery",
    code: `${BASE}
    function description() public view override returns (string memory) {
        return unicode"Secure random lottery winner / 安全随机抽奖";
    }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["secure-random-overclaim", "vault-logic"],
  },
  {
    name: "bad-ai-random-wording",
    prompt: "burn lottery weekly draw",
    code: `${AI_BASE}
    function requestDraw() external onlyManager {}
    function _fulfillReasoning(uint256, uint8) internal override {}
    function _onFlapAIRequestRefunded(uint256) internal override {}
    function lastRequestId() public view override returns (uint256) { return 0; }
    function description() public view override returns (string memory) {
        return unicode"Weekly jackpot for one random participant / 每周随机参与者";
    }
    function requestDraw() external onlyManager {}
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = unicode"random participant / 随机"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["ai-random-wording", "vault-logic"],
  },
  {
    name: "bad-jackpot-fee-zero-prize",
    prompt: "AI lottery",
    code: `${AI_BASE}
    uint256 public jackpot;
    function requestDraw() external onlyManager {
        uint256 fee = 1;
        require(jackpot >= fee, unicode"x / x");
        jackpot -= fee;
    }
    function _fulfillReasoning(uint256, uint8) internal override {}
    function _onFlapAIRequestRefunded(uint256) internal override {}
    function lastRequestId() public view override returns (uint256) { return 0; }
    function description() public view override returns (string memory) { return unicode"AI provider draw / AI"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["lottery-jackpot-fee-zero-prize", "vault-logic"],
  },
  {
    name: "bad-ai-lottery-push-payout",
    prompt: "AI lottery",
    code: `${AI_BASE}
    address[] private drawSnapshot;
    uint256 public jackpot;
    uint256 public pendingRequestId;
    uint256 public lastDrawFee;
    function requestDraw() external onlyManager {
        require(pendingRequestId == 0, unicode"x / x");
        pendingRequestId = 1;
        emit DrawRequested(1, 1, 0);
    }
    function _fulfillReasoning(uint256 requestId, uint8 choice) internal override {
        address winner = drawSnapshot[choice];
        uint256 prize = jackpot; jackpot = 0;
        _sendNative(winner, prize);
        lastDrawFee = 0;
    }
    function _onFlapAIRequestRefunded(uint256 requestId) internal override {
        emit DrawRefunded(requestId, lastDrawFee);
    }
    function lastRequestId() public view override returns (uint256) { return pendingRequestId; }
    event DrawRequested(uint256 indexed requestId, uint256 entrantCount, uint256 fee);
    event DrawRefunded(uint256 indexed requestId, uint256 fee);
    function description() public view override returns (string memory) { return unicode"AI provider draw / AI"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["ai-lottery-push-payout", "vault-logic"],
  },
  {
    name: "bad-weekly-prize-half-buyback",
    prompt: "50/50 buyback and burn weekly prize lottery hold 500 tokens",
    code: `contract TestVault is CodegenVaultBase, FlapAIConsumerBase {
    constructor(address a, address b, address c) CodegenVaultBase(a, b, c) {}
    uint256 public constant MINIMUM_HOLDING = 500 * 1e18;
    uint256 public prizePotAmount;
    uint256 public lastDrawTime;
    uint256 public pendingRequestId;
    uint256 public aiModelId;
    address[] public entrantList;
    address[] private drawSnapshot;
    mapping(address => bool) public hasEntered;
    mapping(address => uint256) public claimablePrize;
    event PrizeCollected(address indexed winner, uint256 amount);
    event NoEntrants(uint256 prizePotAmount);
    event DrawRequested(uint256 indexed requestId, uint256 entrantCount, uint256 fee);
    event DrawRefunded(uint256 indexed requestId, uint256 fee);
    receive() external payable {
        if (msg.value == 0) return;
        uint256 half = msg.value / 2;
        prizePotAmount += half;
    }
    function enter() external nonReentrant {
        require(!hasEntered[msg.sender], unicode"x / x");
        hasEntered[msg.sender] = true;
        entrantList.push(msg.sender);
    }
    function requestDraw() external onlyManager nonReentrant {
        require(pendingRequestId == 0, unicode"x / x");
        require(block.timestamp >= lastDrawTime + 1 weeks, unicode"x / x");
        if (entrantList.length == 0) { emit NoEntrants(prizePotAmount); return; }
        delete drawSnapshot;
        for (uint256 i = 0; i < entrantList.length; i++) drawSnapshot.push(entrantList[i]);
        uint256 fee = 1;
        require(prizePotAmount > fee, unicode"x / x");
        prizePotAmount -= fee;
        pendingRequestId = 1;
        emit DrawRequested(1, drawSnapshot.length, fee);
    }
    function _fulfillReasoning(uint256 requestId, uint8 choice) internal override {
        require(requestId == pendingRequestId, unicode"x / x");
        pendingRequestId = 0;
        address winner = drawSnapshot[choice];
        uint256 prize = prizePotAmount; prizePotAmount = 0;
        claimablePrize[winner] += prize;
        emit PrizeCollected(winner, prize);
    }
    function _onFlapAIRequestRefunded(uint256 requestId) internal override {
        if (requestId == pendingRequestId) {
            emit DrawRefunded(requestId, 0);
            pendingRequestId = 0;
            delete drawSnapshot;
        }
    }
    function claimPrize() external nonReentrant {}
    function lastRequestId() public view override returns (uint256) { return pendingRequestId; }
    function description() public view override returns (string memory) {
        return unicode"Weekly prize vault with buyback and burn. Hold 500+ tokens. / 每周奖池回购销毁";
    }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
        s.vaultType = "T";
        s.description = unicode"Weekly prize vault with buyback and burn / 每周奖池回购销毁";
        s.methods = new VaultMethodSchema[](0);
    }
}`,
    expectRules: [
      "buyback-split-not-implemented",
      "lottery-no-entrant-cap",
      "lottery-refund-no-restore",
      "ai-draw-fee-not-tracked",
      "pull-prize-event-in-fulfill",
      "lottery-no-entrants-spam",
      "ai-lottery-no-provider-disclosure",
      "ai-lottery-guardian-undisclosed",
      "vault-logic",
    ],
  },
  {
    name: "bad-prevrandao-winner",
    prompt: "weekly lottery",
    code: `${BASE}
    address[] public entrants;
    function drawWinner() external onlyManager {
        uint256 idx = uint256(block.prevrandao) % entrants.length;
        _sendNative(entrants[idx], address(this).balance);
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["no-block-randomness"],
  },
  {
    name: "bad-survivor-delete-snapshot-before-rebuild",
    prompt: "survivor elimination until one winner",
    code: `${BASE}
    mapping(address => bool) public hasEntered;
    address[] public entrants;
    address[] public drawSnapshot;
    uint256 public survivorPool;
    uint256 public pendingRequestId;
    function requestElimination() external onlyManager {
        require(entrants.length > 1, unicode"x / x");
        delete drawSnapshot;
        for (uint256 i = 0; i < entrants.length; i++) drawSnapshot.push(entrants[i]);
    }
    function _fulfillReasoning(uint256 requestId, uint8 choice) internal override {
        address eliminated = drawSnapshot[choice];
        hasEntered[eliminated] = false;
        if (drawSnapshot.length == 1) { _sendNative(drawSnapshot[0], survivorPool); }
        delete drawSnapshot;
        entrants = new address[](0);
        for (uint256 i = 0; i < drawSnapshot.length; i++) {
            if (hasEntered[drawSnapshot[i]]) entrants.push(drawSnapshot[i]);
        }
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["survivor-stale-snapshot-win", "survivor-rebuild-after-delete", "vault-logic"],
  },
  {
    name: "bad-stake-erases-pending-reward",
    prompt: "stake to earn",
    code: `${BASE}
    uint256 public totalStaked; uint256 public accRewardPerShare;
    struct UserInfo { uint256 amount; uint256 rewardDebt; }
    mapping(address => UserInfo) public userInfo;
    receive() external payable { if (totalStaked > 0) accRewardPerShare += msg.value * 1e18 / totalStaked; }
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, unicode"x / x");
        IERC20(taxToken).safeTransferFrom(msg.sender, address(this), amount);
        userInfo[msg.sender].amount += amount;
        totalStaked += amount;
        userInfo[msg.sender].rewardDebt = (userInfo[msg.sender].amount * accRewardPerShare) / 1e18;
    }
    function claimReward() external nonReentrant {
        uint256 pending = (userInfo[msg.sender].amount * accRewardPerShare) / 1e18 - userInfo[msg.sender].rewardDebt;
        userInfo[msg.sender].rewardDebt = (userInfo[msg.sender].amount * accRewardPerShare) / 1e18;
        _sendNative(msg.sender, pending);
    }
    function pendingReward(address) external view returns (uint256) { return 0; }
    function description() public view override returns (string memory) { return unicode"Guardian Rule 009 stake / 质押"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
        s.vaultType = "T"; s.description = unicode"Guardian emergency / 应急"; s.methods = new VaultMethodSchema[](0);
    }
}`,
    expectRules: ["stake-erases-pending-reward", "vault-logic"],
  },
  {
    name: "bad-pendingreward-claim-mismatch",
    prompt: "stake rewards",
    code: `${BASE}
    uint256 public totalStaked; uint256 public accRewardPerShare; uint256 public undistributedRewards;
    struct UserInfo { uint256 amount; uint256 rewardDebt; }
    mapping(address => UserInfo) public userInfo;
    receive() external payable { if (totalStaked == 0) undistributedRewards += msg.value; else accRewardPerShare += msg.value * 1e18 / totalStaked; }
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, unicode"x / x");
        if (totalStaked == 0 && undistributedRewards > 0) { accRewardPerShare += undistributedRewards * 1e18 / amount; undistributedRewards = 0; }
        userInfo[msg.sender].amount += amount; totalStaked += amount;
    }
    function claimReward() external nonReentrant {
        uint256 pending = (userInfo[msg.sender].amount * accRewardPerShare) / 1e18 - userInfo[msg.sender].rewardDebt;
        userInfo[msg.sender].rewardDebt = (userInfo[msg.sender].amount * accRewardPerShare) / 1e18;
        _sendNative(msg.sender, pending);
    }
    function pendingReward(address user) external view returns (uint256) {
        uint256 acc = accRewardPerShare;
        if (totalStaked > 0 && undistributedRewards > 0) acc += (undistributedRewards * 1e18) / totalStaked;
        return (userInfo[user].amount * acc) / 1e18 - userInfo[user].rewardDebt;
    }
    function description() public view override returns (string memory) { return unicode"Guardian Rule 009 stake / 质押"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
        s.vaultType = "T"; s.description = unicode"Guardian emergency / 应急"; s.methods = new VaultMethodSchema[](0);
    }
}`,
    expectRules: ["pendingreward-claim-mismatch", "vault-logic"],
  },
  {
    name: "bad-milestone-half-reward",
    prompt: "milestone burn vault register interest claim reward",
    code: `${BASE}
    uint256 public buybackBudget; uint256 public milestonePool; uint256 public milestoneIndex;
    uint256[] public milestoneTargets = [0.1 ether, 0.25 ether];
    mapping(address => uint256) public claimableRewards;
    mapping(uint256 => mapping(address => bool)) public registeredInterest;
    receive() external payable { buybackBudget += (msg.value * 60) / 100; milestonePool += msg.value - (msg.value * 60) / 100; }
    function registerInterest() external {
        registeredInterest[milestoneIndex][msg.sender] = true;
    }
    function advanceMilestone() external onlyManager {
        milestonePool = 0;
        milestoneIndex++;
        _buyAndBurn(buybackBudget, 0);
        buybackBudget = 0;
    }
    function claimReward() external nonReentrant {
        uint256 r = claimableRewards[msg.sender];
        require(r > 0, unicode"x / x");
        claimableRewards[msg.sender] = 0;
        _sendNative(msg.sender, r);
    }
    function currentMilestoneTarget() public view returns (uint256) { return milestoneTargets[milestoneIndex]; }
    function description() public view override returns (string memory) { return unicode"Guardian Rule 009 / 应急"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["claim-mapping-never-credited", "register-never-consumed", "half-implemented-reward-vault"],
  },
  // ── Phase 4 novel-mechanic fixtures: empty prompt + no vaultPlan proves
  // scanners fire from source structure alone (rule-derived, not kind-derived).
  {
    name: "novel-vote-allocation-lifecycle",
    prompt: "",
    code: `${BASE}
    uint256 public charityBucket;
    mapping(address => address) public charityVote;
    event VoteCast(address indexed voter, address indexed charity);
    receive() external payable { charityBucket += msg.value; }
    function voteForCharity(address charity) external nonReentrant {
        require(charity != address(0), unicode"Invalid charity / 无效地址");
        charityVote[msg.sender] = charity;
        emit VoteCast(msg.sender, charity);
    }
    function settleWeek(address winningCharity) external onlyManager nonReentrant {
        uint256 amt = charityBucket;
        charityBucket = 0;
        _sendNative(winningCharity, address(this).balance);
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: [
      "write-method-not-in-uischema",
      "pays-full-balance",
      "payout-no-recipient-check",
      "participation-never-consumed",
    ],
  },
  {
    name: "classic-receive-swap-still-blocked",
    prompt: "",
    code: `${BASE}
    uint256 public totalBurned;
    receive() external payable {
        if (msg.value == 0) return;
        totalBurned += _buyAndBurn(msg.value, 0);
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["receive-no-external-call", "zero-slippage"],
  },
  {
    name: "novel-user-token-custody-needs-guardian-disclosure",
    prompt: "",
    code: `${BASE}
    uint256 public totalCommitted;
    mapping(address => uint256) public committedOf;
    event Committed(address indexed user, uint256 amount);
    function commitTokens(uint256 amount) external nonReentrant {
        require(amount > 0, unicode"Zero / 零");
        uint256 beforeBal = IERC20(taxToken).balanceOf(address(this));
        IERC20(taxToken).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(taxToken).balanceOf(address(this)) - beforeBal;
        committedOf[msg.sender] += received;
        totalCommitted += received;
        emit Committed(msg.sender, received);
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["staking-guardian-trust-undisclosed"],
  },
  {
    name: "good-rewardpool-pattern",
    prompt: "stake dividend",
    code: `${BASE}
    uint256 public totalStaked; uint256 public accRewardPerShare; uint256 public rewardPool;
    struct UserInfo { uint256 amount; uint256 rewardDebt; }
    mapping(address => UserInfo) public userInfo;
    receive() external payable { rewardPool += msg.value; }
    function _updatePool() internal {
        if (totalStaked == 0) return;
        accRewardPerShare += rewardPool * 1e18 / totalStaked; rewardPool = 0;
    }
    function stake(uint256 amount) external {
        require(amount > 0, unicode"x / x");
        _updatePool(); totalStaked += amount;
    }
    function claimReward() external { _updatePool(); }
    function pendingReward(address) external view returns (uint256) { return 0; }
    function description() public view override returns (string memory) { return unicode"Guardian Rule 009 stake / 质押"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
        s.vaultType = "T"; s.description = unicode"Guardian emergency recovery / 应急"; s.methods = new VaultMethodSchema[](4);
        s.methods[0].name = "totalStaked"; s.methods[0].inputs = new FieldDescriptor[](0); s.methods[0].outputs = new FieldDescriptor[](1); s.methods[0].approvals = new ApproveAction[](0);
        s.methods[1].name = "accRewardPerShare"; s.methods[1].inputs = new FieldDescriptor[](0); s.methods[1].outputs = new FieldDescriptor[](1); s.methods[1].approvals = new ApproveAction[](0);
        s.methods[2].name = "rewardPool"; s.methods[2].inputs = new FieldDescriptor[](0); s.methods[2].outputs = new FieldDescriptor[](1); s.methods[2].approvals = new ApproveAction[](0);
        s.methods[3].name = "pendingReward"; s.methods[3].inputs = new FieldDescriptor[](1); s.methods[3].outputs = new FieldDescriptor[](1); s.methods[3].approvals = new ApproveAction[](0);
    }
}`,
    expectAbsent: [
      "stake-rewards-lost-no-stakers",
      "stake-pending-not-rolled",
      "stake-rewardpool-desync",
      "emergency-withdraws-staked",
      "emergency-drains-reserved",
      "excess-only-emergency-override",
      "stake-zero-amount",
      "stake-no-balance-delta",
      "stake-autopay-with-claim",
      "staking-guardian-trust-undisclosed",
      "vault-logic",
    ],
  },
];

let ok = true;
for (const c of cases) {
  if (!assertCase(c)) ok = false;
}
console.log(ok ? "\nAll scanner self-checks passed." : "\nSome scanner self-checks FAILED.");
process.exit(ok ? 0 : 1);
