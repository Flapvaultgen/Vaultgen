/**
 * Regression fixture: a real generated vault that passed every gate in the
 * pipeline (compile, scanners, fork tests, spec audit, economic critic) and was
 * still insolvent by construction.
 *
 * The bug: approveSubmission() moves an amount out of totalReservedForQuests
 * and into _claimableRewards without touching rewardBucket, and createQuest()
 * computes free funds as `rewardBucket - totalReservedForQuests`. Every approval
 * therefore hands the manager back budget that is already owed to an approved
 * user, so a second quest can be funded with the first cohort's rewards and the
 * users who claim last revert on `require(rewardBucket >= amount)`.
 *
 * Trimmed to the accounting surface: the schema, events and bilingual strings
 * are not what any of these checks read, and keeping them would bury the part
 * that matters. FIXED_ variants below are the same mechanic with each accepted
 * remedy applied, and must scan clean — a rule that cannot tell the broken
 * shape from the fixed one is worthless.
 */

const HEAD = `contract QuestProofRewardVault is CodegenVaultBase {
    enum QuestState { Open, Closed }
    enum UserState { NotSubmitted, Submitted, Approved, Claimed }

    struct Quest {
        QuestState state;
        uint256 rewardPerApproval;
        uint256 maxApprovals;
        uint256 approvalsCount;
        uint256 deadline;
    }

    uint256 private constant MAX_SUBMITTERS_PER_QUEST = 500;

    uint256 public rewardBucket;
    uint256 public totalReservedForQuests;
    uint256 public questCount;

    mapping(uint256 => Quest) private _quests;
    mapping(uint256 => mapping(address => UserState)) private _userQuestState;
    mapping(uint256 => mapping(address => uint256)) private _claimableRewards;

    receive() external payable {
        if (msg.value == 0) return;
        rewardBucket += msg.value;
    }
`;

const CREATE_QUEST = `
    function createQuest(uint256 rewardPerApproval, uint256 maxApprovals, uint256 deadline) external onlyManager {
        uint256 totalBudget = rewardPerApproval * maxApprovals;
        uint256 available = rewardBucket - totalReservedForQuests;
        require(available >= totalBudget, unicode"Insufficient unallocated bucket balance / 未分配资金不足");
        uint256 questId = questCount;
        questCount += 1;
        _quests[questId] = Quest({
            state: QuestState.Open,
            rewardPerApproval: rewardPerApproval,
            maxApprovals: maxApprovals,
            approvalsCount: 0,
            deadline: deadline
        });
        totalReservedForQuests += totalBudget;
    }
`;

const CLAIM_AND_VIEWS = `
    function claimReward(uint256 questId) external nonReentrant {
        uint256 amount = _claimableRewards[questId][msg.sender];
        require(amount > 0, unicode"Nothing to claim / 无可领取奖励");
        require(rewardBucket >= amount, unicode"Insufficient bucket balance / 资金池余额不足");
        _claimableRewards[questId][msg.sender] = 0;
        rewardBucket -= amount;
        _userQuestState[questId][msg.sender] = UserState.Claimed;
        _sendNative(msg.sender, amount);
    }

    function description() public pure override returns (string memory) {
        return unicode"Quest reward vault / 任务奖励金库";
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "QuestProofRewardVault";
        schema.description = unicode"Quest rewards / 任务奖励";
        schema.methods = new VaultMethodSchema[](0);
    }
}`;

/** The shipped (broken) approval: releases the reservation, tracks nothing. */
export const BROKEN_QUEST_PROOF_REWARD_VAULT = `${HEAD}${CREATE_QUEST}
    function approveSubmission(uint256 questId, address user) external onlyManager {
        Quest storage q = _quests[questId];
        require(_userQuestState[questId][user] == UserState.Submitted, unicode"User has not submitted / 用户尚未提交");
        require(q.approvalsCount < q.maxApprovals, unicode"Approval cap reached / 已达批准上限");
        uint256 reward = q.rewardPerApproval;
        _claimableRewards[questId][user] += reward;
        q.approvalsCount += 1;
        totalReservedForQuests -= reward;
        _userQuestState[questId][user] = UserState.Approved;
    }
${CLAIM_AND_VIEWS}`;

/** Remedy (a): debit the bucket at the moment the user is credited. */
export const FIXED_BY_DEBITING_BUCKET = `${HEAD}${CREATE_QUEST}
    function approveSubmission(uint256 questId, address user) external onlyManager {
        Quest storage q = _quests[questId];
        require(_userQuestState[questId][user] == UserState.Submitted, unicode"User has not submitted / 用户尚未提交");
        require(q.approvalsCount < q.maxApprovals, unicode"Approval cap reached / 已达批准上限");
        uint256 reward = q.rewardPerApproval;
        rewardBucket -= reward;
        _claimableRewards[questId][user] += reward;
        q.approvalsCount += 1;
        totalReservedForQuests -= reward;
        _userQuestState[questId][user] = UserState.Approved;
    }
${CLAIM_AND_VIEWS}`;

/**
 * Not a quest vault, and not broken: the index-based staking shape. It credits a
 * per-user liability without debiting the bucket (the debit happens at claim
 * time) and guards the claim with `require(rewardBucket >= amount)`. Nothing
 * ever allocates against a free balance, so the ledger rule must stay silent —
 * this is the fixture that keeps the rule from firing on half the vaults Flap
 * users actually launch.
 */
export const STAKING_INDEX_VAULT_CLEAN = `contract StakingRewardVault is CodegenVaultBase {
    uint256 public rewardBucket;
    uint256 public accRewardPerShare;
    uint256 public totalStaked;

    mapping(address => uint256) public stakedAmount;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public pendingRewards;

    receive() external payable {
        if (msg.value == 0) return;
        rewardBucket += msg.value;
        if (totalStaked > 0) accRewardPerShare += (msg.value * 1e18) / totalStaked;
    }

    function _settle(address user) internal {
        uint256 accrued = (stakedAmount[user] * accRewardPerShare) / 1e18;
        uint256 owed = accrued - rewardDebt[user];
        if (owed > 0) pendingRewards[user] += owed;
        rewardDebt[user] = accrued;
    }

    function stake(uint256 amount) external nonReentrant {
        _settle(msg.sender);
        stakedAmount[msg.sender] += amount;
        totalStaked += amount;
    }

    function claimRewards() external nonReentrant {
        _settle(msg.sender);
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, unicode"Nothing to claim / 无可领取奖励");
        require(rewardBucket >= amount, unicode"Insufficient bucket balance / 资金池余额不足");
        pendingRewards[msg.sender] = 0;
        rewardBucket -= amount;
        _sendNative(msg.sender, amount);
    }

    function description() public pure override returns (string memory) {
        return unicode"Staking vault / 质押金库";
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "StakingRewardVault";
        schema.description = unicode"Staking / 质押";
        schema.methods = new VaultMethodSchema[](0);
    }
}`;

/** Remedy (b): keep an aggregate of what is owed and subtract it from free funds. */
export const FIXED_BY_AGGREGATE_COUNTER = `${HEAD}
    uint256 public totalOwedToUsers;

    function createQuest(uint256 rewardPerApproval, uint256 maxApprovals, uint256 deadline) external onlyManager {
        uint256 totalBudget = rewardPerApproval * maxApprovals;
        uint256 available = rewardBucket - totalReservedForQuests - totalOwedToUsers;
        require(available >= totalBudget, unicode"Insufficient unallocated bucket balance / 未分配资金不足");
        uint256 questId = questCount;
        questCount += 1;
        _quests[questId] = Quest({
            state: QuestState.Open,
            rewardPerApproval: rewardPerApproval,
            maxApprovals: maxApprovals,
            approvalsCount: 0,
            deadline: deadline
        });
        totalReservedForQuests += totalBudget;
    }

    function approveSubmission(uint256 questId, address user) external onlyManager {
        Quest storage q = _quests[questId];
        require(_userQuestState[questId][user] == UserState.Submitted, unicode"User has not submitted / 用户尚未提交");
        require(q.approvalsCount < q.maxApprovals, unicode"Approval cap reached / 已达批准上限");
        uint256 reward = q.rewardPerApproval;
        _claimableRewards[questId][user] += reward;
        totalOwedToUsers += reward;
        q.approvalsCount += 1;
        totalReservedForQuests -= reward;
        _userQuestState[questId][user] = UserState.Approved;
    }

    function claimReward(uint256 questId) external nonReentrant {
        uint256 amount = _claimableRewards[questId][msg.sender];
        require(amount > 0, unicode"Nothing to claim / 无可领取奖励");
        _claimableRewards[questId][msg.sender] = 0;
        totalOwedToUsers -= amount;
        rewardBucket -= amount;
        _userQuestState[questId][msg.sender] = UserState.Claimed;
        _sendNative(msg.sender, amount);
    }

    function description() public pure override returns (string memory) {
        return unicode"Quest reward vault / 任务奖励金库";
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "QuestProofRewardVault";
        schema.description = unicode"Quest rewards / 任务奖励";
        schema.methods = new VaultMethodSchema[](0);
    }
}`;
