// Provenance: the exact child source of a QuestProofRewardVault that the pipeline
// generated and passed — compile, scanners, fork tests, spec audit and economic
// critic all green — while being insolvent by construction. Kept verbatim (only
// this header added) so the ledger scanner is regression-tested against the real
// thing and not just a hand-trimmed approximation of it.
//
// The bug: approveSubmission() releases totalReservedForQuests and credits
// _claimableRewards without debiting rewardBucket, while createQuest() treats
// `rewardBucket - totalReservedForQuests` as free funds. Every approval hands the
// manager back budget that is already owed, so a second quest can be funded with
// the first cohort's rewards and the last claimer reverts.
//
// Do not "fix" this file. Its whole job is to stay broken.
contract QuestProofRewardVault is CodegenVaultBase {
    // Only two REAL, manager-controlled quest states exist. There is intentionally NO "Filled"
    // state: reaching the approval cap is a pure counter comparison inside approveSubmission and
    // must NEVER change quest.state, otherwise submitProof (which gates on state == Open) would
    // permanently lock out further activity. The ONLY function that deactivates a quest is
    // closeQuest, and it atomically releases every other still-pending submitter in the same
    // transaction (see below). Approved users have their OWN unconditional exits
    // (abandonApproval / claimReward) that never depend on quest.state at all.
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
    mapping(uint256 => mapping(address => bytes32)) private _submissions;
    mapping(uint256 => mapping(address => uint256)) private _claimableRewards;
    // Per-quest bounded roster of everyone who has ever submitted — used ONLY so that when the
    // manager deactivates a quest via closeQuest, we can find and release every OTHER
    // still-pending (Submitted) submitter back to NotSubmitted in the SAME transaction,
    // guaranteeing no assigned user is ever left stuck referencing a deactivated quest.
    mapping(uint256 => address[]) private _submitterList;
    mapping(uint256 => mapping(address => bool)) private _hasSubmittedBefore;
    event BucketFunded(string bucket, uint256 amount);
    event QuestCreated(uint256 indexed questId, uint256 rewardPerApproval, uint256 maxApprovals, uint256 deadline);
    event ProofSubmitted(uint256 indexed questId, address indexed caller, bytes32 proofHash);
    event SubmissionCancelled(uint256 indexed questId, address indexed caller);
    event SubmissionApproved(uint256 indexed questId, address indexed user, uint256 amount);
    event SubmissionRejected(uint256 indexed questId, address indexed user);
    event ApprovalAbandoned(uint256 indexed questId, address indexed user, uint256 amount);
    event QuestClosed(uint256 indexed questId, uint256 unusedReservationReleased);
    event RewardClaimed(uint256 indexed questId, address indexed caller, uint256 amount);
    constructor(address _taxToken, address _creator, address _factory)
        CodegenVaultBase(_taxToken, _creator, _factory)
    {}
    receive() external payable {
        if (msg.value == 0) return;
        rewardBucket += msg.value;
        emit BucketFunded("rewardBucket", msg.value);
    }
    function createQuest(uint256 rewardPerApproval, uint256 maxApprovals, uint256 deadline) external onlyManager {
        require(rewardPerApproval > 0, unicode"Reward per approval must be > 0 / 单次批准奖励必须大于0");
        require(maxApprovals > 0, unicode"Max approvals must be > 0 / 最大批准数必须大于0");
        require(deadline == 0 || deadline > block.timestamp, unicode"Invalid deadline / 截止时间无效");
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
        emit QuestCreated(questId, rewardPerApproval, maxApprovals, deadline);
    }
    // User action: submit a proof commitment for an Open, non-expired quest. Reaching the
    // approval cap does NOT close a quest, so submitProof stays available until the manager
    // explicitly calls closeQuest (or the deadline passes) — it never silently locks out users.
    function submitProof(uint256 questId, bytes32 proofHash) external {
        require(questId < questCount, unicode"Quest does not exist / 任务不存在");
        Quest storage q = _quests[questId];
        require(q.state == QuestState.Open, unicode"Quest not open / 任务未开放");
        require(q.deadline == 0 || block.timestamp <= q.deadline, unicode"Quest deadline passed / 任务已过期");
        require(proofHash != bytes32(0), unicode"Proof hash required / 需要证明哈希");
        require(_userQuestState[questId][msg.sender] == UserState.NotSubmitted, unicode"Already submitted / 已提交");
        if (!_hasSubmittedBefore[questId][msg.sender]) {
            require(
                _submitterList[questId].length < MAX_SUBMITTERS_PER_QUEST,
                unicode"Too many submitters for this quest / 该任务提交者过多"
            );
            _submitterList[questId].push(msg.sender);
            _hasSubmittedBefore[questId][msg.sender] = true;
        }
        _submissions[questId][msg.sender] = proofHash;
        _userQuestState[questId][msg.sender] = UserState.Submitted;
        emit ProofSubmitted(questId, msg.sender, proofHash);
    }
    // ------------------------------------------------------------------------------------------
    // RULE 001 EXIT #1 — UNCONDITIONAL ABANDON PATH BEFORE APPROVAL
    // The caller can ALWAYS withdraw their own pending (not-yet-approved) submission, no matter
    // whether the quest is still Open, has been Closed by the manager, or is past its deadline.
    // This function performs NO quest-state or deadline check at all.
    // ------------------------------------------------------------------------------------------
    function cancelSubmission(uint256 questId) external {
        require(questId < questCount, unicode"Quest does not exist / 任务不存在");
        require(_userQuestState[questId][msg.sender] == UserState.Submitted, unicode"No pending submission / 无待处理提交");
        _submissions[questId][msg.sender] = bytes32(0);
        _userQuestState[questId][msg.sender] = UserState.NotSubmitted;
        emit SubmissionCancelled(questId, msg.sender);
    }
    // Manager action: approve a specific submitter's proof. The approval cap is enforced as a
    // PURE COUNTER CHECK (approvalsCount < maxApprovals) and NEVER mutates quest.state — reaching
    // the cap must not deactivate the quest or block other users' submitProof/cancelSubmission.
    function approveSubmission(uint256 questId, address user) external onlyManager {
        require(questId < questCount, unicode"Quest does not exist / 任务不存在");
        require(user != address(0), unicode"Invalid user / 无效用户");
        Quest storage q = _quests[questId];
        require(q.state == QuestState.Open, unicode"Quest not open / 任务未开放");
        require(q.deadline == 0 || block.timestamp <= q.deadline, unicode"Quest deadline passed / 任务已过期");
        // Verify the approved address is actually the pending submitter before crediting anything.
        require(_userQuestState[questId][user] == UserState.Submitted, unicode"User has not submitted / 用户尚未提交");
        require(q.approvalsCount < q.maxApprovals, unicode"Approval cap reached / 已达批准上限");
        uint256 reward = q.rewardPerApproval;
        // Reserve into the per-user claimable balance: decrement the funding-side reservation
        // counter and credit the user's claimable mapping (Rule 001 — never a shared pool at claim time).
        _claimableRewards[questId][user] += reward;
        q.approvalsCount += 1;
        totalReservedForQuests -= reward;
        _userQuestState[questId][user] = UserState.Approved;
        emit SubmissionApproved(questId, user, reward);
    }
    function rejectSubmission(uint256 questId, address user) external onlyManager {
        require(questId < questCount, unicode"Quest does not exist / 任务不存在");
        require(_userQuestState[questId][user] == UserState.Submitted, unicode"User has not submitted / 用户尚未提交");
        _submissions[questId][user] = bytes32(0);
        _userQuestState[questId][user] = UserState.NotSubmitted;
        emit SubmissionRejected(questId, user);
    }
    // ------------------------------------------------------------------------------------------
    // RULE 001 EXIT #2 — UNCONDITIONAL ABANDON PATH AFTER APPROVAL
    // An approved user is NEVER forced to either claim or stay stuck: they may voluntarily
    // release their own approved assignment at any time before claiming. This performs NO
    // quest-state check at all (works whether the quest is Open, Closed, or past its deadline),
    // so an approved user can always clear their own per-quest state and go free (or resubmit).
    // If the quest is still Open, the freed approval slot and its reward budget are returned to
    // the quest so the manager can approve a different submitter with those same funds; if the
    // quest has been closed, the amount is simply released back into the unallocated bucket
    // (the slot cannot be reused because the quest can no longer accept new approvals).
    // This does NOT touch any other user's submission, approval, or claimable state.
    // ------------------------------------------------------------------------------------------
    function abandonApproval(uint256 questId) external {
        require(questId < questCount, unicode"Quest does not exist / 任务不存在");
        require(_userQuestState[questId][msg.sender] == UserState.Approved, unicode"Not an approved assignee / 非已批准的分配者");
        uint256 amount = _claimableRewards[questId][msg.sender];
        require(amount > 0, unicode"Nothing to abandon / 无可放弃的奖励");
        _claimableRewards[questId][msg.sender] = 0;
        _userQuestState[questId][msg.sender] = UserState.NotSubmitted;
        Quest storage q = _quests[questId];
        if (q.state == QuestState.Open) {
            q.approvalsCount -= 1;
            totalReservedForQuests += amount;
        }
        emit ApprovalAbandoned(questId, msg.sender, amount);
    }
    // Manager exit path: stop new submissions/approvals for a quest. Already-credited
    // claimableRewards are NEVER reversed here — approved users can always still claimReward
    // (or abandonApproval). This is the ONLY function that deactivates a quest, and it atomically
    // releases every other pending (Submitted) submitter in the SAME transaction so nobody is
    // ever left stuck referencing a deactivated quest.
    function closeQuest(uint256 questId) external onlyManager {
        require(questId < questCount, unicode"Quest does not exist / 任务不存在");
        Quest storage q = _quests[questId];
        require(q.state == QuestState.Open, unicode"Quest not open / 任务未开放");
        uint256 unused = q.rewardPerApproval * (q.maxApprovals - q.approvalsCount);
        q.state = QuestState.Closed;
        totalReservedForQuests -= unused;
        // ----------------------------------------------------------------------------------
        // RULE 001 EXIT GUARANTEE — DEACTIVATION CLEARS OTHER PENDING ASSIGNMENTS (INLINE, ATOMIC)
        // Closing the quest must never trap any other assigned user. Walk every address that
        // ever submitted to this quest and reset any still-pending (Submitted) submitter back
        // to NotSubmitted so they can walk away or submit to a different quest. Already-Approved
        // users are untouched here — they retain their own unconditional exits
        // (abandonApproval / claimReward) regardless of this closure.
        // ----------------------------------------------------------------------------------
        address[] storage closeSubmitters = _submitterList[questId];
        uint256 closeLen = closeSubmitters.length;
        for (uint256 i = 0; i < closeLen; i++) {
            address pendingUser = closeSubmitters[i];
            if (_userQuestState[questId][pendingUser] == UserState.Submitted) {
                _submissions[questId][pendingUser] = bytes32(0);
                _userQuestState[questId][pendingUser] = UserState.NotSubmitted;
                emit SubmissionCancelled(questId, pendingUser);
            }
        }
        emit QuestClosed(questId, unused);
    }
    // ------------------------------------------------------------------------------------------
    // RULE 001 EXIT #3 — UNCONDITIONAL CLAIM (terminal exit for approved users)
    // Pull payment: pays ONLY the caller's own reserved claimable amount for this quest, never
    // a shared pool. Performs NO quest-state check — approved-but-unclaimed users can always
    // claim regardless of whether the quest later closes or expires.
    // ------------------------------------------------------------------------------------------
    function claimReward(uint256 questId) external nonReentrant {
        require(questId < questCount, unicode"Quest does not exist / 任务不存在");
        uint256 amount = _claimableRewards[questId][msg.sender];
        require(amount > 0, unicode"Nothing to claim / 无可领取奖励");
        require(rewardBucket >= amount, unicode"Insufficient bucket balance / 资金池余额不足");
        // State updated BEFORE the native transfer (checks-effects-interactions).
        _claimableRewards[questId][msg.sender] = 0;
        rewardBucket -= amount;
        _userQuestState[questId][msg.sender] = UserState.Claimed;
        _sendNative(msg.sender, amount);
        emit RewardClaimed(questId, msg.sender, amount);
    }
    function getQuest(uint256 questId) public view returns (Quest memory) {
        require(questId < questCount, unicode"Quest does not exist / 任务不存在");
        return _quests[questId];
    }
    function getUserQuestState(uint256 questId, address user) public view returns (uint8) {
        return uint8(_userQuestState[questId][user]);
    }
    function claimableRewards(uint256 questId, address user) public view returns (uint256) {
        return _claimableRewards[questId][user];
    }
    function submissions(uint256 questId, address user) public view returns (bytes32) {
        return _submissions[questId][user];
    }
    function description() public pure override returns (string memory) {
        return unicode"Quest-and-proof reward vault: users submit an on-chain proof hash for a manager-created quest; the manager approves or rejects each submission, and approved users pull a fixed reward-per-approval from a rewardBucket funded entirely by trade tax BNB. Quest budgets are capped and reserved at creation so the manager cannot over-promise beyond available funds. Reaching a quest's approval cap is a pure counter check and never deactivates the quest -- users may keep submitting proofs (they simply cannot be approved once the cap is reached), and can ALWAYS abandon a pending (unapproved) submission via cancelSubmission, unconditionally, regardless of quest state or deadline. Approved users have their OWN unconditional exit: they can either claimReward (pull their guaranteed BNB reward) or voluntarily abandonApproval (release the assignment and, if the quest is still open, free the slot and budget for another submitter) at any time before claiming -- an approved user can never be permanently stuck. The ONLY way a quest is deactivated is the manager's explicit closeQuest call, which atomically, in the same transaction, releases every other still-pending submitter back to not-submitted -- so nobody is ever left stuck referencing a deactivated quest. Guardian emergency withdraw (Flap Rule 009) can drain the entire rewardBucket, including funds already reserved for approved-but-unclaimed users -- this reach is inherent to the emergency escape hatch and should only be used for genuine incidents. / 任务证明奖励金库：用户为管理员创建的任务提交链上证明哈希；管理员批准或拒绝每次提交，已批准用户从完全由交易税BNB注资的奖励池中领取固定的单次批准奖励。任务预算在创建时封顶并预留，防止管理员超额承诺。达到任务的批准上限只是一个纯计数检查，不会使任务失效——用户仍可继续提交证明（只是无法再被批准），并且可以通过cancelSubmission随时无条件撤回尚未被批准的提交，无论任务状态或截止时间如何。已批准的用户拥有自己独立的无条件退出方式：既可以claimReward领取保证的BNB奖励，也可以在领取前随时通过abandonApproval自愿放弃该分配（若任务仍处于开放状态，会释放名额与预算供其他提交者使用）——已批准用户永远不会被永久困住。任务失效的唯一方式是管理员显式调用closeQuest，该操作会在同一笔交易中原子性地将所有其他仍处于待处理状态的提交者释放回未提交状态——确保没有人被困在已失效的任务上。担保人紧急提款（Flap规则009）可提取奖励池全部资金，包括已批准但未领取的部分——这是紧急提款机制固有的能力范围，仅应用于真实紧急情况。";
    }
    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "QuestProofRewardVault";
        schema.description = unicode"Submit quest proofs, get manager approval, and claim BNB rewards from tax income. / 提交任务证明，获得管理员批准后从税收资金中领取BNB奖励。";
        schema.methods = new VaultMethodSchema[](15);
        schema.methods[0].name = "submitProof";
        schema.methods[0].description = unicode"Submit a proof hash for a quest. / 为任务提交证明哈希。";
        schema.methods[0].isWriteMethod = true;
        schema.methods[0].inputs = new FieldDescriptor[](2);
        schema.methods[0].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[0].inputs[1] = FieldDescriptor("proofHash", "bytes32", "Proof hash/commitment", 0);
        schema.methods[0].outputs = new FieldDescriptor[](0);
        schema.methods[0].approvals = new ApproveAction[](0);
        schema.methods[1].name = "cancelSubmission";
        schema.methods[1].description = unicode"Abandon path (before approval): withdraw your own pending submission at any time, unconditionally. / 提前撤回路径：随时无条件撤回你自己尚未被批准的提交。";
        schema.methods[1].isWriteMethod = true;
        schema.methods[1].inputs = new FieldDescriptor[](1);
        schema.methods[1].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[1].outputs = new FieldDescriptor[](0);
        schema.methods[1].approvals = new ApproveAction[](0);
        schema.methods[2].name = "claimReward";
        schema.methods[2].description = unicode"Claim your approved reward for a quest (works even if the quest is later closed). / 领取你在某任务上已批准的奖励（即使任务之后被关闭也可领取）。";
        schema.methods[2].isWriteMethod = true;
        schema.methods[2].inputs = new FieldDescriptor[](1);
        schema.methods[2].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[2].outputs = new FieldDescriptor[](0);
        schema.methods[2].approvals = new ApproveAction[](0);
        schema.methods[3].name = "createQuest";
        schema.methods[3].description = unicode"Manager-only: create a new quest with reward-per-approval and approval cap. / 仅管理员：创建新任务，设定单次批准奖励与批准上限。";
        schema.methods[3].isWriteMethod = true;
        schema.methods[3].inputs = new FieldDescriptor[](3);
        schema.methods[3].inputs[0] = FieldDescriptor("rewardPerApproval", "uint256", "BNB reward per approval", 18);
        schema.methods[3].inputs[1] = FieldDescriptor("maxApprovals", "uint256", "Maximum number of approvals", 0);
        schema.methods[3].inputs[2] = FieldDescriptor("deadline", "uint256", "Deadline timestamp, 0 = none", 0);
        schema.methods[3].outputs = new FieldDescriptor[](0);
        schema.methods[3].approvals = new ApproveAction[](0);
        schema.methods[4].name = "approveSubmission";
        schema.methods[4].description = unicode"Manager-only: approve a user's submission for a quest, crediting their reward; reaching the approval cap does not close the quest. / 仅管理员：批准某用户在某任务上的提交并记入其奖励；达到批准上限不会关闭任务。";
        schema.methods[4].isWriteMethod = true;
        schema.methods[4].inputs = new FieldDescriptor[](2);
        schema.methods[4].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[4].inputs[1] = FieldDescriptor("user", "address", "User address to approve", 0);
        schema.methods[4].outputs = new FieldDescriptor[](0);
        schema.methods[4].approvals = new ApproveAction[](0);
        schema.methods[5].name = "rejectSubmission";
        schema.methods[5].description = unicode"Manager-only: reject a user's submission for a quest, freeing them to resubmit. / 仅管理员：拒绝某用户在某任务上的提交，使其可重新提交。";
        schema.methods[5].isWriteMethod = true;
        schema.methods[5].inputs = new FieldDescriptor[](2);
        schema.methods[5].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[5].inputs[1] = FieldDescriptor("user", "address", "User address to reject", 0);
        schema.methods[5].outputs = new FieldDescriptor[](0);
        schema.methods[5].approvals = new ApproveAction[](0);
        schema.methods[6].name = "abandonApproval";
        schema.methods[6].description = unicode"Abandon path (after approval): voluntarily release your own approved assignment before claiming; frees the slot back to the quest if still open. / 批准后放弃路径：在领取前自愿放弃你自己已批准的分配；若任务仍开放，则释放名额。";
        schema.methods[6].isWriteMethod = true;
        schema.methods[6].inputs = new FieldDescriptor[](1);
        schema.methods[6].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[6].outputs = new FieldDescriptor[](0);
        schema.methods[6].approvals = new ApproveAction[](0);
        schema.methods[7].name = "closeQuest";
        schema.methods[7].description = unicode"Manager-only: the only deactivation path for a quest — stops new submissions/approvals and atomically releases any other pending submitters; already-approved users can still claim or abandon. / 仅管理员：任务唯一的失效路径——停止新提交/新批准，并原子性地释放其他待处理提交者；已批准用户仍可领取或放弃。";
        schema.methods[7].isWriteMethod = true;
        schema.methods[7].inputs = new FieldDescriptor[](1);
        schema.methods[7].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[7].outputs = new FieldDescriptor[](0);
        schema.methods[7].approvals = new ApproveAction[](0);
        schema.methods[8].name = "getQuest";
        schema.methods[8].description = unicode"Full state of a quest. / 任务的完整状态。";
        schema.methods[8].inputs = new FieldDescriptor[](1);
        schema.methods[8].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[8].outputs = new FieldDescriptor[](1);
        schema.methods[8].outputs[0] = FieldDescriptor("quest", "tuple", "Quest struct: state (0=Open,1=Closed), rewardPerApproval, maxApprovals, approvalsCount, deadline", 0);
        schema.methods[8].approvals = new ApproveAction[](0);
        schema.methods[9].name = "getUserQuestState";
        schema.methods[9].description = unicode"A given user's state for a quest (0=NotSubmitted,1=Submitted,2=Approved,3=Claimed). / 某用户在某任务上的状态。";
        schema.methods[9].inputs = new FieldDescriptor[](2);
        schema.methods[9].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[9].inputs[1] = FieldDescriptor("user", "address", "User address", 0);
        schema.methods[9].outputs = new FieldDescriptor[](1);
        schema.methods[9].outputs[0] = FieldDescriptor("state", "uint8", "User state enum", 0);
        schema.methods[9].approvals = new ApproveAction[](0);
        schema.methods[10].name = "claimableRewards";
        schema.methods[10].description = unicode"Claimable BNB for a user on a quest. / 某用户在某任务上可领取的BNB。";
        schema.methods[10].inputs = new FieldDescriptor[](2);
        schema.methods[10].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[10].inputs[1] = FieldDescriptor("user", "address", "User address", 0);
        schema.methods[10].outputs = new FieldDescriptor[](1);
        schema.methods[10].outputs[0] = FieldDescriptor("amount", "uint256", "Claimable BNB amount", 18);
        schema.methods[10].approvals = new ApproveAction[](0);
        schema.methods[11].name = "rewardBucket";
        schema.methods[11].description = unicode"Current rewardBucket BNB balance funded by trade tax. / 由交易税注资的当前奖励池BNB余额。";
        schema.methods[11].inputs = new FieldDescriptor[](0);
        schema.methods[11].outputs = new FieldDescriptor[](1);
        schema.methods[11].outputs[0] = FieldDescriptor("amount", "uint256", "Reward bucket balance in BNB", 18);
        schema.methods[11].approvals = new ApproveAction[](0);
        schema.methods[12].name = "totalReservedForQuests";
        schema.methods[12].description = unicode"Total unused reservation across open quests. / 所有开放任务的未使用预留总额。";
        schema.methods[12].inputs = new FieldDescriptor[](0);
        schema.methods[12].outputs = new FieldDescriptor[](1);
        schema.methods[12].outputs[0] = FieldDescriptor("amount", "uint256", "Total reserved BNB", 18);
        schema.methods[12].approvals = new ApproveAction[](0);
        schema.methods[13].name = "questCount";
        schema.methods[13].description = unicode"Total number of quests created. / 已创建的任务总数。";
        schema.methods[13].inputs = new FieldDescriptor[](0);
        schema.methods[13].outputs = new FieldDescriptor[](1);
        schema.methods[13].outputs[0] = FieldDescriptor("count", "uint256", "Quest count", 0);
        schema.methods[13].approvals = new ApproveAction[](0);
        schema.methods[14].name = "submissions";
        schema.methods[14].description = unicode"A user's stored proof hash for a quest. / 某用户在某任务上存储的证明哈希。";
        schema.methods[14].inputs = new FieldDescriptor[](2);
        schema.methods[14].inputs[0] = FieldDescriptor("questId", "uint256", "Quest ID", 0);
        schema.methods[14].inputs[1] = FieldDescriptor("user", "address", "User address", 0);
        schema.methods[14].outputs = new FieldDescriptor[](1);
        schema.methods[14].outputs[0] = FieldDescriptor("proofHash", "bytes32", "Stored proof hash", 0);
        schema.methods[14].approvals = new ApproveAction[](0);
    }
}
</user_query>