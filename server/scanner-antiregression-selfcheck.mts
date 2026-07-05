/**
 * Phase 4 anti-regression self-check: prove the scanner/patch/repair loop is
 * rule/structure-derived, not VaultKind-derived.
 *
 * Proves:
 *  1. applyCommonCodegenPatches never invents product mechanics (no weeklyJackpot,
 *     jackpot, buybackBudget, executeBuyback, or 50/50 msg.value splits).
 *  2. Rule 005 receive() violations surface as scanner findings (LLM repair path)
 *     instead of being silently mutated into a buyback/jackpot product.
 *  3. Major scanner checks fire with NO vaultPlan and an EMPTY prompt
 *     (oracle, trigger-service, custody, schema-symmetry, claim-credit checks).
 *  4. Spec-named buckets are preserved untouched and produce no false positives.
 *  5. Every scanner finding name maps to a Flap constitution rule (001–009).
 *  6. The scanner source itself contains no VaultKind gating.
 *
 * Run: npx tsx scanner-antiregression-selfcheck.mts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSafety, applyCommonCodegenPatches } from "./codegen.ts";
import { scanMechanicCompleteness } from "./mechanic-completeness.ts";
import { FLAP_RULE_IDS, mapScannerFindingToRuleId } from "./constitution.ts";

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

const BASE = `contract TestVault is CodegenVaultBase {
    constructor(address a, address b, address c) CodegenVaultBase(a, b, c) {}
`;

const observedFindingNames = new Set<string>();
function blockRules(code: string, prompt = ""): string[] {
  // Deliberately NO vaultPlan: every check asserted here must fire kind-free.
  const rules = scanSafety(code, "TestVault", prompt)
    .findings.filter((f) => f.level === "block")
    .map((f) => f.rule);
  for (const r of rules) observedFindingNames.add(r);
  return rules;
}

// ── 1 + 2. Patch neutralization: receive() swap is a finding, not an invented mechanic ──
const receiveSwapSource = `${BASE}
    uint256 public totalBurned;
    receive() external payable {
        if (msg.value == 0) return;
        totalBurned += _buyAndBurn(msg.value, 0);
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`;
const patched = applyCommonCodegenPatches(receiveSwapSource);
const inventedVocabulary = [/weeklyJackpot/, /\bjackpot\b/, /buybackBudget/, /executeBuyback/, /msg\.value\s*\/\s*2/];
for (const re of inventedVocabulary) {
  check(`patch-does-not-invent:${re.source}`, !re.test(patched), `patch introduced ${re}`);
}
check("patch-leaves-receive-swap-unmodified", patched === receiveSwapSource);
check(
  "rule005-still-blocked-after-patch",
  blockRules(patched).includes("receive-no-external-call"),
  "receive() swap must surface as a Rule 005 scanner finding for LLM repair"
);

// ── 4. Spec-named multi-bucket allocation: preserved, no invented buckets, no false positives ──
const multiBucketSource = `${BASE}
    uint256 public charityBucket;
    uint256 public opsBucket;
    uint256 public growthBucket;
    event Allocated(uint256 charity, uint256 ops, uint256 growth);
    receive() external payable {
        if (msg.value == 0) return;
        uint256 charityShare = (msg.value * 60) / 100;
        uint256 opsShare = (msg.value * 30) / 100;
        uint256 growthShare = msg.value - charityShare - opsShare;
        charityBucket += charityShare;
        opsBucket += opsShare;
        growthBucket += growthShare;
        emit Allocated(charityShare, opsShare, growthShare);
    }
    function payCharity(address to, uint256 amount) external onlyManager nonReentrant {
        require(to != address(0), unicode"Zero addr / 零地址");
        require(amount <= charityBucket, unicode"Too much / 超额");
        charityBucket -= amount;
        _sendNative(to, amount);
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
        s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](4);
        s.methods[0].name = "charityBucket"; s.methods[0].inputs = new FieldDescriptor[](0); s.methods[0].outputs = new FieldDescriptor[](1); s.methods[0].approvals = new ApproveAction[](0);
        s.methods[1].name = "opsBucket"; s.methods[1].inputs = new FieldDescriptor[](0); s.methods[1].outputs = new FieldDescriptor[](1); s.methods[1].approvals = new ApproveAction[](0);
        s.methods[2].name = "growthBucket"; s.methods[2].inputs = new FieldDescriptor[](0); s.methods[2].outputs = new FieldDescriptor[](1); s.methods[2].approvals = new ApproveAction[](0);
        s.methods[3].name = "payCharity"; s.methods[3].isWriteMethod = true; s.methods[3].inputs = new FieldDescriptor[](2); s.methods[3].outputs = new FieldDescriptor[](0); s.methods[3].approvals = new ApproveAction[](0);
    }
}`;
const patchedMulti = applyCommonCodegenPatches(multiBucketSource);
check("multi-bucket-patch-is-noop", patchedMulti === multiBucketSource);
for (const re of inventedVocabulary) {
  check(`multi-bucket-no-invented:${re.source}`, !re.test(patchedMulti));
}
const multiRules = blockRules(patchedMulti);
for (const absent of ["buyback-split-not-implemented", "receive-no-external-call", "receive-no-loop", "pays-full-balance", "pool-erased-no-payout"]) {
  check(`multi-bucket-no-false-positive:${absent}`, !multiRules.includes(absent), `got [${multiRules.join(", ")}]`);
}

// ── 3. Kind-free triggering: empty prompt, no vaultPlan ─────────────────────
// Oracle lifecycle checks fire from source structure, not lottery wording.
const oracleSource = `${BASE}
    receive() external payable {}
    uint256 public pendingRequestId;
    function requestDraw() external onlyManager nonReentrant {
        pendingRequestId = 1;
    }
    function _fulfillReasoning(uint256 requestId, uint8 choice) internal override { pendingRequestId = 0; }
    function _onFlapAIRequestRefunded(uint256 requestId) internal override { pendingRequestId = 0; }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`;
check(
  "oracle-guard-fires-without-kind",
  blockRules(oracleSource).includes("draw-request-not-guarded"),
  "requestDraw without pendingRequestId == 0 must be caught with empty prompt + no plan"
);

// Trigger-service auth check fires from the trigger(uint256) shape (Rule 008).
const triggerSource = `${BASE}
    receive() external payable {}
    uint256 public nextRunAt;
    function trigger(uint256 id) external {
        nextRunAt = block.timestamp + 1 hours;
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`;
check(
  "trigger-auth-fires-without-kind",
  blockRules(triggerSource).includes("trigger-no-auth"),
  "unauthenticated trigger(uint256) must be caught with empty prompt + no plan"
);

// Block-entropy winner selection is caught without any lottery wording in the prompt.
const entropySource = `${BASE}
    address[] public participants;
    receive() external payable {}
    function pickRecipient() external onlyManager nonReentrant {
        uint256 idx = uint256(block.prevrandao) % participants.length;
        address winner = participants[idx];
        _sendNative(winner, 1 ether);
    }
    function description() public view override returns (string memory) { return unicode"a / 啊"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType = "T"; s.description = "d"; s.methods = new VaultMethodSchema[](0); }
}`;
check(
  "block-entropy-fires-without-kind",
  blockRules(entropySource).includes("no-block-randomness"),
  "block.prevrandao outcome selection must be caught with empty prompt + no plan"
);

// Schema methods with novel names must exist on the contract.
const phantomSchema = `${BASE}
    receive() external payable {}
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](1);
      s.methods[0].name = "allocateToCause";
    }
}`;
const phantomRules = scanMechanicCompleteness(phantomSchema, "").map((f) => f.rule);
for (const r of phantomRules) observedFindingNames.add(r);
check("novel-schema-method-must-exist", phantomRules.includes("schema-method-not-implemented"));

// Free-form external writes are considered for schema exposure.
const freeFormWrite = `${BASE}
    receive() external payable {}
    mapping(address => uint256) public scoreOf;
    function commitScore(uint256 score) external { scoreOf[msg.sender] = score; }
    function settleScores() external onlyManager { scoreOf[address(0)] = 0; }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) { s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](0); }
}`;
const freeFormRules = scanMechanicCompleteness(freeFormWrite, "").map((f) => f.rule);
for (const r of freeFormRules) observedFindingNames.add(r);
check("free-form-write-considered-for-schema", freeFormRules.includes("write-method-not-in-uischema"));

// Claim mappings require credit paths regardless of method names.
const freeFormClaim = `${BASE}
    receive() external payable {}
    mapping(address => uint256) public badgeCredits;
    function redeemBadge() external nonReentrant {
        uint256 c = badgeCredits[msg.sender];
        require(c > 0, unicode"x / x");
        badgeCredits[msg.sender] = 0;
        _sendNative(msg.sender, c);
    }
    function description() public view override returns (string memory) { return "x"; }
    function vaultUISchema() public pure override returns (VaultUISchema memory s) {
      s.vaultType="T"; s.description="d"; s.methods = new VaultMethodSchema[](1);
      s.methods[0].name = "redeemBadge";
    }
}`;
const freeClaimRules = scanMechanicCompleteness(freeFormClaim, "").map((f) => f.rule);
for (const r of freeClaimRules) observedFindingNames.add(r);
check("claim-credit-check-name-independent", freeClaimRules.includes("claim-mapping-never-credited"));

// ── 5. Every finding name maps to a constitution rule ───────────────────────
check(
  "map:participation-never-consumed->001",
  mapScannerFindingToRuleId("participation-never-consumed") === "001"
);
check(
  "map:oracle-callback-in-uischema->004",
  mapScannerFindingToRuleId("oracle-callback-in-uischema") === "004"
);
check("map:pool-erased-no-payout->001", mapScannerFindingToRuleId("pool-erased-no-payout") === "001");
let unmapped = 0;
for (const name of observedFindingNames) {
  const id = mapScannerFindingToRuleId(name);
  if (!FLAP_RULE_IDS.includes(id)) {
    unmapped++;
    console.error(`  finding "${name}" mapped to unknown rule "${id}"`);
  }
}
check("all-observed-findings-map-to-rules", unmapped === 0);

// ── 6. Scanner source contains no VaultKind gating ──────────────────────────
const codegenSource = await readFile(path.join(SERVER_DIR, "codegen.ts"), "utf8");
const completenessSource = await readFile(path.join(SERVER_DIR, "mechanic-completeness.ts"), "utf8");
// Strip comments before asserting (the migration checklist documents the old triggers).
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const codegenCode = stripComments(codegenSource);
const completenessCode = stripComments(completenessSource);
check("codegen-no-isStakingPlan", !/\bisStakingPlan\s*\(/.test(codegenCode));
check("codegen-no-isLotteryPlan", !/\bisLotteryPlan\s*\(/.test(codegenCode));
check("codegen-no-vaultplan-kind-scanning", !/vaultPlan\??\.kind/.test(codegenCode));
check("codegen-no-kind-invariants", !/getVaultKindInvariants/.test(codegenCode));
check("codegen-no-buyback-bucket-patch", !/patchReceiveBuybackBuckets/.test(codegenCode));
check("completeness-no-prompt-keyword-gate", !/isNovelMechanicPrompt\s*\(\s*userPrompt\s*\)/.test(completenessCode.replace(/export function isNovelMechanicPrompt[\s\S]*?\n\}/, "")));
check("completeness-no-vaultkind-gate", !/vaultPlan\??\.kind/.test(completenessCode));

// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} scanner anti-regression check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll scanner anti-regression checks passed.");
