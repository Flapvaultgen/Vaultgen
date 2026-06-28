/**
 * Self-check for novel-mechanic completeness scanners.
 * Run: npx tsx mechanic-completeness-selfcheck.mts
 */
import { scanMechanicCompleteness } from "./mechanic-completeness.ts";

const BASE = `contract TestVault is CodegenVaultBase {
    constructor(address a, address b, address c) CodegenVaultBase(a, b, c) {}
`;

function assert(name: string, code: string, prompt: string, expectRules: string[]) {
  const rules = scanMechanicCompleteness(code, prompt).map((f) => f.rule);
  const missing = expectRules.filter((r) => !rules.includes(r));
  if (missing.length) {
    console.error(`FAIL ${name}: missing [${missing.join(", ")}]; got [${rules.join(", ")}]`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK ${name}`);
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

if (process.exitCode) {
  console.error("\nMechanic completeness self-check FAILED.");
  process.exit(1);
}
console.log("\nMechanic completeness self-checks passed.");
