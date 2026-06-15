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
        _sendNative(to, address(this).balance);
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectRules: ["emergency-drains-reserved", "vault-logic"],
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
    function stake(uint256 amount) external { _updatePool(); totalStaked += amount; }
    function claimReward() external { _updatePool(); }
    function pendingReward(address) external view returns (uint256) { return 0; }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`,
    expectAbsent: [
      "stake-rewards-lost-no-stakers",
      "stake-pending-not-rolled",
      "stake-rewardpool-desync",
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
