/**
 * Flap Constitution — canonical machine-consumable metadata for Flap spec Rules 001–009.
 *
 * This module is the single source of truth for rule identity (IDs, slugs, titles),
 * generic prompt guidance, scanner-rule → Flap-rule mapping, and repair guidance.
 * It deliberately contains ONLY protocol/safety constraints ("the constitution") —
 * no vault archetypes, no reference implementations, no staking/lottery/buyback/
 * survivor templates. Vault-kind material lives elsewhere and is being phased out
 * (see docs/PHASE0_AUDIT.md).
 *
 * The full normative rule text remains the markdown corpus in
 * server/flap-spec-checker/rules/ (or .agents/skills/flap-vault-spec-checker/),
 * which spec-audit.ts feeds to the LLM verifier. This module carries the
 * structured metadata the rest of the pipeline needs without re-reading markdown.
 */

export type FlapRuleId =
  | "001"
  | "002"
  | "003"
  | "004"
  | "005"
  | "006"
  | "007"
  | "008"
  | "009";

export type FlapConstitutionRule = {
  id: FlapRuleId;
  /** Long id used by the spec-audit corpus and SpecCheckItem ids, e.g. "001-vault-rules". */
  slug: string;
  title: string;
  shortName: string;
  summary: string;
  /** Generic, mechanic-agnostic guidance injected into generation prompts. */
  promptGuidance: string[];
  /** Deterministic scanner rule names (scanSafety / scanVaultLogic / mechanic-completeness) that report under this rule. */
  scannerRuleNames: string[];
  /** Regexes matched against a scanner rule name to attribute findings to this rule (fallback for names not listed above). */
  scannerRulePatterns: RegExp[];
  /** Rule-ID-keyed repair guidance for fix prompts. Generic — never assumes a vault kind. */
  fixGuidance: string[];
  /** Relative corpus path (from server/) with the full normative text. */
  corpusPath: string;
};

const RULES: Record<FlapRuleId, FlapConstitutionRule> = {
  "001": {
    id: "001",
    slug: "001-vault-rules",
    title: "Vault rules",
    shortName: "vault-rules",
    summary:
      "Vault must inherit VaultBaseV2, implement description() and vaultUISchema(), account tax BNB into named buckets, and separate manager vs holder actions.",
    promptGuidance: [
      "Inherit the injected Flap base (VaultBaseV2 via CodegenVaultBase); implement description() and vaultUISchema().",
      "receive() is called by the Flap protocol with tax BNB — msg.sender is the PROTOCOL, never a holder. Never attribute deposits to msg.sender in receive().",
      "Split incoming tax into NAMED storage buckets. Every payout must come from a specific bucket — never send address(this).balance.",
      "Bucket solvency: compute a payout amount BEFORE zeroing its source; the sum of buckets must never exceed the contract balance.",
      "Separate permissions: privileged/mechanism functions use onlyManager; user actions are open functions where msg.sender IS the real user.",
      "Every meaningful state change emits an event.",
    ],
    scannerRuleNames: [
      "must-have-description",
      "must-have-uischema",
      "missing-events",
      "placeholder-code",
      "bucket-balance-desync",
      "buyback-burns-full-balance",
      "payout-no-recipient-check",
      "payout-no-nonreentrant",
      "no-selfdestruct",
      "no-delegatecall",
      "no-tx-origin",
      "deploys-contract",
      "assembly",
      "silent-empty-catch",
      "vault-logic",
      "claim-mapping-never-credited",
      "register-never-consumed",
      "participation-never-consumed",
      "pool-erased-no-payout",
      "half-implemented-reward-vault",
      "milestone-index-unbounded",
      "first-claimer-can-drain-shared-pool",
      "approval-without-reserved-liability",
      "multi-user-payout-without-per-user-accounting",
      "single-resource-multiple-acceptance",
      "accepted-user-can-become-stuck",
      "no-abandon-or-cancel-path",
      "inactive-resource-blocks-user-state",
      "shared-resource-deactivated-while-users-assigned",
      "manager-completion-without-assignee-check",
      "manager-finalization-without-timeout",
      "assignment-model-missing",
    ],
    scannerRulePatterns: [/bucket/, /payout/, /stake-/, /lottery-(?!.*wording)/, /survivor-/, /snapshot/, /pendingreward/],
    fixGuidance: [
      "Fix Rule 001: pay from a specific named bucket and zero it before sending — never pay address(this).balance.",
      "Fix Rule 001: every lifecycle path must be complete — if a claimable mapping exists, some function must credit it (+=) before claim reads it; remove dead register/claim paths instead of leaving them half-built.",
      "Fix Rule 001: guard privileged functions with onlyManager and keep user actions open; emit events for every state change.",
      "Fix Rule 001: never pay the ENTIRE value of a shared bucket to whichever eligible address claims first — reserve a per-user amount (claimableRewards[user] or equivalent) when eligibility is granted, unless the MechanicSpec explicitly declares winner-takes-all/single-winner-pool semantics.",
      "Fix Rule 001: do not let multiple users accept a single-assignee resource — set an assignee (or per-user assignment state) on accept and revert when the resource is already taken; use a status enum (Open/Assigned/Submitted/Completed/Cancelled) instead of one bool when the resource has multiple lifecycle states.",
      "Fix Rule 001: every assigned user must always have an exit — add an abandon function (assignee clears their own assignment before approval) and a manager cancel path for open/expired resources; never deactivate a shared resource in a way that traps other assigned users (clear or honor their assignment state).",
      "Fix Rule 001: reserve the reward into claimable[user] at approval time (decrement the funding bucket, increment the user's claimable balance) and verify the approved address is actually the assignee before crediting.",
    ],
    corpusPath: "flap-spec-checker/rules/001-vault-rules.md",
  },
  "002": {
    id: "002",
    slug: "002-vault-factory-rules",
    title: "Factory rules",
    shortName: "factory-rules",
    summary:
      "Factories must inherit VaultFactoryBaseV2; guardian roles must be granted at construction and never revocable by others. Generated vaults must keep the factory constructor ABI (taxToken, creator, factory).",
    promptGuidance: [
      "Keep the exact pass-through constructor signature constructor(address _taxToken, address _creator, address _factory) — CodegenVaultFactory appends these args to your creation bytecode at launch.",
      "Never deploy other contracts from the vault; deployment compatibility is the factory's job.",
    ],
    scannerRuleNames: ["must-extend-base", "contract-name"],
    scannerRulePatterns: [/factory/],
    fixGuidance: [
      "Fix Rule 002: restore the pass-through constructor (taxToken, creator, factory) exactly as the injected base declares it; do not add constructor params.",
    ],
    corpusPath: "flap-spec-checker/rules/002-vault-factory-rules.md",
  },
  "003": {
    id: "003",
    slug: "003-fairness-rule",
    title: "Fairness",
    shortName: "fairness",
    summary:
      "No privileged path may extract value at users' expense; no payout sized from live balanceOf (flash-loan/MEV gameable); sandwich exposure is a first-class risk.",
    promptGuidance: [
      "NEVER size a payout, dividend, or pro-rata share from a live IERC20.balanceOf() — it is flash-loan/MEV gameable. balanceOf may only gate eligibility (boolean minimum-hold check).",
      "Payout entitlements must come from state the user committed earlier (deposits, snapshots, fixed pools, or verified oracle outcomes).",
      "Privileged roles must not be able to pre-condition state (slippage, timing, routing) to sandwich or front-run users.",
    ],
    scannerRuleNames: [
      "balance-based-payout",
      "holder-lottery-no-balance",
      "claim-amount-from-global-bucket-without-winner-semantics",
      "hardcoded-economic-constant-without-spec",
      "reward-amount-not-specified",
    ],
    scannerRulePatterns: [/fairness/, /balance-based/, /sandwich/],
    fixGuidance: [
      "Fix Rule 003: replace any live-balance payout sizing with entitlement state committed before the payout event (user deposits, snapshots taken before outcomes, fixed pools, or oracle-verified results).",
      "Fix Rule 003: if balanceOf appears in a payout path, restrict it to a boolean eligibility gate only.",
      "Fix Rule 003: size every payout from a per-user reserved/credited amount, never from an undivided shared bucket, unless the MechanicSpec explicitly declares winner-takes-all/single-winner-pool semantics.",
      "Fix Rule 003: never invent a hardcoded reward constant the user did not choose — make the reward amount per-resource (set by the manager when posting) or derive it from an amount the MechanicSpec explicitly records.",
    ],
    corpusPath: "flap-spec-checker/rules/003-fairness-rule.md",
  },
  "004": {
    id: "004",
    slug: "004-ui-friendly-rules",
    title: "UI-friendly",
    shortName: "ui-friendly",
    summary:
      "No custom errors — every revert uses require() with a literal (bilingual EN/中文) string. The Flap UI cannot decode custom error selectors.",
    promptGuidance: [
      'Never define or use custom errors. Every revert must be require(cond, "literal string").',
      'Prefer bilingual messages: unicode"English message / 中文信息".',
      "Do not overclaim randomness security in user-facing text: AI-provider draws are 'external AI provider selection', never 'secure/verifiable random'.",
    ],
    scannerRuleNames: [
      "custom-error",
      "require-not-bilingual",
      "uischema-incomplete",
      "uischema-named-ctor",
      "uischema-view-in-methods",
      "approve-action-wrong-syntax",
      "schema-method-not-implemented",
      "write-method-not-in-uischema",
      "public-state-not-in-uischema",
      "missing-time-until-view",
      "time-until-not-in-uischema",
      "design-schema-method-missing",
      "oracle-callback-in-uischema",
      "event-only-user-action-without-trust-disclosure",
      "approval-not-linked-to-submitted-state",
      "manager-finalization-without-submission",
      "holder-wording-without-holder-check",
      "unbounded-array-return-in-ui-schema",
      "missing-user-status-view",
      "resource-state-not-queryable",
    ],
    scannerRulePatterns: [/ui/, /wording/, /bilingual/],
    fixGuidance: [
      'Fix Rule 004: replace every custom error with require(cond, unicode"English / 中文").',
      "Fix Rule 004: keep vaultUISchema() pure, use positional FieldDescriptor args, and describe randomness honestly (AI provider selection, not secure random).",
      "Fix Rule 004: if a user submission only emits an event, either store on-chain state the approval step can reference (e.g. a proof hash checked at approval time) or disclose in description()/vaultUISchema that review happens off-chain.",
      "Fix Rule 004: expose enough views for a non-coder to see their own state — a per-user assignment/status view, a per-user claimable-amount view, a per-id resource getter with a count view, and the funding bucket; label manager-only actions as manager-only in method descriptions.",
      "Fix Rule 004: never return unbounded dynamic arrays of structs (especially with strings) from schema-facing views — expose a count plus a per-id getter (or paginate) instead.",
      'Fix Rule 004: if the description says "holders", enforce holder eligibility in the code (e.g. a balanceOf(msg.sender) > 0 gate) or fix the wording.',
      "Fix Rule 004: if the spec requires users to submit work before approval, make the manager approval reference the stored submission (proof hash / submitted flag) — never approve unsubmitted work.",
    ],
    corpusPath: "flap-spec-checker/rules/004-ui-friendly-rules.md",
  },
  "005": {
    id: "005",
    slug: "005-receive-gas-limit",
    title: "Receive gas limit",
    shortName: "receive-gas",
    summary:
      "receive() must consume at most 1,000,000 gas on every path: cheap bucket accounting only — no swaps, external calls, transfers, loops, or payouts, and it must not revert on normal deposits.",
    promptGuidance: [
      "receive() external payable does CHEAP accounting only: split msg.value into named storage buckets and return.",
      "No external calls, swaps, token transfers, loops, or payouts anywhere in the receive() call tree (hard protocol cap: 1,000,000 gas).",
      "receive() must never revert on a normal deposit — return early on zero instead of require(msg.value > 0).",
      "Any swap/burn/payout runs in a SEPARATE user- or manager-called function that drains a bucket.",
    ],
    scannerRuleNames: [
      "must-have-receive",
      "receive-no-external-call",
      "receive-no-transfer",
      "receive-no-loop",
      "receive-reverts",
      "receive-msg-sender",
      "buyback-split-not-implemented",
    ],
    scannerRulePatterns: [/receive/, /gas/],
    fixGuidance: [
      "Fix Rule 005: receive() must be cheap — move every swap, transfer, loop, or payout out of receive() into a separate function that drains a named bucket; receive() only does `bucket += share` accounting.",
      "Fix Rule 005: remove reverts on normal deposits from receive(); return early when msg.value is zero.",
    ],
    corpusPath: "flap-spec-checker/rules/005-receive-gas-limit.md",
  },
  "006": {
    id: "006",
    slug: "006-integration-test-coverage",
    title: "Integration tests",
    shortName: "integration-tests",
    summary:
      "A Foundry mainnet-fork test suite must exercise all critical user-facing flows (deploy via factory, tax receive/dispatch, every core write, happy and revert paths).",
    promptGuidance: [
      "Every external write method must be exercisable on a mainnet fork: deploy via the factory, fund via a real tax dispatch, then call each user/manager flow.",
    ],
    scannerRuleNames: ["integration-test-failure", "integration-test-infra"],
    scannerRulePatterns: [/integration-test/, /fork-test/],
    fixGuidance: [
      "Fix Rule 006: make the vault logic pass its fork integration tests — fix the contract behavior the failing assertion describes, not the test file.",
    ],
    corpusPath: "flap-spec-checker/rules/006-integration-test-coverage.md",
  },
  "007": {
    id: "007",
    slug: "007-ai-oracle-integration",
    title: "AI oracle",
    shortName: "ai-oracle",
    summary:
      "Random or AI-decided outcomes must use IFlapAIProvider/FlapAIConsumerBase with authenticated callbacks, a frozen participant snapshot before the request, pull payouts from callbacks, and a refund path. Block entropy is forbidden for outcomes.",
    promptGuidance: [
      "ANY random or AI-decided outcome MUST use FlapAIConsumerBase (request → authenticated callback). block.prevrandao, blockhash, and block.timestamp modulo are FORBIDDEN for outcomes.",
      "Freeze/snapshot the eligible participant set BEFORE requesting the oracle so nobody can join after the outcome is knowable.",
      "Callbacks must only credit claimable state (pull payment) — never push native transfers to winners inside the callback.",
      "Track the request fee and lifecycle: clear pending request state on fulfill AND on refund; a refund must restore the escrowed amount exactly once (never double it).",
    ],
    scannerRuleNames: [
      "no-block-randomness",
      "block-difficulty",
      "ai-callback-no-auth",
      "wrong-ai-address",
      "draw-not-frozen",
      "draw-request-not-guarded",
      "uint8-cast-uncapped",
      "ai-draw-fee-not-tracked",
      "ai-lottery-push-payout",
      "pull-prize-event-in-fulfill",
      "refund-stale-snapshot",
      "refund-doubles-balance",
      "snapshot-not-populated",
      "snapshot-empty-loop",
      "ai-lottery-no-draw-requested",
      "ai-lottery-no-draw-refunded",
      "ai-lottery-no-model-event",
      "ai-lottery-no-draw-requested-emit",
      "ai-lottery-no-draw-refunded-emit",
      "ai-lottery-no-model-event-emit",
      "ai-lottery-no-provider-disclosure",
      "ai-lottery-guardian-undisclosed",
      "secure-random-overclaim",
      "ai-random-wording",
      "survivor-stale-snapshot-win",
    ],
    scannerRulePatterns: [/ai-/, /oracle/, /random/, /draw-/, /refund/, /fulfill/],
    fixGuidance: [
      "Fix Rule 007: route the outcome through FlapAIConsumerBase — snapshot participants before requesting, authenticate the callback, and remove every use of block entropy for outcomes.",
      "Fix Rule 007: in the fulfill/refund callbacks, only credit claimable state (pull payment), clear the pending request and fee exactly once, and restore escrowed funds on refund without doubling.",
    ],
    corpusPath: "flap-spec-checker/rules/007-ai-oracle-integration.md",
  },
  "008": {
    id: "008",
    slug: "008-trigger-service-integration",
    title: "Trigger service",
    shortName: "trigger-service",
    summary:
      "Scheduled/automated execution must integrate IFlapTriggerService/ITriggerReceiver with strict callback authorization and delay-aware logic.",
    promptGuidance: [
      "Scheduled or keeper-automated actions must use IFlapTriggerService/ITriggerReceiver; the trigger callback must verify msg.sender is the trigger service.",
      "Trigger-executed logic must be delay-aware: re-validate preconditions at execution time, not only at scheduling time.",
    ],
    scannerRuleNames: ["trigger-no-auth", "wrong-trigger-address"],
    scannerRulePatterns: [/trigger/],
    fixGuidance: [
      "Fix Rule 008: authenticate trigger callbacks (require msg.sender == trigger service) and re-check all preconditions inside the callback before acting.",
    ],
    corpusPath: "flap-spec-checker/rules/008-trigger-service-integration.md",
  },
  "009": {
    id: "009",
    slug: "009-emergency-risk-controls",
    title: "Emergency controls",
    shortName: "emergency-controls",
    summary:
      "Guardian-guarded emergency functions must exist (or Guardian-only upgrade authority for proxy vaults), stay inactive by default, and never break normal operation or the receive() gas limit. Their reach must be disclosed to users.",
    promptGuidance: [
      "Emergency withdraw functions are inherited from the injected base (guardian-guarded, nonReentrant). Do NOT redeclare them.",
      "If the guardian can reach user-deposited funds (e.g. escrowed/staked assets), disclose that in description() and the schema description.",
    ],
    scannerRuleNames: [
      "emergency-not-guardian",
      "excess-only-emergency-override",
      "excess-only-emergency-token",
      "staking-guardian-trust-undisclosed",
    ],
    scannerRulePatterns: [/emergency/, /guardian/],
    fixGuidance: [
      "Fix Rule 009: keep emergency functions guardian-guarded and inherited from the base; if guardian recovery can reach user funds, state that plainly in description() and the schema.",
    ],
    corpusPath: "flap-spec-checker/rules/009-emergency-risk-controls.md",
  },
};

export const FLAP_RULE_IDS: FlapRuleId[] = ["001", "002", "003", "004", "005", "006", "007", "008", "009"];

export function getFlapRule(id: FlapRuleId): FlapConstitutionRule {
  return RULES[id];
}

export function getAllFlapRules(): FlapConstitutionRule[] {
  return FLAP_RULE_IDS.map((id) => RULES[id]);
}

/** Long slug ("001-vault-rules") → rule. Accepts ids that merely start with the slug's numeric prefix. */
export function getFlapRuleBySlug(slug: string): FlapConstitutionRule | undefined {
  return getAllFlapRules().find((r) => slug === r.slug || slug.startsWith(`${r.id}-`) || slug === r.id);
}

/**
 * Attribute a deterministic scanner finding (by its rule name, e.g. "receive-no-loop")
 * to a Flap constitution rule. Exact names win; patterns are the fallback; Rule 001
 * (vault rules / fund flow) is the default bucket, matching historical behavior.
 */
export function mapScannerFindingToRuleId(scannerRuleName: string): FlapRuleId {
  for (const rule of getAllFlapRules()) {
    if (rule.scannerRuleNames.includes(scannerRuleName)) return rule.id;
  }
  // Order matters for pattern fallback: specific rules before the 001 catch-all patterns.
  const patternOrder: FlapRuleId[] = ["005", "004", "003", "008", "007", "009", "006", "002", "001"];
  for (const id of patternOrder) {
    if (RULES[id].scannerRulePatterns.some((re) => re.test(scannerRuleName))) return id;
  }
  return "001";
}

/** "Rule 005 — Receive gas limit" style label. */
export function formatRuleLabel(id: FlapRuleId): string {
  const r = RULES[id];
  return `Rule ${r.id} — ${r.title}`;
}

/**
 * The generic constitution block for generation prompts: rule summaries and
 * mechanic-agnostic guidance. Contains NO vault archetypes or reference
 * contracts. Pass ruleIds to render a scoped subset (defaults to all 9).
 */
export function formatConstitutionForPrompt(ruleIds?: FlapRuleId[]): string {
  const ids = ruleIds && ruleIds.length > 0 ? [...new Set(ruleIds)] : FLAP_RULE_IDS;
  const sections = ids.map((id) => {
    const r = RULES[id];
    const guidance = r.promptGuidance.map((g) => `  - ${g}`).join("\n");
    return `${formatRuleLabel(r.id)}\n  ${r.summary}\n${guidance}`;
  });
  return `FLAP CONSTITUTION (Rules 001–009 — these are protocol/safety rules, NOT vault templates; any mechanic satisfying them is allowed):\n\n${sections.join("\n\n")}`;
}

/**
 * Rule-ID-keyed fix guidance for repair prompts: one line per (deduplicated)
 * rule, so "Fix Rule NNN" appears exactly once per violated rule.
 * Unknown/empty input returns "".
 */
export function formatRuleFixGuidance(ruleIds: FlapRuleId[]): string {
  const unique = [...new Set(ruleIds)];
  const lines: string[] = [];
  for (const id of unique) {
    const r = RULES[id];
    if (!r || r.fixGuidance.length === 0) continue;
    const merged = r.fixGuidance
      .map((fix, i) => (i === 0 ? fix : fix.replace(new RegExp(`^Fix Rule ${id}:\\s*`), "")))
      .join(" ");
    lines.push(`- ${merged}`);
  }
  return lines.join("\n");
}

/** Group scanner findings by constitution rule for failure memory / fix prompts. */
export function groupFindingsByRule<T extends { rule: string; detail: string }>(
  findings: T[]
): { ruleId: FlapRuleId; label: string; findings: T[] }[] {
  const byRule = new Map<FlapRuleId, T[]>();
  for (const f of findings) {
    const id = mapScannerFindingToRuleId(f.rule);
    const list = byRule.get(id) ?? [];
    list.push(f);
    byRule.set(id, list);
  }
  return [...byRule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ruleId, fs]) => ({ ruleId, label: formatRuleLabel(ruleId), findings: fs }));
}

/** Sorted, de-duplicated rule IDs violated by a set of scanner findings. */
export function flapRuleIdsForFindings(findings: { rule: string }[]): FlapRuleId[] {
  return [...new Set(findings.map((f) => mapScannerFindingToRuleId(f.rule)))].sort();
}

/** Human-readable labels for the rules violated by a set of scanner findings. */
export function describeViolatedRules(findings: { rule: string }[]): string[] {
  return flapRuleIdsForFindings(findings).map((id) => formatRuleLabel(id));
}
