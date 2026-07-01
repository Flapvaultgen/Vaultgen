# Phase 0 Audit — Template Leakage + Cursor/v0 Architecture Plan

**Status:** Diagnosis only. No code changed. No templates added. No archetypes added.

**Question answered:** Where does the current codebase behave like a template/archetype system instead of a rule-constrained custom generator?

---

## 1. Executive summary

The codebase is **two systems layered on top of each other**:

1. **A rule-constrained generator (the good half).** Flap Rules 001–009 are enforced through generic mechanisms: cheap `receive()`, bucket solvency, schema↔function symmetry, bilingual requires, AI-oracle-only randomness, fork tests, emergency controls. The spec audit (`spec-audit.ts`) is almost fully generic — it loads the 9 rule markdown files and audits arbitrary source against them.

2. **A six-kind template system (the leakage).** A fixed `VaultKind` enum (`staking_rewards | ai_lottery | survivor_elimination | buyback | treasury | hybrid`) is threaded through **every stage**: classification → system prompt → generation message ("Vault kind: X. Commit to the VaultPlan invariants") → scanners gated by `isStakingPlan`/`isLotteryPlan` → auto-patches that rewrite code into known shapes (50/50 `buybackBudget`/`weeklyJackpot` split) → per-kind test scaffolds → per-kind repair prompts. The system prompt (`CODEGEN_RULES`, ~400 of its lines) embeds full reference implementations for staking, AI lottery, and survivor vaults, plus a hardcoded vocabulary of bucket/method names (`jackpot`, `executeBuyback`, `accRewardPerShare`, `drawSnapshot`, …).

**Net effect:** a prompt that matches the taxonomy gets high-quality output; a prompt that doesn't gets **silently coerced** into the nearest archetype (the SATO incident) or routed to `hybrid` where scanner coverage is thinner. The opening prompt claim "not limited to a fixed menu" is contradicted by the rest of the pipeline.

**Severity ranking by file:**

| File | Leakage severity |
|---|---|
| `server/codegen.ts` (prompts, scanners, patches, fix prompts) | **Critical** |
| `server/vault-plan.ts` (kind enum, keyword routing, per-kind invariants) | **Critical** |
| `server/test-gen.ts` (per-kind test scaffolds + kind hints to LLM) | **High** |
| `server/mechanic-completeness.ts` (prompt-keyword gates, milestone/register vocabulary) | **High** |
| Selfcheck fixtures (staking/lottery dominated) | **Medium** |
| `web/src/CodegenStudio.tsx` (example prompts = 4 archetypes) | **Low–Medium** |
| `server/spec-audit.ts` | **Low** (one policy downgrade uses buyback/draw vocabulary) |
| `web/src/lib/deploy-gate.ts`, `LaunchOnFlapPanel.tsx`, `src/CodegenVaultFactory.sol`, `src/flap/*` | **Clean** (generic / protocol layer) |

---

## 2. Current architecture map

```
User prompt
  → [A] classifyVaultScope        (vault-plan.ts)        — capability check
  → [B] classifyVaultPlan         (vault-plan.ts)        — SIX-KIND classification
  → [C] expandMechanicDesign      (vault-plan.ts)        — lifecycle design (novel/hybrid only)
  → [D] resolveSystemPrompt       (codegen.ts 644–648)   — CODEGEN_RULES + VaultPlan appendix
  → [E] AI draft                  (codegen.ts)           — "Vault kind: X. Commit to invariants"
  → [F] applyCommonCodegenPatches (codegen.ts 921–947)   — deterministic rewrites
  → [G] forge compile             (codegen.ts)           — Foundry, solc 0.8.26
  → [H] scanSafetyCombined        (codegen.ts 2337+)     — child + full source scanners
  → [I] scanMechanicCompleteness  (mechanic-completeness.ts)
  → [J] generateIntegrationTest   (test-gen.ts)          — fork test gen + run
  → [K] runSpecAudit              (spec-audit.ts)        — advisory 9-rule LLM audit
  → [L] repair loop               (codegen.ts)           — safety/test/compile fix prompts
  → [M] deploy gate               (web deploy-gate.ts)   — compiled + safety + tests
  → [N] launch                    (LaunchOnFlapPanel)    — factory → register → Flap
```

### Classification per step

| Step | Verdict | Notes |
|---|---|---|
| A. Scope check | **Generic-ish, keyword-seeded** | Honest capability signal (recent). Heuristic regexes (`satokey`, `dual token`) are keyword-based but the LLM refinement is grounded in runtime facts. Scope *categories* need the Phase-0 target model (§7) |
| B. Kind classification | **Template-like (BAD)** | Forces every idea into 6 kinds; LLM prompt lists the 6 and keyword fallback regex-routes |
| C. Mechanic design | **Generic in shape, gated badly** | The `MechanicDesign` lifecycle contract is the *right idea* — but it only runs for "novel" prompts detected by **keyword regex** (`milestone|register|epoch|tier|…`) |
| D–E. Prompting | **Mixed** | ~50% generic Flap rules (GOOD), ~400 lines of staking/lottery/survivor reference implementations + kind→shape bullet map (BAD) |
| F. Auto-patches | **Template-like (BAD)** | `patchReceiveBuybackBuckets` injects a hardcoded 50/50 `buybackBudget`/`weeklyJackpot` split |
| G. Compile | **Safe and necessary** | Real Foundry compile |
| H. Safety scanners | **Mixed** | Rule-derived core (receive gas, block entropy, balance-based payout, custom errors, trigger/AI auth) is GOOD; large blocks are gated by `isStake`/`isLottery`/`isSurvivor` detection |
| I. Mechanic completeness | **Mixed** | Schema↔function symmetry, claim-credit pairing, refund-double are GOOD generic; register/milestone/pool scanners and prompt-keyword gating are BAD |
| J. Test generation | **Template-like (BAD)** | `mechanicInvariantTests` branches on `vaultPlan.kind`; AI prompt gets `kindHint`. Only the buy+dispatch smoke path is generic |
| K. Spec audit | **Generic (GOOD)** | 9-rule corpus loaded from markdown; safety-finding→rule mapping is by scanner-rule-name, not kind |
| L. Repair prompts | **Template-like (BAD)** | `surgicalSafetyFixPrompt` is a per-kind rewrite checklist ("Vault kind: X" + lottery/staking/buyback numbered fixes) |
| M. Deploy gate | **Generic (GOOD)** | compiled + safety≠fail + tests passed. No kind logic |
| N. Launch flow | **Generic (GOOD)** | Bytecode registration + CREATE2; factory is kind-agnostic by design |

---

## 3. Template/archetype leakage points (exact locations)

### 3.1 `server/vault-plan.ts` — the taxonomy root

| Location | What | Why it limits Cursor/v0 generation |
|---|---|---|
| `VaultKind` type (L3–9) | Fixed 6-kind enum | Everything downstream keys on it; a 7th idea has no home except `hybrid` |
| `inferVaultPlanFromPrompt` (L110+) | Keyword regex routing (`stake|lottery|survivor|buyback|milestone`) | Prompt words, not mechanics, pick the product shape |
| `KIND_INVARIANTS` (L58–94) | Per-kind invariant lists | Content is mostly good rules, but keyed by kind instead of by *detected structure* |
| `classifyVaultPlan` LLM prompt (L296–323) | "Classify … into a VaultPlan JSON … kind: staking_rewards\|ai_lottery\|…" + routing rules ("AI lottery → ai_lottery") | Tells the model to choose from a small set — the exact anti-pattern |
| `expandMechanicDesign` gate (L210) | `if (!isNovelMechanicPrompt(prompt) && plan.kind !== "hybrid") return plan` | The best generic step (lifecycle design) is **skipped** for anything that keyword-matched a known kind |
| Per-kind bucket/view defaults (L138–162) | `jackpot`, `buybackBudget`, `undistributedRewards` defaults per kind | Hardcodes the naming vocabulary |

### 3.2 `server/codegen.ts` — prompts, scanners, patches, fix prompts

(Line numbers from full-file audit.)

| Location | What | Verdict |
|---|---|---|
| `CODEGEN_RULES` L253–257 | Bullet map: "staking → stake/unstake/claim…; lottery/raffle → address[] entrants…; buyback → _buyAndBurn" | **BAD** — explicit kind→shape router inside the system prompt |
| L311–332 | "STAKING (accRewardPerShare) — reference pattern **the scanner enforces**" | **BAD** — a reference contract with enforcement teeth |
| L370–391 | LOTTERY/RAFFLE + TIME-GATED templates (`enter()`, `MAX_ENTRANTS`, `requestDraw`, `timeUntilDraw`) | **BAD** |
| L416–487 | R1: full ~70-line AI-lottery reference implementation | **BAD** — largest single archetype block |
| L518–558 | R5: full survivor/elimination reference flow | **BAD** |
| L566–597 | `vaultUISchema()` example built around `buybackBudget`/`executeBuyback`/`stake` | **BAD** — teaches 3 fixed methods |
| L644–648 `resolveSystemPrompt` | Always appends VaultPlan JSON + kind invariants | **BAD** — kind reaches every generation |
| L2687 pipeline user message | "Vault kind: ${vaultPlan.kind}. Commit to the VaultPlan invariants before writing code." | **BAD** — the model is ordered to be an archetype |
| `patchReceiveBuybackBuckets` L808–869 | Rewrites `receive()` into hardcoded 50/50 `burnShare`/`jackpotShare` with `weeklyJackpot` default | **BAD** — silently reshapes code into a weekly-burn-lottery hybrid |
| `patchAiLotteryDisclosure` L905–914 | Injects lottery disclosure text | **BAD** (lottery-only) |
| `scanVaultLogic` gates L1002–1011 | `isStake`/`isBuyback`/`isLottery` from **plan kind + prompt keywords + source** | **BAD gating** (even where the checks themselves are valid) |
| `scanSafety` L1420–2258 (multiple blocks) | Lottery enter/draw, survivor snapshot, staking accRewardPerShare, buyback-split scanners keyed to fixed names | **Mixed** — bug classes real, vocabulary fixed |
| L1386 fix message | "Use stake + accRewardPerShare, fixed pools, or AI oracle winner selection" | **BAD** — encodes 3 allowed fairness archetypes for Rule 003 |
| `surgicalSafetyFixPrompt` L3321–3348 | "Vault kind: X" + numbered per-kind fixes (`jackpot`, `rewardDebt`, `survivors==1`, `buybackBudget`/`weeklyJackpot`) | **BAD** — per-kind rewrite checklist |
| `safetyFixPrompt`/`testFixPrompt` L3215–3310 | "repairing a generated ${kind} vault… entire ${kind} lifecycle" | **BAD** |
| `buildFailureMemoryJson` L3196–3213 | Embeds `vaultKind` + `getVaultKindInvariants` | **BAD** |
| `humanStatusMessage` L2545 | "Classifying vault mechanic and building invariant plan…" | **Low** — UI copy implies taxonomy |
| `stubResult` L3358–3413 | Generic treasury stub, but still calls `inferVaultPlanFromPrompt` | **Low** |

### 3.3 `server/mechanic-completeness.ts`

| Location | What | Verdict |
|---|---|---|
| `isNovelMechanicPrompt` L332–339 | **Prompt-keyword** gate (`milestone|register interest|epoch|tier|badge|referral|vote|gauge|campaign|quest`) decides whether extended scanners run | **BAD** — prompt words, not source structure |
| `isMechanismTrigger` L25–29 | Trigger vocabulary `Draw|Burn|Milestone|Buyback|Epoch|Round|Settle|Distribute|Payout` | **BAD** — misses novel trigger names |
| `scanWriteMethodsMissingFromSchema` L151 | `userFacing = register|claim|stake|enter|unstake` | **BAD** — misses `deposit`, `vote`, `submitQuest`, … |
| `scanRegistrationNeverConsumed`, `scanMilestoneIndexUnbounded`, `scanPoolErasedWithoutPayout`, `scanHalfImplementedRewardVault` | Register/milestone/reward-pool naming assumptions | **BAD** (valid bug classes, fixed vocabulary) |
| `scanMissingTimeUntilView` L242–274 | Time-gate heuristics tied to `DRAW_INTERVAL`/`weeklyDraw` names; suggests lottery countdown | **Mixed** |
| `scanClaimMappingsNeverCredited`, `scanSchemaMethodsNotImplemented`, `scanRefundDoublesBalance` | — | **GOOD generic** — keep as-is |

### 3.4 `server/test-gen.ts`

| Location | What | Verdict |
|---|---|---|
| `mechanicInvariantTests` L46–109 | `switch`-like branches per `vaultPlan.kind` producing staking/lottery/survivor/buyback test scaffolds | **BAD** |
| `invariantPromptForKind` L259–287 | Per-kind invariant bullet lists fed to the test-writing LLM | **BAD** |
| `kindHint` L316 | "Vault kind: ${kind}" in AI prompt | **BAD** |
| Fallback default L113 | `kind ?? "treasury"` | **BAD** |
| Buy-on-curve + dispatch smoke L176–183 | Universal Flap tax path | **GOOD** — the Rule 006 minimum, keep |
| `extractWriteMethods` L33–44 | Source-derived method surface | **GOOD** |

### 3.5 `server/spec-audit.ts` (mostly clean)

| Location | What | Verdict |
|---|---|---|
| Rule corpus loading, LLM audit, finding→rule mapping | — | **GOOD** — the model for how everything else should work |
| `applyCodegenAuditPolicies` L451–462 | Downgrades Rule 003 for "keeper-only buyback/treasury/draw" | **BAD (minor)** — assumes those families are inherently fair |
| `specFixPrompt` L414–417 | Fix examples name accRewardPerShare/jackpot/AI oracle | **Mixed** — illustrative only |

### 3.6 Web UI

| Location | What | Verdict |
|---|---|---|
| `CodegenStudio.tsx` L37–41 `EXAMPLES` | 4 example prompts = stake / top-holders airdrop / dividend / burn lottery | **Medium** — teaches users the menu |
| Textarea placeholder L461 | "holders stake tokens…weekly AI draw…" | **Low** |
| `CodegenChatPanel.tsx` L118 placeholder | "add unstake cooldown, cap entrants at 255…" | **Low** |
| `deploy-gate.ts` | compiled + safety + tests | **Clean** |
| `LaunchOnFlapPanel.tsx` | bytecode register/launch, no kind logic | **Clean** |

### 3.7 Scope logic (recent `VaultScope`)

`classifyVaultScope` reasons about **runtime capability** (second token, own AMM, NFT, chart UI), *not* "no archetype exists" — this is the correct axis. Two gaps versus the target model (§7): categories don't distinguish `draft_only` from `launch_ready_possible`, and the pipeline still **silently approximates** out-of-scope ideas (banner shows, but generation proceeds into the nearest tax-vault shape without an explicit user decision).

### 3.8 Contracts & docs (clean layer)

- `src/CodegenVaultFactory.sol` — deploys arbitrary registered bytecode; kind-agnostic. **GOOD.**
- `src/flap/VaultBaseV2.sol`, `IVaultSchemasV1.sol` — protocol interfaces; the schema system was explicitly designed for "vault types that did not exist when the UI was built". **GOOD.**
- `docs/CODEGEN_STUDIO.md` — example prompts are the 4 archetypes; "Good prompts name: buyback, jackpot, treasury, stakers…" biases users toward the menu. **Low-severity copy leakage.**

---

## 4. Good constraints vs bad constraints

### Good fixed constraints (keep — this is the constitution)

| Constraint | Where enforced | Rule |
|---|---|---|
| `receive()` cheap: no swaps/loops/payouts/reverts; protocol is sender | prompt + `scanSafety` L1305–1320 | 001/005 |
| Pay from named buckets, never `address(this).balance` | prompt + scanner L1363–1371 | 001 |
| Bucket solvency (compute before zeroing; sum ≤ balance) | prompt L400–405 | 001 |
| No payout sized by live `balanceOf` (flash-loan gameable) | `usesBalanceBasedPayout` L1384 | 003 |
| Bilingual `require` strings; no custom errors | scanner L1864+, L1388 | 004 |
| Fork integration test exists and runs | test-gen + spec-audit Rule 006 check | 006 |
| Random outcomes via Flap AI Provider; no block entropy; snapshot before request; pull payouts from callbacks | scanner L1343–1361, generic AI lifecycle checks L1224–1241 | 007 |
| Trigger service auth pattern | scanner L1392–1409 | 008 |
| Emergency controls present + disclosed | base contract + scanner L1629–1656 | 009 |
| Schema↔function symmetry (every schema method exists; every user write in schema) | `scanSchemaMethodsNotImplemented` + prompt | UI integrity |
| Claim mappings must be credited somewhere before claim reads them | `scanClaimMappingsNeverCredited` | generic lifecycle |
| No selfdestruct/delegatecall/tx.origin/stubs/TODO | scanner L1287–1290, L1410 | safety |
| Inherit `CodegenVaultBase` / comply with `VaultBaseV2` + factory constructor signature | PREAMBLE + factory | 002 |
| Keeper-input pattern for data not on chain (top-N holders etc.) | prompt L281–287 | honesty |
| Deploy gate: compile + safety + fork tests | `deploy-gate.ts` | launch requirement |

### Bad product constraints (remove/replace)

| Constraint | Where | Replacement direction |
|---|---|---|
| Must classify into 6 `VaultKind`s | `vault-plan.ts` + pipeline | Mechanic spec for **every** prompt (see §6); kinds become optional soft hints at most |
| Keyword → kind routing | `inferVaultPlanFromPrompt`, scanner gates, `isNovelMechanicPrompt` | Trigger checks by **detected source structure** (e.g. "has `FlapAIConsumerBase`", "has claimable mapping", "has time constant + timestamp state") |
| Reference implementations in prompt (staking/lottery/survivor, ~400 lines) | `CODEGEN_RULES` | Rule-level guidance ("IF random outcome THEN oracle+snapshot+pull") without full contracts; neutral schema example |
| "Vault kind: X. Commit to invariants" generation message | pipeline L2687 | "Here is your mechanic spec. Implement it under Rules 001–009" |
| Per-kind repair checklists | `surgicalSafetyFixPrompt`, `safetyFixPrompt`, `testFixPrompt` | Rule-ID-keyed fixes derived from the actual finding |
| Hardcoded 50/50 buyback/jackpot rewrite | `patchReceiveBuybackBuckets` | Only enforce Rule 005 (move the swap out); never invent buckets/splits |
| Per-kind test scaffolds + `kindHint` | `test-gen.ts` | Journeys derived from mechanic spec + extracted write methods |
| Fixed trigger/user-action vocabulary | `isMechanismTrigger`, `userFacing` regex | "Any external non-view write not in SKIP list must be in schema" |
| Rule 003 downgrade for buyback/treasury/draw families | `spec-audit.ts` L451–462 | Downgrade only on structural evidence (no user-payout path), not family names |
| UI examples/copy = 4 archetypes | `CodegenStudio.tsx`, docs | Mix in novel-mechanic examples; copy says "describe any mechanic" |
| Silent approximation of out-of-scope ideas | pipeline (scope is advisory only) | Explicit fork: user confirms "build closest Flap-compatible version" vs "keep as draft/spec" |

---

## 5. Target architecture (Cursor/v0-style)

```
User prompt
  → AI PRODUCT PLANNER
      produces MechanicSpec (§6) for EVERY prompt — no kind gate
  → FLAP CONSTITUTION ANALYSIS (Rules 001–009)
      per-rule applicability + compliance strategy, recorded IN the spec
      scope verdict (§7) — explicit user decision if not launch_ready_possible
  → [optional: user reviews/edits plan — chat step]
  → CUSTOM SOLIDITY GENERATION
      prompt = constitution (generic rules) + MechanicSpec
      NO reference archetype contracts; neutral examples only
  → SCHEMA GENERATION + VALIDATION
      vaultUISchema derived from spec.uiMethods; symmetry-checked vs source
  → RULE-DERIVED SCANNERS
      constitution checks (always) + spec-derived checks
      ("spec says users claim → verify a credit path exists")
      structure-triggered checks (FlapAIConsumerBase present → oracle lifecycle checks)
  → AI-GENERATED FOUNDRY JOURNEYS
      test scenarios come from spec.testScenarios + extracted write methods
      generic minimum stays: deploy + buy-on-curve + dispatch + receive smoke
  → FORK SIMULATION PREVIEW
      run journeys on mainnet fork; show results as a report before launch
  → REPAIR LOOP
      failure memory keyed by RULE IDs + spec items, never vault kind
  → LAUNCH GATE (unchanged): compile + scanners + fork tests + user click
```

**Hardcoded layer after migration:** Rules 001–009 corpus, Flap interfaces (`VaultBaseV2`, schema structs, factory constructor ABI), `CodegenVaultBase` preamble, deploy/launch gates. **Nothing else.**

Note the pipeline stages themselves barely move — the migration is about **what flows between them** (MechanicSpec instead of `VaultKind`) and **what triggers checks** (source structure + spec, instead of prompt keywords + kind).

---

## 6. Proposed generic MechanicSpec format

```typescript
type MechanicSpec = {
  // identity
  productSummary: string;            // one paragraph, user-confirmable
  contractName: string;

  // actors & flows
  actors: { role: "holder" | "manager" | "keeper" | "oracle" | "protocol"; description: string }[];
  fundsIn: { source: "tax_bnb" | "user_bnb" | "user_token"; notes: string }[];

  // accounting
  buckets: { name: string; asset: "BNB" | "taxToken"; creditedBy: string[]; debitedBy: string[] }[];

  // actions (each action = complete lifecycle edge)
  userActions:    ActionSpec[];      // enter/stake/claim/vote/…, free-form names
  managerActions: ActionSpec[];      // triggers, keeper inputs
  scheduledActions: { action: string; interval: string; via: "trigger_service" | "manager" }[];
  oracleActions:  { request: string; callback: string; refundPath: string }[] | null;

  // payout & fairness
  payoutRules: { trigger: string; source: string /* bucket */; recipients: string; mode: "pull" | "push_manager_only" }[];
  fairnessModel: string;             // how Rule 003 is satisfied (snapshot/stake/fixed pool/oracle)

  // safety
  emergencyControls: string;         // Rule 009 approach + disclosure text
  trustAssumptions: string[];        // keeper honesty, oracle latency, manager powers

  // UI
  uiMethods:  { name: string; kind: "view" | "write"; inputs: FieldSketch[]; outputs: FieldSketch[]; description: string }[];
  viewMethods: string[];             // every public state the panel should surface

  // constitution
  ruleAnalysis: Record<"001"|"002"|"003"|"004"|"005"|"006"|"007"|"008"|"009",
    { applies: boolean; strategy: string }>;
  launchCompatibility: { scope: ScopeVerdict /* §7 */; notes: string[] };

  // verification
  testScenarios: { name: string; steps: string[]; expect: string }[];
  invariants: string[];              // e.g. "sum(buckets) ≤ balance", "claimable credited before claim"
};

type ActionSpec = {
  name: string;                      // free-form — NOT from a fixed vocabulary
  caller: "holder" | "manager" | "keeper" | "oracle";
  preconditions: string[];
  effects: string[];                 // which buckets/mappings change
  schemaExposed: boolean;
  events: string[];
};
```

Key properties:

- **Free-form action names** — no `register|claim|stake` vocabulary requirement.
- **Every prompt gets a spec** — replaces both `classifyVaultPlan` and the keyword-gated `expandMechanicDesign`.
- **Rule analysis lives in the spec** — scanners and test-gen consume it instead of `vaultPlan.kind`.
- **Test scenarios and invariants are spec-derived** — replaces `invariantPromptForKind`.
- The existing `MechanicDesign` type is the embryo of this; the spec generalizes it and makes it unconditional.

---

## 7. Proposed scope model

Replace "does this fit an archetype?" with capability questions:

1. Expressible as a Flap-compatible vault under Rules 001–009?
2. Renderable on the standard Flap panel (`vaultUISchema` = methods/fields/countdowns)?
3. Requires custom UI?
4. Requires non-Flap primitives (second token, AMM, NFT, external market, backend service)?
5. Can we still produce a useful draft/spec even if not launch-ready?

```typescript
type ScopeVerdict =
  | "launch_ready_possible"   // full product on standard panel; pipeline can go green
  | "draft_only"              // mechanic compiles/validates but something (e.g. untestable oracle path,
                              //   keeper trust) means human review before launch is mandatory
  | "needs_custom_ui"         // contract fine; standard panel can't render the experience
  | "needs_protocol_extension"// second token / AMM / NFT / off-chain service — different runtime
  | "unsafe_or_unsupported";  // violates a constitution rule with no compliant strategy
```

**Behavioral contract (the anti-silent-approximation rule):** when verdict ≠ `launch_ready_possible`, the studio must (a) show the verdict + reasons, (b) **ask** whether to build the closest Flap-compatible version or stop at the spec/draft, and (c) if approximating, list exactly what was dropped from the user's idea. Never generate the approximation silently.

Mapping from the current `VaultScopeFit`: `native → launch_ready_possible`, `approximate/custom_ui → needs_custom_ui` (with draft option), `out_of_scope → needs_protocol_extension`; `draft_only` and `unsafe_or_unsupported` are new.

---

## 8. Phased implementation roadmap

### Phase 1 — Flap Rules 001–009 constitution module

- **Goal:** One canonical, machine-consumable constitution: rule IDs, per-rule prompt guidance, per-rule scanner mappings, per-rule fix guidance. Everything (prompts, scanners, fix prompts, spec audit) reads from it instead of embedding rule text ad hoc.
- **Files:** new `server/constitution.ts`; wire into `codegen.ts` (prompt assembly, `buildFailureMemoryJson`), `spec-audit.ts` (already reads the corpus — align IDs).
- **Non-goals:** removing VaultKind; changing scanners' logic; touching UI.
- **Acceptance:** system prompt rule sections generated from the module; `safetyFixPrompt` cites rule IDs from it; no behavior change on existing green paths.
- **Tests:** `npm run test:scanners` unchanged-green; `verify-codegen.mts` 3-vault run passes; diff of assembled system prompt reviewed manually.

### Phase 2 — Plan-first MechanicSpec

- **Goal:** Every prompt produces a `MechanicSpec` (§6). It replaces `classifyVaultPlan` + keyword-gated `expandMechanicDesign` as the object threaded through the pipeline. `VaultKind` may survive internally as a derived hint but nothing *requires* it.
- **Files:** `server/vault-plan.ts` (spec type + planner), `server/codegen.ts` (thread spec; generation message becomes "implement this spec under the constitution"), `web/src/lib/codegen.ts` (result carries spec).
- **Non-goals:** UI plan-approval step (later); scanner rewrites; test-gen rewrites.
- **Acceptance:** the string `"Vault kind:"` no longer appears in generation messages; a novel prompt (e.g. "gauge-vote vault: holders vote weekly on which of 3 charity wallets gets the treasury bucket") produces a spec with correct actions/buckets without touching `hybrid` heuristics.
- **Tests:** scanner selfchecks green; generate the 4 classic prompts + 3 novel prompts, verify compile + safety parity with pre-change baseline.

### Phase 3 — Generic codegen prompt from MechanicSpec

- **Goal:** Strip archetype reference implementations (staking L311–332, lottery R1 L416–487, survivor R5 L518–558, kind→shape bullets L253–257, buyback schema example L566–597) from `CODEGEN_RULES`; replace with constitution-derived conditional guidance ("IF spec has oracleActions THEN …") and a neutral schema example.
- **Files:** `server/codegen.ts` (CODEGEN_RULES, refine prompt).
- **Non-goals:** scanner changes (prompts and scanners must not change in the same phase — you need to know which one regressed).
- **Acceptance:** prompt contains zero full reference contracts; classic-4 prompts still reach deploy-ready at ≥ pre-change rate (measure attempts + pass rate over N=5 runs each).
- **Tests:** `verify-codegen.mts` + `verify-strong.mts` baselines compared before/after.

### Phase 4 — Rule-derived scanners + repair loop

- **Goal:** Re-gate every kind-gated scanner on **source structure** (has `FlapAIConsumerBase` → oracle lifecycle checks; has `accRewardPerShare` → accrual checks; has claimable mapping → credit-path check) and **spec content** (spec says users claim → claim path must exist). Replace `surgicalSafetyFixPrompt` per-kind checklist with rule-ID/finding-derived fixes. Neutralize `patchReceiveBuybackBuckets` (enforce Rule 005 only; never invent buckets). Broaden `isMechanismTrigger`/`userFacing` to "any external write not in SKIP list".
- **Files:** `server/codegen.ts` (scanVaultLogic/scanSafety gates, patches, fix prompts), `server/mechanic-completeness.ts`, selfcheck fixture additions.
- **Non-goals:** deleting any bug-class check (the staking/lottery checks are good — only their *triggers* change).
- **Acceptance:** all existing selfcheck fixtures still caught; ≥5 new novel-mechanic fixtures (vote, quest, referral, split, time-decay) added and caught/passed appropriately; no scanner references `vaultPlan.kind`.
- **Tests:** `npm run test:scanners` with expanded fixture set; false-positive check on the classic-4 generated sources.

### Phase 5 — Spec-derived Foundry journeys + fork simulation preview

- **Goal:** `test-gen.ts` builds journeys from `spec.testScenarios` + extracted write methods; delete `mechanicInvariantTests`/`invariantPromptForKind` kind branches (keep buy+dispatch smoke as the universal minimum). Surface fork-run results as a "simulation report" event the UI can render pre-launch.
- **Files:** `server/test-gen.ts`, `server/codegen.ts` (report event), `web/src/lib/codegen.ts` + a results panel.
- **Non-goals:** changing the deploy gate criteria.
- **Acceptance:** generated tests for a novel prompt exercise its actual write methods; simulation report lists scenario → pass/fail; classic-4 fork pass rate ≥ baseline.
- **Tests:** run full pipeline on classic-4 + 3 novel prompts against BSC fork; compare `integrationTestsPassed` rates.

### Phase 6 — Draft vs Launch UX + regression suite

- **Goal:** Implement the §7 scope model end-to-end: verdict shown pre-generation, explicit approximate-vs-draft user choice, "Draft" framing replaces "Not deployable yet" dead-ends. Neutralize UI copy/examples (mix novel mechanics into `EXAMPLES`). Stand up a permanent regression suite: N prompts (classic + novel + out-of-scope) with recorded expected scope/compile/safety outcomes, runnable in CI.
- **Files:** `web/src/CodegenStudio.tsx`, `web/src/lib/deploy-gate.ts` (copy only), `server/vault-plan.ts` (scope verdicts), new `server/regression/*.mts`, `docs/CODEGEN_STUDIO.md`.
- **Non-goals:** custom-UI track, bonding-curve runtime, second-token archetypes (explicitly out of Phase 0–6 scope).
- **Acceptance:** out-of-scope prompt requires explicit user choice before generation proceeds; regression suite green in CI; docs no longer imply a fixed menu.
- **Tests:** regression suite; manual UX pass on the three prompt classes.

---

## 9. Highest-risk files

| File | Risk | Why |
|---|---|---|
| `server/codegen.ts` | **Highest** | 3,400 lines mixing constitution, templates, scanners, patches, and fix prompts; every phase touches it; a prompt regression here silently degrades all output quality |
| `server/vault-plan.ts` | **High** | The taxonomy root; removing kinds ripples into scanners, test-gen, fix prompts, and result types consumed by the web app |
| `server/mechanic-completeness.ts` | **Medium-high** | Loosening keyword gates risks false positives on every generation (scanner blocks = pipeline failures) |
| `server/test-gen.ts` | **Medium** | Kind-branched fallbacks are the safety net when the LLM test fails to compile; replacing them badly breaks the deploy gate |
| Selfcheck fixtures | **Medium** | Current suite would stay green through a regression in novel-mechanic handling — coverage bias is itself a risk |
| `web/src/lib/codegen.ts` types | **Low-medium** | `CodegenResult.vaultPlan` shape is public API to the UI; spec migration must keep it compatible or version it |

---

## 10. Recommendation for Phase 1

**Start with the constitution module (`server/constitution.ts`).** Reasons:

1. **Zero behavior risk** — it reorganizes rule text that already exists (in `CODEGEN_RULES` prose, scanner messages, and `server/flap-spec-checker/rules/*.md`) into one consumable structure. Existing green paths must stay green, which makes it a safe first commit and a forcing function to enumerate exactly which prompt lines are "constitution" vs "template".
2. **It is the dependency of every later phase** — Phase 3 (prompt rebuild), Phase 4 (rule-derived scanners/fixes), and Phase 5 (rule-cited simulation reports) all need rule-keyed data.
3. **It produces the definitive good/bad line-item inventory** — building it forces classifying every line of `CODEGEN_RULES` (this audit's §3.2/§4 tables are the starting checklist).

**Concrete Phase 1 shape:** a module exporting, per rule ID 001–009: `promptGuidance` (generic, conditional on spec features), `scannerRules` (list of scanner rule-name strings that map to it — `spec-audit.ts` L188–194 already has this mapping, inverted), `fixGuidance`, and `corpusPath`. Then re-point `safetyFixPrompt`, `buildFailureMemoryJson`, and the prompt assembly at it, and diff the assembled system prompt against today's to confirm only structural (not semantic) change.

First measurable milestone: **`safetyFixPrompt` cites constitution rule IDs instead of "${vaultPlan.kind} vault", with all selfchecks and a 3-prompt `verify-codegen.mts` run green.**

---

*Phase 0 complete. No code changed. Stop point per brief.*
