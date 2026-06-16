import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runSpecAudit, specCodegenFixableItems, specFixPrompt, specFixPromptStream, type SpecAuditResult } from "./spec-audit.js";
import { generateIntegrationTest } from "./test-gen.js";

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
};

export type FixLogEntry = {
  phase: "writing" | "compile_fix" | "safety_fix" | "spec_fix" | "generating_tests" | "auditing";
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
  abi: unknown[] | null;
  bytecodeSize: number | null;
  attempts: number;
  integrationTestPath: string | null;
  fixLog: FixLogEntry[];
  autoFixExhausted: boolean;
  mode: "openai" | "stub";
};

const MAX_PIPELINE_ATTEMPTS = 12;

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

const CODEGEN_RULES = `You are Origin Vault Codegen — you write a COMPLETE, correct, original Solidity contract for a
single Flap tax vault that performs EXACTLY the mechanic the user describes. You are not limited to
a fixed menu; design whatever on-chain logic fits. The contract is compiled with solc 0.8.26 and
REJECTED on any error, so be precise.

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
2. Include the pass-through constructor (required). You MAY add ONE initialization line for round
   timers in the same constructor body (nothing else), e.g. lastDrawTime = block.timestamp; for weekly
   lotteries. Do NOT redeclare taxToken/creator/factory/BURN_ADDRESS:
       constructor(address _taxToken, address _creator, address _factory)
           CodegenVaultBase(_taxToken, _creator, _factory)
       {
           lastDrawTime = block.timestamp; // optional — timed lottery/epoch vaults only
       }
3. Implement receive() external payable and keep it CHEAP: pure accounting only (update storage
   counters/budgets). NO external calls, swaps, transfers, or loops in receive(). It must never
   revert on a normal deposit (do NOT require(msg.value > 0) — just return early if zero).
4. FULLY implement the mechanic with every function and payout path it needs — never half-built.
   - staking -> stake/unstake/claim with correct accrual accounting (e.g. accRewardPerShare scaled
     by 1e18). Track each user's staked balance and reward debt.
   - lottery/raffle -> keep an address[] of entrants, draw by indexing into THAT array
     (idx = rand % entrants.length), then pay. NEVER iterate address(i) — it is meaningless.
   - buyback -> call the inherited _buyAndBurn(amount, minOut). Do NOT hand-roll the swap.
5. Use the onlyManager modifier on privileged/admin functions. Guard any function that sends BNB
   or calls the Portal with nonReentrant.
6. Override description() public view returns (string memory).
7. Override vaultUISchema() public pure returns (VaultUISchema memory schema) — see exact rules below.
8. Compute a payout amount BEFORE zeroing its source (never set x = 0 then send x).
9. Randomness wording — do NOT overclaim security:
   - FlapAIConsumerBase draws: describe as "external AI provider selection" / "Flap AI oracle callback" — NOT
     "secure random", "cryptographically secure", or "verifiable randomness" unless you use a VRF/proof-backed source.
   - block.prevrandao / blockhash: FORBIDDEN for outcomes (R4). If ever mentioned in docs, call it "on-chain entropy"
     and disclose it is manager-influencable — do not use it for winner picks.
   - ANY lottery, raffle, survivor pick, or random winner MUST use FlapAIConsumerBase (R1) for the outcome.
     NEVER use block.prevrandao, blockhash, or block.timestamp % n for winner/elimination selection.
10. NEVER use selfdestruct, delegatecall, or tx.origin. Do not deploy other contracts.
11. NEVER define or use custom errors (Flap UI-01). EVERY revert must be require(cond, "literal
    string") — the UI cannot decode custom error selectors. Prefer unicode"English / 中文" messages.
12. Move ERC20 tokens with SafeERC20: IERC20(token).safeTransfer / safeTransferFrom. Never rely on
    the raw bool return of transfer/transferFrom.
13. NEVER emit a stub, placeholder, TODO/FIXME, "implement this later", or a function that returns
    fake/empty data. Every function must be fully and correctly implemented.
14. If the mechanic needs data that does NOT exist on-chain (e.g. ranking ALL token holders, an
    off-chain price, a "top N holders" list — the vault CANNOT enumerate ERC20 holders), do NOT fake
    it. Instead accept it as input to an onlyManager keeper function, e.g.
        function executeAirdrop(address[] calldata winners, uint256[] calldata amounts)
            external onlyManager nonReentrant { ... validate sums against the pool, then pay ... }
    and state the off-chain/keeper trust assumption in the explanation. Validate inputs on-chain
    (array lengths match, total <= pool) so the keeper cannot over-pay.

FLAP PROTOCOL FUND-FLOW RULES (these are how tax actually flows — violating them produces a
broken or unsafe vault even if it compiles):
A. receive() is called by the Flap tax processor on every tax event with plain BNB. Inside
   receive(), msg.sender is the PROTOCOL, NOT a holder/buyer. NEVER attribute a deposit to
   msg.sender, NEVER push msg.sender as a participant, NEVER index user state by msg.sender in
   receive(). receive() may ONLY do cheap accounting: split msg.value into named storage buckets
   (e.g. buybackBudget, jackpot, rewardPool, treasury). It MUST NOT call _buyAndBurn, _sendNative,
   transfer, swap, any external call, or any loop. (Hard protocol cap: receive() <= 1,000,000 gas.)
B. Buyback/burn runs in a SEPARATE function, e.g.:
       function executeBuyback(uint256 minTokensOut) external onlyManager nonReentrant {
           uint256 amt = buybackBudget; require(amt > 0, "none"); buybackBudget = 0;
           _buyAndBurn(amt, minTokensOut);     // pass a REAL minOut for slippage, never 0 in prod
       }
C. Per-holder logic happens in user-called functions (enter/stake/claim/draw), where msg.sender IS
   the real user. You MAY read IERC20(taxToken).balanceOf(msg.sender) ONLY as a boolean minimum-hold
   gate (e.g. require(balance >= 1e18) to enter()) — NEVER to compute a payout amount or pro-rata share.
   NEVER size a payout/dividend from a live balanceOf — it is flash-loan/MEV gameable (Rule 003).
D. If you STAKE real tokens, you MUST pull them: IERC20(taxToken).transferFrom(msg.sender,
   address(this), amount) (the UI approves via an ApproveAction). Reward accrual MUST be a correct
   accRewardPerShare model: when reward BNB is added, accRewardPerShare += added * 1e18 / totalStaked;
   pending = user.amount * accRewardPerShare / 1e18 - user.rewardDebt. Do NOT invent ad-hoc formulas.

STAKING (accRewardPerShare) — reference pattern the scanner enforces:
- struct UserInfo { uint256 amount; uint256 rewardDebt; }
- receive(): if totalStaked == 0, pendingRewards += msg.value (single undistributed bucket).
  if totalStaked > 0, accRewardPerShare += msg.value * 1e18 / totalStaked.
  NEVER mix accRewardPerShare += in receive with rewardPool -= on payout — pick ONE model.
- stake(): if pendingRewards > 0, roll BEFORE increasing totalStaked using denominator (totalStaked + amount)
  so the FIRST staker also receives pre-stake tax: accRewardPerShare += pendingRewards * 1e18 / (totalStaked + amount); pendingRewards = 0;
- claimReward(): compute pending, pay _sendNative, update rewardDebt — do NOT call an internal
  harvest helper that also pays (no double-harvest).
- Add pendingReward(address user) external view returns (uint256) so the UI can show accured rewards.
- stake/unstake may sync rewardDebt after amount change but should NOT auto-pay unless you omit claimReward().
- Pay rewards from contract BNB balance — never rewardPool -= pending unless ALL tax went into rewardPool only.
- If taxToken may be fee-on-transfer, credit stake amount using balance-before/after delta, not requested amount.
- Override emergencyWithdrawToken for taxToken when users stake: withdraw only excess above totalStaked tokens.
E. NEVER pay out address(this).balance. Pay each winner/claimant from the SPECIFIC bucket that
   funds it (e.g. send jackpot, then jackpot = 0). BNB in must equal BNB out across buckets.
F. CodegenVaultBase provides emergencyWithdrawNative/Token (onlyGuardian). For bucket vaults
   (buybackBudget, jackpot, treasury, etc.) you SHOULD override emergencyWithdrawNative to withdraw
   ONLY excess BNB above reserved buckets (buybackBudget + jackpot + …), OR zero all bucket counters
   if draining everything — otherwise guardian rescue desyncs accounting. Overrides MUST keep
   onlyGuardian — never onlyManager.
G. Fairness (Rule 003): no privileged role may sandwich or systematically out-compete users.

PRODUCTION QUALITY BAR (match FreeCoin.sol / Flap reference vaults — incomplete output is REJECTED):
- EVERY require/revert string MUST be bilingual: unicode"English / 中文" (Flap UI Rule 004).
- EVERY external function that sends BNB (_sendNative, _buyAndBurn, .call{value:}) MUST use nonReentrant.
- EVERY payout with an address recipient param MUST require(to != address(0), unicode"...").
- NEVER use silent try/catch {} — handle failures explicitly with require.
- Emit events for every meaningful state change (deposits split, buyback, withdraw, enter, payout).
- vaultUISchema MUST be COMPLETE for every method entry (see below) — partial schemas break the Flap UI.
- Include VIEW methods in vaultUISchema for every public state var the user cares about
  (e.g. buybackBudget, treasury, totalStaked, jackpot) so the UI can display live values.
- MANDATORY: EVERY uint256 public / bool public / address public in the child contract
  (except taxToken/creator/factory from base) MUST appear as a view method in vaultUISchema.methods
  with the SAME name — scan rejects missing ones (public-state-not-in-uischema).
- stake()/unstake() that use transferFrom MUST include ApproveAction on taxToken in vaultUISchema.

UI SCHEMA (vaultUISchema) — common AI mistakes to AVOID:
- schema.methods[] is ONLY for user-callable write methods AND custom view helpers — NEVER list
  "description" or "vaultUISchema" as methods (those are separate overrides).
- For EVERY methods[i] you MUST set ALL of: name, description, isWriteMethod (if write),
  inputs = new FieldDescriptor[](N), outputs = new FieldDescriptor[](M), approvals = new ApproveAction[](K).
  Even when N/M/K is 0, still assign the empty arrays — omitting outputs/approvals breaks the UI.
- Each write method needs isWriteMethod = true and accurate inputs/outputs FieldDescriptor arrays.
- For stake/unstake with transferFrom, set approvals[0] = ApproveAction("taxToken", "amount").
  ApproveAction has ONLY two positional string args (tokenType, amountFieldName) — NEVER use
  named braces like ApproveAction({token: taxToken, ...}) and NEVER reference the taxToken variable
  inside vaultUISchema (it is pure — use the literal string "taxToken").

EVENTS — emit for every meaningful state change (helps auditability):
- e.g. event BudgetUpdated(string bucket, uint256 amount); event Entered(address user);
  event BuybackExecuted(uint256 bnbIn, uint256 tokensBought); // name fields to match emitted values
  event WinnerPaid(address winner, uint256 prize);

LOTTERY / RAFFLE (any entrants[] + draw) — timing, caps, oracle randomness:
- enter() MUST NOT gate on weekly/round timers (lastDrawTime + 1 weeks, etc.) — that locks the first
  round or blocks entry incorrectly. Enforce cadence ONLY on requestDraw() (not enter).
- If using lastDrawTime / roundStart, initialize it in constructor: lastDrawTime = block.timestamp;
- Cap entrants: MAX_ENTRANTS <= 255 and require(entrants.length < MAX_ENTRANTS) in enter() — draw loops
  must not be unbounded (gas DoS).
- Winner selection MUST use FlapAIConsumerBase requestDraw() + _fulfillReasoning (R1) — NEVER
  drawWinner() with block.prevrandao / blockhash. There is no on-chain VRF shortcut on Flap.
- For real jackpots and demo lotteries alike: inherit FlapAIConsumerBase, snapshot entrants, AI pick.
- Prefer mapping(address => uint256) claimablePrize + claim() for large winner payouts (pull payment).
- Reset hasEntered[] BEFORE delete entrants; loop snapshot or entrants copy, never loop after delete.

BUCKET ACCOUNTING — when using named buckets (buybackBudget, treasury, jackpot, rewardPool):
- receive() ONLY increments buckets. Every spend MUST decrement the specific bucket first, then pay.
- Tracked native buckets MUST stay solvent: sum(buckets) must never exceed address(this).balance.
- NEVER pay AI oracle fees or jackpots from undifferentiated address(this).balance while bucket counters
  still show funds — deduct from the correct bucket (e.g. jackpot -= fee before p.reason{value: fee}).
- NEVER use require(address(this).balance >= X) for bucket-funded actions without syncing buckets.
- For bucket vaults, override emergencyWithdrawNative with excess-only withdrawal:
      uint256 reserved = buybackBudget + jackpot + treasury; // all tracked native buckets
      uint256 excess = address(this).balance;
      require(excess > reserved, unicode"No excess / 无多余");
      excess -= reserved;
      _sendNative(to, excess);
      emit EmergencyWithdrawNative(to, excess);
  NEVER drain address(this).balance while reserved buckets still hold user funds.

LOTTERY + AI (FlapAIConsumerBase) — MANDATORY patterns:
- Snapshot: at requestDraw(), copy entrants to address[] drawSnapshot and use ONLY drawSnapshot in
  _fulfillReasoning — never index live entrants[] after the oracle request (entrant set must be frozen).
- Dedup: enter() MUST guard with mapping(address => bool) hasEntered or equivalent — no duplicate pushes.
- Freeze: enter() MUST require(pendingRequestId == 0, "...") so no one joins mid-draw.
There is NO Chainlink VRF on Flap. For ANY winner selection / random outcome with real value at
stake, DO NOT use block.prevrandao (the manager can read it in-tx and only call when they win).
Instead use the FlapAIProvider, a commit-and-reveal oracle (VRF-like) whose callback is authenticated.

R1. Random winner / AI-decided outcome via FlapAIProvider:
   - The provider address is _getFlapAIProvider() (inherited from FlapAIConsumerBase). NEVER use
     _getPortal() or _getFlapTriggerService() for the AI provider — they are different contracts.
   - Also inherit FlapAIConsumerBase:  contract X is CodegenVaultBase, FlapAIConsumerBase { ... }
   - Add: uint256 public pendingRequestId; uint256 public aiModelId; and a setter
       function setAiModel(uint256 id) external onlyManager { aiModelId = id; }
   - To start a draw (snapshot entrants FIRST so the set is fixed before the choice is known):
       function requestDraw() external onlyManager nonReentrant {
           require(pendingRequestId == 0, "Draw pending");
           delete drawSnapshot;
           for (uint256 i = 0; i < entrants.length; i++) drawSnapshot.push(entrants[i]);
           uint256 n = drawSnapshot.length; // NEVER loop drawSnapshot.length right after delete — it is 0
           require(n > 0 && n <= 255, "Bad entrant count");
           IFlapAIProvider p = IFlapAIProvider(_getFlapAIProvider());
           uint256 fee = p.getModel(aiModelId).price;
           require(jackpot >= fee, "Need fee from jackpot"); jackpot -= fee;
           lastDrawFee = fee;
           pendingRequestId = p.reason{value: fee}(aiModelId,
               "Pick one integer uniformly at random in [0, n-1] to choose a lottery winner.", uint8(n));
       }
   - In _fulfillReasoning use drawSnapshot[choice], NOT entrants[choice].
   - Reset hasEntered for every drawSnapshot address BEFORE delete entrants (loop drawSnapshot first).
   - Set lastDrawTime = block.timestamp after a successful draw payout.
   - Clear lastDrawFee = 0 after successful fulfillment.
   - Store draw fee in lastDrawFee at requestDraw; restore jackpot += lastDrawFee in _onFlapAIRequestRefunded.
   - On refund: clear pendingRequestId, restore fee bucket, delete drawSnapshot, clear lastDrawFee — never leave
     stale snapshot/fee state or permanently locked hasEntered.
   - Before uint8(n) cast: require(n > 0 && n <= 255, "...") or require(n <= type(uint8).max, "...").
   - requestDraw() MUST require(pendingRequestId == 0) — block overlapping async requests.
   - Implement the THREE required overrides (callback auth is handled by the base's
     onlyFlapAIProvider — do NOT write your own public fulfillReasoning):
       function _fulfillReasoning(uint256 requestId, uint8 choice) internal override {
           require(requestId == pendingRequestId, "Stale request");
           pendingRequestId = 0;
           require(drawSnapshot.length > 0 && choice < drawSnapshot.length, "Bad choice");
           address winner = drawSnapshot[choice];
           uint256 prize = jackpot; jackpot = 0;
           for (uint256 i = 0; i < drawSnapshot.length; i++) hasEntered[drawSnapshot[i]] = false;
           delete drawSnapshot;
           delete entrants;
           _sendNative(winner, prize);
       }
       function _onFlapAIRequestRefunded(uint256 requestId) internal override {
           if (requestId == pendingRequestId) {
               pendingRequestId = 0;
               jackpot += lastDrawFee;
               lastDrawFee = 0;
           }
       }
       function lastRequestId() public view override returns (uint256) { return pendingRequestId; }
   - The callback runs under a HARD 2,000,000 gas cap: NO unbounded loops / heavy external calls in
     it, and it must never revert-lock (always clear pendingRequestId first).

R2. Scheduled / automated execution via FlapTriggerService (so no human controls timing):
   - Also implement ITriggerReceiver:  contract X is CodegenVaultBase, ITriggerReceiver { ... }
   - Schedule:  uint256 fee = IFlapTriggerService(_getFlapTriggerService()).getFee();
                uint256 rid = IFlapTriggerService(_getFlapTriggerService()).requestTrigger{value: fee}(uint64(when));
                scheduled[rid] = true;
   - Receive (MUST validate the sender, re-check timing, consume the request):
       function trigger(uint256 requestId) external override nonReentrant {
           require(msg.sender == _getFlapTriggerService(), "Only trigger service");
           require(scheduled[requestId], "Unknown request");
           delete scheduled[requestId];
           // ... do the scheduled action; re-validate any time/price conditions ...
       }
   - Same hard 2,000,000 gas cap; never assume it fires exactly at the scheduled time.

R3. Use FlapAIConsumerBase whenever the mechanic needs a random or AI-decided outcome (lottery,
    survivor elimination, weighted pick). Use FlapTriggerService (R2) for scheduled automation.
    Simple stake/dividend/buyback vaults need neither.

R4. Randomness policy — block entropy is FORBIDDEN for outcomes:
   - Flap has no Chainlink VRF. Use FlapAIProvider via FlapAIConsumerBase (R1/R5) for outcomes.
   - If the user mentions prevrandao, VRF, or "random draw", still implement FlapAIConsumerBase.
   - NEVER emit drawWinner() / pickWinner() that uses block.prevrandao % n or blockhash.
   - In description(), vaultUISchema(), and comments: say "external AI provider selection" for AI draws —
     never "secure random" unless describing a VRF/proof-backed source.
   - Weekly/timed lotteries: requestDraw() enforces lastDrawTime + 1 weeks; _fulfillReasoning sets lastDrawTime = block.timestamp after payout.
   - Bucket vaults: override emergencyWithdrawNative for excess-only withdrawal.
   - Prefer claimablePrize + claim() pull payment for winners.

R5. Survivor / elimination (FlapAIConsumerBase — same snapshot rules as R1 lottery):
   - Snapshot active stakers into drawSnapshot[] at requestElimination() BEFORE the AI request:
       delete drawSnapshot;
       for (uint256 i = 0; i < stakers.length; i++) {
           if (isActiveStaker[stakers[i]]) drawSnapshot.push(stakers[i]);
       }
     NEVER loop i < drawSnapshot.length immediately after delete — the array is empty.
   - _fulfillReasoning uses drawSnapshot[choice] only — never live stakers[] after the request.
   - Remove ONLY the eliminated address from active tracking; NEVER delete stakers[] entirely mid-game.
   - Winner when one active staker remains; pay survivorPool then zero the bucket.
   - Count active stakers in _fulfillReasoning — never if (drawSnapshot.length == 1) on a frozen snapshot.
   - Cap active stakers <= 255; restore survivorPool += fee on _onFlapAIRequestRefunded.

EXACT STRUCT SHAPES — build the schema with FIELD ASSIGNMENT only. Do NOT use struct constructors
like VaultMethodSchema({...}) (it has 8 fields and will fail). vaultType and description are STRINGS.

  struct FieldDescriptor { string name; string fieldType; string description; uint8 decimals; }
  struct VaultUISchema { string vaultType; string description; VaultMethodSchema[] methods; }

  function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
      schema.vaultType = "MyVault";              // a string, never a number
      schema.description = unicode"What it does / 中文说明";
      schema.methods = new VaultMethodSchema[](3);

      // View: expose live bucket balance
      schema.methods[0].name = "buybackBudget";
      schema.methods[0].description = unicode"Current buyback BNB budget / 当前回购预算";
      schema.methods[0].inputs = new FieldDescriptor[](0);
      schema.methods[0].outputs = new FieldDescriptor[](1);
      schema.methods[0].outputs[0] = FieldDescriptor("budget", "uint256", "Buyback budget in BNB", 18);
      schema.methods[0].approvals = new ApproveAction[](0);

      // Write: executeBuyback
      schema.methods[1].name = "executeBuyback";
      schema.methods[1].description = unicode"Execute buyback with slippage protection / 执行回购";
      schema.methods[1].isWriteMethod = true;
      schema.methods[1].inputs = new FieldDescriptor[](1);
      schema.methods[1].inputs[0] = FieldDescriptor("minTokensOut", "uint256", "Minimum tokens out", 18);
      schema.methods[1].outputs = new FieldDescriptor[](0);
      schema.methods[1].approvals = new ApproveAction[](0);

      // Write: stake with approval
      schema.methods[2].name = "stake";
      schema.methods[2].description = unicode"Stake tax tokens / 质押代币";
      schema.methods[2].isWriteMethod = true;
      schema.methods[2].inputs = new FieldDescriptor[](1);
      schema.methods[2].inputs[0] = FieldDescriptor("amount", "uint256", "Amount to stake", 18);
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
  const missing: string[] = [];
  for (const m of source.matchAll(
    /(?:uint256|uint128|uint64|uint32|uint|bool|address)\s+public\s+(?:(?:constant|immutable)\s+)?(\w+)/g
  )) {
    const name = m[1]!;
    if (skip.has(name)) continue;
    if (schemaBody.includes(`"${name}"`)) continue;
    const camel = name.charAt(0).toUpperCase() + name.slice(1);
    if (schemaBody.includes(`"get${camel}"`)) continue;
    missing.push(name);
  }
  return missing;
}

/** Prompt-aware logic checks beyond structural patterns — used by scanSafety and verify-codegen. */
export function scanVaultLogic(source: string, userPrompt = ""): string[] {
  const issues: string[] = [];
  const prompt = userPrompt.toLowerCase();
  const isStake = /stake|dividend|earn|reward/i.test(prompt) || (/accRewardPerShare/.test(source) && /function\s+stake\s*\(/.test(source));
  const isBuyback = /buyback/i.test(prompt) || /buybackBudget/.test(source);
  const isLottery = /lottery|raffle|jackpot/i.test(prompt) || (/FlapAIConsumerBase/.test(source) && /entrants/.test(source));

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
    if (/buybackBudget|treasury/.test(source) && !/function\s+emergencyWithdrawNative\s*\(/.test(source)) {
      issues.push("Bucket vault missing emergencyWithdrawNative override");
    }
  }

  if (isLottery) {
    if (/block\.prevrandao|blockhash\s*\(/.test(source) && !/FlapAIConsumerBase/.test(source)) {
      issues.push("Uses block entropy instead of FlapAIConsumerBase");
    }
    if (/entrants\.push/.test(source) && !/MAX_ENTRANTS|entrants\.length\s*[<>=]+\s*255/.test(source)) {
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
      const fulfill = source.match(/function _fulfillReasoning[\s\S]*?^\s*\}/m)?.[0] ?? "";
      if (fulfill && !/hasEntered[\s\S]{0,200}=\s*false/.test(fulfill)) {
        issues.push("hasEntered mapping never reset when round ends");
      }
    }
    if (/holder|hold token|token holder/i.test(prompt) && /function enter/.test(source)) {
      const enter = source.match(/function enter[\s\S]*?^\s*\}/m)?.[0] ?? "";
      if (!/balanceOf\s*\(\s*msg\.sender\s*\)/.test(enter)) {
        issues.push("Holder lottery enter() missing taxToken balance check");
      }
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

  // Bucket emergency drain check (logic layer).
  if (/buybackBudget|jackpot|treasury|rewardPool|charityBudget/.test(source)) {
    const emerg = source.match(/function emergencyWithdrawNative[\s\S]*?^\s*\}/m)?.[0] ?? "";
    if (emerg && /address\s*\(\s*this\s*\)\.balance/.test(emerg)) {
      if (!/balance\s*-|excess|reserved|buybackBudget\s*\+|jackpot\s*\+|treasury\s*\+/.test(emerg)) {
        issues.push("emergencyWithdrawNative drains full balance while native buckets exist");
      }
    }
  }

  // AI async lifecycle.
  if (/FlapAIConsumerBase/.test(source) && /lastDrawFee|DrawFee/.test(source)) {
    const fulfill = source.match(/function _fulfillReasoning[\s\S]*?^\s*\}/m)?.[0] ?? "";
    if (fulfill && /lastDrawFee/.test(source) && !/lastDrawFee\s*=\s*0/.test(fulfill)) {
      issues.push("lastDrawFee not cleared after successful fulfillment");
    }
    const refund = source.match(/function _onFlapAIRequestRefunded[\s\S]*?^\s*\}/m)?.[0] ?? "";
    if (refund && /drawSnapshot/.test(source) && !/delete drawSnapshot/.test(refund)) {
      issues.push("AI refund handler does not clear stale drawSnapshot");
    }
  }

  if (/uint8\s*\(\s*(?:n|entrants\.length|drawSnapshot\.length)/.test(source)) {
    const reqDraw = source.match(/function requestDraw[\s\S]*?^\s*\}/m)?.[0] ?? "";
    const reqElim = source.match(/function requestElimination[\s\S]*?^\s*\}/m)?.[0] ?? "";
    const guard = reqDraw + reqElim;
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
  userPrompt = ""
): { level: SafetyLevel; findings: SafetyFinding[] } {
  const findings: SafetyFinding[] = [];
  const add = (level: "block" | "warn", rule: string, detail: string) => findings.push({ level, rule, detail });

  const has = (re: RegExp) => re.test(source);
  const hasBuyback =
    /buybackBudget|executeBuyback|_buyAndBurn/i.test(source) || /buyback/i.test(userPrompt);
  const hasBuckets = /buybackBudget|treasury|jackpot|rewardPool/i.test(source);
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

  // Unbounded entrants[] in draw is a gas DoS — cap at MAX_ENTRANTS (<= 255).
  const drawsFromEntrantList =
    has(/function\s+drawWinner\s*\(/) ||
    has(/requestDraw\s*\(/) ||
    has(/for\s*\([^)]*entrants\.length/) ||
    has(/%\s*entrants\.length\b/);
  if (has(/entrants\.push\s*\(/) && drawsFromEntrantList && (hasLottery || has(/function\s+drawWinner\s*\(/))) {
    const hasEntrantCap =
      /MAX_ENTRANTS|maxEntrants|MAX_ENTRANT|entrants\.length\s*[<>=]+\s*255/.test(source);
    if (!hasEntrantCap) {
      add(
        "block",
        "lottery-no-entrant-cap",
        "Lottery with entrants.push + draw loop must cap entries: MAX_ENTRANTS <= 255 and require(entrants.length < MAX_ENTRANTS) in enter()."
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
  if (
    fulfillFn &&
    (/survivor|eliminat/i.test(source) || /survivor|eliminat/i.test(userPrompt)) &&
    /drawSnapshot\.length\s*==\s*1/.test(fulfillFn.body) &&
    has(/isActiveStaker|activeStaker/)
  ) {
    add(
      "block",
      "survivor-stale-snapshot-win",
      "Do not use drawSnapshot.length == 1 in _fulfillReasoning to detect the winner — count remaining active stakers after marking the eliminated address inactive."
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

  if (hasBuckets && !/function\s+emergencyWithdrawNative\s*\(/.test(source)) {
    add(
      "block",
      "bucket-emergency-no-override",
      "Bucket vault must override emergencyWithdrawNative to withdraw only excess BNB above reserved buckets (buybackBudget + jackpot + …), or zero buckets on full drain — base guardian drain desyncs accounting."
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

  // AI refund should restore fee taken from jackpot bucket.
  if (
    has(/_onFlapAIRequestRefunded/) &&
    has(/jackpot\s*-=\s*fee/) &&
    !/_onFlapAIRequestRefunded[\s\S]{0,400}jackpot\s*\+=/.test(source)
  ) {
    add(
      "block",
      "lottery-refund-no-restore",
      "_onFlapAIRequestRefunded must restore jackpot += fee (and clear pendingRequestId) when the AI oracle refunds a draw fee."
    );
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
    if (!has(/jackpot\s*-=\s*fee|buybackBudget\s*-=\s*fee|treasury\s*-=\s*fee|feeBucket\s*-=/)) {
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

  // Bucket emergencyWithdrawNative must not drain reserved funds.
  const emergFn = extractFunctionChunks(source).find((f) => f.name === "emergencyWithdrawNative");
  if (emergFn && hasBuckets) {
    const drainsAll =
      /_sendNative\s*\(\s*\w+\s*,\s*(?:bal|balance|address\s*\(\s*this\s*\)\.balance)/.test(emergFn.body) &&
      !/balance\s*-|excess|reserved|buybackBudget\s*\+|jackpot\s*\+|treasury\s*\+|rewardPool\s*\+/.test(
        emergFn.body
      );
    if (drainsAll) {
      add(
        "block",
        "emergency-drains-reserved",
        "emergencyWithdrawNative must withdraw only excess above sum(tracked native buckets) — never address(this).balance while buckets hold reserved funds."
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
  const refundFn = extractFunctionChunks(source).find((f) => f.name === "_onFlapAIRequestRefunded");
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

  // Staking vaults should expose pendingReward(address) view for UI.
  if (hasStakeAccrual && !has(/function\s+pendingReward\s*\(\s*address/)) {
    add(
      "block",
      "stake-no-pending-view",
      "Add pendingReward(address user) external view returns (uint256) so the UI can display accrued rewards."
    );
  }

  // Stake vault: emergencyWithdrawToken must not drain user staked tokens.
  if (has(/function\s+stake\s*\(/) && has(/totalStaked/) && has(/emergencyWithdrawToken/)) {
    const emergTok = extractFunctionChunks(source).find((f) => f.name === "emergencyWithdrawToken");
    if (
      emergTok &&
      /IERC20\s*\(\s*taxToken\s*\)|token\s*==\s*taxToken/.test(emergTok.body) &&
      !/totalStaked|staked|reserved/.test(emergTok.body)
    ) {
      add(
        "block",
        "emergency-withdraws-staked",
        "Override emergencyWithdrawToken for taxToken — withdraw only excess above totalStaked, never user stake principal."
      );
    }
  }

  // enter() on lottery/survivor should use nonReentrant when mutating entrant state.
  if (enterFn && has(/entrants\.push|hasEntered/) && !/nonReentrant/.test(enterFn.header)) {
    add(
      "block",
      "enter-no-nonreentrant",
      "enter() mutates entrant state — add nonReentrant to prevent reentrancy during entry."
    );
  }

  // Holder lottery: enter() should verify token balance when prompt implies holders-only.
  if (
    enterFn &&
    /holder|hold token|token holder/i.test(userPrompt) &&
    !/balanceOf\s*\(\s*msg\.sender\s*\)/.test(enterFn.body)
  ) {
    add(
      "block",
      "holder-lottery-no-balance",
      "Holder lottery enter() must require(IERC20(taxToken).balanceOf(msg.sender) >= minimum) — verify the entrant holds tokens."
    );
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

  for (const detail of scanVaultLogic(source, userPrompt)) {
    add("block", "vault-logic", detail);
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

  try {
    // Build only the generated file's tree; the rest of the repo is cached.
    await execAsync(`"${FORGE}" build "${filePath}" 2>&1`, {
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
    const artifactPath = path.join(REPO_ROOT, "out", fileName, `${contractName}.json`);
    return { ok: true, errors: "", artifactPath, filePath };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const errors = (e.stdout || "") + (e.stderr || "") || e.message || "Unknown compile error";
    return { ok: false, errors: cleanForgeOutput(errors), artifactPath: "", filePath };
  }
}

function cleanForgeOutput(out: string): string {
  // Keep only Error/Warning lines + context, trim ansi noise.
  return out
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, 80)
    .join("\n");
}

export async function cleanupCodegen(): Promise<void> {
  if (existsSync(CODEGEN_DIR)) await rm(CODEGEN_DIR, { recursive: true, force: true });
}

async function readArtifact(artifactPath: string): Promise<{ abi: unknown[] | null; bytecodeSize: number | null }> {
  try {
    const raw = await readFile(artifactPath, "utf8");
    const json = JSON.parse(raw);
    const bytecode: string = json?.bytecode?.object ?? "";
    const size = bytecode.startsWith("0x") ? (bytecode.length - 2) / 2 : null;
    return { abi: json?.abi ?? null, bytecodeSize: size };
  } catch {
    return { abi: null, bytecodeSize: null };
  }
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

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
  | "fixing"
  | "fixing_spec"
  | "compiling"
  | "compile_failed"
  | "auditing"
  | "generating_tests"
  | "done"
  | "error";

export type CodegenEvent =
  | { type: "status"; phase: CodegenStatusPhase; attempt: number; message?: string }
  | { type: "code_reset"; attempt: number }
  | { type: "code_delta"; delta: string }
  | { type: "name"; contractName: string }
  | { type: "explanation"; text: string }
  | { type: "spec_audit"; audit: SpecAuditResult }
  | { type: "result"; result: CodegenResult }
  | { type: "error"; error: string };

async function aiGenerateJson(
  client: import("openai").default,
  model: string,
  messages: ChatMessage[]
): Promise<{ raw: string; contractName: string; code: string; explanation: string }> {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages,
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty AI response");
  const obj = JSON.parse(raw);
  return {
    raw,
    contractName: sanitizeName(String(obj.contractName ?? "GeneratedVault")),
    code: stripImports(String(obj.code ?? "")),
    explanation: String(obj.explanation ?? ""),
  };
}

async function aiGenerateStream(
  client: import("openai").default,
  model: string,
  messages: ChatMessage[],
  emit: (ev: CodegenEvent) => void,
  attempt: number
): Promise<{ raw: string; contractName: string; code: string; explanation: string }> {
  emit({ type: "code_reset", attempt });
  const stream = await client.chat.completions.create({
    model,
    temperature: 0.2,
    stream: true,
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

/** Unified pipeline: compile → safety → tests → audit → fix until spec !== fail or budget exhausted. */
async function runCodegenPipeline(opts: {
  client: import("openai").default;
  model: string;
  apiKey: string;
  userPrompt: string;
  systemPrompt: string;
  stream: boolean;
  emit?: (ev: CodegenEvent) => void;
  seedMessages?: ChatMessage[];
  scanPrompt?: string;
}): Promise<Omit<CodegenResult, "mode">> {
  const { client, model, apiKey, userPrompt, systemPrompt, stream, emit, seedMessages, scanPrompt } = opts;
  const safetyPrompt = scanPrompt ?? userPrompt;
  const messages: ChatMessage[] =
    seedMessages ??
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Write the vault contract for this idea:\n\n${userPrompt}` },
    ];

  const fixLog: FixLogEntry[] = [];
  let contractName = "GeneratedVault";
  let code = "";
  let explanation = "";
  let compileErrors = "";
  let ok = false;
  let artifactPath = "";
  let filePath = "";
  let attempts = 0;
  let integrationTestPath: string | null = null;
  let specAudit: SpecAuditResult = {
    level: "skipped",
    summary: "Not audited yet.",
    items: [],
    mode: "openai",
  };
  let safety = scanSafety("", "GeneratedVault", safetyPrompt);
  let abi: unknown[] | null = null;
  let bytecodeSize: number | null = null;
  let fullSource = "";
  let pendingFix: string | null = null;

  const status = (phase: CodegenStatusPhase, message?: string) => {
    emit?.({ type: "status", phase, attempt: attempts, message });
  };

  while (attempts < MAX_PIPELINE_ATTEMPTS) {
    if (pendingFix) {
      messages.push({ role: "user", content: pendingFix });
      pendingFix = null;
    }

    attempts++;
    status(attempts === 1 ? "writing" : "fixing");

    let lastAssistant: string;
    if (stream && emit) {
      const gen = await aiGenerateStream(client, model, messages, emit, attempts);
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

    emit?.({ type: "name", contractName });
    emit?.({ type: "explanation", text: explanation });

    status("compiling");
    const res = await compile(contractName, code);
    ok = res.ok;
    compileErrors = res.errors;
    artifactPath = res.artifactPath;
    filePath = res.filePath;

    if (!ok) {
      fixLog.push({ phase: "compile_fix", attempt: attempts, message: firstErrors(compileErrors) });
      status("compile_failed", firstErrors(compileErrors));
      messages.push({ role: "assistant", content: lastAssistant });
      pendingFix = stream ? compileFixPromptStream(compileErrors) : compileFixPrompt(compileErrors);
      continue;
    }

    safety = scanSafety(code, contractName, safetyPrompt);
    const blocking = safety.findings.filter((f) => f.level === "block");
    if (blocking.length > 0) {
      fixLog.push({
        phase: "safety_fix",
        attempt: attempts,
        rule: blocking.map((b) => b.rule).join(","),
        message: blocking[0]!.detail,
      });
      status("fixing", blocking.map((b) => b.rule).join(", "));
      messages.push({ role: "assistant", content: lastAssistant });
      pendingFix = stream ? safetyFixPromptStream(blocking) : safetyFixPrompt(blocking);
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
    ({ abi, bytecodeSize } = await readArtifact(artifactPath));

    status("generating_tests", "Writing integration test (Rule 006)…");
    const tr = await generateIntegrationTest(contractName, artifactPath, fullSource, apiKey, model);
    if (tr.ok) {
      integrationTestPath = tr.path;
      fixLog.push({ phase: "generating_tests", attempt: attempts, message: tr.path });
    } else {
      fixLog.push({ phase: "generating_tests", attempt: attempts, message: tr.errors.slice(0, 160) });
    }

    status("auditing", "Flap pre-audit (spec checker)…");
    specAudit = await runSpecAudit(fullSource, contractName, apiKey, model, {
      compiled: true,
      safetyFindings: safety.findings,
    });
    emit?.({ type: "spec_audit", audit: specAudit });
    fixLog.push({ phase: "auditing", attempt: attempts, message: `spec: ${specAudit.level}` });

    if (specAudit.level !== "fail") break;

    const fixable = specCodegenFixableItems(specAudit.items);
    if (fixable.length === 0) break;

    fixLog.push({
      phase: "spec_fix",
      attempt: attempts,
      rule: fixable.map((f) => f.id).join(","),
      message: fixable.map((f) => f.title).join("; "),
    });
    status("fixing_spec", fixable.map((f) => f.id).join(", "));
    messages.push({ role: "assistant", content: lastAssistant });
    pendingFix = stream ? specFixPromptStream(fixable) : specFixPrompt(fixable);
  }

  if (!fullSource && code) fullSource = `${PREAMBLE}\n${code.trim()}\n`;

  const remainingFails = specCodegenFixableItems(specAudit.items);
  const autoFixExhausted =
    specAudit.level === "fail" && (attempts >= MAX_PIPELINE_ATTEMPTS || remainingFails.length === 0);

  return {
    contractName,
    explanation,
    source: fullSource,
    compiled: ok,
    compileErrors,
    safety,
    specAudit,
    abi,
    bytecodeSize,
    attempts,
    integrationTestPath,
    fixLog,
    autoFixExhausted,
  };
}

// ── Public: generate a vault with compile-and-fix loop ──────────────────────
export async function generateVaultCode(
  prompt: string,
  apiKey: string | undefined,
  model: string
): Promise<CodegenResult> {
  if (!apiKey) {
    return stubResult(prompt);
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const result = await runCodegenPipeline({
    client,
    model,
    apiKey,
    userPrompt: prompt,
    systemPrompt: CODEGEN_SYSTEM_PROMPT,
    stream: false,
  });

  await cleanupCodegen();

  return { ...result, mode: "openai" };
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
  emit: (ev: CodegenEvent) => void
): Promise<void> {
  if (!apiKey) {
    const stub = stubResult(prompt);
    emit({ type: "status", phase: "error", attempt: 0, message: "OPENAI_API_KEY not set" });
    emit({ type: "result", result: stub });
    return;
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  try {
    const result = await runCodegenPipeline({
      client,
      model,
      apiKey,
      userPrompt: prompt,
      systemPrompt: STREAM_SYSTEM_PROMPT,
      stream: true,
      emit,
    });

    await cleanupCodegen();

    const full: CodegenResult = { ...result, mode: "openai" };
    emit({
      type: "status",
      phase: full.compiled && full.specAudit.level !== "fail" ? "done" : "error",
      attempt: full.attempts,
      message:
        full.autoFixExhausted && full.specAudit.level === "fail"
          ? "Auto-fix exhausted — spec still has FAIL items."
          : undefined,
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
    emit({ type: "status", phase: "error", attempt: 0, message: "OPENAI_API_KEY not set" });
    emit({ type: "error", error: "OPENAI_API_KEY not set" });
    return;
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const scanPrompt = `${session.initialPrompt}\n${message}`;
  const seedMessages = buildRefineSeedMessages(session, message, REFINE_STREAM_SYSTEM_PROMPT);

  try {
    emit({ type: "status", phase: "writing", attempt: 0, message: "Applying your refinement…" });

    const result = await runCodegenPipeline({
      client,
      model,
      apiKey,
      userPrompt: session.initialPrompt,
      systemPrompt: REFINE_STREAM_SYSTEM_PROMPT,
      stream: true,
      emit,
      seedMessages,
      scanPrompt,
    });

    await cleanupCodegen();

    const full: CodegenResult = { ...result, mode: "openai" };
    emit({
      type: "status",
      phase: full.compiled && full.specAudit.level !== "fail" ? "done" : "error",
      attempt: full.attempts,
      message:
        full.autoFixExhausted && full.specAudit.level === "fail"
          ? "Auto-fix exhausted — spec still has FAIL items."
          : undefined,
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

function safetyFixPrompt(blocking: SafetyFinding[]): string {
  const list = blocking.map((f) => `- [${f.rule}] ${f.detail}`).join("\n");
  const missingState = blocking
    .filter((f) => f.rule === "public-state-not-in-uischema")
    .map((f) => f.detail)
    .join("\n");
  const uischemaHint = missingState
    ? `\nFor public-state-not-in-uischema: add a vaultUISchema view method for EACH variable listed above. Copy an existing view method entry and change name/outputs. Count methods array size correctly.\n${missingState}\n`
    : "";
  return `The contract compiles, but a Flap-spec safety scan found BLOCKING issues that make it unsafe or not production-ready. Fix every one and return the corrected JSON (same shape, no imports/pragma).

Quality bar reminders:
- require(cond, unicode"English / 中文") on every revert
- vaultUISchema: EVERY method needs inputs, outputs, approvals arrays (empty if none)
- Include view methods for public state (buybackBudget, treasury, etc.)
- nonReentrant on all payout/swap functions; require(to != address(0)) on recipient payouts
- Emit events for state changes; no silent try/catch
- Lottery: no weekly timer on enter(); lastDrawTime = block.timestamp in constructor; MAX_ENTRANTS cap
- Random outcomes: FlapAIConsumerBase only — never block.prevrandao / drawWinner() with on-chain entropy
- Wording: "external AI provider selection" for AI draws — never "secure random" without VRF/proof
- Staking: pendingRewards when totalStaked==0; pendingReward(address) view; no hidden auto-pay in updateUserReward
- Bucket vaults: excess-only emergencyWithdrawNative (never drain reserved buckets)
- AI async: clear lastDrawFee after fulfill; delete drawSnapshot on refund; require(n <= 255) before uint8 cast
- enter() nonReentrant; hasEntered reset when round ends
- BuybackExecuted(uint256 bnbIn, uint256 tokensBought) — name event fields to match emit values
${uischemaHint}
Blocking issues:

${list}`;
}

function compileFixPromptStream(errors: string): string {
  return `That failed to compile with solc 0.8.26. Fix ALL errors and re-output in the SAME plain-text format (CONTRACT_NAME / EXPLANATION / SOLIDITY). No imports/pragma.

ApproveAction("taxToken", "amount") only — pure vaultUISchema cannot reference taxToken variable. FieldDescriptor uses positional args.

Errors:

${errors}`;
}

function safetyFixPromptStream(blocking: SafetyFinding[]): string {
  const list = blocking.map((f) => `- [${f.rule}] ${f.detail}`).join("\n");
  return `It compiles, but a Flap-spec safety scan found BLOCKING issues. Fix every one and re-output in the SAME plain-text format (CONTRACT_NAME / EXPLANATION / SOLIDITY). No imports/pragma.

Quality bar: unicode bilingual requires; complete vaultUISchema (inputs/outputs/approvals on every method); view methods for public state; nonReentrant on payouts; events on state changes; lottery timing only on requestDraw (not enter); MAX_ENTRANTS <= 255; bucket emergencyWithdrawNative override; FlapAIConsumerBase for all random winner/elimination picks (never prevrandao).

Blocking issues:

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
        return "Stub vault (set OPENAI_API_KEY to generate real custom logic)";
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
  const safety = scanSafety(body, contractName);
  return {
    contractName,
    explanation: `Stub for "${prompt.slice(0, 80)}" — set OPENAI_API_KEY for real AI codegen.`,
    source: `${PREAMBLE}\n${body}\n`,
    compiled: false,
    compileErrors: "OPENAI_API_KEY not set — returning a stub (not compiled). Set the key in server/.env.local for real codegen.",
    safety,
    specAudit: {
      level: "skipped",
      summary: "Pre-audit requires OPENAI_API_KEY and a successful compile.",
      items: [],
      mode: "skipped",
    },
    abi: null,
    bytecodeSize: null,
    attempts: 0,
    integrationTestPath: null,
    fixLog: [],
    autoFixExhausted: false,
    mode: "stub",
  };
}
