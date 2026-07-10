import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runSpecAudit, type SpecAuditResult } from "./spec-audit.js";
import {
  generateIntegrationTest,
  runIntegrationTests,
  buildSimulationReport,
  type SimulationReport,
  type SimulationScenarioResult,
  type TestJourney,
} from "./test-gen.js";
// Phase 6: VaultPlan is a retired taxonomy — imported as a TYPE ONLY for the
// deprecated, ignored optional parameters on scanner APIs.
import type { VaultPlan } from "./vault-plan.js";
import {
  classifyVaultScope,
  inferVaultScopeFromPrompt,
  consentGate,
  buildApproximationReport,
  type VaultScope,
  type ApproximationConsent,
  type ApproximationReport,
} from "./vault-scope.js";
import {
  planMechanicSpec,
  inferMechanicSpecFromPrompt,
  formatMechanicSpecForPrompt,
  summarizeMechanicSpec,
  type MechanicSpec,
} from "./mechanic-spec.js";
import { scanMechanicCompleteness } from "./mechanic-completeness.js";
import {
  designQuestionGate,
  applyConservativeLifecycleDefaults,
  type DesignQuestion,
} from "./design-questions.js";
import { runEconomicCriticPass, type EconomicCriticReport } from "./economic-critic.js";
import {
  MAX_CRITIC_REPAIR_ATTEMPTS,
  buildCriticRepairPrompt,
  repairReason,
  selectRepairFindings,
  shouldTriggerCriticRepair,
  summarizeRemainingIssues,
  type RepairAttempt,
} from "./critic-repair.js";
import { resolveCheapModel, resolveEscalationModel } from "./ai-model.js";
import { generateVaultUi, type VaultUiArtifact } from "./ui-gen.js";
import {
  extractJsonPayload,
  createAiUsageTotals,
  runWithAiUsage,
  type AiChatClient,
  type AiUsageTotals,
} from "./ai-client.js";
import { createHash } from "node:crypto";
import {
  formatConstitutionForPrompt,
  formatRuleFixGuidance,
  formatRuleLabel,
  groupFindingsByRule,
  mapScannerFindingToRuleId,
} from "./constitution.js";

const execAsync = promisify(exec);

// Repo root is one level up from /server.
const REPO_ROOT = path.resolve(process.cwd(), "..");
const FORGE =
  process.env.FORGE_PATH ??
  (existsSync(path.join(os.homedir(), ".foundry", "bin", "forge"))
    ? path.join(os.homedir(), ".foundry", "bin", "forge")
    : "forge");
const CODEGEN_DIR = path.join(REPO_ROOT, "src", "_codegen");

export type SafetyLevel = "pass" | "warn" | "fail";

export type SafetyFinding = {
  level: "block" | "warn";
  rule: string;
  detail: string;
  sourceScope?: "child" | "full-injected";
};

export type ScanSafetyOptions = {
  sourceScope?: "child" | "full-injected";
  /** @deprecated Phase 6: accepted for API compatibility, never consulted. */
  vaultPlan?: VaultPlan;
  childSource?: string;
  fullSourceOnly?: boolean;
  /** Phase 7: feeds economic-correctness scanners (winner-takes-all / per-user accounting semantics). */
  mechanicSpec?: MechanicSpec;
};

export type FixLogEntry = {
  phase:
    | "writing"
    | "classifying"
    | "compile_fix"
    | "safety_fix"
    | "test_fix"
    | "spec_fix"
    | "generating_tests"
    | "auditing"
    | "critic_repair";
  attempt: number;
  rule?: string;
  message: string;
};

export type CodegenResult = {
  contractName: string;
  explanation: string;
  source: string;
  compiled: boolean;
  compileErrors: string;
  safety: { level: SafetyLevel; findings: SafetyFinding[] };
  specAudit: SpecAuditResult;
  /** THE plan object — the authoritative mechanic plan (Phase 2; primary since Phase 6). */
  mechanicSpec: MechanicSpec;
  /** Launch-readiness verdict (Phase 6 Draft/Launch model). */
  scope?: VaultScope;
  /** What this result is in the draft/launch flow (Phase 6; Phase 8 adds design_questions). */
  deliverable: "contract" | "spec_only" | "consent_required" | "refused_unsafe" | "design_questions";
  /** Honest preserved/dropped record when the user consented to a closest-draft approximation. */
  approximation: ApproximationReport | null;
  /** Phase 8: open plain-English design questions (critical ones pause generation until answered/consented). */
  designQuestions: DesignQuestion[];
  /** Phase 8: plain-English record of conservative defaults chosen on the user's behalf (after explicit consent). */
  designDecisions: string[];
  abi: unknown[] | null;
  creationBytecode: string | null;
  bytecodeSize: number | null;
  /** Deployed (runtime) bytecode size in bytes — must stay ≤24,576 (EIP-170) or CREATE2 will always fail. */
  deployedBytecodeSize: number | null;
  attempts: number;
  integrationTestPath: string | null;
  integrationTestsPassed: boolean;
  /** Structured Rule 006 fork-simulation results (Phase 5) — scenario × rule × pass/fail. */
  simulationReport: SimulationReport | null;
  /** Phase 7: advisory economic-correctness critic report — never overrides deterministic scanners. */
  economicCritique: EconomicCriticReport | null;
  /** Cleanup pass: bounded automatic repair attempts triggered by serious critic findings (+ test failures). */
  repairAttempts: RepairAttempt[];
  fixLog: FixLogEntry[];
  autoFixExhausted: boolean;
  /**
   * AI-generated bespoke UI for this vault in Flap's official component
   * template format (Component.tsx + VaultABI.ts + i18n.json + manifest.json,
   * plus esbuild-compiled JS). Rendered sandboxed on our site immediately and
   * downloadable for Flap Artifact Workbench submission. Advisory — null when
   * the pass failed or was skipped.
   */
  uiArtifact: VaultUiArtifact | null;
  mode: "openai" | "stub";
  /** Per-run AI token usage + estimated cost (null for stubs/legacy records). */
  tokenUsage: AiUsageTotals | null;
};

const MAX_PIPELINE_ATTEMPTS = 12;
const MAX_TEST_FIX_ATTEMPTS = 8;
const MAX_TOTAL_ATTEMPTS = MAX_PIPELINE_ATTEMPTS + MAX_TEST_FIX_ATTEMPTS;

/** Output cap for full-contract generations — a vault + schema comfortably fits. */
const CODEGEN_MAX_OUTPUT_TOKENS = 32_000;

// ── Injected preamble: imports + an abstract base that supplies all the
//    error-prone boilerplate so the AI only writes the mechanic. ─────────────
const PREAMBLE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {VaultBaseV2} from "../flap/VaultBaseV2.sol";
import {IPortalTradeV2} from "../flap/IPortal.sol";
import {FlapAIConsumerBase, IFlapAIProvider} from "../flap/IFlapAIProvider.sol";
import {IFlapTriggerService, ITriggerReceiver} from "../flap/IFlapTriggerService.sol";
import {
    VaultUISchema,
    VaultMethodSchema,
    VaultDataSchema,
    FieldDescriptor,
    ApproveAction
} from "../flap/IVaultSchemasV1.sol";

/// @dev Injected base. The generated vault MUST inherit this. It already provides the
///      standard wiring so the AI never has to (re)write it:
///        - state: taxToken, creator, factory
///        - constructor(address,address,address) — DO NOT redeclare it in the child
///        - BURN_ADDRESS, onlyManager (creator OR guardian)
///        - _sendNative(to, amount): safe pull payout
///        - _buyAndBurn(bnbAmount, minTokensOut): buy taxToken off the Flap Portal and burn it
abstract contract CodegenVaultBase is VaultBaseV2, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public taxToken;
    address public creator;
    address public factory;
    address internal constant BURN_ADDRESS = 0x00576E4Fb32296Cd973A0d413D0379609400DEad;

    event EmergencyWithdrawNative(address indexed to, uint256 amount);
    event EmergencyWithdrawToken(address indexed token, address indexed to, uint256 amount);

    constructor(address _taxToken, address _creator, address _factory) {
        taxToken = _taxToken;
        creator = _creator;
        factory = _factory;
    }

    modifier onlyManager() {
        require(msg.sender == creator || msg.sender == _getGuardian(), unicode"Not authorized / 无权限");
        _;
    }

    /// @notice Guardian escape hatch for stuck native BNB (Flap Rule 009).
    function emergencyWithdrawNative(address to) external virtual onlyGuardian nonReentrant {
        require(to != address(0), unicode"Zero address / 零地址");
        uint256 bal = address(this).balance;
        if (bal > 0) {
            _sendNative(to, bal);
            emit EmergencyWithdrawNative(to, bal);
        }
    }

    /// @notice Guardian escape hatch for stuck ERC20 tokens (Flap Rule 009).
    function emergencyWithdrawToken(address token, address to) external virtual onlyGuardian nonReentrant {
        require(token != address(0) && to != address(0), unicode"Zero address / 零地址");
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            IERC20(token).safeTransfer(to, bal);
            emit EmergencyWithdrawToken(token, to, bal);
        }
    }

    /// @notice FlapTriggerService (native automation/keeper) address for the current chain.
    function _getFlapTriggerService() internal view returns (address) {
        if (block.chainid == 56) return 0xcf4EE25035CF883895110f367F5BA8172416a7F9;
        revert(unicode"Trigger service unavailable on this chain / 本链不支持触发服务");
    }

    function _sendNative(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, unicode"Transfer failed / 转账失败");
    }

    function _buyAndBurn(uint256 bnbAmount, uint256 minTokensOut) internal returns (uint256 bought) {
        if (bnbAmount == 0) return 0;
        uint256 beforeBal = IERC20(taxToken).balanceOf(address(this));
        IPortalTradeV2.ExactInputParams memory p = IPortalTradeV2.ExactInputParams({
            inputToken: address(0),
            outputToken: taxToken,
            inputAmount: bnbAmount,
            minOutputAmount: minTokensOut,
            permitData: ""
        });
        bought = IPortalTradeV2(_getPortal()).swapExactInput{value: bnbAmount}(p);
        uint256 afterBal = IERC20(taxToken).balanceOf(address(this));
        uint256 received = afterBal > beforeBal ? afterBal - beforeBal : 0;
        if (received > 0) IERC20(taxToken).safeTransfer(BURN_ADDRESS, received);
    }
}
`;

const FLAP_V2_ARCHITECTURE = `FLAP V2 ARCHITECTURE (follow exactly):
- NEVER modify, rename, move, or regenerate src/flap/ — canonical interfaces only.
- Generated vault source is compiled from src/_codegen/ beside src/flap/ (studio path).
- STUDIO DEPLOY PATH (default): non-upgradeable constructor vault inheriting CodegenVaultBase,
  deployed via CodegenVaultFactory CREATE2 + creation bytecode (testnet / rapid iteration).
- PRODUCTION PATH (when user asks for "production", "upgradeable", "beacon", or "mainnet-ready"):
  generate UpgradeableBeacon factory + Initializable vault implementation per FreeCoinBeacon.sol:
  constructor() { _disableInitializers(); }, initialize(...) replaces constructor logic,
  ReentrancyGuardUpgradeable, BeaconProxy via factory with abi.encodeCall(Vault.initialize, (...)).
  Upgrade/admin authority MUST be Guardian-only. Omit emergencyWithdrawNative/Token on upgradeable vaults
  (Rule 009 proxy exception — emergency = Guardian upgrade path).

RULE 009 — EMERGENCY CONTROLS (non-upgradeable studio vaults):
- CodegenVaultBase ALREADY provides Guardian-only, nonReentrant, full-balance emergencyWithdrawNative(to)
  and full-token-balance emergencyWithdrawToken(token, to) with events. DO NOT override these unless the
  user explicitly opts out of Rule 009 compatibility.
- NEVER make creator/manager able to call emergency functions. NEVER add amount params or hardcode recipient.
- DO NOT generate "excess-only" emergency withdrawals for Flap spec compliance — that diverges from Rule 009.
- Vaults that custody user-deposited tokens or user-claimable BNB: the inherited Guardian CAN drain all of it
  by design. Disclose this trust model in description() and vaultUISchema.description
  (e.g. "Guardian emergency recovery per Flap Rule 009"). For production vaults that custody user funds,
  recommend the upgradeable beacon pattern (no emergency drain functions).
`;

// Phase 3: CODEGEN_RULES is spec-first and constitution-driven. It must contain
// NO vault-archetype reference implementations and no fixed mechanic vocabulary
// (jackpot/drawSnapshot/accRewardPerShare/…). Rule text comes from
// constitution.ts (formatConstitutionForPrompt) — do not duplicate it here.
// Scanner-required naming patterns for kind-classified prompts live ONLY in the
// transitional VaultPlan appendix (vault-plan.ts KIND_INVARIANTS) until the
// scanners are re-gated on source structure in Phase 4.
const CODEGEN_RULES = `You are Flap Vault Gen — you implement the user's MechanicSpec as a COMPLETE, correct, original
Solidity contract for a single Flap tax vault. There is NO menu of vault types and NO archetype to
choose from: the MechanicSpec in the user message is the AUTHORITATIVE product plan (actors, buckets,
named actions, payout rules, UI methods, ruleAnalysis, testScenarios). Preserve the user's mechanic —
do not silently approximate it into a different product. Use the spec's free-form action and bucket
names where they are valid Solidity identifiers. Any VaultPlan/vault-kind block appended after these
rules is transitional compatibility context only — where it conflicts with the MechanicSpec, the
MechanicSpec wins. The contract is compiled with solc 0.8.26 and REJECTED on any error, so be precise.

LANGUAGE: the user's prompt may be written in English, Simplified Chinese, or a mix of both — read and
understand either fluently. Solidity identifiers, comments, and code must always stay in English (required
by the compiler and tooling), but the natural-language "explanation"/"EXPLANATION" you return must mirror
the user's language: if their prompt is primarily Simplified Chinese, write the explanation in Simplified
Chinese; otherwise write it in English. require()/revert strings inside the contract stay bilingual
English/Chinese either way (Rule 004) — that is a fixed UI requirement, not a language mirror.

${FLAP_V2_ARCHITECTURE}

${formatConstitutionForPrompt()}

WHAT IS ALREADY PROVIDED (do NOT write any of this — it is injected and in scope):
- SPDX line, pragma, and all imports.
- An abstract base contract CodegenVaultBase that your contract MUST inherit. It already declares:
    * state vars: taxToken, creator, factory  (DO NOT redeclare these — it is a compile error)
    * a base constructor constructor(address,address,address) — your contract MUST include exactly
      this pass-through constructor (and nothing else in it), because the base requires the args:
          constructor(address _taxToken, address _creator, address _factory)
              CodegenVaultBase(_taxToken, _creator, _factory)
          {}
    * address internal constant BURN_ADDRESS
    * modifier onlyManager() — passes for the creator OR the guardian; use it on privileged fns
    * function _sendNative(address to, uint256 amount) — safe pull payout
    * function _buyAndBurn(uint256 bnbAmount, uint256 minTokensOut) — buys taxToken off the Flap
      Portal with bnbAmount and burns it; returns tokens bought
    * emergencyWithdrawNative(address) and emergencyWithdrawToken(address,address) — guardian
      escape hatches (DO NOT redeclare/override these; they already exist on the base)
    * "using SafeERC20 for IERC20;" is already applied — for token moves call
      IERC20(token).safeTransfer(...) / IERC20(token).safeTransferFrom(...)
- Inherited helpers from the Flap base: _getPortal(), _getGuardian() (both return address).

HARD REQUIREMENTS:
1. Define EXACTLY ONE contract: contract <PascalCaseName> is CodegenVaultBase { ... }.
2. Include the pass-through constructor (required). You MAY add ONE initialization line for interval
   timer state in the same constructor body (nothing else) when the MechanicSpec has scheduled or
   interval-gated actions. Do NOT redeclare taxToken/creator/factory/BURN_ADDRESS:
       constructor(address _taxToken, address _creator, address _factory)
           CodegenVaultBase(_taxToken, _creator, _factory)
       {
           lastExecutionTime = block.timestamp; // optional — interval-gated mechanics only
       }
3. Implement receive() external payable and keep it CHEAP: pure accounting only (update storage
   counters/budgets). NO external calls, swaps, transfers, or loops in receive(). It must never
   revert on a normal deposit (do NOT require(msg.value > 0) — just return early if zero).
4. FULLY implement every action, bucket, payout rule, and view named in the MechanicSpec — never
   half-built. Every lifecycle edge must be wired end-to-end: whatever a user can trigger must have a
   complete effect path, and whatever the spec says gets credited must actually be credited by some
   function. If the mechanic buys and burns the tax token, call the inherited
   _buyAndBurn(amount, minOut) — do NOT hand-roll the swap. If the mechanic selects among
   participants, index into a real address[] you maintain — NEVER iterate address(i).
5. Use the onlyManager modifier on privileged/admin functions. Guard any function that sends BNB
   or calls the Portal with nonReentrant.
6. Override description() public view returns (string memory).
7. Override vaultUISchema() public pure returns (VaultUISchema memory schema) — see exact rules below.
8. Compute a payout amount BEFORE zeroing its source (never set x = 0 then send x).
9. Randomness wording — do NOT overclaim security (Rules 004/007):
   - Flap AI oracle outcomes: describe as "external AI provider selection" / "Flap AI oracle callback" — NOT
     "secure random", "cryptographically secure", or "verifiable randomness" unless you use a VRF/proof-backed source.
   - block.prevrandao / blockhash: FORBIDDEN for outcomes. If ever mentioned in docs, call it "on-chain entropy"
     and disclose it is manager-influencable — do not use it to select outcomes.
   - ANY random or chance-based selection among participants MUST use FlapAIConsumerBase (see the
     ORACLE OUTCOMES section) — NEVER block.prevrandao, blockhash, or block.timestamp % n.
10. NEVER use selfdestruct, delegatecall, or tx.origin. Do not deploy other contracts.
11. NEVER define or use custom errors (Flap UI-01). EVERY revert must be require(cond, "literal
    string") — the UI cannot decode custom error selectors. Prefer unicode"English / 中文" messages.
12. Move ERC20 tokens with SafeERC20: IERC20(token).safeTransfer / safeTransferFrom. Never rely on
    the raw bool return of transfer/transferFrom.
13. NEVER emit a stub, placeholder, TODO/FIXME, "implement this later", or a function that returns
    fake/empty data. Every function must be fully and correctly implemented.
14. NO HALF-IMPLEMENTED MECHANICS: if users can claim, some function MUST credit the claimable
    mapping (mapping[user] += share) before claim reads it. If users can register/enroll, something
    MUST consume that registration. If the spec has no user payouts, do NOT add claim paths at all.
    Every external user write MUST appear in vaultUISchema.methods. Any index into a storage array
    MUST be bounds-checked (require(i < arr.length)) before use.
15. If the mechanic needs data that does NOT exist on-chain (e.g. ranking ALL token holders, an
    off-chain price, an external result — the vault CANNOT enumerate ERC20 holders), do NOT fake
    it. Instead accept it as input to an onlyManager keeper function, e.g.
        function applyKeeperData(address[] calldata recipients, uint256[] calldata amounts)
            external onlyManager nonReentrant { ... validate sums against the funding bucket, then credit ... }
    and state the off-chain/keeper trust assumption in the explanation. Validate inputs on-chain
    (array lengths match, total <= bucket) so the keeper cannot over-pay.

FLAP PROTOCOL FUND-FLOW RULES (these are how tax actually flows — violating them produces a
broken or unsafe vault even if it compiles):
A. receive() is called by the Flap tax processor on every tax event with plain BNB. Inside
   receive(), msg.sender is the PROTOCOL, NOT a holder/buyer. NEVER attribute a deposit to
   msg.sender, NEVER push msg.sender as a participant, NEVER index user state by msg.sender in
   receive(). receive() may ONLY do cheap accounting: split msg.value into the named storage buckets
   from the MechanicSpec. It MUST NOT call _buyAndBurn, _sendNative,
   transfer, swap, any external call, or any loop. (Hard protocol cap: receive() <= 1,000,000 gas.)
B. Anything that spends a bucket (swap/burn via _buyAndBurn, payouts, oracle fees) runs in a
   SEPARATE user- or manager-called function: read the bucket, require it is non-zero, zero/decrement
   it FIRST, then act. Swaps MUST take a real minTokensOut slippage parameter — never hardcode 0 in prod.
C. Per-holder logic happens in user-called functions (the actions named in the MechanicSpec), where
   msg.sender IS the real user. You MAY read IERC20(taxToken).balanceOf(msg.sender) ONLY as a boolean
   minimum-hold gate (e.g. require(balance >= 1e18) to join) — NEVER to compute a payout amount or
   pro-rata share. NEVER size a payout/dividend from a live balanceOf — it is flash-loan/MEV gameable (Rule 003).
D. If users deposit/commit real tokens, you MUST pull them with
   IERC20(taxToken).safeTransferFrom(msg.sender, address(this), amount) (the UI approves via an
   ApproveAction in the schema) and track each user's committed balance in explicit vault accounting.
E. NEVER pay out address(this).balance. Pay each claimant from the SPECIFIC bucket that
   funds it (read the bucket, zero/decrement it, then send). BNB in must equal BNB out across buckets.
F. CodegenVaultBase provides Rule 009 emergency functions (onlyGuardian, full balance). Do NOT override
   them for "excess-only" accounting unless the user explicitly opts out of Rule 009 compatibility.
G. Fairness (Rule 003): no privileged role may sandwich or systematically out-compete users.

PRODUCTION QUALITY BAR (match FreeCoin.sol / Flap reference vaults — incomplete output is REJECTED):
- EVERY require/revert string MUST be bilingual: unicode"English / 中文" (Flap UI Rule 004).
- EVERY external function that sends BNB (_sendNative, _buyAndBurn, .call{value:}) MUST use nonReentrant.
- EVERY payout with an address recipient param MUST require(to != address(0), unicode"...").
- NEVER use silent try/catch {} — handle failures explicitly with require.
- Emit events for every meaningful state change (bucket splits, deposits, withdrawals, joins, payouts).
- vaultUISchema MUST be COMPLETE for every method entry (see below) — partial schemas break the Flap UI.
- Include VIEW methods in vaultUISchema for every public state var the user cares about
  (bucket totals, per-user balances, claimable amounts, counters) so the UI can display live values.
- MANDATORY: EVERY uint256 public / bool public / address public in the child contract
  (except taxToken/creator/factory from base) MUST appear as a view method in vaultUISchema.methods
  with the SAME name — scan rejects missing ones (public-state-not-in-uischema).
- ANY method that pulls tokens via transferFrom MUST include ApproveAction on taxToken in vaultUISchema.

UI SCHEMA (vaultUISchema) — common AI mistakes to AVOID:
- schema.methods[] is ONLY for user-callable write methods AND custom view helpers — NEVER list
  "description" or "vaultUISchema" as methods (those are separate overrides).
- For EVERY methods[i] you MUST set ALL of: name, description, isWriteMethod (if write),
  inputs = new FieldDescriptor[](N), outputs = new FieldDescriptor[](M), approvals = new ApproveAction[](K).
  Even when N/M/K is 0, still assign the empty arrays — omitting outputs/approvals breaks the UI.
- Each write method needs isWriteMethod = true and accurate inputs/outputs FieldDescriptor arrays.
- For any method that pulls tokens with transferFrom, set approvals[0] = ApproveAction("taxToken", "amount").
  ApproveAction has ONLY two positional string args (tokenType, amountFieldName) — NEVER use
  named braces like ApproveAction({token: taxToken, ...}) and NEVER reference the taxToken variable
  inside vaultUISchema (it is pure — use the literal string "taxToken").

EVENTS — emit for every meaningful state change (helps auditability):
- e.g. event BucketFunded(string bucket, uint256 amount); event Joined(address user);
  event ActionExecuted(uint256 amountIn, uint256 amountOut); // name fields to match emitted values
  event PayoutCredited(address recipient, uint256 amount);
- Derive event names from the MechanicSpec's action names where possible.

SCHEMA INTEGRITY — MANDATORY rule (enforced by safety scanner):
- Every string listed in schema.methods[i].name MUST correspond to an ACTUAL function or public
  state variable in the contract. Do NOT list functions in the schema that you forgot to implement.
  The Flap UI calls each schema method and will revert visibly if the function does not exist.
- Every view method in vaultUISchema that reads a derived/computed value MUST be a real
  function — never list a computed view without implementing it.

BUCKET ACCOUNTING — when using the named buckets from the MechanicSpec:
- receive() ONLY increments buckets. Every spend MUST decrement the specific bucket first, then pay.
- Tracked native buckets MUST stay solvent: sum(buckets) must never exceed address(this).balance.
- NEVER pay oracle fees or payouts from undifferentiated address(this).balance while bucket counters
  still show funds — deduct from the correct bucket before the external call.
- NEVER use require(address(this).balance >= X) for bucket-funded actions without syncing buckets.

CONDITIONAL GUIDANCE — apply ONLY the sections the MechanicSpec actually needs. Check its actions,
oracleActions, scheduledActions, payoutRules, fundsIn, and ruleAnalysis; do not add machinery the
spec does not ask for.

IF USERS DEPOSIT OR COMMIT TOKENS (Rule 002 — user funds must be safe):
   - Pull tokens per fund-flow rule D above. taxToken is a Flap tax token and MAY be fee-on-transfer,
     so ALWAYS credit the user with the balance delta:
         uint256 beforeBal = IERC20(taxToken).balanceOf(address(this));
         IERC20(taxToken).safeTransferFrom(msg.sender, address(this), amount);
         uint256 received = IERC20(taxToken).balanceOf(address(this)) - beforeBal;
         require(received > 0, unicode"No tokens received / 未收到代币");
   - Withdrawals pay out exactly what the vault accounting says the user is owed — never a live
     balanceOf-derived number, never someone else's funds.
   - If depositors continuously share incoming BNB pro-rata, use an EXACT per-share accumulator:
     a global accumulated-reward-per-committed-token counter (scaled by 1e18) plus a per-user debt
     checkpoint. Settle or preserve a user's pending entitlement BEFORE changing their committed
     balance. Pick ONE reward model and use it everywhere (never mix an accumulator with ad-hoc
     bucket subtraction). Decide what happens to BNB that arrives while nothing is committed (hold
     it in an undistributed bucket and roll it in later) and document that in description().
   - Expose a pending-entitlement view (e.g. pendingReward(address)) and list it in vaultUISchema.

IF THE MECHANIC HAS PAYOUTS TO USERS (Rule 003 — no favoritism, no gameable sizing):
   - Prefer PULL payments: credit mapping(address => uint256) claimable amounts first, then a
     nonReentrant claim function that zeroes the balance before _sendNative(msg.sender, amt).
   - NEVER push BNB to a computed winner inside an oracle/trigger callback — a contract recipient
     that reverts would brick the mechanic. Credit claimable and let them claim.
   - Size every payout from vault accounting (buckets, committed balances) — never from live
     balanceOf and never influenced by a privileged role choosing when to act in its own favor.

IF PARTICIPANTS JOIN A SET (any mechanic that later selects among, iterates, or eliminates members):
   - Maintain address[] participants PLUS mapping(address => bool) joined for dedup — no duplicate pushes.
   - Cap the set size with a require in the join function (<= 255 if an oracle later picks an index,
     because the choice arrives as uint8) — any loop over participants must be bounded (gas DoS).
   - Do NOT gate joining on interval timers (that locks the first round) — enforce cadence ONLY on
     the action that executes the round. Block joins while an oracle request is pending.
   - If joining is open (no taxToken balance gate), description() MUST disclose the Sybil risk;
     if gated, use require(IERC20(taxToken).balanceOf(msg.sender) >= minimum) as a boolean gate only.

IF THE MECHANIC HAS RANDOM OR AI-DECIDED OUTCOMES (Rule 007 — oracle lifecycle):
   There is NO Chainlink VRF on Flap and block entropy is FORBIDDEN for outcomes (the manager can
   read prevrandao in-tx and act only when it favors them). Use the FlapAIProvider — a
   commit-and-reveal oracle with an authenticated callback — via FlapAIConsumerBase. This applies to
   ANY selection among participants or chance-based outcome, whatever the mechanic is called.
   - Inherit it:  contract X is CodegenVaultBase, FlapAIConsumerBase { ... }
   - The provider address is _getFlapAIProvider() (inherited). NEVER use _getPortal() or
     _getFlapTriggerService() for the AI provider — they are different contracts.
   - Keep uint256 public pendingRequestId; uint256 public aiModelId; and an onlyManager setter for
     aiModelId that emits an event.
   - Exact call shapes (these must compile):
         uint256 fee = IFlapAIProvider(_getFlapAIProvider()).getModel(aiModelId).price;
         pendingRequestId = IFlapAIProvider(_getFlapAIProvider()).reason{value: fee}(
             aiModelId, "<instruction asking for one integer in [0, n-1]>", uint8(n));
     Before the uint8(n) cast: require(n > 0 && n <= 255, "...").
   - Implement the THREE required overrides (callback auth is the base's onlyFlapAIProvider — do NOT
     write your own public fulfillReasoning):
         function _fulfillReasoning(uint256 requestId, uint8 choice) internal override { ... }
         function _onFlapAIRequestRefunded(uint256 requestId) internal override { ... }
         function lastRequestId() public view override returns (uint256) { return pendingRequestId; }
   - Request lifecycle (order matters):
     * require(pendingRequestId == 0) before a new request — no overlapping async requests.
     * SNAPSHOT the participant set into a dedicated storage array BEFORE the request so the set is
       frozen before the outcome is known: delete the snapshot, then push each live participant.
       NEVER loop <snapshot>.length immediately after delete — it is 0 until repopulated.
     * Pay the oracle fee from the specific bucket that funds the outcome: require the bucket is
       STRICTLY greater than the fee (never >= — the payout would be 0), decrement the bucket,
       and record the fee paid in a state var so a refund can restore it.
   - Fulfillment (callback runs under a HARD 2,000,000 gas cap — bounded loops only, no heavy
     external calls, and it must never revert-lock):
     * require(requestId == pendingRequestId, "..."), then clear pendingRequestId FIRST.
     * Bounds-check: require(<snapshot>.length > 0 && choice < <snapshot>.length, "...").
     * Index ONLY the snapshot with choice — never the live participant array.
     * Apply the outcome; credit winners via the claimable mapping (pull payment).
     * Reset the joined/dedup flags by looping the SNAPSHOT before deleting the live set; then
       delete both arrays as the mechanic requires; clear the recorded fee; update any interval
       timer to block.timestamp; emit an outcome event.
   - Refund handler: if the requestId matches, clear pendingRequestId, restore the RECORDED FEE to
     the funding bucket (never bucket += bucket — that doubles it), clear the recorded fee, delete
     the snapshot, and emit a refund event.
   - Emit events for: request made (id, count, fee), outcome applied, refund received, model updated.
   - If the outcome ELIMINATES one member per round instead of paying one winner: require the live
     set has MORE THAN ONE member before requesting (so the snapshot is always >= 2 at fulfill
     time — a snapshot length of 1 can never occur, do not branch on it). In the callback, mark the
     eliminated member, rebuild the live set from the snapshot keeping the still-active members, and
     count the remaining members DURING that rebuild — if exactly one remains, that member is the
     final winner. Delete the snapshot only AFTER rebuilding the live set from it.

IF THE MECHANIC HAS SCHEDULED OR AUTOMATED ACTIONS (Rule 008 — keeper/trigger compatibility):
   - Simplest compliant pattern: an external "anyone can poke" or onlyManager trigger function that
     require()s the time/state condition, executes the action, and updates the timer. It MUST appear
     in vaultUISchema.methods — it is the primary action button and must not be hidden.
   - For protocol automation use FlapTriggerService:
     * Also implement ITriggerReceiver:  contract X is CodegenVaultBase, ITriggerReceiver { ... }
     * Schedule:  uint256 fee = IFlapTriggerService(_getFlapTriggerService()).getFee();
                  uint256 rid = IFlapTriggerService(_getFlapTriggerService()).requestTrigger{value: fee}(uint64(when));
                  scheduled[rid] = true;
     * trigger(uint256 requestId) external override nonReentrant MUST validate
       msg.sender == _getFlapTriggerService(), require + delete scheduled[requestId], and RE-CHECK
       the time/state conditions before acting.
     * Same hard 2,000,000 gas cap; never assume it fires exactly at the scheduled time.

IF THE MECHANIC IS INTERVAL-GATED (epochs, rounds, periodic executions):
   - Initialize the timer state in the constructor (see hard requirement 2).
   - Enforce cadence ONLY on the executing trigger, never on join/deposit paths.
   - Update the timer when the round actually completes (e.g. in the oracle callback, not at request).
   - Expose a countdown view and list it in vaultUISchema.methods so users see a live countdown:
         function timeUntilNextExecution() public view returns (uint256) {
             uint256 next = lastExecutionTime + EXECUTION_INTERVAL;
             return block.timestamp >= next ? 0 : next - block.timestamp;
         }

Mechanics with none of the above (pure accounting/burn/treasury flows) need NO oracle, NO trigger
service, and NO participant machinery — do not add them.

EXACT STRUCT SHAPES — build the schema with FIELD ASSIGNMENT only. Do NOT use struct constructors
like VaultMethodSchema({...}) (it has 8 fields and will fail). vaultType and description are STRINGS.

  struct FieldDescriptor { string name; string fieldType; string description; uint8 decimals; }
  struct VaultUISchema { string vaultType; string description; VaultMethodSchema[] methods; }

  Neutral shape example — substitute the REAL view/write method names from the MechanicSpec's
  uiMethods (this is a shape template, NOT a product suggestion):

  function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
      schema.vaultType = "MyVault";              // a string, never a number
      schema.description = unicode"What it does / 中文说明";
      schema.methods = new VaultMethodSchema[](3);

      // View: expose a live bucket/state value (name = the actual public var or view function)
      schema.methods[0].name = "rewardBucket";
      schema.methods[0].description = unicode"Current reward bucket in BNB / 当前奖励池";
      schema.methods[0].inputs = new FieldDescriptor[](0);
      schema.methods[0].outputs = new FieldDescriptor[](1);
      schema.methods[0].outputs[0] = FieldDescriptor("amount", "uint256", "Bucket balance in BNB", 18);
      schema.methods[0].approvals = new ApproveAction[](0);

      // Write: a mechanic action with an input and no token approval
      schema.methods[1].name = "executeRound";
      schema.methods[1].description = unicode"Run the next round / 执行下一轮";
      schema.methods[1].isWriteMethod = true;
      schema.methods[1].inputs = new FieldDescriptor[](1);
      schema.methods[1].inputs[0] = FieldDescriptor("minAmountOut", "uint256", "Slippage floor", 18);
      schema.methods[1].outputs = new FieldDescriptor[](0);
      schema.methods[1].approvals = new ApproveAction[](0);

      // Write: a method that pulls tokens via transferFrom (needs an ApproveAction)
      schema.methods[2].name = "depositTokens";
      schema.methods[2].description = unicode"Deposit tax tokens / 存入代币";
      schema.methods[2].isWriteMethod = true;
      schema.methods[2].inputs = new FieldDescriptor[](1);
      schema.methods[2].inputs[0] = FieldDescriptor("amount", "uint256", "Amount to deposit", 18);
      schema.methods[2].outputs = new FieldDescriptor[](0);
      schema.methods[2].approvals = new ApproveAction[](1);
      schema.methods[2].approvals[0] = ApproveAction("taxToken", "amount");
  }
`;

export const CODEGEN_SYSTEM_PROMPT = `${CODEGEN_RULES}

Respond with JSON only (no markdown):
{
  "contractName": "PascalCaseName",
  "explanation": "1-3 sentences on what the vault does and any caveats (e.g. randomness, keeper needed)",
  "code": "the full Solidity for the single contract, starting at 'contract <Name> is CodegenVaultBase {'"
}`;

export const STREAM_SYSTEM_PROMPT = `${CODEGEN_RULES}

Output PLAIN TEXT in EXACTLY this format and nothing else. Do NOT use markdown code fences.
CONTRACT_NAME: <PascalCaseName>
EXPLANATION: <one or two sentences on what the vault does and any caveats>
SOLIDITY:
contract <Name> is CodegenVaultBase { ... full contract ... }`;

export const REFINE_STREAM_SYSTEM_PROMPT = `${CODEGEN_RULES}

You are REFINING an existing Flap vault contract based on user chat feedback — not writing from scratch.
- Preserve working mechanics unless the user asks to change them.
- Apply the requested refinement plus any fixes required for Flap compliance.
- Keep the same contract name unless the user explicitly asks to rename.
- Return the COMPLETE updated child contract (not a diff or partial snippet).

Output PLAIN TEXT in EXACTLY this format. Do NOT use markdown code fences.
CONTRACT_NAME: <PascalCaseName>
EXPLANATION: <1-2 sentences describing what you changed>
SOLIDITY:
contract <Name> is CodegenVaultBase { ... full updated contract ... }`;

const UPGRADEABLE_MODE_APPENDIX = `
PRODUCTION UPGRADEABLE MODE (user requested production/upgradeable/beacon/mainnet-ready):
- Generate TWO contracts in one file if needed: upgradeable vault implementation + VaultFactoryBaseV2 factory.
- Vault: Initializable, ReentrancyGuardUpgradeable, constructor() { _disableInitializers(); }, initialize(...) external initializer.
- Factory: UpgradeableBeacon + BeaconProxy; newVault passes abi.encodeCall(Vault.initialize, (...)).
- Guardian-only upgrade/admin authority on beacon. Omit emergencyWithdrawNative/Token on upgradeable vault (Rule 009 proxy exception).
- Still implement receive(), description(), vaultUISchema(), vaultDataSchema() on factory.
- Reference: src/FreeCoinBeacon.sol in this repo.`;

function wantsUpgradeableMode(prompt: string): boolean {
  return /\b(production|upgradeable|beacon|mainnet-ready|mainnet ready)\b/i.test(prompt);
}

/** Phase 6: no VaultPlan appendix — the MechanicSpec in the user message is the only plan. */
function resolveSystemPrompt(base: string, userPrompt: string): string {
  let prompt = base;
  if (wantsUpgradeableMode(userPrompt)) prompt += UPGRADEABLE_MODE_APPENDIX;
  return prompt;
}

/**
 * Spec-first generation instruction (Phase 2/3): the MechanicSpec is the
 * authoritative plan — no "Vault kind:" framing, no VaultPlan commitment.
 */
export function buildGenerationUserMessage(userPrompt: string, spec: MechanicSpec): string {
  const lc = spec.lifecycle;
  const lifecycleOrders =
    lc && lc.resourceType && lc.assignmentModel !== "not_applicable"
      ? `

Lifecycle & non-coder visibility orders (the spec has a discrete "${lc.resourceType}" resource):
- Use a status ENUM (e.g. Open/Assigned/Submitted/Completed/Cancelled), not a single bool, when the ${lc.resourceType} has multiple lifecycle states.
- ${lc.assignmentModel === "multi_assignee" ? `Multi-assignee is EXPLICIT in the spec: track accepted users per ${lc.resourceType}, keep completion and rewards PER USER, and never let one user's completion or a global deactivation trap another user's state or exit.` : `Enforce single-assignee: accepting sets the assignee; a second accept of the same ${lc.resourceType} must revert. Approval must verify the approved address IS the assignee.`}
- ${lc.requiresSubmission === "yes" ? `Users submit their work on-chain (e.g. a proof hash) before approval; the approval function must reference that stored submission.` : `If completion depends on user work, store the submission on-chain or disclose off-chain review in description().`}
- Reserve the reward into a per-user claimable mapping at ${lc.rewardReservationPoint === "unspecified" ? "approval" : lc.rewardReservationPoint.replace(/^on_/, "")} time (decrement the funding bucket, credit claimable[user]); the user claims via a pull payment.
- Every assigned user must ALWAYS have an exit: implement the abandon path (${lc.abandonPath || `assignee clears their own assignment before approval`}) and the cancel path (${lc.cancelPath || `manager cancels an open/expired ${lc.resourceType} without trapping assigned users`}); clear or honor assignment state on every deactivation.
- Views a non-coder needs (expose in vaultUISchema): a ${lc.resourceType} count, a per-id getter, a per-user assignment/status view, a per-user claimable-amount view, and the funding bucket. NEVER return unbounded dynamic arrays of structs with strings — use count + per-id getters.
- Label manager-only actions as manager-only in their schema method descriptions.${lc.stateVisibilityRequirements.length ? `\n- Spec visibility requirements: ${lc.stateVisibilityRequirements.join("; ")}.` : ""}`
      : "";
  return `Write the vault contract for this idea:

${userPrompt}

${formatMechanicSpecForPrompt(spec)}

Implementation orders:
- The MechanicSpec above is the authoritative plan. Preserve the user's mechanic exactly — do not silently approximate it into a different product.
- Implement every named action, bucket, and payout rule from the spec; use its free-form method names where they are valid Solidity identifiers.
- Generate vaultUISchema() from the spec's uiMethods (plus every public state var, per the system rules).
- Follow the spec's ruleAnalysis for which Flap constitution rules (Rules 001–009) apply, and make the mechanic pass the spec's testScenarios.
- Any vault-kind hints elsewhere in this conversation are transitional compatibility context only.${lifecycleOrders}`;
}

// Phase 6: the retired VaultPlan taxonomy is no longer re-exported here — the
// scope verdict model is the public surface alongside the MechanicSpec.
export {
  type VaultScope,
  type ScopeVerdict,
  type ApproximationConsent,
  type ApproximationReport,
  consentGate,
  inferVaultScopeFromPrompt,
  classifyVaultScope,
} from "./vault-scope.js";

export type RefineChatTurn = { role: "user" | "assistant"; content: string };

export type RefineSession = {
  initialPrompt: string;
  contractName: string;
  source: string;
  chatHistory: RefineChatTurn[];
};

function extractChildCode(source: string, contractName: string): string {
  const needle = `contract ${contractName}`;
  const idx = source.indexOf(needle);
  if (idx >= 0) return source.slice(idx).trim();
  const m = source.match(/contract\s+\w+[\s\S]*$/);
  return m ? m[0].trim() : source;
}

// Extract the full body of receive() with balanced braces (handles nested blocks).
function usesBlockEntropyIn(sourceSlice: string): boolean {
  return (
    /block\.prevrandao\b/.test(sourceSlice) ||
    /\bblockhash\s*\(/.test(sourceSlice) ||
    /keccak256\([^)]*block\.(timestamp|number|prevrandao)/.test(sourceSlice) ||
    /block\.(timestamp|number)\s*%/.test(sourceSlice)
  );
}

function extractConstructorBody(source: string): string | null {
  const m = source.match(/constructor\s*\([^)]*\)[^{]*\{/);
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return source.slice(start, i - 1);
}

function extractReceiveBody(source: string): string | null {
  const m = source.match(/receive\s*\(\s*\)\s*external\s+payable[^{]*\{/);
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return source.slice(start, i - 1);
}

/** True when a payout amount is derived from live balanceOf(msg.sender) (Rule 003), not a min-hold gate. */
function usesBalanceBasedPayout(source: string): boolean {
  if (/_sendNative\s*\(\s*msg\.sender\s*,[^)]*balanceOf\s*\(\s*msg\.sender\s*\)/.test(source)) return true;
  if (/\.call\{value:[^}]*balanceOf\s*\(\s*msg\.sender\s*\)/.test(source)) return true;

  const chunks = source.split(/\bfunction\s+/);
  for (const chunk of chunks) {
    if (!/balanceOf\s*\(\s*msg\.sender\s*\)/.test(chunk)) continue;
    const pays = /(_sendNative|\.call\{value|safeTransfer\s*\(\s*msg\.sender)/.test(chunk);
    if (!pays) continue;
    if (/balanceOf\s*\(\s*msg\.sender\s*\)[^;{]*\/\s*[^;{]*totalSupply/.test(chunk)) return true;
    if (/=\s*[^;]*balanceOf\s*\(\s*msg\.sender\s*\)/.test(chunk) && pays) return true;
    if (/proRata|pro-rata|proportional/i.test(chunk) && pays) return true;
  }
  return false;
}

function extractVaultUISchemaBody(source: string): string | null {
  const m = source.match(/function\s+vaultUISchema\s*\([^)]*\)[^{]*\{/);
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return source.slice(start, i - 1);
}

function extractFunctionChunks(source: string): { name: string; body: string; header: string }[] {
  const chunks: { name: string; body: string; header: string }[] = [];
  const re = /function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const name = m[1]!;
    const start = m.index + m[0].length;
    let i = start;
    let depth = 1;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    chunks.push({ name, header: m[0], body: source.slice(start, i - 1) });
  }
  return chunks;
}

function findFunctionBody(source: string, fnName: string): string | null {
  return extractFunctionChunks(source).find((f) => f.name === fnName)?.body ?? null;
}

/** True when code deletes drawSnapshot then loops drawSnapshot.length (array is empty — loop never runs). */
function loopsSnapshotLengthAfterDelete(body: string, snapshotVar = "drawSnapshot"): boolean {
  const idx = body.indexOf(`delete ${snapshotVar}`);
  if (idx < 0) return false;
  const after = body.slice(idx + `delete ${snapshotVar}`.length);
  return new RegExp(`for\\s*\\([^)]*${snapshotVar}\\.length`, "i").test(after);
}

function isSurvivorMechanic(source: string, userPrompt = ""): boolean {
  return (
    /survivor|eliminat/i.test(userPrompt) ||
    /requestElimination|SurvivorVault|EliminationVault/i.test(source) ||
    (/requestElimination/.test(source) && /_fulfillReasoning/.test(source) && /drawSnapshot/.test(source))
  );
}

/*
 * ── PHASE 4 SCANNER-TRIGGER MIGRATION CHECKLIST (kind-derived → rule/structure-derived) ──
 *
 * Every bug-class check below is preserved; only WHAT MAKES IT FIRE changed.
 *
 * 1. scanVaultLogic isStake gate: was isStakingPlan(vaultPlan) || prompt keywords
 *    → now share-accrual / deposit-function source structure (detectSourceStructure).
 * 2. scanVaultLogic isBuyback gate: was vaultPlan.kind === "buyback" || prompt keyword
 *    → now swap-helper / budget-bucket source structure.
 * 3. scanVaultLogic isLottery gate: was isLotteryPlan(vaultPlan) || prompt keywords
 *    → now oracle-lifecycle / block-entropy-with-participants source structure.
 * 4. scanSafetyFullInjected isStake: was isStakingPlan(vaultPlan)
 *    → now user-token-custody structure in the child source (transferFrom(msg.sender)).
 * 5. scanSafety staking-guardian-trust-undisclosed: was `function stake(` + totalStaked
 *    → now fires for ANY external function taking user token custody, free-form name.
 * 6. patchReceiveBuybackBuckets: REMOVED — it invented a 50/50 buyback/jackpot split
 *    (buybackBudget, weeklyJackpot, executeBuyback). Rule 005 violations in receive()
 *    now surface as scanner findings repaired by the LLM with rule-derived guidance.
 * 7. buildFailureMemoryJson / surgicalSafetyFixPrompt: dropped vaultKind +
 *    kind-derived invariants; repair prompts cite Rule IDs, finding names, and the
 *    MechanicSpec only.
 *
 * VaultKind remains transitional metadata elsewhere (vault-plan appendix, test-gen);
 * removing it globally is Phase 5.
 */

/** Rule-derived structural signals — scanners key off these, never off VaultKind. */
type SourceStructure = {
  /** accRewardPerShare-style share-index accrual state (Rule 001/003 accounting checks). */
  hasShareAccrual: boolean;
  /** An external/public non-view function pulls user tokens via transferFrom(msg.sender …). */
  hasUserTokenCustody: boolean;
  /** stake()-shaped deposit accounting (kept for classic coverage; name is NOT required elsewhere). */
  hasStakeShape: boolean;
  /** Flap AI provider / oracle consumer / reasoning-request lifecycle present (Rule 007 checks). */
  hasOracleLifecycle: boolean;
  /** Block entropy used near a participant set (Rule 007 randomness checks). */
  hasBlockEntropyOutcome: boolean;
  /** Swap/buyback helpers or a tracked buyback budget (Rule 005 receive + slippage checks). */
  hasSwapStructure: boolean;
};

function detectSourceStructure(source: string): SourceStructure {
  const custodyFn = extractFunctionChunks(source).some(
    (f) =>
      /external|public/.test(f.header) &&
      !/\bview\b|\bpure\b/.test(f.header) &&
      /(?:safeT|t)ransferFrom\s*\(\s*msg\.sender/.test(f.body)
  );
  return {
    hasShareAccrual: /accRewardPerShare/.test(source),
    hasUserTokenCustody: custodyFn,
    hasStakeShape: /function\s+stake\s*\(/.test(source) && /totalStaked/.test(source),
    hasOracleLifecycle:
      /FlapAIConsumerBase/.test(source) ||
      /_fulfillReasoning|_onFlapAIRequestRefunded/.test(source) ||
      /\.reason\s*\{/.test(source) ||
      /function\s+requestDraw\s*\(|function\s+requestElimination\s*\(/.test(source),
    hasBlockEntropyOutcome:
      /block\.prevrandao|blockhash\s*\(/.test(source) &&
      /entrants|entrantList|participants?|drawSnapshot|winner/i.test(source),
    hasSwapStructure: /_buyAndBurn|swapExactInput|executeBuyback|buybackBudget/.test(source),
  };
}

function replaceFunctionBody(source: string, fnName: string, newBody: string): string {
  const re = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)[^{]*\\{`, "g");
  const m = re.exec(source);
  if (!m) return source;
  const start = m.index + m[0].length;
  let i = start;
  let depth = 1;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return source.slice(0, start) + newBody + source.slice(i - 1);
}

/**
 * Phase 4: the former patchReceiveBuybackBuckets deterministic patch was REMOVED.
 * It invented a product mechanic (50/50 buyback/jackpot split, buybackBudget,
 * weeklyJackpot, executeBuyback) that the user's MechanicSpec never asked for.
 * Unsafe logic inside receive() (Rule 005) now surfaces as scanner findings
 * (receive-no-external-call / receive-no-transfer / receive-no-loop) and is
 * repaired by the LLM with rule-derived guidance — deterministic mutation must
 * never author mechanics.
 */

/** Cap lottery entrants at 255 in enter(), not only at draw time. */
function patchEntrantCap(code: string): string {
  if (!/function\s+enter\s*\(/.test(code) || !/entrants\.push/.test(code)) return code;
  if (/MAX_ENTRANTS|entrants\.length\s*<\s*255|entrants\.length\s*<\s*type\s*\(\s*uint8\s*\)\.max/.test(code)) {
    return code;
  }

  let out = code;
  if (!/MAX_ENTRANTS/.test(out)) {
    const anchor = out.match(/address\[\]\s+(?:public\s+)?entrants\s*;/);
    if (anchor) {
      out = out.replace(anchor[0], `${anchor[0]}\n    uint256 public constant MAX_ENTRANTS = 255;`);
    }
  }

  const enterBody = findFunctionBody(out, "enter");
  if (enterBody && !/MAX_ENTRANTS|\.length\s*<\s*255/.test(enterBody)) {
    out = replaceFunctionBody(
      out,
      "enter",
      `require(entrants.length < MAX_ENTRANTS, unicode"Entrant cap / 参与者已满");\n        ${enterBody.trimStart()}`
    );
  }
  return out;
}

/** Add nonReentrant to enter() when mutating entrant arrays. */
function patchEnterNonReentrant(code: string): string {
  if (!/function\s+enter\s*\(/.test(code) || !/entrants\.push|hasEntered/.test(code)) return code;
  if (/function\s+enter\s*\([^)]*\)\s*external\s+nonReentrant/.test(code)) return code;
  return code.replace(/function\s+enter\s*\(\s*\)\s*external(?!\s+nonReentrant)/, "function enter() external nonReentrant");
}

/** Ensure AI lottery vaults disclose Flap AI provider selection in schema description. */
function patchAiLotteryDisclosure(code: string): string {
  if (!/FlapAIConsumerBase/.test(code) || !/function\s+requestDraw\s*\(/.test(code)) return code;
  const schemaBody = extractVaultUISchemaBody(code);
  if (!schemaBody) return code;
  if (/AI.{0,30}provider|AI.{0,20}oracle|AI.{0,20}selected|Flap AI/i.test(schemaBody)) return code;
  return code.replace(
    /(schema\.description\s*=\s*unicode"[^"]*)(")/,
    `$1; winner selected by Flap AI provider (not on-chain VRF)$2`
  );
}

function isForgeCompileSuccess(out: string): boolean {
  return /Compiler run successful/i.test(out);
}

/** Deterministic fixes for patterns the AI often misses after many retries.
 * Phase 4 constraint: patches may enforce safety constraints (caps, guards,
 * reentrancy, disclosure) but must NEVER invent product mechanics (buckets,
 * splits, reward flows). Rule 005 receive() violations are left to the
 * scanner + LLM repair loop. */
export function applyCommonCodegenPatches(code: string): string {
  let out = code;

  out = patchEntrantCap(out);
  out = patchEnterNonReentrant(out);
  out = patchAiLotteryDisclosure(out);

  if (/FlapAIConsumerBase/.test(out) && /lastDrawFee/.test(out)) {
    const fulfillBody = findFunctionBody(out, "_fulfillReasoning");
    if (fulfillBody && !/lastDrawFee\s*=\s*0/.test(fulfillBody)) {
      out = replaceFunctionBody(out, "_fulfillReasoning", `${fulfillBody.trimEnd()}\n        lastDrawFee = 0;\n    `);
    }
  }

  for (const fnName of ["requestDraw", "requestElimination"] as const) {
    const body = findFunctionBody(out, fnName);
    if (!body || !/uint8\s*\(\s*(?:n|entrants\.length|drawSnapshot\.length)/.test(body)) continue;
    if (/<=\s*255|<=\s*type\s*\(\s*uint8\s*\)\.max|MAX_ENTRANTS/.test(body)) continue;
    const guard = body.includes("drawSnapshot.length")
      ? 'require(drawSnapshot.length > 0 && drawSnapshot.length <= type(uint8).max, unicode"Invalid entrant count / 无效参与者数量");\n        '
      : 'require(n > 0 && n <= type(uint8).max, unicode"Invalid entrant count / 无效参与者数量");\n        ';
    out = replaceFunctionBody(out, fnName, `${guard}${body.trimStart()}`);
  }

  return out;
}

function hasAsciiOnlyRequire(source: string): boolean {
  // Flap UI expects unicode"English / 中文" — flag bare require(..., "ascii") in child contract.
  return /require\s*\(\s*[^)]+\s*,\s*"(?!.*\/)[^"]*"\s*\)/.test(source);
}

function uischemaIncomplete(schemaBody: string): string[] {
  const issues: string[] = [];
  const indices = [...schemaBody.matchAll(/\.methods\[(\d+)\]\.name\s*=\s*"([^"]+)"/g)];
  for (const m of indices) {
    const idx = m[1]!;
    const name = m[2]!;
    if (!new RegExp(`\\.methods\\[${idx}\\]\\.outputs\\s*=`).test(schemaBody)) {
      issues.push(`methods[${idx}] "${name}" missing outputs array`);
    }
    if (!new RegExp(`\\.methods\\[${idx}\\]\\.approvals\\s*=`).test(schemaBody)) {
      issues.push(`methods[${idx}] "${name}" missing approvals array`);
    }
    if (!new RegExp(`\\.methods\\[${idx}\\]\\.inputs\\s*=`).test(schemaBody)) {
      issues.push(`methods[${idx}] "${name}" missing inputs array`);
    }
  }
  return issues;
}

function publicStateMissingFromUISchema(source: string, schemaBody: string): string[] {
  const skip = new Set(["taxToken", "creator", "factory"]);
  const coveredByAlias = (name: string): boolean => {
    if (name === "pendingRequestId") return /lastRequestId|"requestId"/.test(schemaBody);
    if (name === "aiModelId") return /setAiModel|"aiModelId"/.test(schemaBody);
    // Draw cadence/fee bookkeeping — exposed via events and manager flows, not standalone UI views.
    if (name === "lastDrawFee" || name === "lastDrawTime" || name === "currentWeek") return true;
    return false;
  };
  const missing: string[] = [];
  for (const m of source.matchAll(
    /(?:uint256|uint128|uint64|uint32|uint|bool|address)\s+public\s+(?:(constant|immutable)\s+)?(\w+)/g
  )) {
    const isFixed = m[1] === "constant" || m[1] === "immutable";
    const name = m[2]!;
    if (isFixed || skip.has(name) || coveredByAlias(name)) continue;
    if (schemaBody.includes(`"${name}"`)) continue;
    const camel = name.charAt(0).toUpperCase() + name.slice(1);
    if (schemaBody.includes(`"get${camel}"`)) continue;
    if (schemaBody.includes(`"view${camel}"`)) continue;
    missing.push(name);
  }
  return missing;
}

/** Source-structure logic checks beyond structural patterns — used by scanSafety and verify-codegen.
 * Phase 4: triggers are rule/structure-derived (never VaultKind-derived); vaultPlan is accepted
 * only for API compatibility and is not consulted. */
export function scanVaultLogic(source: string, userPrompt = "", _vaultPlan?: VaultPlan): string[] {
  const issues: string[] = [];
  const prompt = userPrompt.toLowerCase();
  const structure = detectSourceStructure(source);
  // Share-accrual / deposit accounting checks (classically "staking") fire from source structure.
  const isStake = structure.hasShareAccrual || structure.hasStakeShape;
  // Swap-out-of-receive checks (classically "buyback") fire from swap/budget structure.
  const isBuyback = structure.hasSwapStructure;
  // Oracle-outcome checks (classically "lottery") fire from the AI/oracle lifecycle or block entropy.
  const isLottery = structure.hasOracleLifecycle || structure.hasBlockEntropyOutcome;

  if (isStake) {
    const recv = source.match(/receive\s*\(\s*\)\s*external\s+payable[^{]*\{([\s\S]*?)^\s*\}/m)?.[1] ?? "";
    if (/accRewardPerShare\s*\+=/.test(recv) && /totalStaked\s*>\s*0/.test(recv)) {
      if (
        !/(?:else|totalStaked\s*==\s*0)[\s\S]{0,150}(rewardPool|treasury|undistributed|pendingRewards?)/.test(recv) &&
        !/rewardPool|undistributedRewards|pendingTaxRewards|pendingRewards/.test(source)
      ) {
        issues.push("Tax BNB lost when totalStaked == 0 (no rewardPool/treasury/pendingRewards fallback)");
      }
    }
    if (/accRewardPerShare\s*\+=/.test(recv) && /rewardPool\s*-=/i.test(source)) {
      issues.push("Mixed accRewardPerShare accrual with rewardPool -= on payout");
    }
    const claimBody = source.match(/function claimReward\s*\([^)]*\)[^{]*\{([\s\S]*?)^\s*\}/m)?.[1] ?? "";
    if (/updateUserReward|_updateReward/i.test(claimBody) && /require\s*\(\s*pending\s*>/.test(claimBody)) {
      issues.push("claimReward double-harvest (calls _updateReward then requires pending > 0)");
    }
    if (/rewardPool\s*\+=|pendingRewards\s*\+=/.test(recv)) {
      const stakeBody = source.match(/function stake\s*\([^)]*\)[^{]*\{([\s\S]*?)^\s*\}/m)?.[1] ?? "";
      const updatePoolRolls =
        /function\s+_?updatePool[\s\S]*?(accRewardPerShare\s*\+=|rewardPool\s*=\s*0|pendingRewards\s*=\s*0)/.test(
          source
        );
      const rollsOnStake =
        /rewardPool|pendingRewards/.test(stakeBody) ||
        (/_updatePool\s*\(\)|updatePool\s*\(\)/.test(stakeBody) && updatePoolRolls);
      if (!rollsOnStake) {
        issues.push("Pending rewards not rolled in on stake()");
      }
    }
    if (!/function\s+claim(?:Reward)?\s*\(/i.test(source)) {
      issues.push("Missing claim/claimReward function");
    }
  }

  if (isBuyback) {
    const recv = source.match(/receive\s*\(\s*\)\s*external\s+payable[^{]*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s)?.[1] ?? "";
    if (/swapExactInput|_buyAndBurn|_sendNative/.test(recv)) {
      issues.push("Buyback/payout inside receive() — split into buckets only");
    }
    if (/buybackBudget|treasury/.test(source)) {
      /* Rule 009: inherit full-balance emergencyWithdrawNative from CodegenVaultBase — do not require excess-only override. */
    }
  }

  if (isStake) {
    const stakeFnBody = source.match(/function stake\s*\([^)]*\)[^{]*\{([\s\S]*?)^\s*\}/m)?.[1] ?? "";
    if (/function stake/.test(source) && !/require\s*\(\s*amount\s*>\s*0/.test(stakeFnBody)) {
      issues.push("stake() missing require(amount > 0)");
    }
    if (
      /safeTransferFrom\s*\(/.test(stakeFnBody) &&
      !/beforeBal|afterBal|received|balanceOf\s*\(\s*address\s*\(\s*this\s*\)\s*\)\s*-/.test(stakeFnBody)
    ) {
      issues.push("stake() credits requested amount — use balance-before/after delta for fee-on-transfer taxToken");
    }
    if (/function claimReward/.test(source) && /_sendNative\s*\(/.test(stakeFnBody)) {
      issues.push("stake() auto-pays rewards while claimReward() exists — sync via claimReward only");
    }
    // stake-erases-pending-reward: rewardDebt reset after amount increase without prior claim/accrual.
    if (
      /user\.amount\s*\+=/.test(stakeFnBody) &&
      /rewardDebt\s*=/.test(stakeFnBody) &&
      !/(?:pending|_claim|claimReward|_updateReward|updateUserReward|_updatePool|updatePool|_accrue|accrue)[\s\S]{0,400}user\.amount\s*\+=/.test(
        stakeFnBody
      ) &&
      stakeFnBody.indexOf("rewardDebt =") > stakeFnBody.search(/user\.amount\s*\+=/)
    ) {
      issues.push(
        "stake() resets rewardDebt after increasing user.amount without first claiming or preserving pending rewards"
      );
    }
    // pendingreward-claim-mismatch: view shows undistributed/pending pool rewards claimReward cannot pay.
    const pendingViewBody = findFunctionBody(source, "pendingReward") ?? "";
    const claimBodyFull = findFunctionBody(source, "claimReward") ?? findFunctionBody(source, "claim") ?? "";
    const viewIncludesPool =
      /undistributedRewards|pendingRewards/.test(pendingViewBody) &&
      /accRewardPerShare[\s\S]{0,200}(undistributedRewards|pendingRewards)/.test(pendingViewBody);
    const claimDistributesPool =
      /undistributedRewards|pendingRewards/.test(claimBodyFull) &&
      /(undistributedRewards\s*=\s*0|pendingRewards\s*=\s*0|accRewardPerShare\s*\+=)/.test(claimBodyFull);
    if (viewIncludesPool && !claimDistributesPool) {
      issues.push("pendingReward(address) includes undistributedRewards but claimReward() does not distribute them");
    }
    const schemaBody = extractVaultUISchemaBody(source) ?? "";
    if (/function pendingReward\s*\(\s*address/.test(source) && schemaBody && !/\.name\s*=\s*"pendingReward"/.test(schemaBody)) {
      issues.push("pendingReward(address) exists but is missing from vaultUISchema.methods");
    }
    const descTrust = [
      source.match(/function description[\s\S]*?^\s*\}/m)?.[0] ?? "",
      schemaBody,
    ].join("\n");
    if (!/Guardian|Rule 009|emergency recovery|应急/i.test(descTrust)) {
      issues.push("Staking vault must disclose Guardian emergency recovery (Flap Rule 009) in description() or vaultUISchema.description");
    }
  }

  if (isLottery) {
    if (/block\.prevrandao|blockhash\s*\(/.test(source) && !/FlapAIConsumerBase/.test(source)) {
      issues.push("Uses block entropy instead of FlapAIConsumerBase");
    }
    if (
      /(?:entrants|entrantList)\.push/.test(source) &&
      !/MAX_ENTRANTS|(?:entrants|entrantList)\.length\s*[<>=]+\s*255/.test(source)
    ) {
      issues.push("No MAX_ENTRANTS cap at 255");
    }
    if (/FlapAIConsumerBase/.test(source) && /requestDraw|requestElimination/.test(source)) {
      if (!/drawSnapshot|entrantSnapshot/.test(source)) {
        issues.push("AI lottery without entrant snapshot array");
      }
    }
    const enterBody = source.match(/function enter\s*\([^)]*\)[^{]*\{([\s\S]*?)^\s*\}/m)?.[1] ?? "";
    if (/lastDrawTime\s*\+|roundStart\s*\+/.test(enterBody)) {
      issues.push("Weekly timer on enter() instead of requestDraw only");
    }
    if (/hasEntered/.test(source) && /delete\s+entrants|_fulfillReasoning/.test(source)) {
      const fulfillBody = findFunctionBody(source, "_fulfillReasoning") ?? "";
      if (fulfillBody && !/hasEntered[\s\S]{0,400}=\s*false/.test(fulfillBody)) {
        issues.push("hasEntered mapping never reset when round ends");
      }
    }
    const holderRequirement =
      /holder|hold token|token holder/i.test(prompt) ||
      /holder|持有/i.test(source.match(/function description[\s\S]*?^\s*\}/m)?.[0] ?? "");
    if (holderRequirement && /function enter/.test(source)) {
      const enter = source.match(/function enter[\s\S]*?^\s*\}/m)?.[0] ?? "";
      if (!/balanceOf\s*\(\s*msg\.sender\s*\)/.test(enter)) {
        issues.push("Holder lottery enter() missing taxToken balance check");
      }
    }
    const descBody = source.match(/function description[\s\S]*?return unicode"([^"]+)"/)?.[1] ?? "";
    if (
      /FlapAIConsumerBase/.test(source) &&
      /requestDraw/.test(source) &&
      /jackpot\s*>=\s*fee/.test(source) &&
      !/jackpot\s*>\s*fee|MIN_PRIZE|minimum prize/i.test(source)
    ) {
      issues.push("jackpot >= fee allows zero-prize winner — require jackpot > fee (or jackpot > fee + MIN_PRIZE)");
    }
    if (/FlapAIConsumerBase/.test(source) && /requestDraw/.test(source)) {
      const fulfillBody = findFunctionBody(source, "_fulfillReasoning") ?? "";
      if (fulfillBody && /_sendNative\s*\(\s*winner/.test(fulfillBody) && !/claimablePrize|claimPrize/.test(source)) {
        issues.push(
          "_fulfillReasoning push-pays winner via _sendNative — use claimablePrize[winner] += prize and claimPrize() pull payment"
        );
      }
      if (!/event DrawRequested/.test(source)) {
        issues.push("AI lottery missing DrawRequested event");
      }
      if (!/event DrawRefunded/.test(source)) {
        issues.push("AI lottery missing DrawRefunded event");
      }
      if (/function setAiModel/.test(source) && !/event AiModelUpdated/.test(source)) {
        issues.push("AI lottery missing AiModelUpdated event");
      }
      const refundBody = findFunctionBody(source, "_onFlapAIRequestRefunded") ?? "";
      if (/event DrawRefunded/.test(source) && refundBody && !/emit DrawRefunded/.test(refundBody)) {
        issues.push("_onFlapAIRequestRefunded must emit DrawRefunded(requestId, fee)");
      }
      const reqDrawBody = findFunctionBody(source, "requestDraw") ?? "";
      if (/event DrawRequested/.test(source) && reqDrawBody && !/emit DrawRequested/.test(reqDrawBody)) {
        issues.push("requestDraw() must emit DrawRequested after starting the AI request");
      }
      if (/random/i.test(descBody) && !/AI provider|AI-provider|Flap AI|oracle/i.test(descBody)) {
        issues.push('description() must disclose AI-provider winner selection — not bare "random" wording');
      }
    }
  }

  if (isSurvivorMechanic(source, userPrompt)) {
    const fulfillBody = findFunctionBody(source, "_fulfillReasoning") ?? "";
    const elimBody = findFunctionBody(source, "requestElimination") ?? "";
    if (fulfillBody && loopsSnapshotLengthAfterDelete(fulfillBody)) {
      issues.push(
        "Survivor _fulfillReasoning deletes drawSnapshot before looping drawSnapshot.length — rebuild entrants from the snapshot BEFORE delete drawSnapshot"
      );
    }
    if (fulfillBody && /drawSnapshot\.length\s*==\s*1/.test(fulfillBody)) {
      issues.push(
        "Survivor winner check uses drawSnapshot.length == 1 but requestElimination requires entrants.length > 1 — count survivors after elimination instead"
      );
    }
    if (
      fulfillBody &&
      /WinnerPaid|survivors\s*==\s*1/.test(fulfillBody) &&
      !/hasEntered\[winner\]\s*=\s*false/.test(fulfillBody)
    ) {
      issues.push("Final survivor winner must reset hasEntered[winner] = false so they can play again");
    }
    if (elimBody && loopsSnapshotLengthAfterDelete(elimBody)) {
      issues.push("requestElimination must repopulate drawSnapshot from entrants[] after delete — not loop empty drawSnapshot.length");
    }
    const emergBody = findFunctionBody(source, "emergencyWithdrawNative") ?? "";
    if (emergBody && /excess|reserved|survivorPool/.test(emergBody) && !/emit\s+EmergencyWithdrawNative/.test(emergBody)) {
      issues.push("emergencyWithdrawNative override must emit EmergencyWithdrawNative(to, amount)");
    }
  }

  // Trust / wording — applies to all vault types.
  const trustSurface = [
    source.match(/function description[\s\S]*?^\s*\}/m)?.[0] ?? "",
    source.match(/function vaultUISchema[\s\S]*?^\s*\}/m)?.[0] ?? "",
    source,
  ].join("\n");
  if (/secure random|cryptographically secure|true random|provably fair random/i.test(trustSurface)) {
    if (!/VRF|verifiable randomness|proof-backed|external AI provider|Flap AI provider|AI provider selection/i.test(trustSurface)) {
      issues.push('Overclaims randomness — use "external AI provider selection" for AI draws, not "secure random"');
    }
  }

  // Do not flag inherited Rule 009 full-balance emergency drain on bucket vaults.

  // AI async lifecycle.
  if (/FlapAIConsumerBase/.test(source) && /lastDrawFee|DrawFee/.test(source)) {
    const fulfillBody = findFunctionBody(source, "_fulfillReasoning") ?? "";
    if (fulfillBody && /lastDrawFee/.test(source) && !/lastDrawFee\s*=\s*0/.test(fulfillBody)) {
      issues.push("lastDrawFee not cleared after successful fulfillment");
    }
    const refundBody = findFunctionBody(source, "_onFlapAIRequestRefunded") ?? "";
    if (refundBody && /drawSnapshot/.test(source) && !/delete drawSnapshot/.test(refundBody)) {
      issues.push("AI refund handler does not clear stale drawSnapshot");
    }
  }

  if (/uint8\s*\(\s*(?:n|entrants\.length|drawSnapshot\.length)/.test(source)) {
    const reqDrawBody = findFunctionBody(source, "requestDraw") ?? "";
    const reqElimBody = findFunctionBody(source, "requestElimination") ?? "";
    const guard = reqDrawBody + reqElimBody;
    if (!/<=\s*255|<=\s*type\s*\(\s*uint8\s*\)\.max|MAX_ENTRANTS/.test(guard)) {
      issues.push("uint8 entrant cast without require(n <= 255) guard");
    }
  }

  // Buyback burn delta.
  if (/function\s+_buyAndBurn/.test(source) && /safeTransfer\s*\(\s*BURN_ADDRESS,\s*IERC20/.test(source)) {
    if (!/afterBal|beforeBal|received|delta/.test(source)) {
      issues.push("Buyback may burn full token balance instead of swap-received delta");
    }
  }

  return issues;
}

// ── Safety scanner (defense-in-depth on top of the compile gate) ────────────
export function scanSafety(
  source: string,
  contractName: string,
  userPrompt = "",
  opts: ScanSafetyOptions = {}
): { level: SafetyLevel; findings: SafetyFinding[] } {
  const { sourceScope = "child", vaultPlan, childSource, fullSourceOnly = false, mechanicSpec } = opts;
  const findings: SafetyFinding[] = [];
  const add = (level: "block" | "warn", rule: string, detail: string) =>
    findings.push({ level, rule, detail, sourceScope });

  if (fullSourceOnly) {
    scanSafetyFullInjected(source, childSource ?? source, userPrompt, vaultPlan, add);
    const level: SafetyLevel = findings.some((f) => f.level === "block")
      ? "fail"
      : findings.length
        ? "warn"
        : "pass";
    return { level, findings };
  }

  const has = (re: RegExp) => re.test(source);
  const hasBuyback =
    /buybackBudget|executeBuyback|_buyAndBurn/i.test(source) || /buyback/i.test(userPrompt);
  // Bucket solvency (Rule 001/003) fires structurally: any state var accumulated in
  // receive() and later spent (-=/= 0) is a fund bucket — user-chosen names included.
  const recvBodyForBuckets = extractReceiveBody(source) ?? "";
  const structuralBuckets = [...recvBodyForBuckets.matchAll(/(\w+)\s*\+=/g)]
    .map((m) => m[1]!)
    .filter((name) => new RegExp(`${name}\\s*(?:-=|=\\s*0\\s*;)`).test(source));
  const hasBuckets =
    /buybackBudget|treasury|jackpot|rewardPool|prizePotAmount|survivorPool/i.test(source) ||
    structuralBuckets.length > 0;
  const entrantArrayRe = /(?:entrants|entrantList|participantList|entryList)/;
  const prizeBucketRe = /(?:jackpot|prizePotAmount|survivorPool|rewardPool)/;
  const hasLottery =
    /FlapAIConsumerBase|entrants|_fulfillReasoning|requestDraw/i.test(source) ||
    /lottery|raffle|jackpot/i.test(userPrompt);

  // Hard blockers — money-loss / takeover primitives.
  if (has(/\bselfdestruct\s*\(/)) add("block", "no-selfdestruct", "Uses selfdestruct — can destroy the vault and funds.");
  if (has(/\bsuicide\s*\(/)) add("block", "no-selfdestruct", "Uses suicide (deprecated selfdestruct).");
  if (has(/\.delegatecall\s*\(/)) add("block", "no-delegatecall", "Uses delegatecall — arbitrary code execution risk.");
  if (has(/\btx\.origin\b/)) add("block", "no-tx-origin", "Uses tx.origin — phishing/auth bypass risk.");

  // Structural requirements.
  if (!new RegExp(`contract\\s+${contractName}\\b`).test(source)) {
    add("block", "contract-name", `Contract \"${contractName}\" not found in source.`);
  }
  if (!/\bCodegenVaultBase\b/.test(source) && !/\bVaultBaseV2\b/.test(source)) {
    add("block", "must-extend-base", "Contract must inherit CodegenVaultBase.");
  }
  if (!/receive\s*\(\s*\)\s*external\s+payable/.test(source)) {
    add("block", "must-have-receive", "Missing `receive() external payable`.");
  }
  if (!/function\s+description\s*\(/.test(source)) add("block", "must-have-description", "Missing description() override.");
  if (!/function\s+vaultUISchema\s*\(/.test(source)) add("block", "must-have-uischema", "Missing vaultUISchema() override.");

  // receive() must be cheap: no external calls / swaps / loops inside its body (Flap Rule 005).
  const recvBody = extractReceiveBody(source);
  if (recvBody !== null) {
    const body = recvBody;
    if (/\.call\s*\{|\.call\s*\(/.test(body)) add("block", "receive-no-external-call", "receive() makes a low-level call (Rule 005: tax dispatch can be bricked).");
    if (/\.transfer\s*\(|\.send\s*\(/.test(body)) add("block", "receive-no-transfer", "receive() transfers value.");
    if (/swapExactInput|_getPortal\s*\(|_buyAndBurn\s*\(|_sendNative\s*\(/.test(body)) {
      add("block", "receive-no-external-call", "receive() calls a swap/payout helper (_buyAndBurn/_sendNative). Move it to a keeper function.");
    }
    if (/\bfor\s*\(|\bwhile\s*\(/.test(body)) add("block", "receive-no-loop", "receive() contains a loop (gas-bomb risk).");
    if (/\bmsg\.sender\b/.test(body)) {
      add("warn", "receive-msg-sender", "receive() uses msg.sender — but in a tax deposit that is the protocol, not a holder. Per-user logic belongs in user-called functions.");
    }
    if (/\brequire\s*\(\s*msg\.value/.test(body)) {
      add("warn", "receive-reverts", "receive() can revert on a deposit (require on msg.value). Return early instead so tax dispatch never fails.");
    }
    const splitReceive =
      /msg\.value\s*\/\s*2\b|msg\.value\s*-\s*\w+Share|\bhalf\s*=/.test(body) || /buyback/i.test(body);
    const mentionsBuyback =
      /buyback|回购/i.test(userPrompt) ||
      /buyback|回购/i.test(source.match(/function description[\s\S]*?^\s*\}/m)?.[0] ?? "") ||
      /buyback|回购/i.test(extractVaultUISchemaBody(source) ?? "");
    if (splitReceive && mentionsBuyback) {
      const tracksBuyback = /buybackBudget\s*\+=/.test(body + source);
      const hasExecute = /function\s+executeBuyback\s*\(/.test(source);
      if (!tracksBuyback || !hasExecute) {
        add(
          "block",
          "buyback-split-not-implemented",
          "receive() splits tax for buyback/burn but buybackBudget and executeBuyback() are missing — reserved BNB is untracked until Guardian emergency withdrawal."
        );
      }
    }
  }

  // Soft warnings.
  if (has(/\bassembly\b/)) add("warn", "assembly", "Uses inline assembly — review carefully.");
  if (has(/\bnew\s+[A-Z]\w*\s*\(/)) add("warn", "deploys-contract", "Deploys another contract from within the vault.");
  if (has(/block\.difficulty\b/)) {
    add("block", "block-difficulty", "block.difficulty is removed in solc 0.8.26 — use FlapAIConsumerBase for random outcomes, not block entropy.");
  }
  // Block-derived randomness for winner/elimination selection is forbidden — use Flap AI oracle.
  const drawWinnerFn = extractFunctionChunks(source).find((f) => f.name === "drawWinner");
  const drawWinnerUsesBlockRand =
    drawWinnerFn !== undefined && usesBlockEntropyIn(drawWinnerFn.body);
  const usesPrngForWinner =
    (usesBlockEntropyIn(source) &&
      /random|raffle|winner|\bdraw\b|lottery|jackpot|pick|eliminat|survivor|prevrandao\s*%\s*entrants/i.test(
        source + userPrompt
      )) ||
    drawWinnerUsesBlockRand;
  if (usesPrngForWinner && !has(/FlapAIConsumerBase/)) {
    add(
      "block",
      "no-block-randomness",
      "Winner/elimination selection must use FlapAIConsumerBase (Flap AI oracle) — never block.prevrandao, blockhash, or timestamp % n. Use requestDraw/requestElimination + _fulfillReasoning (R1)."
    );
  }
  const paysFullBalance =
    has(/payable\([^)]*\)\.call\{value:\s*address\(this\)\.balance/) ||
    has(/_sendNative\([^,]+,\s*address\(this\)\.balance/);
  if (paysFullBalance) {
    add(
      hasBuckets ? "block" : "warn",
      "pays-full-balance",
      "Pays out address(this).balance — ignores per-bucket accounting. Pay from a specific bucket variable."
    );
  }
  if (has(/function\s+stake\s*\(/) && !has(/(safe)?[tT]ransferFrom\s*\(/)) {
    add("warn", "stake-no-transferfrom", "A stake() function exists but never calls transferFrom — users could 'stake' tokens they don't hold.");
  }
  const zeroSlippage = /_buyAndBurn\s*\([^,]+,\s*0\s*\)/.test(source) || /minOutputAmount:\s*0\b/.test(source);
  if (zeroSlippage) {
    add(
      hasBuyback ? "block" : "warn",
      "zero-slippage",
      "Buyback uses minOut = 0 (no slippage protection) — sandwichable. Require a real minimum from caller."
    );
  }
  // Fairness (Rule 003): sizing a payout from live balanceOf is flash-loan/MEV gameable.
  if (usesBalanceBasedPayout(source)) {
    add("block", "balance-based-payout", "Payout sized by live balanceOf(msg.sender) without staking — flash-buyable (Rule 003). Use stake + accRewardPerShare, fixed pools, or AI oracle winner selection.");
  }
  // UI-01: the Flap UI cannot decode custom error selectors — only literal require strings.
  if (has(/\berror\s+[A-Z]\w*\s*\(/) || has(/\brevert\s+[A-Z]\w*\s*\(/)) {
    add("block", "custom-error", "Custom errors are not allowed (Flap UI-01). Use require(cond, \"literal string\").");
  }
  // Rule 008: a trigger() callback MUST validate the Flap Trigger Service as sender.
  if (has(/function\s+trigger\s*\(\s*uint256/) && !has(/msg\.sender\s*==\s*_getFlapTriggerService\s*\(\s*\)/)) {
    add("block", "trigger-no-auth", "trigger(uint256) must require(msg.sender == _getFlapTriggerService()) (Rule 008) or anyone can fire it.");
  }
  // Rule 007: a self-defined AI callback MUST be provider-authenticated (inherit FlapAIConsumerBase instead).
  if (has(/function\s+fulfillReasoning\s*\(/) && !has(/onlyFlapAIProvider/)) {
    add("block", "ai-callback-no-auth", "fulfillReasoning must be onlyFlapAIProvider (Rule 007). Inherit FlapAIConsumerBase and override _fulfillReasoning instead.");
  }
  // Wrong service address: the AI provider is _getFlapAIProvider(), NOT _getPortal()/_getFlapTriggerService().
  if (has(/IFlapAIProvider\s*\(\s*_getPortal\s*\(/) || has(/IFlapAIProvider\s*\(\s*_getFlapTriggerService\s*\(/)) {
    add("block", "wrong-ai-address", "IFlapAIProvider must be constructed from _getFlapAIProvider(), not _getPortal()/_getFlapTriggerService().");
  }
  if (has(/\.reason\s*\{/) && !has(/_getFlapAIProvider\s*\(/)) {
    add("block", "wrong-ai-address", "An AI reason() request is made without using _getFlapAIProvider() for the provider address.");
  }
  if (has(/IFlapTriggerService\s*\(\s*_getPortal\s*\(/) || has(/IFlapTriggerService\s*\(\s*_getFlapAIProvider\s*\(/)) {
    add("block", "wrong-trigger-address", "IFlapTriggerService must be constructed from _getFlapTriggerService().");
  }
  // No half-built code: stubs/placeholders mean the mechanic is non-functional.
  if (has(/\bTODO\b|\bFIXME\b|placeholder|\bstub\b|should be replaced|not implemented|implement (?:this|the|actual|real|logic)/i)) {
    add("block", "placeholder-code", "Contains a stub/placeholder/TODO — the mechanic is not fully implemented. Implement it fully, or take off-chain data via an onlyManager keeper parameter.");
  }

  // vaultUISchema must not list description/vaultUISchema as methods.
  if (/\.methods\[\d+\]\.name\s*=\s*"(?:description|vaultUISchema)"/.test(source)) {
    add("block", "uischema-view-in-methods", 'vaultUISchema.methods must not include "description" or "vaultUISchema" — those are separate overrides.');
  }

  // Lottery + AI: require entrant snapshot array used in fulfill path.
  if (
    hasLottery &&
    has(/_fulfillReasoning/) &&
    has(/entrants/) &&
    !/drawSnapshot|entrantSnapshot|snapshotEntrants/i.test(source)
  ) {
    add(
      "block",
      "lottery-no-snapshot",
      "AI lottery must snapshot entrants at requestDraw() into drawSnapshot[] and pay from drawSnapshot in _fulfillReasoning — never index live entrants[] after the oracle request."
    );
  }

  // enter() must deduplicate participants.
  if (has(/function\s+enter\s*\(/) && has(/entrants\.push\s*\(\s*msg\.sender\s*\)/)) {
    if (!has(/hasEntered|entered\[|isEntrant|require\s*\(\s*![\s\S]{0,40}entered/)) {
      add("block", "enter-no-dedup", "enter() pushes msg.sender without a dedup guard — use mapping(address => bool) hasEntered.");
    }
  }

  // enter() must freeze while draw is pending.
  if (has(/function\s+enter\s*\(/) && has(/pendingRequestId/) && !has(/enter[\s\S]{0,400}pendingRequestId\s*==\s*0/)) {
    add("block", "draw-not-frozen", "enter() must require(pendingRequestId == 0) so entrants cannot join during an in-flight AI draw.");
  }

  // After draw, hasEntered must be cleared BEFORE delete entrants (or loop drawSnapshot).
  if (
    has(/_fulfillReasoning/) &&
    has(/hasEntered/) &&
    has(/delete\s+entrants/) &&
    /delete\s+entrants\s*;[\s\S]{0,300}entrants\.length/.test(source)
  ) {
    add(
      "block",
      "lottery-hasentered-not-cleared",
      "After delete entrants, entrants.length is 0 — reset hasEntered[] in a loop over drawSnapshot (or copy) BEFORE delete entrants, or users can never re-enter."
    );
  }

  // Demo lottery: enter() must not gate on weekly/round timers (locks first round or blocks entry).
  const enterFn = extractFunctionChunks(source).find((f) => f.name === "enter");
  if (enterFn) {
    const roundTimerInEnter =
      /lastDrawTime|roundStart|lastRound|drawEpoch|epochStart|lastDraw\b/.test(enterFn.body) &&
      /\+\s*(?:1\s+weeks?|7\s+days?|WEEK\b)/.test(enterFn.body);
    if (roundTimerInEnter) {
      add(
        "block",
        "lottery-enter-round-timer",
        "enter() must NOT check weekly/round timers (lastDrawTime + 1 weeks) — enforce cadence only on drawWinner()/requestDraw(). Initialize lastDrawTime = block.timestamp in constructor."
      );
    }
  }

  // Timed draw lotteries must initialize lastDrawTime (default 0 breaks first-round weekly cadence).
  const ctorBody = extractConstructorBody(source);
  if (
    has(/\blastDrawTime\b/) &&
    (has(/function\s+drawWinner\s*\(/) || has(/function\s+requestDraw\s*\(/)) &&
    /lastDrawTime\s*\+\s*(?:1\s+weeks?|7\s+days?|WEEK\b|DRAW_INTERVAL)/.test(source) &&
    !(ctorBody && /lastDrawTime\s*=\s*block\.timestamp/.test(ctorBody))
  ) {
    add(
      "block",
      "lottery-lastdraw-not-init",
      "Initialize lastDrawTime = block.timestamp in the constructor — default 0 makes the first draw instant or blocks entry incorrectly."
    );
  }

  // Unbounded entrant arrays in draw is a gas DoS — cap at MAX_ENTRANTS (<= 255).
  const drawsFromEntrantList =
    has(/function\s+drawWinner\s*\(/) ||
    has(/requestDraw\s*\(/) ||
    has(new RegExp(`for\\s*\\([^)]*${entrantArrayRe.source}\\.length`)) ||
    has(new RegExp(`%\\s*${entrantArrayRe.source}\\.length\\b`));
  if (
    has(new RegExp(`${entrantArrayRe.source}\\.push\\s*\\(`)) &&
    drawsFromEntrantList &&
    (hasLottery || has(/function\s+drawWinner\s*\(/))
  ) {
    const hasEntrantCap =
      /MAX_ENTRANTS|maxEntrants|MAX_ENTRANT/.test(source) ||
      new RegExp(`${entrantArrayRe.source}\\.length\\s*[<>=]+\\s*255`).test(source);
    if (!hasEntrantCap) {
      add(
        "block",
        "lottery-no-entrant-cap",
        "Lottery with entrantList/entrants.push + draw loop must cap entries: MAX_ENTRANTS <= 255 and require(entrantList.length < MAX_ENTRANTS) in enter()."
      );
    }
  }

  // Prevrandao demo lottery must disclose weak entropy in description().
  // (removed — no-block-randomness blocks all prevrandao winner paths)

  // roundStart / epoch timers must be initialized in constructor (same bug class as lastDrawTime).
  if (
    has(/\broundStart\b/) &&
    (has(/roundStart\s*\+\s*(?:1\s+days?|24\s+hours?|86400)/) || has(/function\s+enter\s*\(/)) &&
    !(ctorBody && /roundStart\s*=\s*block\.timestamp/.test(ctorBody))
  ) {
    add(
      "block",
      "lottery-round-not-init",
      "Initialize roundStart = block.timestamp in the constructor — default 0 breaks timed entry windows."
    );
  }

  // Survivor / elimination AI draws must snapshot active participants before oracle request.
  if (
    has(/_fulfillReasoning/) &&
    has(/eliminat|survivor|activeStakers|stakers/) &&
    (/survivor|eliminat/i.test(source) || /survivor|eliminat/i.test(userPrompt)) &&
    !/stakerSnapshot|activeSnapshot|eliminationSnapshot|snapshotStakers|drawSnapshot/i.test(source)
  ) {
    add(
      "block",
      "survivor-no-snapshot",
      "Survivor/elimination vault must snapshot active stakers at request time and use ONLY the snapshot in _fulfillReasoning — never index live arrays after the oracle request."
    );
  }

  // AI snapshot must be populated from live list — never loop empty drawSnapshot after delete.
  const elimFn = extractFunctionChunks(source).find(
    (f) => f.name === "requestElimination" || f.name === "requestDraw"
  );
  if (elimFn && has(/drawSnapshot/) && /delete\s+drawSnapshot/.test(elimFn.body)) {
    if (
      /delete\s+drawSnapshot[\s\S]{0,160}for\s*\(\s*uint256\s+i\s*=\s*0;\s*i\s*<\s*drawSnapshot\.length/.test(
        elimFn.body
      )
    ) {
      add(
        "block",
        "snapshot-empty-loop",
        "After delete drawSnapshot, you must repopulate it from stakers[]/entrants[] — looping drawSnapshot.length on an empty array skips every participant."
      );
    }
    const afterDelete = elimFn.body.split("delete drawSnapshot")[1] ?? "";
    if (
      afterDelete.includes("drawSnapshot.length") &&
      !/drawSnapshot\.push|stakers\.length|entrants\.length|isActiveStaker|hasEntered/.test(afterDelete)
    ) {
      add(
        "block",
        "snapshot-not-populated",
        "requestDraw/requestElimination must copy stakers[] or entrants[] into drawSnapshot after delete — before calling the AI oracle."
      );
    }
  }

  const fulfillFn = extractFunctionChunks(source).find((f) => f.name === "_fulfillReasoning");
  const refundFn = extractFunctionChunks(source).find((f) => f.name === "_onFlapAIRequestRefunded");
  const reqDrawFn = extractFunctionChunks(source).find((f) => f.name === "requestDraw");
  const survivor = isSurvivorMechanic(source, userPrompt);
  if (fulfillFn && survivor) {
    if (/drawSnapshot\.length\s*==\s*1/.test(fulfillFn.body)) {
      add(
        "block",
        "survivor-stale-snapshot-win",
        "Do not use drawSnapshot.length == 1 in _fulfillReasoning — requestElimination requires entrants.length > 1, so snapshot size is always >= 2. Count remaining survivors after marking eliminated inactive."
      );
    }
    if (loopsSnapshotLengthAfterDelete(fulfillFn.body)) {
      add(
        "block",
        "survivor-rebuild-after-delete",
        "In _fulfillReasoning rebuild entrants by looping drawSnapshot BEFORE delete drawSnapshot — after delete, drawSnapshot.length is 0 and the game breaks."
      );
    }
    if (
      (/WinnerPaid/.test(fulfillFn.body) || /survivors\s*==\s*1/.test(fulfillFn.body)) &&
      !/hasEntered\[winner\]\s*=\s*false/.test(fulfillFn.body)
    ) {
      add(
        "block",
        "survivor-winner-not-reset",
        "When the final survivor wins, set hasEntered[winner] = false before delete entrants so the winner is not permanently locked out."
      );
    }
  }

  if (
    fulfillFn &&
    survivor &&
    /delete\s+entrants/.test(fulfillFn.body) &&
    /entrants\s*=\s*new\s+address\[\]\(0\)/.test(fulfillFn.body) &&
    loopsSnapshotLengthAfterDelete(fulfillFn.body)
  ) {
    add(
      "block",
      "survivor-clears-entrants-empty-loop",
      "Never delete drawSnapshot then loop drawSnapshot.length to rebuild entrants — the loop runs zero times and entrants stays empty forever."
    );
  }

  if (
    has(/_fulfillReasoning/) &&
    (/survivor|eliminat/i.test(source) || /survivor|eliminat/i.test(userPrompt)) &&
    /delete\s+stakers/.test(source)
  ) {
    add(
      "block",
      "survivor-deletes-all-stakers",
      "Survivor _fulfillReasoning must remove ONLY the eliminated staker — never delete the entire stakers[] array after one elimination round."
    );
  }

  if (hasBuckets && /function\s+emergencyWithdrawNative\s*\(/.test(source)) {
    const emergOverride = extractFunctionChunks(source).find((f) => f.name === "emergencyWithdrawNative");
    if (emergOverride && /excess|reserved|buybackBudget\s*\+|jackpot\s*\+|treasury\s*\+/.test(emergOverride.body)) {
      add(
        "block",
        "excess-only-emergency-override",
        "Do not override emergencyWithdrawNative with excess-only logic — inherit Rule 009 full-balance drain from CodegenVaultBase unless the user explicitly opts out."
      );
    }
  }
  const emergTokOverride = extractFunctionChunks(source).find((f) => f.name === "emergencyWithdrawToken");
  if (
    emergTokOverride &&
    /totalStaked|excess|reserved/.test(emergTokOverride.body) &&
    /taxToken|token\s*==/.test(emergTokOverride.body)
  ) {
    add(
      "block",
      "excess-only-emergency-token",
      "Do not override emergencyWithdrawToken with excess-only/totalStaked logic — inherit Rule 009 full-token drain from CodegenVaultBase unless the user explicitly opts out."
    );
  } else if (/function\s+emergencyWithdrawNative\s*\([^)]*\)[^{]*onlyManager/.test(source)) {
    add(
      "block",
      "emergency-not-guardian",
      "emergencyWithdrawNative must use onlyGuardian (Flap Rule 009) — not onlyManager/creator."
    );
  }

  // Event param names must match emitted values (indexer/UI clarity).
  if (
    /event\s+BuybackExecuted\s*\([^)]*\bminOut\b/.test(source) &&
    (/emit\s+BuybackExecuted\s*\([^)]*tokensBought/.test(source) ||
      /emit\s+BuybackExecuted\s*\([^)]*_buyAndBurn/.test(source))
  ) {
    add(
      "block",
      "buyback-event-field-mismatch",
      "Rename BuybackExecuted second param to tokensBought — you emit the swap return value, not minOut."
    );
  }

  // Non-AI lottery: hasEntered must be cleared in drawWinner before delete entrants.
  const drawFn = extractFunctionChunks(source).find((f) => f.name === "drawWinner");
  if (drawFn && !has(/_fulfillReasoning/) && has(/hasEntered/) && /delete\s+entrants/.test(drawFn.body)) {
    const deleteIdx = drawFn.body.indexOf("delete entrants");
    const beforeDelete = drawFn.body.slice(0, deleteIdx);
    const clearsEntered =
      /hasEntered[\s\S]{0,120}=\s*false/.test(beforeDelete) ||
      /delete\s+hasEntered/.test(beforeDelete);
    if (!clearsEntered) {
      add(
        "block",
        "lottery-hasentered-not-cleared",
        "drawWinner() must reset hasEntered for every entrant in a loop BEFORE delete entrants."
      );
    }
  }

  // AI refund should restore fee taken from prize bucket via lastDrawFee.
  if (has(/_onFlapAIRequestRefunded/) && has(new RegExp(`${prizeBucketRe.source}\\s*-=\\s*fee`))) {
    const refundBody = refundFn?.body ?? "";
    const restoresFee =
      new RegExp(`${prizeBucketRe.source}\\s*\\+=\\s*lastDrawFee`).test(refundBody) ||
      new RegExp(`${prizeBucketRe.source}\\s*\\+=\\s*fee`).test(refundBody);
    if (!restoresFee) {
      add(
        "block",
        "lottery-refund-no-restore",
        "_onFlapAIRequestRefunded must restore prizePotAmount/jackpot += lastDrawFee (and clear pendingRequestId) when the AI oracle refunds a draw fee."
      );
    }
  }

  // Staking: reward payouts must not use live balanceOf for amounts.
  const hasStakeAccrual = has(/accRewardPerShare/) && has(/function\s+claim(?:Reward)?\s*\(/);
  if (hasStakeAccrual) {
    const hasAccrualState =
      has(/rewardDebt/) || has(/userRewardDebt/) || has(/UserInfo\s*\{[^}]*rewardDebt/);
    if (!hasAccrualState || !has(/totalStaked/)) {
      add("block", "stake-incomplete-accrual", "Stake vault with accRewardPerShare must track rewardDebt per user and totalStaked.");
    }
  }

  // Staking: tax BNB must not vanish when nobody is staked.
  const recvBodyStake = extractReceiveBody(source);
  if (
    recvBodyStake &&
    /accRewardPerShare\s*\+=/.test(recvBodyStake) &&
    /totalStaked\s*>\s*0/.test(recvBodyStake) &&
    !/(?:else|totalStaked\s*==\s*0)[\s\S]{0,120}(rewardPool|treasury|undistributed|pendingRewards?)/.test(
      recvBodyStake
    ) &&
    !/rewardPool|undistributedRewards|pendingTaxRewards|pendingRewards/.test(source)
  ) {
    add(
      "block",
      "stake-rewards-lost-no-stakers",
      "receive() only accrues when totalStaked > 0 — tax BNB is lost when nobody is staked. Use rewardPool/treasury when totalStaked == 0 and roll it in on next stake."
    );
  }

  // Staking: direct auto-pay inside stake() when claimReward exists.
  const stakeFnDirect = extractFunctionChunks(source).find((f) => f.name === "stake");
  if (
    stakeFnDirect &&
    has(/function\s+claim(?:Reward)?\s*\(/) &&
    /_sendNative\s*\(/.test(stakeFnDirect.body) &&
    !/updateUserReward|_updateReward|harvest/.test(stakeFnDirect.body)
  ) {
    add(
      "block",
      "stake-autopay-with-claim",
      "Do not _sendNative inside stake() when claimReward() exists — users should claim via claimReward() only."
    );
  }

  // Staking: hidden auto-payout from stake/unstake without syncing rewardDebt in the same internal fn.
  const harvestFn = extractFunctionChunks(source).find(
    (f) =>
      /updateUserReward|_updateReward|harvest|_claimPending|settleReward/i.test(f.name) &&
      /_sendNative\s*\(/.test(f.body)
  );
  if (harvestFn && has(/function\s+stake\s*\(/) && has(/function\s+claim(?:Reward)?\s*\(/)) {
    if (
      /stake\s*\([^)]*\)[\s\S]{0,400}(updateUserReward|_updateReward|harvest)|unstake\s*\([^)]*\)[\s\S]{0,400}(updateUserReward|_updateReward|harvest)/.test(
        source
      ) &&
      !/rewardDebt\s*=/.test(harvestFn.body)
    ) {
      add(
        "block",
        "stake-hidden-autopay",
        "Do not _sendNative inside updateUserReward/_updateReward called from stake/unstake without updating rewardDebt in that same function — use claim() only, or sync rewardDebt immediately after each payout."
      );
    }
  }

  // Staking: mixed rewardPool + accRewardPerShare accounting (rewardPool -= when tax went to accRewardPerShare).
  if (
    has(/accRewardPerShare/) &&
    has(/rewardPool/) &&
    /rewardPool\s*-=/.test(source)
  ) {
    const recvStake = extractReceiveBody(source);
    if (recvStake && /accRewardPerShare\s*\+=/.test(recvStake)) {
      add(
        "block",
        "stake-rewardpool-desync",
        "Do not decrement rewardPool when paying accRewardPerShare rewards — tax accrued via accRewardPerShare was never added to rewardPool. Pay from contract balance only, or route ALL tax through pendingRewards/rewardPool first."
      );
    }
  }

  // Staking: claimReward calls harvest then requires pending > 0 (always reverts after harvest).
  const claimFn = extractFunctionChunks(source).find((f) => f.name === "claimReward" || f.name === "claim");
  if (claimFn && /updateUserReward|_updateReward|harvest/i.test(claimFn.body)) {
    if (/require\s*\(\s*pending\s*>/.test(claimFn.body)) {
      add(
        "block",
        "stake-claim-double-harvest",
        "claimReward must not call _updateReward/harvest then require(pending > 0) — harvest already paid and zeroed pending. Pay once inside claimReward only."
      );
    }
  }

  // Staking: pendingRewards only rolled when totalStaked > 0 — first staker loses pre-stake tax.
  const stakeFnRoll = extractFunctionChunks(source).find((f) => f.name === "stake");
  if (stakeFnRoll && has(/pendingRewards/) && /pendingRewards\s*>\s*0/.test(stakeFnRoll.body)) {
    const rollsForFirst =
      /pendingRewards[\s\S]{0,250}\(totalStaked\s*\+\s*amount|totalStaked\s*\+\s*amount[\s\S]{0,250}pendingRewards/.test(
        stakeFnRoll.body
      ) || /totalStaked\s*==\s*0[\s\S]{0,200}pendingRewards/.test(stakeFnRoll.body);
    if (/pendingRewards[\s\S]{0,80}totalStaked\s*>\s*0/.test(stakeFnRoll.body) && !rollsForFirst) {
      add(
        "block",
        "stake-first-staker-pending-lost",
        "Roll pendingRewards using (totalStaked + amount) as denominator — if you only roll when totalStaked > 0, the first staker never gets pre-stake tax."
      );
    }
  }

  // Staking: pendingRewards never referenced in stake() at all.
  if (has(/pendingRewards\s*\+=/) && has(/function\s+stake\s*\(/)) {
    const stakeFnPending = extractFunctionChunks(source).find((f) => f.name === "stake");
    const updatePoolRolls =
      /function\s+_?updatePool[\s\S]*?(accRewardPerShare\s*\+=|pendingRewards\s*=\s*0)/.test(source);
    const rollsOnStake =
      stakeFnPending &&
      (/pendingRewards/.test(stakeFnPending.body) ||
        (/_updatePool\s*\(\)|updatePool\s*\(\)/.test(stakeFnPending.body) && updatePoolRolls));
    if (stakeFnPending && !rollsOnStake) {
      add(
        "block",
        "stake-pending-not-rolled",
        "stake() must roll pendingRewards into accRewardPerShare — otherwise pre-stake tax is stuck forever."
      );
    }
  }

  // Timed lottery: lastDrawTime must advance after a successful draw (fulfill or drawWinner).
  if (
    has(/\blastDrawTime\b/) &&
    has(/function\s+requestDraw\s*\(/) &&
    /lastDrawTime\s*\+\s*(?:1\s+weeks?|DRAW_INTERVAL|7\s+days?)/.test(source)
  ) {
    const fulfill = extractFunctionChunks(source).find((f) => f.name === "_fulfillReasoning");
    const drawWin = extractFunctionChunks(source).find((f) => f.name === "drawWinner");
    const updatesTime =
      (fulfill && /lastDrawTime\s*=\s*block\.timestamp/.test(fulfill.body)) ||
      (drawWin && /lastDrawTime\s*=\s*block\.timestamp/.test(drawWin.body));
    if (!updatesTime) {
      add(
        "block",
        "lottery-lastdraw-not-updated",
        "Set lastDrawTime = block.timestamp in _fulfillReasoning (or drawWinner) after paying the winner — otherwise the next draw can be requested immediately."
      );
    }
  }

  // Bucket accounting: AI fee from balance without bucket decrement.
  if (hasBuckets && has(/\.reason\s*\{/) && has(/address\s*\(\s*this\s*\)\.balance\s*>=/)) {
    if (
      !has(
        /jackpot\s*-=\s*fee|prizePotAmount\s*-=\s*fee|buybackBudget\s*-=\s*fee|treasury\s*-=\s*fee|feeBucket\s*-=/
      )
    ) {
      add(
        "block",
        "bucket-balance-desync",
        "AI oracle fee checks address(this).balance but does not decrement a named bucket (e.g. jackpot -= fee) — bucket counters will desync from real BNB."
      );
    }
  }

  // Production quality — match FreeCoin / Flap reference vault bar.
  if (hasAsciiOnlyRequire(source)) {
    add(
      "block",
      "require-not-bilingual",
      'Every require message must be bilingual: require(cond, unicode"English / 中文") — bare ASCII strings break Flap UI (Rule 004).'
    );
  }
  if (has(/try\s*\{[\s\S]*?\}\s*catch\s*\{\s*\}/)) {
    add("block", "silent-empty-catch", "Silent try/catch {} swallows failures — use require or explicit handling.");
  }

  const schemaBody = extractVaultUISchemaBody(source);
  if (schemaBody) {
    const uiIssues = uischemaIncomplete(schemaBody);
    if (uiIssues.length > 0) {
      add(
        "block",
        "uischema-incomplete",
        `vaultUISchema incomplete: ${uiIssues.slice(0, 3).join("; ")}. Every method needs inputs, outputs, and approvals arrays (even if empty).`
      );
    }
    const missingViews = publicStateMissingFromUISchema(source, schemaBody);
    if (missingViews.length > 0) {
      add(
        "block",
        "public-state-not-in-uischema",
        `Expose public state in vaultUISchema as view methods: ${missingViews.join(", ")}.`
      );
    }
  }

  if (has(/transferFrom\s*\(/) && schemaBody && !/ApproveAction\s*\(\s*"taxToken"/.test(schemaBody)) {
    add(
      "block",
      "stake-no-approve-action",
      'Functions using transferFrom require ApproveAction("taxToken", "<amountField>") on the matching vaultUISchema write method.'
    );
  }
  if (has(/ApproveAction\s*\(\s*\{/) || has(/amountField\s*:/) || has(/ApproveAction\s*\(\s*taxToken\b/)) {
    add(
      "block",
      "approve-action-wrong-syntax",
      'ApproveAction must be positional strings only: ApproveAction("taxToken", "amount"). No named struct args; vaultUISchema is pure so never use the taxToken variable.'
    );
  }
  if (has(/VaultMethodSchema\s*\(\s*\{/) || has(/FieldDescriptor\s*\(\s*\{/)) {
    add(
      "block",
      "uischema-named-ctor",
      "VaultMethodSchema and FieldDescriptor must use positional args only — never named struct constructors like FieldDescriptor({name: ...})."
    );
  }

  for (const fn of extractFunctionChunks(source)) {
    const pays =
      /_sendNative\s*\(|_buyAndBurn\s*\(|\.call\{value:/.test(fn.body) ||
      (/function\s+\w+\s*\([^)]*address\s+\w+/.test(fn.header) && /_sendNative\s*\(\s*\w+/.test(fn.body));
    if (!pays) continue;
    const isExternal = /external|public/.test(fn.header);
    if (!isExternal) continue;
    if (!/nonReentrant/.test(fn.header)) {
      add(
        "block",
        "payout-no-nonreentrant",
        `Function ${fn.name}() sends value but lacks nonReentrant — add nonReentrant to every payout/swap function.`
      );
      break;
    }
    if (/address\s+\w+/.test(fn.header) && /_sendNative\s*\(\s*\w+/.test(fn.body) && !/!=\s*address\s*\(\s*0\s*\)/.test(fn.body)) {
      add(
        "block",
        "payout-no-recipient-check",
        `Function ${fn.name}() pays to a recipient address but never checks recipient != address(0).`
      );
      break;
    }
  }

  const writeFns = extractFunctionChunks(source).filter(
    (f) => /external|public/.test(f.header) && /nonReentrant/.test(f.header) && !/view|pure/.test(f.header)
  );
  const hasEvents = /\bevent\s+\w+/.test(source);
  if (writeFns.length >= 2 && !hasEvents) {
    add("block", "missing-events", "Vault has multiple write functions but no events — emit on every budget/payout/state change.");
  }

  // Trust wording — do not overclaim "secure random" without VRF/proof source.
  const trustText = [
    extractFunctionChunks(source).find((f) => f.name === "description")?.body ?? "",
    extractVaultUISchemaBody(source) ?? "",
    source,
  ].join("\n");
  if (/secure random|cryptographically secure|true random|provably fair random/i.test(trustText)) {
    if (
      !/VRF|verifiable randomness|proof-backed|external AI provider|Flap AI provider|AI provider selection/i.test(
        trustText
      )
    ) {
      add(
        "block",
        "secure-random-overclaim",
        'Do not describe AI/oracle draws as "secure random" — use "external AI provider selection" unless you use a VRF/proof-backed source.'
      );
    }
  }

  if (hasStakeAccrual && has(/function\s+pendingReward\s*\(\s*address/)) {
    const schemaBodyStake = extractVaultUISchemaBody(source) ?? "";
    if (schemaBodyStake && !/\.name\s*=\s*"pendingReward"/.test(schemaBodyStake)) {
      add(
        "block",
        "stake-pending-not-in-schema",
        "pendingReward(address) must appear as a view method in vaultUISchema.methods."
      );
    }
  }

  // Rule 009: any vault taking user token custody (free-form deposit/commit/lock names)
  // must disclose Guardian emergency recovery in description/schema — fires from
  // transferFrom(msg.sender …) structure, not from a "stake" vocabulary gate.
  const custody = detectSourceStructure(source);
  if (custody.hasUserTokenCustody || custody.hasStakeShape) {
    const stakeTrust = [
      extractFunctionChunks(source).find((f) => f.name === "description")?.body ?? "",
      extractVaultUISchemaBody(source) ?? "",
    ].join("\n");
    if (!/Guardian|Rule 009|emergency recovery|应急/i.test(stakeTrust)) {
      add(
        "block",
        "staking-guardian-trust-undisclosed",
        "Vault takes custody of user tokens (transferFrom in a user action) — description()/vaultUISchema must disclose Guardian emergency recovery per Flap Rule 009."
      );
    }
  }

  // uint8 entrant count cast must be capped.
  if (has(/uint8\s*\(\s*(?:n|entrants\.length|drawSnapshot\.length)/)) {
    const reqFn = extractFunctionChunks(source).find(
      (f) => f.name === "requestDraw" || f.name === "requestElimination"
    );
    const guardBody = reqFn?.body ?? "";
    if (!/<=\s*255|<=\s*type\s*\(\s*uint8\s*\)\.max|MAX_ENTRANTS/.test(guardBody)) {
      add(
        "block",
        "uint8-cast-uncapped",
        "Before uint8(n) for AI callback, require(n > 0 && n <= 255) or require(n <= type(uint8).max) — entrant loops must be capped."
      );
    }
  }

  // lastDrawFee must clear after successful fulfillment.
  if (has(/lastDrawFee/) && fulfillFn) {
    if (!/lastDrawFee\s*=\s*0/.test(fulfillFn.body)) {
      add(
        "block",
        "lastDrawFee-not-cleared",
        "Set lastDrawFee = 0 in _fulfillReasoning after a successful draw — stale fee state breaks refund accounting."
      );
    }
  }

  // AI refund must clear stale snapshot.
  if (refundFn && has(/drawSnapshot/) && !/delete drawSnapshot/.test(refundFn.body)) {
    add(
      "block",
      "refund-stale-snapshot",
      "_onFlapAIRequestRefunded must delete drawSnapshot (and clear pendingRequestId) so the round is not stuck."
    );
  }

  // requestDraw must block while async request pending.
  if (has(/function\s+requestDraw\s*\(/) && has(/pendingRequestId/) && !has(/requestDraw[\s\S]{0,400}pendingRequestId\s*==\s*0/)) {
    add(
      "block",
      "draw-request-not-guarded",
      "requestDraw() must require(pendingRequestId == 0) — never start overlapping AI requests."
    );
  }

  // Staking: require(amount > 0) and fee-on-transfer balance delta.
  if (stakeFnDirect && has(/function\s+stake\s*\(/) && has(/totalStaked/)) {
    if (!/require\s*\(\s*amount\s*>\s*0/.test(stakeFnDirect.body)) {
      add("block", "stake-zero-amount", "stake() must require(amount > 0, unicode\"... / ...\").");
    }
    if (
      /safeTransferFrom\s*\(/.test(stakeFnDirect.body) &&
      !/beforeBal|afterBal|received|balanceOf\s*\(\s*address\s*\(\s*this\s*\)\s*\)\s*-/.test(stakeFnDirect.body)
    ) {
      add(
        "block",
        "stake-no-balance-delta",
        "stake() must credit actual tokens received (balance before/after safeTransferFrom) — taxToken may be fee-on-transfer."
      );
    }
    // stake-erases-pending-reward
    if (
      /user\.amount\s*\+=|userInfo\[msg\.sender\]\.amount\s*\+=/.test(stakeFnDirect.body) &&
      /rewardDebt\s*=/.test(stakeFnDirect.body) &&
      !/(?:pending|_claim|claimReward|_updateReward|updateUserReward|_updatePool|updatePool)[\s\S]{0,500}(?:user\.amount\s*\+=|userInfo\[msg\.sender\]\.amount\s*\+=)/.test(
        stakeFnDirect.body
      ) &&
      stakeFnDirect.body.search(/rewardDebt\s*=/) > stakeFnDirect.body.search(/(?:user\.amount\s*\+=|userInfo\[msg\.sender\]\.amount\s*\+=)/)
    ) {
      add(
        "block",
        "stake-erases-pending-reward",
        "stake() resets rewardDebt after increasing user.amount without first claiming or preserving pending rewards."
      );
    }
  }

  // pendingreward-claim-mismatch
  const pendingViewFn = extractFunctionChunks(source).find((f) => f.name === "pendingReward");
  const claimFnStake = extractFunctionChunks(source).find((f) => f.name === "claimReward" || f.name === "claim");
  if (pendingViewFn && claimFnStake && hasStakeAccrual) {
    const viewIncludesPool =
      /undistributedRewards|pendingRewards/.test(pendingViewFn.body) &&
      /accRewardPerShare[\s\S]{0,250}(undistributedRewards|pendingRewards)/.test(pendingViewFn.body);
    const claimDistributesPool =
      /undistributedRewards|pendingRewards/.test(claimFnStake.body) &&
      /(undistributedRewards\s*=\s*0|pendingRewards\s*=\s*0|accRewardPerShare\s*\+=)/.test(claimFnStake.body);
    if (viewIncludesPool && !claimDistributesPool) {
      add(
        "block",
        "pendingreward-claim-mismatch",
        "pendingReward(address) includes undistributedRewards/pendingRewards but claimReward() does not roll or distribute them — UI shows unclaimable rewards."
      );
    }
  }

  // Staking vaults should expose pendingReward(address) view for UI.
  if (hasStakeAccrual && !has(/function\s+pendingReward\s*\(\s*address/)) {
    add(
      "block",
      "stake-no-pending-view",
      "Add pendingReward(address user) external view returns (uint256) so the UI can display accrued rewards."
    );
  }

  // Rule 009: do not require staking vaults to block Guardian token drain — inherit base; disclose trust instead.

  // enter() on lottery/survivor should use nonReentrant when mutating entrant state.
  if (enterFn && has(/entrants\.push|hasEntered/) && !/nonReentrant/.test(enterFn.header)) {
    add(
      "block",
      "enter-no-nonreentrant",
      "enter() mutates entrant state — add nonReentrant to prevent reentrancy during entry."
    );
  }

  // Holder lottery: enter() should verify token balance when prompt implies holders-only.
  const descFn = extractFunctionChunks(source).find((f) => f.name === "description");
  const descText = descFn?.body ?? "";
  const holderImplied =
    /holder|hold token|token holder/i.test(userPrompt) || /holder|持有/i.test(descText);
  if (enterFn && holderImplied && !/balanceOf\s*\(\s*msg\.sender\s*\)/.test(enterFn.body)) {
    add(
      "block",
      "holder-lottery-no-balance",
      "Holder lottery enter() must require(IERC20(taxToken).balanceOf(msg.sender) >= minimum) — verify the entrant holds tokens, or say 'open entry' in description()."
    );
  }

  // AI lottery: jackpot >= fee leaves zero prize for winner.
  if (
    reqDrawFn &&
    has(/FlapAIConsumerBase/) &&
    new RegExp(`${prizeBucketRe.source}\\s*>=\\s*fee`).test(reqDrawFn.body) &&
    !new RegExp(`${prizeBucketRe.source}\\s*>\\s*fee`).test(reqDrawFn.body) &&
    !/MIN_PRIZE|minimum prize/i.test(reqDrawFn.body + source)
  ) {
    add(
      "block",
      "lottery-jackpot-fee-zero-prize",
      "require(prizePot/jackpot > fee) — >= fee lets the winner receive 0 after the oracle fee is deducted."
    );
  }

  // AI draw fee must be stored in lastDrawFee for refund accounting.
  if (
    reqDrawFn &&
    has(/FlapAIConsumerBase/) &&
    new RegExp(`${prizeBucketRe.source}\\s*-=\\s*fee`).test(reqDrawFn.body) &&
    !/lastDrawFee\s*=/.test(reqDrawFn.body)
  ) {
    add(
      "block",
      "ai-draw-fee-not-tracked",
      "requestDraw() must set lastDrawFee = fee when deducting from prizePotAmount/jackpot — refunds must restore the bucket."
    );
  }

  // requestDraw with zero entrants must require entrants or advance lastDrawTime (no spam loop).
  if (reqDrawFn && has(/lastDrawTime/) && has(/function\s+enter\s*\(/)) {
    const zeroBranch = reqDrawFn.body.match(
      new RegExp(`(?:${entrantArrayRe.source})\\.length\\s*==\\s*0[\\s\\S]{0,240}`)
    )?.[0];
    if (
      zeroBranch &&
      /return\s*;/.test(zeroBranch) &&
      !/require\s*\([^)]*\.length\s*>\s*0/.test(reqDrawFn.body) &&
      !/lastDrawTime\s*=\s*block\.timestamp/.test(zeroBranch)
    ) {
      add(
        "block",
        "lottery-no-entrants-spam",
        "requestDraw() must require(entrantList.length > 0) or set lastDrawTime when no entrants — otherwise manager can spam NoEntrants forever."
      );
    }
  }

  // AI lottery: push payout in oracle callback can revert on contract winners.
  if (
    fulfillFn &&
    has(/FlapAIConsumerBase/) &&
    has(/requestDraw/) &&
    /_sendNative\s*\(\s*winner/.test(fulfillFn.body) &&
    !/claimablePrize|claimPrize/.test(source)
  ) {
    add(
      "block",
      "ai-lottery-push-payout",
      "In _fulfillReasoning credit claimablePrize[winner] and add claimPrize() — do not _sendNative(winner) in the oracle callback."
    );
  }

  // Pull-claim vaults must not emit PrizeCollected/RewardCollected in the oracle callback.
  if (
    fulfillFn &&
    has(/FlapAIConsumerBase/) &&
    /claimablePrize|claimableReward/.test(source) &&
    /emit\s+(?:PrizeCollected|RewardCollected)\s*\(/.test(fulfillFn.body)
  ) {
    add(
      "block",
      "pull-prize-event-in-fulfill",
      "Use PrizeAwarded in _fulfillReasoning when crediting claimablePrize — reserve PrizeCollected for claimPrize() only."
    );
  }

  // AI lottery must disclose AI-provider selection and Guardian recovery in description/schema.
  if (has(/FlapAIConsumerBase/) && has(/requestDraw/)) {
    const descTrust = [
      source.match(/function description[\s\S]*?^\s*\}/m)?.[0] ?? "",
      extractVaultUISchemaBody(source) ?? "",
    ].join("\n");
    if (!/AI.{0,30}provider|AI.{0,20}oracle|AI.{0,20}selected|AI.{0,20}选择|provider/i.test(descTrust)) {
      add(
        "block",
        "ai-lottery-no-provider-disclosure",
        "AI lottery must disclose in description() and vaultUISchema.description that the winner is selected by the Flap AI provider (not verifiable on-chain randomness)."
      );
    }
    if (!/Guardian|Rule 009|emergency recovery|应急/i.test(descTrust)) {
      add(
        "block",
        "ai-lottery-guardian-undisclosed",
        "Disclose inherited Guardian emergency recovery (Flap Rule 009) in description() and vaultUISchema.description."
      );
    }
  }

  // AI lottery: indexer events for draw lifecycle.
  if (has(/FlapAIConsumerBase/) && has(/function\s+requestDraw\s*\(/)) {
    if (!has(/event DrawRequested/)) {
      add("block", "ai-lottery-no-draw-requested", "Emit event DrawRequested(uint256 indexed requestId, uint256 entrantCount, uint256 fee) on requestDraw().");
    } else if (reqDrawFn && !/emit DrawRequested/.test(reqDrawFn.body)) {
      add("block", "ai-lottery-no-draw-requested-emit", "requestDraw() must emit DrawRequested after p.reason(...).");
    }
    if (!has(/event DrawRefunded/)) {
      add("block", "ai-lottery-no-draw-refunded", "Declare event DrawRefunded(uint256 indexed requestId, uint256 fee) for oracle refunds.");
    } else if (refundFn && !/emit DrawRefunded/.test(refundFn.body)) {
      add("block", "ai-lottery-no-draw-refunded-emit", "_onFlapAIRequestRefunded must emit DrawRefunded(requestId, lastDrawFee).");
    }
    const setModelFn = extractFunctionChunks(source).find((f) => f.name === "setAiModel");
    if (setModelFn) {
      if (!has(/event AiModelUpdated/)) {
        add("block", "ai-lottery-no-model-event", "Declare event AiModelUpdated(uint256 indexed modelId) and emit it from setAiModel().");
      } else if (!/emit AiModelUpdated/.test(setModelFn.body)) {
        add("block", "ai-lottery-no-model-event-emit", "setAiModel() must emit AiModelUpdated(id).");
      }
    }
  }

  // AI lottery: description must disclose provider trust, not vague "random".
  if (has(/FlapAIConsumerBase/) && has(/requestDraw/)) {
    const aiTrustText = [descText, extractVaultUISchemaBody(source) ?? ""].join("\n");
    if (
      /\brandom\b/i.test(aiTrustText) &&
      !/AI provider|AI-provider|Flap AI|oracle selection|provider selection/i.test(aiTrustText)
    ) {
      add(
        "block",
        "ai-random-wording",
        'description()/vaultUISchema must say "AI-provider selected" — bare "random winner/participant" hides provider trust.'
      );
    }
  }

  // Child must not override _buyAndBurn to burn full balance.
  const buyBurnFn = extractFunctionChunks(source).find((f) => f.name === "_buyAndBurn");
  if (
    buyBurnFn &&
    /safeTransfer\s*\(\s*BURN_ADDRESS,\s*IERC20\s*\(\s*taxToken\s*\)\.balanceOf/.test(buyBurnFn.body) &&
    !/beforeBal|afterBal|received|delta/.test(buyBurnFn.body)
  ) {
    add(
      "block",
      "buyback-burns-full-balance",
      "_buyAndBurn must burn only the swap-received token delta (balance-after minus balance-before), not the full vault token balance."
    );
  }

  for (const detail of scanVaultLogic(source, userPrompt, vaultPlan)) {
    if (findings.some((f) => f.detail === detail)) continue;
    add("block", "vault-logic", detail);
  }

  for (const mf of scanMechanicCompleteness(source, userPrompt, vaultPlan, mechanicSpec)) {
    if (findings.some((f) => f.rule === mf.rule)) continue;
    add(mf.level ?? "block", mf.rule, mf.detail);
  }

  const level: SafetyLevel = findings.some((f) => f.level === "block")
    ? "fail"
    : findings.length
      ? "warn"
      : "pass";
  return { level, findings };
}

/** Full-injected source checks — inherited base emergency + custody context. */
function scanSafetyFullInjected(
  fullSource: string,
  childSource: string,
  userPrompt: string,
  _vaultPlan: VaultPlan | undefined,
  add: (level: "block" | "warn", rule: string, detail: string) => void
): void {
  // Phase 4: fires from user-token-custody structure in the child source, not from VaultKind.
  const childStructure = detectSourceStructure(childSource);
  const isStake = childStructure.hasUserTokenCustody || childStructure.hasStakeShape;

  if (!isStake) return;

  const childOverridesNative = /function\s+emergencyWithdrawNative\s*\(/.test(childSource);
  const childOverridesToken = /function\s+emergencyWithdrawToken\s*\(/.test(childSource);
  const stakeTrust = [
    extractFunctionChunks(childSource).find((f) => f.name === "description")?.body ?? "",
    extractVaultUISchemaBody(childSource) ?? "",
  ].join("\n");
  const disclosed = /Guardian|Rule 009|emergency recovery|应急|staked token/i.test(stakeTrust);

  if (!childOverridesNative && /function\s+emergencyWithdrawNative\s*\(/.test(fullSource)) {
    add(
      disclosed ? "warn" : "block",
      "staking-native-emergency-drain",
      "Inherited emergencyWithdrawNative drains all BNB including claimable rewards. Disclose Guardian Rule 009 in description/schema or override with explicit policy."
    );
  }

  if (
    !childOverridesToken &&
    /function\s+emergencyWithdrawToken\s*\(/.test(fullSource) &&
    /safeTransferFrom\s*\(/.test(childSource)
  ) {
    add(
      disclosed ? "warn" : "block",
      "staking-guardian-token-drain",
      "Inherited emergencyWithdrawToken can drain staked taxToken. Disclose Guardian can recover staked tokens in description/schema."
    );
  }
}

/** Run scanners on child + full injected source; dedupe by rule+scope. */
export function scanSafetyCombined(
  childSource: string,
  fullSource: string,
  contractName: string,
  userPrompt: string,
  vaultPlan?: VaultPlan,
  mechanicSpec?: MechanicSpec
): { level: SafetyLevel; findings: SafetyFinding[] } {
  const child = scanSafety(childSource, contractName, userPrompt, {
    sourceScope: "child",
    vaultPlan,
    childSource,
    mechanicSpec,
  });
  const full = scanSafety(fullSource, contractName, userPrompt, {
    sourceScope: "full-injected",
    vaultPlan,
    childSource,
    fullSourceOnly: true,
  });

  const seen = new Set<string>();
  const findings: SafetyFinding[] = [];
  for (const f of [...child.findings, ...full.findings]) {
    const key = `${f.rule}:${f.sourceScope}:${f.detail.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }

  const level: SafetyLevel = findings.some((f) => f.level === "block")
    ? "fail"
    : findings.length
      ? "warn"
      : "pass";
  return { level, findings };
}

// ── forge compile gate ──────────────────────────────────────────────────────
async function compile(
  contractName: string,
  body: string
): Promise<{ ok: boolean; errors: string; artifactPath: string; filePath: string }> {
  // Clear any prior generated file so stale/broken attempts never pollute `forge build`/`forge test`.
  await rm(CODEGEN_DIR, { recursive: true, force: true });
  await mkdir(CODEGEN_DIR, { recursive: true });
  const fileName = `${contractName}.sol`;
  const filePath = path.join(CODEGEN_DIR, fileName);
  const source = `${PREAMBLE}\n${body.trim()}\n`;
  await writeFile(filePath, source, "utf8");

  const artifactPath = path.join(REPO_ROOT, "out", fileName, `${contractName}.json`);

  try {
    // Build only the generated file's tree; the rest of the repo is cached.
    const { stdout } = await execAsync(`"${FORGE}" build "${filePath}" 2>&1`, {
      cwd: REPO_ROOT,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 16,
    });
    // Pretty-print so the source shown in the UI is readable (best-effort).
    try {
      await execAsync(`"${FORGE}" fmt "${filePath}"`, { cwd: REPO_ROOT, timeout: 20_000 });
    } catch {
      /* formatting is cosmetic — ignore failures */
    }
    return { ok: true, errors: "", artifactPath, filePath };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout || "") + (e.stderr || "") || e.message || "Unknown compile error";
    if (isForgeCompileSuccess(raw)) {
      try {
        await execAsync(`"${FORGE}" fmt "${filePath}"`, { cwd: REPO_ROOT, timeout: 20_000 });
      } catch {
        /* formatting is cosmetic */
      }
      return { ok: true, errors: "", artifactPath, filePath };
    }
    return { ok: false, errors: cleanForgeOutput(raw), artifactPath: "", filePath };
  }
}

function cleanForgeOutput(out: string): string {
  // Keep solc/forge errors; drop dependency revision noise when no real failure.
  const cleaned = out
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => !/Dependency 'lib\//.test(l) || !/revision mismatch/.test(l));
  const hasSolcError = cleaned.some((l) => /\bError\b/.test(l) && !/Warning/.test(l));
  const lines = hasSolcError ? cleaned : cleaned.filter((l) => !/^Warning:/.test(l.trim()));
  return lines.slice(0, 80).join("\n");
}

export async function cleanupCodegen(): Promise<void> {
  if (existsSync(CODEGEN_DIR)) await rm(CODEGEN_DIR, { recursive: true, force: true });
}

async function readArtifact(artifactPath: string): Promise<{
  abi: unknown[] | null;
  creationBytecode: string | null;
  bytecodeSize: number | null;
  deployedBytecodeSize: number | null;
}> {
  try {
    const raw = await readFile(artifactPath, "utf8");
    const json = JSON.parse(raw);
    const bytecode: string = json?.bytecode?.object ?? "";
    const creationBytecode = bytecode.startsWith("0x") ? bytecode : null;
    const size = creationBytecode ? (creationBytecode.length - 2) / 2 : null;
    const deployedBytecode: string = json?.deployedBytecode?.object ?? "";
    const deployedSize = deployedBytecode.startsWith("0x") ? (deployedBytecode.length - 2) / 2 : null;
    return { abi: json?.abi ?? null, creationBytecode, bytecodeSize: size, deployedBytecodeSize: deployedSize };
  } catch {
    return { abi: null, creationBytecode: null, bytecodeSize: null, deployedBytecodeSize: null };
  }
}

/** EIP-170 (Spurious Dragon): a deployed contract's runtime code can never exceed 24,576 bytes
 *  on any EVM chain. This is a hard protocol limit, not a Flap/gas/network issue — a vault over
 *  this size will ALWAYS fail to deploy via CREATE2 (factory sees `vault == address(0)` and
 *  reverts DeployFailed()), no matter how many times it's registered/re-launched. Catch it at
 *  compile time so it never reaches a user as a cryptic on-chain revert. */
export const MAX_DEPLOYED_BYTECODE_SIZE = 24_576;

/**
 * One-shot rescue for a vault that compiles and passes every check EXCEPT it's over the
 * EIP-170 deployed-bytecode limit: recompile with solc's IR-based pipeline (`--via-ir`),
 * which for large, branch-heavy generated contracts routinely produces meaningfully
 * smaller runtime bytecode than the legacy codegen path (observed ~40% smaller on a real
 * oversized vault) at the cost of a much slower single compile. Only worth trying once,
 * on demand, never as the default pipeline compiler (it would make every iterative
 * compile-fix-retry cycle far too slow).
 */
async function tryViaIRRescue(
  filePath: string,
  artifactPath: string
): Promise<{
  abi: unknown[] | null;
  creationBytecode: string | null;
  bytecodeSize: number | null;
  deployedBytecodeSize: number | null;
} | null> {
  if (!filePath || !artifactPath) return null;
  try {
    await execAsync(`"${FORGE}" build "${filePath}" --via-ir --optimizer-runs 200 --force 2>&1`, {
      cwd: REPO_ROOT,
      timeout: 240_000,
      maxBuffer: 1024 * 1024 * 16,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout || "") + (e.stderr || "") || e.message || "";
    if (!isForgeCompileSuccess(raw)) return null;
  }
  const artifact = await readArtifact(artifactPath);
  if (deployedSizeFinding(artifact.deployedBytecodeSize)) return null;
  return artifact;
}

export function deployedSizeFinding(deployedBytecodeSize: number | null): SafetyFinding | null {
  if (deployedBytecodeSize === null || deployedBytecodeSize <= MAX_DEPLOYED_BYTECODE_SIZE) return null;
  const overBy = deployedBytecodeSize - MAX_DEPLOYED_BYTECODE_SIZE;
  return {
    level: "block",
    rule: "deployed-bytecode-exceeds-eip170",
    detail:
      `Deployed (runtime) bytecode is ${deployedBytecodeSize} bytes — ${overBy} bytes over the ` +
      `${MAX_DEPLOYED_BYTECODE_SIZE}-byte EIP-170 limit every EVM chain enforces. CREATE2 deployment ` +
      `will ALWAYS fail (factory sees vault == address(0) and reverts DeployFailed()) regardless of ` +
      `network or retries. Shrink the contract: split rarely-used admin/view logic into fewer, more ` +
      `generic functions, remove redundant state/events, or simplify the mechanic surface. This is a ` +
      `hard on-chain limit, not a style preference.`,
  };
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Cost control: cap what a retry resends. Keeps the seed head (system prompt +
 * initial user message [+ refine history]) and only the LATEST assistant draft
 * plus everything after it (the pending fix prompt). Older failed drafts —
 * each a full contract — are collapsed into a short failure summary, so the
 * conversation stays ~2 attempts large no matter how many retries happen.
 */
export function pruneRetryHistory(
  messages: ChatMessage[],
  headLength: number,
  fixLog: FixLogEntry[]
): ChatMessage[] {
  const head = messages.slice(0, headLength);
  const tail = messages.slice(headLength);
  let lastAssistantIdx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  // Nothing before the latest draft to drop.
  if (lastAssistantIdx <= 0) return messages;
  const droppedDrafts = tail.slice(0, lastAssistantIdx).filter((m) => m.role === "assistant").length;
  const failureLines = fixLog
    .filter((f) => ["compile_fix", "safety_fix", "test_fix", "critic_repair"].includes(f.phase))
    .slice(0, -1) // the newest failure is fully described in the pending fix prompt
    .slice(-8)
    .map((f) => `- attempt ${f.attempt} [${f.phase}${f.rule ? `: ${f.rule}` : ""}] ${f.message.slice(0, 160)}`);
  const summary: ChatMessage = {
    role: "user",
    content:
      `NOTE: ${droppedDrafts} earlier failed draft(s) were removed from this conversation to save space. ` +
      `Do NOT repeat their mistakes:\n${failureLines.join("\n") || "- (see the fix instructions below)"}`,
  };
  return [...head, summary, ...tail.slice(lastAssistantIdx)];
}

function buildRefineSeedMessages(session: RefineSession, refineMessage: string, systemPrompt: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const turn of session.chatHistory) {
    messages.push({ role: turn.role, content: turn.content.slice(0, 4000) });
  }
  const childCode = extractChildCode(session.source, session.contractName);
  messages.push({
    role: "user",
    content: `Apply this refinement to the existing vault contract.

Original mechanic idea:
${session.initialPrompt}

Current contract name: ${session.contractName}

Current Solidity (child contract only — must still inherit CodegenVaultBase):
${childCode}

Refinement requested:
${refineMessage}

Return the FULL updated contract with the refinement applied.`,
  });
  return messages;
}

export type CodegenStatusPhase =
  | "writing"
  | "classifying"
  | "fixing"
  | "fixing_spec"
  | "test_fix"
  | "compiling"
  | "compile_failed"
  | "auditing"
  | "generating_tests"
  | "ui_gen"
  | "done"
  | "error";

export type CodegenEvent =
  | { type: "status"; phase: CodegenStatusPhase; attempt: number; maxAttempts?: number; message?: string }
  | {
      type: "code_reset";
      attempt: number;
      reason: "initial" | "retry";
      retryKind?: FixLogEntry["phase"];
      message?: string;
    }
  | { type: "fix_log"; entry: FixLogEntry }
  | { type: "code_delta"; delta: string }
  | { type: "name"; contractName: string }
  | { type: "explanation"; text: string }
  | { type: "spec_audit"; audit: SpecAuditResult }
  | { type: "scope"; scope: VaultScope }
  | { type: "mechanic_spec"; spec: MechanicSpec }
  | { type: "simulation_report"; report: SimulationReport }
  | { type: "economic_critique"; report: EconomicCriticReport }
  | {
      /** Phase 6: the idea is not launch-ready as requested — generation is paused for an explicit choice. */
      type: "consent_required";
      scope: VaultScope;
      spec: MechanicSpec;
      options: { id: ApproximationConsent | "stop"; label: string }[];
    }
  | {
      /** Phase 8: safety-relevant mechanic decisions are missing — generation is paused for plain-English answers or an explicit choice. */
      type: "design_questions";
      spec: MechanicSpec;
      questions: DesignQuestion[];
      options: { id: ApproximationConsent | "stop"; label: string }[];
    }
  | { type: "result"; result: CodegenResult }
  | { type: "error"; error: string };

async function aiGenerateJson(
  client: AiChatClient,
  model: string,
  messages: ChatMessage[]
): Promise<{ raw: string; contractName: string; code: string; explanation: string }> {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    max_tokens: CODEGEN_MAX_OUTPUT_TOKENS,
    cache_conversation: true, // retry loop — the next attempt re-reads this prefix
    messages,
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty AI response");
  const obj = JSON.parse(extractJsonPayload(raw));
  return {
    raw,
    contractName: sanitizeName(String(obj.contractName ?? "GeneratedVault")),
    code: stripImports(String(obj.code ?? "")),
    explanation: String(obj.explanation ?? ""),
  };
}

function humanStatusMessage(phase: CodegenStatusPhase, attempt: number, message?: string): string | undefined {
  switch (phase) {
    case "writing":
      return attempt <= 1 ? "Drafting your vault contract from scratch…" : "AI is rewriting the contract…";
    case "compiling":
      return "Compiling with solc (Foundry)…";
    case "compile_failed":
      return message
        ? `Compile failed — will retry: ${message.slice(0, 140)}`
        : "Compile failed — sending the draft back to AI to fix…";
    case "fixing":
      return message ? `Fixing safety issues (${message})…` : "Fixing safety scanner issues…";
    case "fixing_spec":
      return message ? `Fixing Flap spec rules (${message})…` : "Fixing Flap spec compliance…";
    case "test_fix":
      return message ? `Fixing integration test failures (${message})…` : "Fixing behavioral test failures…";
    case "classifying":
      return "Planning the mechanic spec (plan-first)…";
    case "generating_tests":
      return message ?? "Generating integration test (Rule 006)…";
    case "auditing":
      return message ?? "Running Flap pre-audit (spec checker)…";
    default:
      return message;
  }
}

function describeCodeReset(lastFix: FixLogEntry | undefined, attempt: number): Pick<
  Extract<CodegenEvent, { type: "code_reset" }>,
  "reason" | "retryKind" | "message"
> {
  if (attempt <= 1 || !lastFix) {
    return { reason: "initial" };
  }
  const kind = lastFix.phase;
  if (kind === "compile_fix") {
    return {
      reason: "retry",
      retryKind: kind,
      message: `Previous draft did not compile. Starting pass ${attempt} with a fresh rewrite.`,
    };
  }
  if (kind === "safety_fix") {
    return {
      reason: "retry",
      retryKind: kind,
      message: `Safety scanner blocked the draft${lastFix.rule ? ` (${lastFix.rule})` : ""}. Starting pass ${attempt} to fix it.`,
    };
  }
  if (kind === "spec_fix") {
    return {
      reason: "retry",
      retryKind: kind,
      message: `Flap pre-audit found issues${lastFix.rule ? ` (${lastFix.rule})` : ""}. Starting pass ${attempt} to fix them.`,
    };
  }
  if (kind === "test_fix") {
    return {
      reason: "retry",
      retryKind: kind,
      message: `Integration/invariant tests failed. Starting pass ${attempt} to fix vault logic.`,
    };
  }
  if (kind === "critic_repair") {
    return {
      reason: "retry",
      retryKind: kind,
      message: `Economic critic flagged serious findings. Starting pass ${attempt} with an automatic repair.`,
    };
  }
  return {
    reason: "retry",
    retryKind: kind,
    message: `Starting pass ${attempt} — rewriting the contract.`,
  };
}

async function aiGenerateStream(
  client: AiChatClient,
  model: string,
  messages: ChatMessage[],
  emit: (ev: CodegenEvent) => void,
  attempt: number,
  lastFix?: FixLogEntry
): Promise<{ raw: string; contractName: string; code: string; explanation: string }> {
  emit({ type: "code_reset", attempt, ...describeCodeReset(lastFix, attempt) });
  const stream = await client.chat.completions.create({
    model,
    temperature: 0.2,
    stream: true,
    max_tokens: CODEGEN_MAX_OUTPUT_TOKENS,
    cache_conversation: true, // retry loop — the next attempt re-reads this prefix
    messages,
  });

  let full = "";
  let codeStarted = false;
  const MARKER = "SOLIDITY:";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (!delta) continue;
    full += delta;
    if (codeStarted) {
      emit({ type: "code_delta", delta });
    } else {
      const idx = full.indexOf(MARKER);
      if (idx >= 0) {
        codeStarted = true;
        const after = full.slice(idx + MARKER.length).replace(/^\s*\n/, "");
        if (after) emit({ type: "code_delta", delta: after });
      }
    }
  }

  const parsed = parseStreamOutput(full);
  return {
    raw: full,
    contractName: sanitizeName(parsed.name),
    code: stripImports(parsed.code),
    explanation: parsed.explanation,
  };
}

/**
 * Phase 6: a pipeline stop BEFORE Solidity generation — either awaiting the
 * user's explicit approximation choice, delivering a spec-only draft, or
 * refusing an unsafe mechanic. Never a silent approximation.
 */
function earlyStopResult(
  mechanicSpec: MechanicSpec,
  scope: VaultScope,
  deliverable: "spec_only" | "consent_required" | "refused_unsafe" | "design_questions",
  approximation: ApproximationReport | null,
  designQuestions: DesignQuestion[] = []
): Omit<CodegenResult, "mode" | "tokenUsage"> {
  const explanation =
    deliverable === "refused_unsafe"
      ? `Not generated: ${scope.summary} Required to proceed: ${scope.requiredForLaunch.join("; ") || "a redesigned, honest mechanic"}.`
      : deliverable === "spec_only"
        ? `Draft spec only (your choice): ${scope.summary}`
        : deliverable === "design_questions"
          ? `Your idea needs ${designQuestions.length} design decision(s) before safe code can be generated. Answer the questions (refine your prompt), or choose a conservative safe draft with the defaults explained.`
          : `Awaiting your choice: ${scope.summary} Pick how to proceed — closest Flap-compatible draft, spec-only draft, or stop.`;
  return {
    contractName: mechanicSpec.contractName || "GeneratedVault",
    explanation,
    source: "",
    compiled: false,
    compileErrors: "",
    safety: { level: "pass", findings: [] },
    specAudit: { level: "skipped", summary: "No contract generated.", items: [], mode: "skipped" },
    mechanicSpec,
    scope,
    deliverable,
    approximation,
    designQuestions,
    designDecisions: [],
    abi: null,
    creationBytecode: null,
    bytecodeSize: null,
    deployedBytecodeSize: null,
    attempts: 0,
    integrationTestPath: null,
    integrationTestsPassed: false,
    simulationReport: null,
    economicCritique: null,
    repairAttempts: [],
    fixLog: [],
    autoFixExhausted: false,
    uiArtifact: null,
  };
}

/** Unified pipeline: plan spec → scope verdict → consent gate → compile → dual safety → tests → advisory audit → fix until pass or budget exhausted. */
async function runCodegenPipeline(opts: {
  client: AiChatClient;
  model: string;
  apiKey: string;
  userPrompt: string;
  systemPrompt: string;
  stream: boolean;
  emit?: (ev: CodegenEvent) => void;
  seedMessages?: ChatMessage[];
  scanPrompt?: string;
  mechanicSpec?: MechanicSpec;
  /** Phase 6: the user's explicit choice when the idea is not launch-ready as requested. */
  approximationConsent?: ApproximationConsent;
}): Promise<Omit<CodegenResult, "mode" | "tokenUsage">> {
  const {
    client,
    model,
    apiKey,
    userPrompt,
    systemPrompt,
    stream,
    emit,
    seedMessages,
    scanPrompt,
    mechanicSpec: seedSpec,
    approximationConsent,
  } = opts;
  const safetyPrompt = scanPrompt ?? userPrompt;
  // Advisory-only calls (scope verdict, spec pre-audit, economic critic) run on
  // the cheap model when configured — they never gate the pipeline, so a
  // smaller model there cuts cost without touching codegen quality.
  const advisoryModel = resolveCheapModel();

  let mechanicSpec = seedSpec;
  let scope: VaultScope | undefined;
  let approximation: ApproximationReport | null = null;
  let designQuestions: DesignQuestion[] = [];
  let designDecisions: string[] = [];
  if (!mechanicSpec) {
    emit?.({ type: "status", phase: "classifying", attempt: 0, message: "Planning the mechanic spec (plan-first)…" });
    // Phase 6 main path: MechanicSpec plan + scope verdict, in parallel.
    // No VaultPlan/VaultKind classification anymore.
    const [plannedSpec, scopeResult] = await Promise.all([
      planMechanicSpec(userPrompt, apiKey, model),
      classifyVaultScope(userPrompt, apiKey, advisoryModel),
    ]);
    mechanicSpec = plannedSpec;
    scope = scopeResult;
    emit?.({ type: "scope", scope });
    emit?.({ type: "mechanic_spec", spec: mechanicSpec });
    emit?.({ type: "status", phase: "classifying", attempt: 0, message: "Mechanic plan ready…" });

    // ── Phase 6 consent gate: no silent approximation. Refinements of an
    //    already-generated vault (seedMessages) skip the gate — consent was
    //    given when the vault was first generated.
    if (!seedMessages) {
      const decision = consentGate(scope, approximationConsent);
      if (decision.action === "refuse_unsafe") {
        return earlyStopResult(mechanicSpec, scope, "refused_unsafe", null);
      }
      if (decision.action === "await_consent") {
        emit?.({
          type: "consent_required",
          scope,
          spec: mechanicSpec,
          options: [
            { id: "closest_draft", label: "Build the closest Flap-compatible draft (differences listed honestly)" },
            { id: "spec_only", label: "Keep this as a draft spec only — no contract yet" },
            { id: "stop", label: "Stop — explain what would be required to build it as requested" },
          ],
        });
        return earlyStopResult(mechanicSpec, scope, "consent_required", null);
      }
      if (decision.action === "spec_only") {
        return earlyStopResult(mechanicSpec, scope, "spec_only", buildApproximationReport(userPrompt, scope));
      }
      if (decision.asDraft) {
        approximation = buildApproximationReport(userPrompt, scope);
      }

      // ── Phase 8 design-question gate: unresolved SAFETY-relevant mechanic
      //    decisions (assignment model, reward amount, exits, proof, eligibility)
      //    pause generation for plain-English answers. The same explicit consent
      //    value unlocks a CONSERVATIVE draft with every default explained —
      //    silent risky defaults are impossible.
      const designDecision = designQuestionGate(userPrompt, mechanicSpec, approximationConsent);
      if (designDecision.action === "ask") {
        emit?.({
          type: "design_questions",
          spec: mechanicSpec,
          questions: designDecision.questions,
          options: [
            { id: "closest_draft", label: "Use safe conservative choices for me (each choice will be explained)" },
            { id: "spec_only", label: "Keep this as a draft spec only — no contract yet" },
            { id: "stop", label: "Stop — I will answer the questions in a new prompt" },
          ],
        });
        return earlyStopResult(mechanicSpec, scope, "design_questions", null, designDecision.questions);
      }
      if (designDecision.action === "spec_only") {
        return earlyStopResult(mechanicSpec, scope, "spec_only", buildApproximationReport(userPrompt, scope), designDecision.questions);
      }
      if (designDecision.action === "proceed_conservative") {
        const applied = applyConservativeLifecycleDefaults(userPrompt, mechanicSpec);
        mechanicSpec = applied.spec;
        designDecisions = applied.decisions;
        designQuestions = designDecision.questions;
        emit?.({ type: "mechanic_spec", spec: mechanicSpec });
        emit?.({
          type: "status",
          phase: "classifying",
          attempt: 0,
          message: `Proceeding with ${applied.decisions.length} safe conservative design choice(s) — each is recorded in the result.`,
        });
      }
    }
  }
  if (!mechanicSpec) mechanicSpec = inferMechanicSpecFromPrompt(userPrompt);

  const resolvedSystemPrompt = resolveSystemPrompt(systemPrompt, userPrompt);

  let messages: ChatMessage[] =
    seedMessages ??
    [
      { role: "system", content: resolvedSystemPrompt },
      { role: "user", content: buildGenerationUserMessage(userPrompt, mechanicSpec) },
    ];
  // Everything up to here is the stable head that pruning must never touch
  // (it is also the prompt-cache-friendly prefix).
  const messagesHeadLength = messages.length;

  const fixLog: FixLogEntry[] = [];
  const previousFailures = new Set<string>();
  let contractName = "GeneratedVault";
  let code = "";
  let explanation = "";
  let compileErrors = "";
  let ok = false;
  let artifactPath = "";
  let filePath = "";
  let attempts = 0;
  let integrationTestPath: string | null = null;
  let integrationTestsPassed = false;
  let simulationReport: SimulationReport | null = null;
  let testJourneys: TestJourney[] = [];
  const failingScenarios = (): SimulationScenarioResult[] =>
    simulationReport?.scenarios.filter((s) => s.status === "fail") ?? [];
  let specAudit: SpecAuditResult = {
    level: "skipped",
    summary: "Not audited yet.",
    items: [],
    mode: "openai",
  };
  let safety = scanSafety("", "GeneratedVault", safetyPrompt);
  let abi: unknown[] | null = null;
  let creationBytecode: string | null = null;
  let bytecodeSize: number | null = null;
  let deployedBytecodeSize: number | null = null;
  let fullSource = "";
  let pendingFix: string | null = null;
  let testFixAttempts = 0;
  let lastAssistantOut = "";
  const repairAttempts: RepairAttempt[] = [];

  const status = (phase: CodegenStatusPhase, message?: string) => {
    emit?.({
      type: "status",
      phase,
      attempt: attempts,
      maxAttempts: MAX_TOTAL_ATTEMPTS,
      message: humanStatusMessage(phase, attempts, message),
    });
  };

  const pushFix = (entry: FixLogEntry) => {
    fixLog.push(entry);
    emit?.({ type: "fix_log", entry });
  };

  // Cost control: regenerating the integration test is an expensive LLM call.
  // When a fix pass changed only the vault's internals (same contract name and
  // public ABI), the previously generated suite still describes the same
  // surface — reuse it and only refresh the deploy bytecode it forks with.
  let reusableTest: { interfaceHash: string; path: string; journeys: TestJourney[] } | null = null;
  const currentInterfaceHash = (): string => {
    const signatures = Array.isArray(abi)
      ? (abi as { type?: string; name?: string; inputs?: { type?: string }[] }[])
          .filter((entry) => entry?.type === "function")
          .map((entry) => `${entry.name}(${(entry.inputs ?? []).map((i) => i?.type ?? "").join(",")})`)
          .sort()
      : [];
    return createHash("sha256").update(`${contractName}|${signatures.join(";")}`).digest("hex");
  };

  const runIntegrationGate = async (): Promise<{ passed: boolean; errors: string }> => {
    const interfaceHash = currentInterfaceHash();
    if (reusableTest && reusableTest.interfaceHash === interfaceHash && creationBytecode) {
      status("generating_tests", "Interface unchanged — reusing the existing journey tests…");
      try {
        await writeFile(
          path.join(REPO_ROOT, "test", "_codegen", `${contractName}.bin`),
          Buffer.from(creationBytecode.slice(2), "hex")
        );
        integrationTestPath = reusableTest.path;
        testJourneys = reusableTest.journeys;
        pushFix({
          phase: "generating_tests",
          attempt: attempts,
          message: `${reusableTest.path} (reused — interface unchanged)`,
        });
      } catch {
        reusableTest = null; // bin refresh failed — fall through to full regeneration
      }
    }
    if (!reusableTest || reusableTest.interfaceHash !== interfaceHash || integrationTestPath === null) {
      status("generating_tests", "Writing MechanicSpec journey tests (Rule 006)…");
      const tr = await generateIntegrationTest(contractName, artifactPath, fullSource, apiKey, model, mechanicSpec);
      testJourneys = tr.journeys;
      if (!tr.ok) {
        reusableTest = null;
        pushFix({ phase: "generating_tests", attempt: attempts, message: tr.errors.slice(0, 200) });
        return { passed: false, errors: `Integration test generation failed:\n${tr.errors}` };
      }
      integrationTestPath = tr.path;
      reusableTest = { interfaceHash, path: tr.path, journeys: tr.journeys };
      pushFix({ phase: "generating_tests", attempt: attempts, message: tr.path });
    }

    const suitePath = integrationTestPath ?? "";
    status("generating_tests", "Running Foundry fork simulation…");
    const testRun = await runIntegrationTests(contractName, suitePath);
    integrationTestsPassed = testRun.ok || testRun.skipped === true;
    simulationReport = buildSimulationReport(contractName, suitePath, testRun.output, testJourneys, testRun);
    emit?.({ type: "simulation_report", report: simulationReport });
    if (!integrationTestsPassed) {
      previousFailures.add("integration-test-failure");
      pushFix({
        phase: "test_fix",
        attempt: attempts,
        rule: "integration-test-failure",
        message: testRun.errors.slice(0, 200),
      });
      return { passed: false, errors: testRun.errors };
    }
    return { passed: true, errors: "" };
  };

  const runAuditIfReady = async () => {
    if (!ok || !integrationTestsPassed || specAudit.level !== "skipped") return;
    status("auditing", "Flap pre-audit (advisory)…");
    try {
      specAudit = await runSpecAudit(fullSource, contractName, apiKey, advisoryModel, {
        compiled: true,
        safetyFindings: safety.findings,
        advisory: true,
      });
    } catch (err) {
      // Advisory-only: an audit-call failure (bad cheap-model id, provider
      // hiccup) must never sink a pipeline whose hard gates already passed.
      specAudit = {
        level: "warn",
        summary: `Pre-audit call failed (${err instanceof Error ? err.message : String(err)}) — review manually.`,
        items: [],
        mode: "openai",
      };
    }
    emit?.({ type: "spec_audit", audit: specAudit });
    pushFix({ phase: "auditing", attempt: attempts, message: `spec: ${specAudit.level} (advisory)` });
  };

  while (attempts < MAX_PIPELINE_ATTEMPTS) {
    if (pendingFix) {
      messages.push({ role: "user", content: pendingFix });
      pendingFix = null;
    }
    messages = pruneRetryHistory(messages, messagesHeadLength, fixLog);

    attempts++;
    const lastFix = attempts > 1 ? fixLog[fixLog.length - 1] : undefined;
    status(attempts === 1 ? "writing" : lastFix?.phase === "test_fix" ? "test_fix" : lastFix?.phase === "spec_fix" ? "fixing_spec" : "fixing");

    let lastAssistant: string;
    if (stream && emit) {
      const gen = await aiGenerateStream(client, model, messages, emit, attempts, lastFix);
      lastAssistant = gen.raw;
      contractName = gen.contractName;
      code = gen.code;
      explanation = gen.explanation || explanation;
    } else {
      const gen = await aiGenerateJson(client, model, messages);
      lastAssistant = gen.raw;
      contractName = gen.contractName;
      code = gen.code;
      explanation = gen.explanation;
    }
    lastAssistantOut = lastAssistant;

    emit?.({ type: "name", contractName });
    emit?.({ type: "explanation", text: explanation });

    code = applyCommonCodegenPatches(code);

    status("compiling");
    const res = await compile(contractName, code);
    ok = res.ok;
    compileErrors = res.errors;
    artifactPath = res.artifactPath;
    filePath = res.filePath;

    if (!ok) {
      pushFix({ phase: "compile_fix", attempt: attempts, message: firstErrors(compileErrors) });
      status("compile_failed", firstErrors(compileErrors));
      messages.push({ role: "assistant", content: lastAssistant });
      pendingFix = stream ? compileFixPromptStream(compileErrors) : compileFixPrompt(compileErrors);
      continue;
    }

    fullSource = `${PREAMBLE}\n${code.trim()}\n`;
    if (filePath) {
      try {
        fullSource = await readFile(filePath, "utf8");
      } catch {
        /* use in-memory */
      }
    }

    safety = scanSafetyCombined(code, fullSource, contractName, safetyPrompt, undefined, mechanicSpec);
    const blocking = safety.findings.filter((f) => f.level === "block");
    if (blocking.length > 0) {
      for (const b of blocking) previousFailures.add(b.rule);
      pushFix({
        phase: "safety_fix",
        attempt: attempts,
        rule: blocking.map((b) => b.rule).join(","),
        message: blocking[0]!.detail,
      });
      status("fixing", blocking.map((b) => b.rule).join(", "));
      messages.push({ role: "assistant", content: lastAssistant });
      const recentSafety = fixLog.filter((f) => f.phase === "safety_fix").slice(-3);
      const stuck =
        recentSafety.length >= 3 &&
        recentSafety.every((f) => f.rule === recentSafety[0]!.rule);
      const sameRuleCount = blocking.filter((b) => previousFailures.has(b.rule)).length;
      pendingFix = stuck || sameRuleCount >= 3
        ? surgicalSafetyFixPrompt(blocking, recentSafety[0]?.message ?? blocking[0]!.detail)
        : stream
          ? safetyFixPromptStream(blocking, attempts, [...previousFailures], mechanicSpec)
          : safetyFixPrompt(blocking, attempts, [...previousFailures], mechanicSpec);
      continue;
    }

    ({ abi, creationBytecode, bytecodeSize, deployedBytecodeSize } = await readArtifact(artifactPath));

    let sizeFinding = deployedSizeFinding(deployedBytecodeSize);
    if (sizeFinding) {
      status("compiling", "Deployed bytecode over EIP-170 limit — retrying with --via-ir…");
      const rescued = await tryViaIRRescue(filePath, artifactPath);
      if (rescued) {
        ({ abi, creationBytecode, bytecodeSize, deployedBytecodeSize } = rescued);
        pushFix({
          phase: "safety_fix",
          attempt: attempts,
          rule: "deployed-bytecode-exceeds-eip170",
          message: `Recompiled with --via-ir — deployed bytecode now ${deployedBytecodeSize} bytes (under the 24,576-byte limit).`,
        });
        sizeFinding = null;
      }
    }
    if (sizeFinding) {
      previousFailures.add(sizeFinding.rule);
      pushFix({ phase: "safety_fix", attempt: attempts, rule: sizeFinding.rule, message: sizeFinding.detail });
      status("fixing", sizeFinding.rule);
      messages.push({ role: "assistant", content: lastAssistant });
      pendingFix = stream
        ? safetyFixPromptStream([sizeFinding], attempts, [...previousFailures], mechanicSpec)
        : safetyFixPrompt([sizeFinding], attempts, [...previousFailures], mechanicSpec);
      continue;
    }

    const gate = await runIntegrationGate();
    if (!gate.passed) {
      status("test_fix", "integration-test-failure");
      if (/fs_permissions|not allowed to be accessed for read operations/i.test(gate.errors)) {
        pushFix({
          phase: "test_fix",
          attempt: attempts,
          rule: "integration-test-infra",
          message: gate.errors.slice(0, 300),
        });
        break;
      }
      messages.push({ role: "assistant", content: lastAssistant });
      pendingFix = stream
        ? testFixPromptStream(gate.errors, attempts, [...previousFailures], mechanicSpec, failingScenarios())
        : testFixPrompt(gate.errors, attempts, [...previousFailures], mechanicSpec, failingScenarios());
      continue;
    }

    break;
  }

  let lastTestErrors =
    fixLog.filter((f) => f.phase === "test_fix").at(-1)?.message ??
    fixLog.filter((f) => f.phase === "generating_tests").at(-1)?.message ??
    "";

  while (
    ok &&
    safety.level !== "fail" &&
    !integrationTestsPassed &&
    testFixAttempts < MAX_TEST_FIX_ATTEMPTS
  ) {
    testFixAttempts++;
    attempts++;
    status("test_fix", lastTestErrors.slice(0, 120) || "Fixing integration test failures…");

    if (pendingFix) {
      messages.push({ role: "user", content: pendingFix });
      pendingFix = null;
    } else {
      messages.push({
        role: "user",
        content: stream
          ? testFixPromptStream(lastTestErrors, attempts, [...previousFailures], mechanicSpec, failingScenarios())
          : testFixPrompt(lastTestErrors, attempts, [...previousFailures], mechanicSpec, failingScenarios()),
      });
    }
    messages = pruneRetryHistory(messages, messagesHeadLength, fixLog);

    let lastAssistant: string;
    if (stream && emit) {
      const gen = await aiGenerateStream(client, model, messages, emit, attempts, {
        phase: "test_fix",
        attempt: attempts,
        rule: "integration-test-failure",
        message: lastTestErrors.slice(0, 120),
      });
      lastAssistant = gen.raw;
      contractName = gen.contractName;
      code = gen.code;
      explanation = gen.explanation || explanation;
    } else {
      const gen = await aiGenerateJson(client, model, messages);
      lastAssistant = gen.raw;
      contractName = gen.contractName;
      code = gen.code;
      explanation = gen.explanation;
    }
    lastAssistantOut = lastAssistant;

    emit?.({ type: "name", contractName });
    emit?.({ type: "explanation", text: explanation });
    code = applyCommonCodegenPatches(code);

    status("compiling");
    const res = await compile(contractName, code);
    ok = res.ok;
    compileErrors = res.errors;
    artifactPath = res.artifactPath;
    filePath = res.filePath;

    if (!ok) {
      pushFix({ phase: "compile_fix", attempt: attempts, message: firstErrors(compileErrors) });
      pendingFix = stream ? compileFixPromptStream(compileErrors) : compileFixPrompt(compileErrors);
      messages.push({ role: "assistant", content: lastAssistant });
      continue;
    }

    fullSource = `${PREAMBLE}\n${code.trim()}\n`;
    if (filePath) {
      try {
        fullSource = await readFile(filePath, "utf8");
      } catch {
        /* use in-memory */
      }
    }

    safety = scanSafetyCombined(code, fullSource, contractName, safetyPrompt, undefined, mechanicSpec);
    const blocking = safety.findings.filter((f) => f.level === "block");
    if (blocking.length > 0) {
      for (const b of blocking) previousFailures.add(b.rule);
      pushFix({
        phase: "safety_fix",
        attempt: attempts,
        rule: blocking.map((b) => b.rule).join(","),
        message: blocking[0]!.detail,
      });
      messages.push({ role: "assistant", content: lastAssistant });
      pendingFix = stream
        ? safetyFixPromptStream(blocking, attempts, [...previousFailures], mechanicSpec)
        : safetyFixPrompt(blocking, attempts, [...previousFailures], mechanicSpec);
      continue;
    }

    ({ abi, creationBytecode, bytecodeSize, deployedBytecodeSize } = await readArtifact(artifactPath));

    let sizeFinding2 = deployedSizeFinding(deployedBytecodeSize);
    if (sizeFinding2) {
      status("compiling", "Deployed bytecode over EIP-170 limit — retrying with --via-ir…");
      const rescued2 = await tryViaIRRescue(filePath, artifactPath);
      if (rescued2) {
        ({ abi, creationBytecode, bytecodeSize, deployedBytecodeSize } = rescued2);
        pushFix({
          phase: "safety_fix",
          attempt: attempts,
          rule: "deployed-bytecode-exceeds-eip170",
          message: `Recompiled with --via-ir — deployed bytecode now ${deployedBytecodeSize} bytes (under the 24,576-byte limit).`,
        });
        sizeFinding2 = null;
      }
    }
    if (sizeFinding2) {
      previousFailures.add(sizeFinding2.rule);
      pushFix({ phase: "safety_fix", attempt: attempts, rule: sizeFinding2.rule, message: sizeFinding2.detail });
      status("fixing", sizeFinding2.rule);
      messages.push({ role: "assistant", content: lastAssistant });
      pendingFix = stream
        ? safetyFixPromptStream([sizeFinding2], attempts, [...previousFailures], mechanicSpec)
        : safetyFixPrompt([sizeFinding2], attempts, [...previousFailures], mechanicSpec);
      continue;
    }

    const gate = await runIntegrationGate();
    if (!gate.passed) {
      lastTestErrors = gate.errors;
      messages.push({ role: "assistant", content: lastAssistant });
      pendingFix = stream
        ? testFixPromptStream(gate.errors, attempts, [...previousFailures], mechanicSpec, failingScenarios())
        : testFixPrompt(gate.errors, attempts, [...previousFailures], mechanicSpec, failingScenarios());
      continue;
    }
    break;
  }

  await runAuditIfReady();

  if (!fullSource && code) fullSource = `${PREAMBLE}\n${code.trim()}\n`;

  // Phase 7: advisory economic critic — only worth running on a vault that
  // actually compiled and passed the deterministic safety scanners; never
  // blocks the pipeline and never overrides scanSafety/integration results.
  let economicCritique: EconomicCriticReport | null = null;
  if (ok && safety.level !== "fail" && fullSource) {
    economicCritique = await runEconomicCriticPass(contractName, fullSource, mechanicSpec, apiKey, advisoryModel);
    emit?.({ type: "economic_critique", report: economicCritique });
  }

  // Cleanup pass: bounded critic-driven auto-repair. High/blocking critic
  // findings (with any remaining test failures folded into the same context)
  // trigger repair attempts BEFORE the final result. The critic stays advisory
  // for launch gating — a repair that regresses any hard gate (compile /
  // scanners / tests) is rolled back to the last good state.
  if (ok && safety.level !== "fail" && shouldTriggerCriticRepair(economicCritique)) {
    const escalationModel = resolveEscalationModel();
    const maxRepairs = MAX_CRITIC_REPAIR_ATTEMPTS + (escalationModel ? 1 : 0);

    while (repairAttempts.length < maxRepairs && shouldTriggerCriticRepair(economicCritique)) {
      const repairNum = repairAttempts.length + 1;
      const escalated = repairNum > MAX_CRITIC_REPAIR_ATTEMPTS && escalationModel !== null;
      const repairModel = escalated ? escalationModel! : model;
      const findings = selectRepairFindings(economicCritique);
      const testErrors = integrationTestsPassed ? "" : lastTestErrors;
      const reason = repairReason(findings.length > 0, !integrationTestsPassed);

      attempts++;
      status(
        "fixing",
        `Economic repair attempt ${repairNum}/${maxRepairs}${escalated ? " (escalation model)" : ""}: ${findings
          .map((f) => f.finding)
          .slice(0, 3)
          .join(", ")}`
      );
      pushFix({
        phase: "critic_repair",
        attempt: attempts,
        rule: findings.map((f) => f.finding).join(","),
        message: `Repair ${repairNum}/${maxRepairs}${escalated ? " [escalated]" : ""}: ${findings[0]?.explanation.slice(0, 160) ?? "critic findings"}`,
      });

      // Snapshot the current hard-gate-passing state so a bad repair can be rolled back.
      const snapshot = {
        code,
        fullSource,
        contractName,
        explanation,
        abi,
        creationBytecode,
        bytecodeSize,
        deployedBytecodeSize,
        safety,
        compileErrors,
        integrationTestsPassed,
        simulationReport,
        integrationTestPath,
      };

      const basePrompt = buildCriticRepairPrompt({
        contractName,
        findings,
        mechanicSpec,
        attempt: repairNum,
        escalated,
        testErrors,
        failingScenarioSummary: formatFailingScenarios(failingScenarios()),
        compiled: ok,
        scannersPassed: safety.level !== "fail",
        testsPassed: integrationTestsPassed,
      });
      messages.push({ role: "assistant", content: lastAssistantOut });
      messages.push({
        role: "user",
        content: stream
          ? `${basePrompt}\n\nRe-output in the SAME plain-text format (CONTRACT_NAME / EXPLANATION / SOLIDITY).`
          : `${basePrompt}\n\nReturn the corrected JSON (same shape, no imports/pragma).`,
      });
      messages = pruneRetryHistory(messages, messagesHeadLength, fixLog);

      if (stream && emit) {
        const gen = await aiGenerateStream(client, repairModel, messages, emit, attempts, {
          phase: "critic_repair",
          attempt: attempts,
          message: `Economic repair attempt ${repairNum}`,
        });
        lastAssistantOut = gen.raw;
        contractName = gen.contractName;
        code = gen.code;
        explanation = gen.explanation || explanation;
      } else {
        const gen = await aiGenerateJson(client, repairModel, messages);
        lastAssistantOut = gen.raw;
        contractName = gen.contractName;
        code = gen.code;
        explanation = gen.explanation;
      }
      emit?.({ type: "name", contractName });
      code = applyCommonCodegenPatches(code);

      const attemptRecord: RepairAttempt = {
        attempt: repairNum,
        reason,
        model: repairModel,
        escalated,
        findingsAddressed: findings.map((f) => f.finding),
        compileResult: "fail",
        scannerResult: "skip",
        testResult: "skip",
        criticResult: "not_rerun",
        remainingIssues: [],
      };

      const rollback = () => {
        ({
          code,
          fullSource,
          contractName,
          explanation,
          abi,
          creationBytecode,
          bytecodeSize,
          deployedBytecodeSize,
          safety,
          compileErrors,
          integrationTestsPassed,
          simulationReport,
          integrationTestPath,
        } = snapshot);
        ok = true;
      };

      status("compiling");
      const res = await compile(contractName, code);
      if (!res.ok) {
        attemptRecord.remainingIssues = ["repair attempt did not compile — rolled back to previous good code"];
        repairAttempts.push(attemptRecord);
        pushFix({ phase: "critic_repair", attempt: attempts, message: `Repair ${repairNum} failed to compile — rolled back.` });
        rollback();
        continue;
      }
      attemptRecord.compileResult = "pass";
      artifactPath = res.artifactPath;
      filePath = res.filePath;
      compileErrors = "";

      let repairedFullSource = `${PREAMBLE}\n${code.trim()}\n`;
      if (filePath) {
        try {
          repairedFullSource = await readFile(filePath, "utf8");
        } catch {
          /* use in-memory */
        }
      }

      const repairedSafety = scanSafetyCombined(code, repairedFullSource, contractName, safetyPrompt, undefined, mechanicSpec);
      if (repairedSafety.level === "fail") {
        attemptRecord.scannerResult = "fail";
        attemptRecord.remainingIssues = ["repair attempt tripped deterministic scanners — rolled back to previous good code"];
        repairAttempts.push(attemptRecord);
        pushFix({ phase: "critic_repair", attempt: attempts, message: `Repair ${repairNum} tripped scanners — rolled back.` });
        rollback();
        continue;
      }
      attemptRecord.scannerResult = "pass";
      safety = repairedSafety;
      fullSource = repairedFullSource;
      ({ abi, creationBytecode, bytecodeSize, deployedBytecodeSize } = await readArtifact(artifactPath));

      let repairSizeFinding = deployedSizeFinding(deployedBytecodeSize);
      if (repairSizeFinding) {
        const rescued3 = await tryViaIRRescue(filePath, artifactPath);
        if (rescued3) {
          ({ abi, creationBytecode, bytecodeSize, deployedBytecodeSize } = rescued3);
          pushFix({
            phase: "critic_repair",
            attempt: attempts,
            message: `Repair ${repairNum}: recompiled with --via-ir — deployed bytecode now ${deployedBytecodeSize} bytes.`,
          });
          repairSizeFinding = null;
        }
      }
      if (repairSizeFinding) {
        attemptRecord.scannerResult = "fail";
        attemptRecord.remainingIssues = [
          "repair attempt grew deployed bytecode past the EIP-170 limit — rolled back to previous good code",
        ];
        repairAttempts.push(attemptRecord);
        pushFix({
          phase: "critic_repair",
          attempt: attempts,
          message: `Repair ${repairNum} exceeded EIP-170 deployed size — rolled back.`,
        });
        rollback();
        continue;
      }

      const gate = await runIntegrationGate();
      if (!gate.passed) {
        // Tests regressed (or stayed failing): only roll back when the snapshot had passing tests.
        attemptRecord.testResult = "fail";
        if (snapshot.integrationTestsPassed) {
          attemptRecord.remainingIssues = ["repair attempt broke integration tests — rolled back to previous good code"];
          repairAttempts.push(attemptRecord);
          pushFix({ phase: "critic_repair", attempt: attempts, message: `Repair ${repairNum} broke tests — rolled back.` });
          rollback();
          continue;
        }
        lastTestErrors = gate.errors;
      } else {
        attemptRecord.testResult = "pass";
      }

      // Rerun the critic on the accepted repaired code so the loop (and the
      // final report) reflect the new state.
      economicCritique = await runEconomicCriticPass(contractName, fullSource, mechanicSpec, apiKey, advisoryModel);
      emit?.({ type: "economic_critique", report: economicCritique });
      attemptRecord.criticResult = shouldTriggerCriticRepair(economicCritique) ? "findings_remain" : "clean";
      attemptRecord.remainingIssues = summarizeRemainingIssues(
        economicCritique,
        true,
        safety.level !== "fail",
        integrationTestsPassed
      );
      repairAttempts.push(attemptRecord);
      pushFix({
        phase: "critic_repair",
        attempt: attempts,
        message:
          attemptRecord.criticResult === "clean"
            ? `Repair ${repairNum} accepted — critic clean.`
            : `Repair ${repairNum} accepted — ${attemptRecord.remainingIssues.length} issue(s) remain.`,
      });
    }
  }

  // Final, sticky safeguard: if the retry budget was exhausted while the vault was
  // still over the EIP-170 deployed-code limit, the result must never report
  // safety as passing — regardless of which loop/attempt last touched `safety`.
  const finalSizeFinding = deployedSizeFinding(deployedBytecodeSize);
  if (finalSizeFinding && !safety.findings.some((f) => f.rule === finalSizeFinding.rule)) {
    safety = { level: "fail", findings: [...safety.findings, finalSizeFinding] };
  }

  // ── Custom vault UI pass (advisory) — only for fully-passing vaults. The
  //    artifact renders sandboxed on our site immediately and is the same file
  //    a user submits to Flap's Artifact Workbench for flap.sh binding.
  let uiArtifact: VaultUiArtifact | null = null;
  if (ok && safety.level !== "fail" && integrationTestsPassed) {
    emit?.({ type: "status", phase: "ui_gen", attempt: attempts, message: "Designing the custom vault UI…" });
    uiArtifact = await generateVaultUi({ client, model, contractName, source: fullSource, spec: mechanicSpec });
    emit?.({
      type: "status",
      phase: "ui_gen",
      attempt: attempts,
      message: uiArtifact
        ? `Custom UI ready (${Math.round(uiArtifact.bytes / 1024)} KB).`
        : "Custom UI pass skipped (generation failed) — the standard schema panel will be used.",
    });
  }

  return {
    contractName,
    explanation,
    source: fullSource,
    compiled: ok,
    compileErrors,
    safety,
    specAudit,
    mechanicSpec,
    scope,
    deliverable: "contract",
    approximation,
    designQuestions,
    designDecisions,
    abi,
    creationBytecode,
    bytecodeSize,
    deployedBytecodeSize,
    attempts,
    integrationTestPath,
    integrationTestsPassed,
    simulationReport,
    economicCritique,
    repairAttempts,
    fixLog,
    uiArtifact,
    autoFixExhausted:
      (attempts >= MAX_PIPELINE_ATTEMPTS && safety.level === "fail") ||
      (ok &&
        safety.level !== "fail" &&
        !integrationTestsPassed &&
        testFixAttempts >= MAX_TEST_FIX_ATTEMPTS &&
        attempts >= MAX_PIPELINE_ATTEMPTS),
  };
}

function pipelineSuccess(result: CodegenResult): boolean {
  // Phase 6: consent stops and spec-only drafts are deliberate, successful outcomes.
  if (result.deliverable !== "contract") return result.deliverable !== "refused_unsafe";
  return result.compiled && result.safety.level !== "fail" && result.integrationTestsPassed;
}

function pipelineFinishMessage(result: CodegenResult): string | undefined {
  if (result.deliverable === "consent_required") {
    return "This idea is not launch-ready as requested — choose how to proceed before generation.";
  }
  if (result.deliverable === "design_questions") {
    return "A few design decisions are missing — answer the plain-English questions (or pick safe defaults) before code is generated.";
  }
  if (result.deliverable === "spec_only") {
    return "Draft spec delivered (no contract generated, per your choice).";
  }
  if (result.deliverable === "refused_unsafe") {
    return "Not generated: the mechanic is unsafe or cannot be honestly disclosed.";
  }
  if (result.autoFixExhausted && result.safety.level === "fail") {
    return "Auto-fix exhausted — safety scanner still blocking.";
  }
  if (result.compiled && result.safety.level !== "fail" && !result.integrationTestsPassed) {
    return "Auto-fix exhausted — integration tests still failing. Try refining the vault or check server logs.";
  }
  if (!result.compiled) return "Generation finished without a successful compile.";
  return undefined;
}

// ── Public: generate a vault with compile-and-fix loop ──────────────────────
export async function generateVaultCode(
  prompt: string,
  apiKey: string | undefined,
  model: string,
  approximationConsent?: ApproximationConsent
): Promise<CodegenResult> {
  if (!apiKey) {
    return stubResult(prompt);
  }

  const { createAiClient } = await import("./ai-client.js");
  const client = createAiClient(apiKey);

  const tokenUsage = createAiUsageTotals();
  const result = await runWithAiUsage(tokenUsage, () =>
    runCodegenPipeline({
      client,
      model,
      apiKey,
      userPrompt: prompt,
      systemPrompt: CODEGEN_SYSTEM_PROMPT,
      stream: false,
      approximationConsent,
    })
  );

  await cleanupCodegen();
  logAiUsage(tokenUsage);

  return { ...result, mode: "openai", tokenUsage };
}

function logAiUsage(usage: AiUsageTotals): void {
  const cost = usage.estCostUsd !== null ? ` ~$${usage.estCostUsd.toFixed(4)}` : "";
  console.log(
    `[ai-usage] calls=${usage.calls} in=${usage.inputTokens} out=${usage.outputTokens} ` +
      `cacheRead=${usage.cacheReadInputTokens} cacheWrite=${usage.cacheWriteInputTokens}${cost}`
  );
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, "");
  const finalName = /^[A-Za-z]/.test(cleaned) ? cleaned : `Vault${cleaned}`;
  return finalName.slice(0, 48) || "GeneratedVault";
}

// Strip any SPDX/pragma/import lines the model added despite instructions.
function stripImports(code: string): string {
  return code
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith("// SPDX-License-Identifier")) return false;
      if (t.startsWith("pragma ")) return false;
      if (t.startsWith("import ")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

// ── Streaming codegen (Server-Sent Events) ─────────────────────────────────

function parseStreamOutput(full: string): { name: string; explanation: string; code: string } {
  const nameMatch = full.match(/CONTRACT_NAME:\s*(.+)/);
  const explMatch = full.match(/EXPLANATION:\s*([\s\S]*?)\n\s*SOLIDITY:/);
  const solIdx = full.indexOf("SOLIDITY:");
  let code = solIdx >= 0 ? full.slice(solIdx + "SOLIDITY:".length) : full;
  // Strip any accidental markdown fences.
  code = code.replace(/```solidity/gi, "").replace(/```/g, "").trim();
  return {
    name: (nameMatch?.[1] ?? "GeneratedVault").trim(),
    explanation: (explMatch?.[1] ?? "").trim(),
    code,
  };
}

export async function generateVaultCodeStream(
  prompt: string,
  apiKey: string | undefined,
  model: string,
  emit: (ev: CodegenEvent) => void,
  approximationConsent?: ApproximationConsent
): Promise<void> {
  if (!apiKey) {
    const stub = stubResult(prompt);
    emit({ type: "status", phase: "error", attempt: 0, message: "ANTHROPIC_API_KEY not set" });
    emit({ type: "result", result: stub });
    return;
  }

  const { createAiClient } = await import("./ai-client.js");
  const client = createAiClient(apiKey);

  try {
    const tokenUsage = createAiUsageTotals();
    const result = await runWithAiUsage(tokenUsage, () =>
      runCodegenPipeline({
        client,
        model,
        apiKey,
        userPrompt: prompt,
        systemPrompt: STREAM_SYSTEM_PROMPT,
        stream: true,
        emit,
        approximationConsent,
      })
    );

    await cleanupCodegen();
    logAiUsage(tokenUsage);

    const full: CodegenResult = { ...result, mode: "openai", tokenUsage };
    emit({
      type: "status",
      phase: pipelineSuccess(full) ? "done" : "error",
      attempt: full.attempts,
      maxAttempts: MAX_TOTAL_ATTEMPTS,
      message: pipelineFinishMessage(full),
    });
    emit({ type: "result", result: full });
  } catch (err) {
    console.error("codegen stream failed:", err);
    emit({ type: "error", error: err instanceof Error ? err.message : "Codegen failed" });
  }
}

export async function generateVaultCodeRefineStream(
  message: string,
  session: RefineSession,
  apiKey: string | undefined,
  model: string,
  emit: (ev: CodegenEvent) => void
): Promise<void> {
  if (!apiKey) {
    emit({ type: "status", phase: "error", attempt: 0, message: "ANTHROPIC_API_KEY not set" });
    emit({ type: "error", error: "ANTHROPIC_API_KEY not set" });
    return;
  }

  const { createAiClient } = await import("./ai-client.js");
  const client = createAiClient(apiKey);

  const scanPrompt = `${session.initialPrompt}\n${message}`;
  const refineSystem = REFINE_STREAM_SYSTEM_PROMPT;
  const seedMessages = buildRefineSeedMessages(session, message, refineSystem);

  try {
    emit({ type: "status", phase: "writing", attempt: 0, message: "Applying your refinement…" });

    const tokenUsage = createAiUsageTotals();
    const result = await runWithAiUsage(tokenUsage, () =>
      runCodegenPipeline({
        client,
        model,
        apiKey,
        userPrompt: session.initialPrompt,
        systemPrompt: refineSystem,
        stream: true,
        emit,
        seedMessages,
        scanPrompt,
      })
    );

    await cleanupCodegen();
    logAiUsage(tokenUsage);

    const full: CodegenResult = { ...result, mode: "openai", tokenUsage };
    emit({
      type: "status",
      phase: pipelineSuccess(full) ? "done" : "error",
      attempt: full.attempts,
      maxAttempts: MAX_TOTAL_ATTEMPTS,
      message: pipelineFinishMessage(full),
    });
    emit({ type: "result", result: full });
  } catch (err) {
    console.error("codegen refine stream failed:", err);
    emit({ type: "error", error: err instanceof Error ? err.message : "Refine failed" });
  }
}

function compileFixPrompt(errors: string): string {
  return `That contract failed to compile with solc 0.8.26. Fix ALL errors and return the corrected JSON (same shape). Do not add imports/pragma.

Common codegen compile fixes:
- ApproveAction("taxToken", "amount") — two STRING args only; vaultUISchema is pure (no taxToken variable).
- FieldDescriptor("name", "uint256", "desc", 18) — positional, not FieldDescriptor({...}).
- VaultMethodSchema — assign fields one-by-one, never struct constructors.

Errors:

${errors}`;
}

/** Phase 4: failure memory cites Rule IDs, finding names, and the MechanicSpec — never a vault kind. */
function buildFailureMemoryJson(
  attempt: number,
  previousFailures: string[],
  currentlyBlocking: { id: string; reason: string; sourceScope?: string }[],
  mechanicSpec?: MechanicSpec
): string {
  return JSON.stringify(
    {
      attempt,
      previousFailures,
      currentlyBlocking: currentlyBlocking.map((b) => ({
        ...b,
        flapRule: formatRuleLabel(mapScannerFindingToRuleId(b.id)),
      })),
      ...(mechanicSpec ? { mechanicSpec: summarizeMechanicSpec(mechanicSpec) } : {}),
    },
    null,
    2
  );
}

function safetyFixPrompt(
  blocking: SafetyFinding[],
  attempt: number,
  previousFailures: string[],
  mechanicSpec?: MechanicSpec
): string {
  const currentlyBlocking = blocking.map((f) => ({
    id: f.rule,
    reason: f.detail,
    sourceScope: f.sourceScope,
  }));
  const memory = buildFailureMemoryJson(attempt, previousFailures, currentlyBlocking, mechanicSpec);
  const grouped = groupFindingsByRule(blocking);
  const list = grouped
    .map(
      (g) =>
        `${g.label}:\n${g.findings.map((f) => `- [${f.rule}${f.sourceScope ? `/${f.sourceScope}` : ""}] ${f.detail}`).join("\n")}`
    )
    .join("\n");
  const ruleGuidance = formatRuleFixGuidance(grouped.map((g) => g.ruleId));
  const missingState = blocking
    .filter((f) => f.rule === "public-state-not-in-uischema")
    .map((f) => f.detail)
    .join("\n");
  const uischemaHint = missingState
    ? `\nFor public-state-not-in-uischema: add a vaultUISchema view method for EACH variable listed above.\n${missingState}\n`
    : "";
  const schemaIntegrityHint = blocking.some((f) => f.rule === "schema-method-not-implemented")
    ? `\nFor schema-method-not-implemented: either IMPLEMENT the missing function body, or REMOVE it from vaultUISchema.methods. Never list a method name without a matching function/public var.\n`
    : "";
  const timeUntilHint = blocking.some((f) =>
    /missing-time-until-view|time-until-not-in-uischema/.test(f.rule)
  )
    ? `\nFor time-until issues: add a view returning seconds remaining until the next scheduled action (e.g. function timeUntilNextExecution() public view returns (uint256)) and list it in vaultUISchema.methods so Flap shows a countdown.\n`
    : "";
  const triggerHint = blocking.some(
    (f) => f.rule === "write-method-not-in-uischema" || f.rule === "design-schema-method-missing"
  )
    ? `\nFor missing write/trigger methods: any external user action or mechanism trigger (advance*, execute*, request*, etc.) MUST appear in vaultUISchema.methods (isWriteMethod=true) — including onlyManager triggers so users see the mechanism exists.\n`
    : "";
  const economicPayoutHint = blocking.some((f) =>
    /first-claimer-can-drain-shared-pool|approval-without-reserved-liability|claim-amount-from-global-bucket-without-winner-semantics|multi-user-payout-without-per-user-accounting|approval-not-linked-to-submitted-state|event-only-user-action-without-trust-disclosure/.test(
      f.rule
    )
  )
    ? `\nFor economic/multi-user payout issues (Phase 7):
- Do NOT pay the full shared bucket to whichever eligible address claims first — add a per-user liability mapping (e.g. mapping(address => uint256) public claimableRewards) and pay only claimableRewards[msg.sender].
- Reserve/credit the reward amount at approval/eligibility time, not at claim time: e.g. \`rewardBucket -= amount; claimableRewards[user] += amount;\` inside the manager approval function.
- Make approval consume or reference the submitted state (e.g. store latestProofHash[user] = keccak256(proof) on submission and check it in approval), or explicitly disclose in description()/vaultUISchema that review is off-chain from event logs.
- Only pay the entire bucket to a single caller when the mechanic is genuinely winner-takes-all — in that case say so explicitly in description() and never leave a per-user eligibility mapping that implies more than one recipient.
- Add a view for the caller's own claimable amount and (if relevant) submission/approval status so the Flap UI can show it.
- Keep receive() cheap (Rule 005), keep bilingual require() strings (Rule 004), and always update state (zero claimableRewards[msg.sender]) BEFORE the native transfer.\n`
    : "";
  const lifecycleHint = blocking.some((f) =>
    /single-resource-multiple-acceptance|accepted-user-can-become-stuck|no-abandon-or-cancel-path|inactive-resource-blocks-user-state|shared-resource-deactivated-while-users-assigned|manager-completion-without-assignee-check|manager-finalization-without-submission|manager-finalization-without-timeout|holder-wording-without-holder-check|hardcoded-economic-constant-without-spec|unbounded-array-return-in-ui-schema|missing-user-status-view|resource-state-not-queryable|assignment-model-missing|reward-amount-not-specified/.test(
      f.rule
    )
  )
    ? `\nFor lifecycle / assignment / stuck-state issues (Phase 8):
- Do not let multiple users accept a single-assignee resource — set the assignee on accept and revert when the resource is already taken; add per-user assignment tracking (e.g. mapping(address => uint256) acceptedResourceOf) when users attach to resources.
- Use a status ENUM (e.g. Open, Assigned, Submitted, Completed, Cancelled) instead of one bool when the resource has multiple lifecycle states, and make each transition explicit.
- Add BOTH exit paths: an abandon function (the assignee clears their own assignment before approval) and a manager cancel function for open/expired resources — and never deactivate a shared resource in a way that traps other assigned users (clear or honor their assignment state on deactivation).
- Add proof submission if completion depends on user work (store a proofHash the approval verifies); the manager approval must verify the approved address IS the assignee before crediting anything.
- Reserve the reward into claimable[user] at approval time (\`rewardBucket -= amount; claimable[user] += amount;\`) — never invent a hardcoded reward constant the spec did not decide; make the amount per-resource (set by the manager when posting).
- Add views for user assignment, claimable balance, resource status (count + per-id getter), and the reward bucket — avoid unbounded array returns in vaultUISchema-facing views (use count + per-id getters or pagination).
- Enforce holder eligibility (balanceOf(msg.sender) > 0 gate) if the description says "holders", or fix the wording.
- Target safe single-assignee shape (adapt names to the mechanic): enum Status {Open, Assigned, Submitted, Completed, Cancelled}; struct with description, rewardAmount, assignee, proofHash, deadline, status; post(description, rewardAmount, deadline) [manager]; accept(id) sets assignee+status; submitProof(id, proofHash); approve(user, id) verifies assignee+proofHash then reserves into claimable[user]; abandon(id) lets the assignee exit before approval; cancel(id) [manager] for open/expired; claim() pays only claimable[msg.sender]; views: count, get(id), getAccepted(user), getClaimable(user), rewardBucket.
- Keep receive() cheap (Rule 005), preserve bilingual require() strings (Rule 004), and keep state updates BEFORE native transfers.\n`
    : "";
  const repeated = previousFailures.filter((r) => blocking.some((b) => b.rule === r));
  const repeatNote =
    repeated.length > 0
      ? `\nThese rules failed in previous attempts: ${[...new Set(repeated)].join(", ")}. Do not make a superficial edit — change the underlying logic.\n`
      : "";
  return `You are repairing a generated Flap vault that violates the Flap constitution (Rules 001–009). Do not rewrite unrelated architecture, but DO re-check the complete mechanic lifecycle before returning code.

Do not only patch the visible failing line. Fix the underlying rule violation.

Rule-specific fixes for the violated rules:
${ruleGuidance}

Failure memory:
${memory}
${repeatNote}
Before returning code, verify:
- all previous blocking findings are fixed
- no new violation of the same Flap rules is introduced
- UI schema matches functions/events
- no forbidden wording remains
${uischemaHint}${schemaIntegrityHint}${timeUntilHint}${triggerHint}${economicPayoutHint}${lifecycleHint}
Return the corrected JSON (same shape, no imports/pragma).

Blocking issues (grouped by Flap rule):

${list}`;
}

function compileFixPromptStream(errors: string): string {
  return `That failed to compile with solc 0.8.26. Fix ALL errors and re-output in the SAME plain-text format (CONTRACT_NAME / EXPLANATION / SOLIDITY). No imports/pragma.

ApproveAction("taxToken", "amount") only — pure vaultUISchema cannot reference taxToken variable. FieldDescriptor uses positional args.

Errors:

${errors}`;
}

function safetyFixPromptStream(
  blocking: SafetyFinding[],
  attempt: number,
  previousFailures: string[],
  mechanicSpec?: MechanicSpec
): string {
  return `${safetyFixPrompt(blocking, attempt, previousFailures, mechanicSpec)}\n\nRe-output in the SAME plain-text format (CONTRACT_NAME / EXPLANATION / SOLIDITY).`;
}

/** Phase 5: cite failing simulation scenarios (spec action + Rule IDs + expected behavior), never a vault kind. */
function formatFailingScenarios(scenarios: SimulationScenarioResult[]): string {
  if (scenarios.length === 0) return "";
  const lines = scenarios.slice(0, 6).map((s) => {
    const rules = s.ruleIds.map((id) => formatRuleLabel(id)).join("; ");
    const methods = s.methods.length ? ` MechanicSpec method(s): ${s.methods.join(", ")}.` : "";
    return `- Fix failing scenario \`${s.scenario}\` (actor: ${s.actor}).${methods}
  Expected: ${s.expected}
  Actual: ${s.actual}${s.failureSummary ? `\n  Failure: ${s.failureSummary.slice(0, 300)}` : ""}
  Rules involved: ${rules}.`;
  });
  return `\nFailing simulation scenarios (fix the CONTRACT so each expected behavior holds):\n${lines.join("\n")}\n`;
}

function testFixPrompt(
  errors: string,
  attempt: number,
  previousFailures: string[],
  mechanicSpec?: MechanicSpec,
  failedScenarios: SimulationScenarioResult[] = []
): string {
  const memory = buildFailureMemoryJson(
    attempt,
    previousFailures,
    [{ id: "integration-test-failure", reason: errors.slice(0, 500) }],
    mechanicSpec
  );
  return `Foundry integration tests failed (${formatRuleLabel("006")}). Fix the vault logic (not the test file) and return corrected JSON (same shape, no imports/pragma).

${formatRuleFixGuidance(["006"])}
${formatFailingScenarios(failedScenarios)}
Failure memory:
${memory}

Do not only patch the visible failing line. Re-evaluate the complete mechanic lifecycle against the MechanicSpec and the Flap constitution before returning code.

Test errors:
${errors.slice(0, 3000)}`;
}

function testFixPromptStream(
  errors: string,
  attempt: number,
  previousFailures: string[],
  mechanicSpec?: MechanicSpec,
  failedScenarios: SimulationScenarioResult[] = []
): string {
  return `${testFixPrompt(errors, attempt, previousFailures, mechanicSpec, failedScenarios)}\n\nRe-output in the SAME plain-text format (CONTRACT_NAME / EXPLANATION / SOLIDITY).`;
}

function surgicalSafetyFixPrompt(blocking: SafetyFinding[], repeatedMessage: string): string {
  const grouped = groupFindingsByRule(blocking);
  const ruleIds = grouped.map((g) => g.ruleId);
  const list = grouped
    .map((g) => `${g.label}:\n${g.findings.map((f) => `- [${f.rule}] ${f.detail}`).join("\n")}`)
    .join("\n");
  const ruleGuidance = formatRuleFixGuidance(ruleIds);
  return `You have failed to fix the same blocking issue multiple times: "${repeatedMessage}".

The violated Flap constitution rules are: ${ruleIds.map((id) => formatRuleLabel(id)).join("; ")}. Do not make a superficial edit. Change the underlying logic so the rule is satisfied.

Rule-specific fixes (apply the ones matching the violated rules):
${ruleGuidance}

Known concrete remedies — apply ONLY where your code contains the matching pattern:
- If a fulfill/refund callback escrows a request fee: clear the fee exactly once on fulfill AND on refund; refund restores the escrowed amount once (never doubled), and clears any frozen snapshot.
- If an oracle request casts a count to uint8: require(n > 0 && n <= type(uint8).max, ...) before the cast, and require the funding bucket strictly exceeds the fee.
- If a callback pays winners: credit a claimable mapping (pull payment) — never _sendNative(winner) inside the callback.
- If users accrue rewards against a share index: settle or preserve pending amounts BEFORE changing the user's balance, and keep the pending view consistent with what claim pays.
- If an elimination flow rebuilds a participant list from a snapshot: rebuild BEFORE deleting the snapshot, and count remaining participants instead of testing the snapshot's length.
- If receive() performs a swap/burn/payout: move it to a separate manager function that drains a named bucket with real slippage protection; receive() only does bucket accounting.
- If an unbounded participant array feeds an oracle request: cap entries at join time (e.g. max 255), not only at request time.

Re-output the FULL contract in plain-text format (CONTRACT_NAME / EXPLANATION / SOLIDITY).

Blocking issues still present (grouped by Flap rule):

${list}`;
}

function firstErrors(out: string): string {
  return out
    .split("\n")
    .filter((l) => /Error/.test(l))
    .slice(0, 3)
    .join(" | ");
}

function stubResult(prompt: string): CodegenResult {
  const body = `contract GeneratedVault is CodegenVaultBase {
    uint256 public totalReceived;

    receive() external payable {
        totalReceived += msg.value; // cheap accounting only
    }

    function withdraw() external onlyManager nonReentrant {
        _sendNative(creator, address(this).balance);
    }

    function description() public view override returns (string memory) {
        return "Stub vault (set ANTHROPIC_API_KEY to generate real custom logic)";
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "GeneratedVault";
        schema.description = unicode"Stub vault / 存根金库";
        schema.methods = new VaultMethodSchema[](1);
        schema.methods[0].name = "withdraw";
        schema.methods[0].description = unicode"Withdraw balance / 提取余额";
        schema.methods[0].isWriteMethod = true;
        schema.methods[0].inputs = new FieldDescriptor[](0);
        schema.methods[0].outputs = new FieldDescriptor[](0);
        schema.methods[0].approvals = new ApproveAction[](0);
    }
}`;
  const contractName = "GeneratedVault";
  const safety = scanSafety(body, contractName, prompt);
  return {
    contractName,
    explanation: `Stub for "${prompt.slice(0, 80)}" — set ANTHROPIC_API_KEY for real AI codegen.`,
    source: `${PREAMBLE}\n${body}\n`,
    compiled: false,
    compileErrors: "ANTHROPIC_API_KEY not set — returning a stub (not compiled). Set the key in server/.env.local for real codegen.",
    safety,
    specAudit: {
      level: "skipped",
      summary: "Pre-audit requires ANTHROPIC_API_KEY and a successful compile.",
      items: [],
      mode: "skipped",
    },
    mechanicSpec: inferMechanicSpecFromPrompt(prompt),
    scope: inferVaultScopeFromPrompt(prompt),
    deliverable: "contract",
    approximation: null,
    designQuestions: [],
    designDecisions: [],
    abi: null,
    creationBytecode: null,
    bytecodeSize: null,
    deployedBytecodeSize: null,
    attempts: 0,
    integrationTestPath: null,
    integrationTestsPassed: false,
    simulationReport: null,
    economicCritique: null,
    repairAttempts: [],
    fixLog: [],
    autoFixExhausted: false,
    uiArtifact: null,
    mode: "stub",
    tokenUsage: null,
  };
}
