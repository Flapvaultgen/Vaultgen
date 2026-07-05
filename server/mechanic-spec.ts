/**
 * MechanicSpec — the plan-first intermediate product spec (Phase 2).
 *
 * Every user prompt is expanded into a free-form MechanicSpec BEFORE any
 * Solidity is generated:
 *
 *   user prompt → MechanicSpec → Rules 001–009 analysis → Solidity
 *
 * This is NOT a template. Action names are free-form — the planner must never
 * force a mechanic into a fixed stake/enter/claim/draw vocabulary. Rule
 * applicability is derived from the planned mechanic STRUCTURE (randomness →
 * Rule 007, scheduled execution → Rule 008, user payouts → Rule 003, …), never
 * from a vault kind.
 *
 * Phase 6: the VaultKind/VaultPlan taxonomy is fully retired from the
 * pipeline. Scanners (Phase 4), test generation (Phase 5), and the pipeline
 * itself (Phase 6) derive everything from this spec + Rules 001–009 + the
 * scope verdict (vault-scope.ts).
 */

import { getAllFlapRules, getFlapRule, FLAP_RULE_IDS, type FlapRuleId } from "./constitution.js";
import type { MechanicDesign } from "./vault-plan.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type MechanicActor = {
  role: "holder" | "manager" | "keeper" | "oracle" | "protocol" | "external";
  description: string;
};

export type FundsInSpec = {
  source: "tax_bnb" | "user_bnb" | "user_token";
  notes: string;
};

export type BucketSpec = {
  name: string;
  asset: "BNB" | "taxToken";
  creditedBy: string[];
  debitedBy: string[];
};

/** One complete lifecycle edge. `name` is FREE-FORM — never forced into a fixed vocabulary. */
export type ActionSpec = {
  name: string;
  caller: "holder" | "manager" | "keeper" | "oracle";
  description: string;
  preconditions: string[];
  effects: string[];
  schemaExposed: boolean;
  events: string[];
};

export type ScheduledActionSpec = {
  action: string;
  interval: string;
  via: "trigger_service" | "manager" | "keeper";
};

export type OracleActionSpec = {
  request: string;
  callback: string;
  refundPath: string;
};

/** Phase 7 (economic hardening): how the payout AMOUNT is decided. */
export type PayoutDistributionMode =
  | "manager_assigned_amount"
  | "fixed_per_user"
  | "pro_rata_snapshot"
  | "winner_takes_all"
  | "refund"
  | "milestone_unlock";

/** Phase 7: how the liability (who is owed what) is tracked before it is sent. */
export type PayoutLiabilityModel =
  | "reserved_on_approval"
  | "credited_before_claim"
  | "calculated_from_snapshot"
  | "single_winner_pool"
  | "event_only_offchain_review";

export type PayoutRuleSpec = {
  trigger: string;
  /** The named bucket the payout is funded from. */
  source: string;
  recipients: string;
  mode: "pull" | "push_manager_only";
  /** Phase 7: how the amount is decided (manager-assigned, fixed, pro-rata, single winner, ...). */
  distributionMode: PayoutDistributionMode;
  /** Phase 7: how the liability is tracked before the claim/send. */
  liabilityModel: PayoutLiabilityModel;
  /** Free text: what makes an address eligible (e.g. "manager approval of a submitted proof"). */
  eligibilitySource: string;
  /** Free text: where the CLAIM AMOUNT itself comes from — never "the entire shared bucket" unless winnerTakesAll. */
  claimAmountSource: string;
  /** Explicit, conservative flag — true ONLY for a genuine winner-takes-all / single-winner-pool mechanic. */
  winnerTakesAll: boolean;
  /** Derived default: true whenever multiple addresses can become independently eligible and winnerTakesAll is false. */
  perUserAccountingRequired: boolean;
};

// ── Phase 8 (lifecycle hardening): generic resource/assignment lifecycle ─────
// These are lifecycle PRIMITIVES, not vault templates: bounty/task, quest
// proof, epoch, and contest mechanics all reduce to "a resource with states,
// an assignment model, exits, and a reward reservation point".

/** How users get attached to a discrete resource (bounty, task, round, slot, …). */
export type AssignmentModel =
  | "single_assignee" //  exactly one user works the resource at a time
  | "multi_assignee" //   several users can work the same resource, tracked per user
  | "open_pool" //        no assignment — anyone eligible acts directly (votes, stakes, entries)
  | "unspecified" //      the user has not decided yet — a design question, not a default
  | "not_applicable"; //  the mechanic has no discrete assignable resource

export type CompletionAuthority = "manager" | "keeper" | "oracle" | "automatic" | "user_self" | "unspecified";

export type RewardReservationPoint = "on_post" | "on_accept" | "on_approval" | "on_settlement" | "unspecified" | "not_applicable";

export type LifecycleSpec = {
  /** Free-form resource noun ("bounty", "quest", "epoch", "contest entry"); "" when no discrete resource exists. */
  resourceType: string;
  /** Ordered lifecycle states of the resource, e.g. open → accepted → submitted → approved → claimed. */
  resourceStates: string[];
  /** Per-user states, when they differ from the resource states. */
  userStates: string[];
  assignmentModel: AssignmentModel;
  /** 0 = unlimited / not applicable; 1 for single-assignee. */
  maxAssignees: number;
  /** Whether completing requires the user to submit something (proof, entry, work). */
  requiresSubmission: "yes" | "no" | "unspecified";
  completionAuthority: CompletionAuthority;
  /** Deadline/expiry description; "" when none is planned. */
  timeoutOrExpiry: string;
  /** How an assigned user exits on their own; "" = MISSING (a stuck-state risk). */
  abandonPath: string;
  /** How the manager retires a resource without trapping users; "" = MISSING. */
  cancelPath: string;
  rewardReservationPoint: RewardReservationPoint;
  /** Honest list of ways a user could get stuck, for disclosure + tests. */
  stuckStateRisks: string[];
  userExitPaths: string[];
  managerExitPaths: string[];
  /** Views the UI must expose so a non-coder can see their own state. */
  stateVisibilityRequirements: string[];
};

export type UiMethodSketch = {
  name: string;
  kind: "view" | "write";
  description: string;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
};

export type RuleAnalysisEntry = {
  applies: boolean;
  strategy: string;
  notes: string[];
};

export type MechanicRuleAnalysis = Record<FlapRuleId, RuleAnalysisEntry>;

export type MechanicSpec = {
  productSummary: string;
  contractName: string;
  actors: MechanicActor[];
  fundsIn: FundsInSpec[];
  buckets: BucketSpec[];
  userActions: ActionSpec[];
  managerActions: ActionSpec[];
  scheduledActions: ScheduledActionSpec[];
  oracleActions: OracleActionSpec[];
  payoutRules: PayoutRuleSpec[];
  /** Phase 8: generic resource/assignment lifecycle — null when the mechanic has no discrete lifecycle. */
  lifecycle: LifecycleSpec | null;
  fairnessModel: string;
  emergencyControls: string;
  trustAssumptions: string[];
  uiMethods: UiMethodSketch[];
  viewMethods: string[];
  ruleAnalysis: MechanicRuleAnalysis;
  launchCompatibility: { notes: string[] };
  testScenarios: { name: string; steps: string[]; expect: string }[];
  invariants: string[];
};

// ── Rule 001–009 analysis (structure-derived, never kind-derived) ────────────

/** Rules that apply to every Flap vault regardless of mechanic. */
const ALWAYS_APPLIES: Record<string, string> = {
  "001": "Split tax BNB into the named buckets; pay only from buckets; manager vs holder permissions; events on every state change.",
  "002": "Inherit CodegenVaultBase and keep the exact pass-through constructor so CodegenVaultFactory can deploy it.",
  "004": "Bilingual require() strings only (no custom errors); complete truthful vaultUISchema covering every uiMethod and viewMethod.",
  "005": "receive() only credits buckets — no swaps, external calls, transfers, loops, or reverts on normal deposits.",
  "006": "Every user/manager action in this spec must be exercisable in a mainnet-fork Foundry test.",
  "009": "Inherit guardian-only emergency withdrawals from the base; disclose guardian reach over any user-custodied funds.",
};

/**
 * Derive per-rule applicability from the planned mechanic structure.
 * Rules 001/002/004/005/006/009 always apply. 003 applies when the mechanic
 * pays anyone out; 007 when an oracle/random outcome exists; 008 when
 * execution is scheduled/automated.
 */
export function deriveRuleAnalysis(structure: {
  payoutRules: PayoutRuleSpec[];
  oracleActions: OracleActionSpec[];
  scheduledActions: ScheduledActionSpec[];
  fairnessModel?: string;
}): MechanicRuleAnalysis {
  const analysis = {} as MechanicRuleAnalysis;

  for (const id of FLAP_RULE_IDS) {
    const rule = getFlapRule(id);
    analysis[id] = {
      applies: id in ALWAYS_APPLIES,
      strategy: ALWAYS_APPLIES[id] ?? "",
      notes: [],
    };
    if (!analysis[id].strategy) analysis[id].strategy = rule.summary;
  }

  if (structure.payoutRules.length > 0) {
    analysis["003"] = {
      applies: true,
      strategy:
        structure.fairnessModel?.trim() ||
        "Size every payout from committed state (deposits, snapshots, fixed pools, or oracle outcomes) — never from a live balanceOf.",
      notes: structure.payoutRules.map((p) => {
        const perUserNote = p.winnerTakesAll
          ? "explicit winner-takes-all/single-winner-pool"
          : "per-user accounting required (reserve/credit before claim) — never pay a shared bucket in full to the first claimant";
        return `Payout "${p.trigger}" from bucket "${p.source}" to ${p.recipients} (${p.mode}; ${p.distributionMode}/${p.liabilityModel}; ${perUserNote}).`;
      }),
    };
  } else {
    analysis["003"] = {
      applies: false,
      strategy: "No user payouts planned — keep balance reads out of any future payout math.",
      notes: [],
    };
  }

  if (structure.oracleActions.length > 0) {
    analysis["007"] = {
      applies: true,
      strategy:
        "Use FlapAIConsumerBase for every random/AI-decided outcome: snapshot participants before the request, authenticate callbacks, pull payouts, exact-once refunds. Block entropy is forbidden.",
      notes: structure.oracleActions.map((o) => `Oracle flow: ${o.request} → ${o.callback} (refund: ${o.refundPath}).`),
    };
  } else {
    analysis["007"] = {
      applies: false,
      strategy: "No random or AI-decided outcomes planned — do not introduce block entropy anywhere.",
      notes: [],
    };
  }

  if (structure.scheduledActions.length > 0) {
    const viaTrigger = structure.scheduledActions.some((s) => s.via === "trigger_service");
    analysis["008"] = {
      applies: true,
      strategy: viaTrigger
        ? "Integrate IFlapTriggerService/ITriggerReceiver: authenticate the callback, consume the request id, re-validate timing inside the callback."
        : "Scheduled actions are manager/keeper-called: enforce the interval on the trigger function and expose a countdown view.",
      notes: structure.scheduledActions.map((s) => `Scheduled: ${s.action} every ${s.interval} via ${s.via}.`),
    };
  } else {
    analysis["008"] = {
      applies: false,
      strategy: "No scheduled/automated execution planned.",
      notes: [],
    };
  }

  return analysis;
}

// ── Phase 7: payout distribution/liability semantics ─────────────────────────

const DISTRIBUTION_MODES: PayoutDistributionMode[] = [
  "manager_assigned_amount",
  "fixed_per_user",
  "pro_rata_snapshot",
  "winner_takes_all",
  "refund",
  "milestone_unlock",
];
const LIABILITY_MODELS: PayoutLiabilityModel[] = [
  "reserved_on_approval",
  "credited_before_claim",
  "calculated_from_snapshot",
  "single_winner_pool",
  "event_only_offchain_review",
];

/**
 * Conservative text heuristic used ONLY when neither the LLM nor an explicit
 * flag declares the semantics. Per the Phase 7 default rule: a payout is
 * winner-takes-all ONLY when the recipients text unambiguously says so
 * ("a single winner", "the winner", "winner takes all") AND does not also
 * describe multiple/every/pro-rata recipients. Everything else defaults to
 * per-user accounting — silence must never imply "pay the first claimant everything".
 */
export function inferPayoutSemanticsFromText(recipients: string): {
  distributionMode: PayoutDistributionMode;
  liabilityModel: PayoutLiabilityModel;
  winnerTakesAll: boolean;
} {
  const r = recipients.toLowerCase();
  const saysMultiple = /\beach\b|\bevery\b|\ball (holders|users|participants|entrants)\b|pro.?rata|\bmultiple\b|\bboth\b/.test(r);
  const saysSingleWinner = /\b(a |the |sole )?(single |one )?winner\b|\bwinner takes all\b|\bone winner\b/.test(r);
  if (saysSingleWinner && !saysMultiple) {
    return { distributionMode: "winner_takes_all", liabilityModel: "single_winner_pool", winnerTakesAll: true };
  }
  if (/pro.?rata|proportional|share of|per.?stake|per.?deposit/.test(r)) {
    return { distributionMode: "pro_rata_snapshot", liabilityModel: "calculated_from_snapshot", winnerTakesAll: false };
  }
  return { distributionMode: "manager_assigned_amount", liabilityModel: "reserved_on_approval", winnerTakesAll: false };
}

/**
 * Normalize one payout rule's Phase 7 semantics, backfilling missing/invalid
 * fields conservatively: explicit flags win, then the fallback spec's own
 * semantics, then the text heuristic above, then the safe default
 * (per-user accounting, never winner-takes-all).
 */
function normalizePayoutSemantics(
  raw: Record<string, unknown>,
  recipients: string,
  fallback?: Partial<PayoutRuleSpec>
): Pick<
  PayoutRuleSpec,
  "distributionMode" | "liabilityModel" | "eligibilitySource" | "claimAmountSource" | "winnerTakesAll" | "perUserAccountingRequired"
> {
  const rawDistribution = DISTRIBUTION_MODES.includes(raw.distributionMode as PayoutDistributionMode)
    ? (raw.distributionMode as PayoutDistributionMode)
    : undefined;
  const rawLiability = LIABILITY_MODELS.includes(raw.liabilityModel as PayoutLiabilityModel)
    ? (raw.liabilityModel as PayoutLiabilityModel)
    : undefined;
  const heuristic = inferPayoutSemanticsFromText(recipients);

  const winnerTakesAll: boolean =
    raw.winnerTakesAll === true ||
    rawDistribution === "winner_takes_all" ||
    rawLiability === "single_winner_pool" ||
    (raw.winnerTakesAll !== false && rawDistribution === undefined && rawLiability === undefined && fallback?.winnerTakesAll === true) ||
    (raw.winnerTakesAll === undefined && rawDistribution === undefined && rawLiability === undefined && fallback === undefined && heuristic.winnerTakesAll);

  const distributionMode: PayoutDistributionMode =
    rawDistribution ?? fallback?.distributionMode ?? heuristic.distributionMode;
  const liabilityModel: PayoutLiabilityModel = rawLiability ?? fallback?.liabilityModel ?? heuristic.liabilityModel;
  const eligibilitySource = str(raw.eligibilitySource, fallback?.eligibilitySource ?? "");
  const claimAmountSource = str(raw.claimAmountSource, fallback?.claimAmountSource ?? "");
  const perUserAccountingRequired: boolean =
    raw.perUserAccountingRequired === false || raw.perUserAccountingRequired === true
      ? (raw.perUserAccountingRequired as boolean)
      : !winnerTakesAll;

  return { distributionMode, liabilityModel, eligibilitySource, claimAmountSource, winnerTakesAll, perUserAccountingRequired };
}

// ── Phase 8: lifecycle inference (heuristic, conservative) ───────────────────

const ASSIGNMENT_MODELS: AssignmentModel[] = ["single_assignee", "multi_assignee", "open_pool", "unspecified", "not_applicable"];
const COMPLETION_AUTHORITIES: CompletionAuthority[] = ["manager", "keeper", "oracle", "automatic", "user_self", "unspecified"];
const RESERVATION_POINTS: RewardReservationPoint[] = ["on_post", "on_accept", "on_approval", "on_settlement", "unspecified", "not_applicable"];

/**
 * Detect a discrete assignable resource (bounty/task/quest/contest/…) in the
 * prompt and build a conservative LifecycleSpec for it. Anything the user did
 * NOT decide stays "unspecified"/"" — the design-question gate turns those
 * gaps into plain-English questions instead of risky silent defaults.
 * Returns null for mechanics without a discrete assignable resource
 * (plain staking, voting, buyback, treasury).
 */
export function inferLifecycleFromPrompt(prompt: string): LifecycleSpec | null {
  const p = prompt.toLowerCase();
  const resourceMatch = p.match(/\b(bounty|bounties|task|quest|mission|gig|challenge|contest|assignment)s?\b/);
  if (!resourceMatch) return null;
  const resourceType = resourceMatch[1]!.replace(/^bounties$/, "bounty");

  const saysSingle =
    /\b(one|single|only one|first)\b[^.]{0,50}\b(user|holder|person|wallet|assignee)\b[^.]{0,50}\b(accept|take|work|claim|assigned)/.test(p) ||
    /\bfirst come,? first serve/.test(p) ||
    /\bsingle[- ]assignee\b/.test(p);
  const saysMulti =
    /\b(multiple|many|several|any number of|unlimited)\b[^.]{0,40}\b(users|holders|people|wallets)\b[^.]{0,60}\b(accept|take|work|complete|join|do)\b/.test(p) ||
    /\bmulti[- ]assignee\b/.test(p) ||
    /\b(each|every)\b[^.]{0,30}\b(user|holder)\b[^.]{0,40}\bcan\b[^.]{0,40}\b(accept|work on|complete)\b[^.]{0,30}\b(same|the)\b/.test(p);
  const assignmentModel: AssignmentModel = saysSingle ? "single_assignee" : saysMulti ? "multi_assignee" : "unspecified";

  const requiresSubmission: LifecycleSpec["requiresSubmission"] = /\bproofs?\b|\bsubmit|\bsubmission|\bevidence\b|\bdeliverable/.test(p)
    ? "yes"
    : "unspecified";
  const completionAuthority: CompletionAuthority = /\bmanager\b[^.]{0,40}\b(approv|mark|verif|confirm|review)/.test(p)
    ? "manager"
    : "unspecified";
  const abandonPath = /\babandon|\bgive up|\bquit\b|\bwithdraw from|\bun-?accept|\bback out/.test(p)
    ? "user can abandon/un-accept before completion (per the prompt)"
    : "";
  const cancelPath = /\bcancel|\bretract|\bremove\b[^.]{0,20}\b(bounty|task|quest)|\bexpire/.test(p)
    ? "manager can cancel/expire the resource (per the prompt)"
    : "";
  const timeoutOrExpiry = /\bdeadline|\bexpiry|\bexpires?\b|\btime ?limit|\bwithin \d/.test(p) ? "deadline/expiry mentioned in the prompt" : "";
  const rewardReservationPoint: RewardReservationPoint = /\breserve/.test(p) ? "on_approval" : "unspecified";

  const stuckStateRisks: string[] = [];
  if (!abandonPath) stuckStateRisks.push(`no abandon path decided — a user assigned to a ${resourceType} may have no way to exit on their own`);
  if (!cancelPath) stuckStateRisks.push(`no cancel path decided — a dead ${resourceType} may trap its assigned user(s) forever`);
  if (assignmentModel === "unspecified")
    stuckStateRisks.push(`assignment model undecided — if several users can accept the same ${resourceType} but completion deactivates it globally, the others become stuck`);
  if (completionAuthority === "manager" || completionAuthority === "unspecified")
    stuckStateRisks.push("if the manager never marks completion and there is no timeout, assigned users wait forever");

  return {
    resourceType,
    resourceStates: ["open", "accepted", "submitted", "approved", "claimed"],
    userStates: ["not_assigned", "assigned", "submitted", "claimable", "claimed"],
    assignmentModel,
    maxAssignees: assignmentModel === "single_assignee" ? 1 : 0,
    requiresSubmission,
    completionAuthority,
    timeoutOrExpiry,
    abandonPath,
    cancelPath,
    rewardReservationPoint,
    stuckStateRisks,
    userExitPaths: abandonPath ? [abandonPath] : [],
    managerExitPaths: cancelPath ? [cancelPath] : [],
    stateVisibilityRequirements: [
      `a count view and a per-id getter for ${resourceType} state`,
      "a per-user view of the user's current assignment/status",
      "a per-user view of the claimable amount",
      "a view of the funding bucket",
    ],
  };
}

// ── Deterministic fallback planner (no API key / LLM failure) ────────────────

function pascalCase(words: string): string {
  const cleaned = words.replace(/[^A-Za-z0-9\s]/g, " ").trim();
  const name = cleaned
    .split(/\s+/)
    .slice(0, 4)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ""))
    .join("");
  const safe = /^[A-Za-z]/.test(name) ? name : `Vault${name}`;
  return (safe || "GeneratedVault").slice(0, 40);
}

/**
 * Heuristic MechanicSpec from prompt semantics — used when no API key is
 * available or the planner LLM fails. Detects mechanic FEATURES (randomness,
 * scheduling, deposits, voting, payouts), never routes to a vault kind.
 * Action names are lifted from the user's own words where possible.
 */
export function inferMechanicSpecFromPrompt(prompt: string): MechanicSpec {
  const p = prompt.toLowerCase();

  const wantsRandomOutcome =
    /\brandom|lottery|raffle|\bdraw\b|jackpot|winner|lucky|eliminat|survivor|pick (a|one|the)/i.test(p);
  const wantsSchedule =
    /weekly|daily|monthly|hourly|every (day|week|month|hour|\d)|epoch|interval|schedule|automat|keeper|\bcron\b|each (day|week|month)|per (day|week|month)|\bround(s)?\b/i.test(p);
  const usersDepositTokens = /\bstake|staking|deposit|lock(s|ed|ing)? (up )?(their )?token/i.test(p);
  const usersVote = /\bvote|voting|ballot|\belect\b/i.test(p);
  const usersJoin = /\benter\b|\bjoin\b|\bticket\b|participate|sign.?up|\bregister\b/i.test(p);
  const usersClaim = /\bclaim\b/i.test(p);
  const paysOut =
    /reward|prize|dividend|payout|pay(s)? out|distribut|airdrop|\bwin(s|ner)?\b|receive(s)?\b|donat|send(s)? (to|the)|\bearn(s|ing)?\b|share of/i.test(
      p
    ) || wantsRandomOutcome;
  const burnsOrBuysBack = /\bburn|buy.?back/i.test(p);

  const actors: MechanicActor[] = [
    { role: "protocol", description: "Flap tax processor — calls receive() with tax BNB on every trade." },
    { role: "holder", description: "Token holders interacting through the standard Flap panel." },
    { role: "manager", description: "Creator/guardian — privileged mechanism triggers via onlyManager." },
  ];
  if (wantsRandomOutcome) actors.push({ role: "oracle", description: "Flap AI Provider — delivers the requested outcome via authenticated callback." });
  if (wantsSchedule) actors.push({ role: "keeper", description: "Flap Trigger Service or manager cadence for scheduled execution." });

  const fundsIn: FundsInSpec[] = [{ source: "tax_bnb", notes: "Trade tax arrives as plain BNB in receive() from the protocol." }];
  if (usersDepositTokens) fundsIn.push({ source: "user_token", notes: "Users deposit/lock the launched tax token via transferFrom (fee-on-transfer safe: credit the balance delta)." });

  const buckets: BucketSpec[] = [];
  if (paysOut) buckets.push({ name: "payoutPool", asset: "BNB", creditedBy: ["receive()"], debitedBy: ["the payout/claim path"] });
  if (burnsOrBuysBack) buckets.push({ name: "burnBudget", asset: "BNB", creditedBy: ["receive()"], debitedBy: ["the buyback/burn trigger"] });
  buckets.push({ name: "treasury", asset: "BNB", creditedBy: ["receive()"], debitedBy: ["manager withdrawal"] });

  const userActions: ActionSpec[] = [];
  if (usersDepositTokens) {
    const verb = /\bstak/i.test(p) ? "stake" : /\block/i.test(p) ? "lockTokens" : "deposit";
    userActions.push({
      name: verb,
      caller: "holder",
      description: "User commits tokens to participate; entitlement accounting is based on this committed state.",
      preconditions: ["amount > 0", "user approved the tax token"],
      effects: ["user committed balance increases (by received balance delta)", "total committed increases"],
      schemaExposed: true,
      events: ["Deposited"],
    });
  }
  if (usersVote) {
    userActions.push({
      name: "vote",
      caller: "holder",
      description: "User casts a vote for one of the configured options for the current period.",
      preconditions: ["voting period is open", "user has not already voted this period (or vote replaces prior vote)"],
      effects: ["vote tally for the chosen option increases", "user marked as voted for the period"],
      schemaExposed: true,
      events: ["Voted"],
    });
  }
  if (usersJoin && wantsRandomOutcome) {
    userActions.push({
      name: "enterRound",
      caller: "holder",
      description: "User joins the current round; participant set is deduplicated and capped.",
      preconditions: ["no outcome request pending", "not already entered", "participant cap not reached"],
      effects: ["participant list grows"],
      schemaExposed: true,
      events: ["Entered"],
    });
  }
  if (usersClaim || paysOut) {
    userActions.push({
      name: "claimPayout",
      caller: "holder",
      description: "User pulls their credited payout (pull payment).",
      preconditions: ["claimable balance > 0"],
      effects: ["claimable balance zeroed before send", "BNB sent to the user"],
      schemaExposed: true,
      events: ["PayoutClaimed"],
    });
  }

  const managerActions: ActionSpec[] = [];
  const mainTriggerName = burnsOrBuysBack
    ? "executeBurn"
    : usersVote
      ? "settlePeriod"
      : paysOut
        ? "executeDistribution"
        : "withdrawTreasury";
  managerActions.push({
    name: mainTriggerName,
    caller: "manager",
    description: "Primary mechanism trigger — drains the funding bucket and performs the planned action.",
    preconditions: wantsSchedule ? ["the configured interval has elapsed"] : ["funding bucket > 0"],
    effects: ["funding bucket zeroed before acting", "credits claimables or executes the burn/transfer"],
    schemaExposed: true,
    events: ["MechanismExecuted"],
  });

  const scheduledActions: ScheduledActionSpec[] = wantsSchedule
    ? [{ action: mainTriggerName, interval: /weekly|each week|per week/i.test(p) ? "weekly" : /daily|each day/i.test(p) ? "daily" : "recurring interval", via: "manager" }]
    : [];

  const oracleActions: OracleActionSpec[] = wantsRandomOutcome
    ? [
        {
          request: "requestOutcome — snapshot the frozen participant set, pay the oracle fee from the funding bucket, one pending request at a time",
          callback: "_fulfillReasoning — validate requestId, clear pending state, credit the selected recipient's claimable balance (pull payment)",
          refundPath: "_onFlapAIRequestRefunded — restore the exact fee to its bucket once, clear pending state and the snapshot",
        },
      ]
    : [];

  const payoutRules: PayoutRuleSpec[] = paysOut
    ? [
        (() => {
          const recipients = wantsRandomOutcome
            ? "a single winner selected from the frozen participant snapshot"
            : usersVote
              ? "the option/recipient chosen by the vote outcome"
              : usersDepositTokens
                ? "each staker pro-rata to their committed (deposited) balance"
                : "multiple eligible users per the mechanic's committed state";
          const semantics = wantsRandomOutcome
            ? {
                distributionMode: "winner_takes_all" as const,
                liabilityModel: "single_winner_pool" as const,
                eligibilitySource: "frozen participant snapshot taken before the oracle request",
                claimAmountSource: "the single winner's claimable balance credited once by the oracle callback",
                winnerTakesAll: true,
                perUserAccountingRequired: false,
              }
            : usersDepositTokens
              ? {
                  distributionMode: "pro_rata_snapshot" as const,
                  liabilityModel: "calculated_from_snapshot" as const,
                  eligibilitySource: "users with a committed (deposited/staked) balance > 0",
                  claimAmountSource: "pendingReward(user) computed from an accumulator and the user's committed balance — never a raw shared bucket",
                  winnerTakesAll: false,
                  perUserAccountingRequired: true,
                }
              : usersVote
                ? {
                    distributionMode: "manager_assigned_amount" as const,
                    liabilityModel: "credited_before_claim" as const,
                    eligibilitySource: "the single option/recipient chosen by the settled vote",
                    claimAmountSource: "the settled bucket amount sent to the chosen recipient once per settlement",
                    winnerTakesAll: false,
                    perUserAccountingRequired: false,
                  }
                : {
                    distributionMode: "manager_assigned_amount" as const,
                    liabilityModel: "reserved_on_approval" as const,
                    eligibilitySource: "manager-approved eligibility per user",
                    claimAmountSource: "claimableRewards[user] (or equivalent) credited/reserved at approval time — never the raw shared bucket",
                    winnerTakesAll: false,
                    perUserAccountingRequired: true,
                  };
          return {
            trigger: mainTriggerName,
            source: buckets[0]!.name,
            recipients,
            mode: "pull" as const,
            ...semantics,
          };
        })(),
      ]
    : [];

  const viewMethods = [
    ...buckets.map((b) => b.name),
    ...(usersDepositTokens ? ["pendingPayout"] : []),
    ...(wantsSchedule ? ["timeUntilNextExecution"] : []),
  ];

  const uiMethods: UiMethodSketch[] = [
    ...userActions.map((a) => ({
      name: a.name,
      kind: "write" as const,
      description: a.description,
      inputs: a.name === "vote" ? [{ name: "option", type: "uint256" }] : /stake|deposit|lock/i.test(a.name) ? [{ name: "amount", type: "uint256" }] : [],
      outputs: [],
    })),
    ...managerActions.filter((a) => a.schemaExposed).map((a) => ({
      name: a.name,
      kind: "write" as const,
      description: a.description,
      inputs: [],
      outputs: [],
    })),
    ...viewMethods.map((v) => ({
      name: v,
      kind: "view" as const,
      description: `Live value of ${v}.`,
      inputs: [],
      outputs: [{ name: "value", type: "uint256" }],
    })),
  ];

  const spec: MechanicSpec = {
    productSummary: `Flap tax vault for: ${prompt.trim().slice(0, 240)}`,
    contractName: pascalCase(prompt) || "GeneratedVault",
    actors,
    fundsIn,
    buckets,
    userActions,
    managerActions,
    scheduledActions,
    oracleActions,
    payoutRules,
    lifecycle: inferLifecycleFromPrompt(prompt),
    fairnessModel: paysOut
      ? "Payout entitlements come from committed state (deposits, votes, frozen snapshots, or oracle outcomes) — never sized from a live balanceOf."
      : "No user payouts — fairness reduces to honest disclosure of manager powers.",
    emergencyControls:
      "Guardian-only emergencyWithdrawNative/Token inherited from CodegenVaultBase (Rule 009); disclosed in description() and the schema.",
    trustAssumptions: [
      "Guardian can recover all vault funds (Rule 009 emergency path).",
      ...(wantsRandomOutcome ? ["Outcomes are selected by the external Flap AI provider (trusted oracle), not verifiable randomness."] : []),
      ...(wantsSchedule ? ["Scheduled execution depends on the trigger service/keeper actually firing."] : []),
    ],
    uiMethods,
    viewMethods,
    ruleAnalysis: deriveRuleAnalysis({ payoutRules, oracleActions, scheduledActions }),
    launchCompatibility: {
      notes: ["Standard Flap tax vault — deployable through CodegenVaultFactory and rendered by the standard panel."],
    },
    testScenarios: [
      {
        name: "tax dispatch credits buckets",
        steps: ["deploy via factory on a mainnet fork", "buy on the curve to dispatch tax", "assert bucket counters increased"],
        expect: "receive() splits tax into the named buckets without reverting",
      },
      ...userActions.map((a) => ({
        name: `user action ${a.name}`,
        steps: [`call ${a.name} as a funded user`, "assert its planned effects"],
        expect: `${a.name} updates state and emits ${a.events.join(", ") || "its event"}`,
      })),
      {
        name: `mechanism trigger ${mainTriggerName}`,
        steps: [`fund the bucket`, `call ${mainTriggerName} as manager`, "assert bucket drained and outcome applied"],
        expect: "bucket zeroed before paying/acting; outcome state updated",
      },
    ],
    invariants: [
      "sum(named buckets) <= address(this).balance at all times",
      "every claimable mapping is credited (+=) by some function before claim reads it",
      "receive() does cheap bucket accounting only and never reverts on a normal deposit",
      ...(wantsRandomOutcome ? ["participant snapshot is frozen before any oracle request; refunds restore the fee exactly once"] : []),
      ...(paysOut && !wantsRandomOutcome
        ? ["a shared payout bucket is never paid in full to whichever eligible address claims first — reserve/credit a per-user amount unless the mechanic is explicitly winner-takes-all"]
        : []),
    ],
  };

  return spec;
}

// ── Normalization of LLM output ──────────────────────────────────────────────

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

function normalizeAction(raw: unknown, defaultCaller: ActionSpec["caller"]): ActionSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const name = str(a.name, "");
  if (!name) return null;
  const caller = ["holder", "manager", "keeper", "oracle"].includes(a.caller as string)
    ? (a.caller as ActionSpec["caller"])
    : defaultCaller;
  return {
    name,
    caller,
    description: str(a.description, ""),
    preconditions: strArray(a.preconditions),
    effects: strArray(a.effects),
    schemaExposed: a.schemaExposed !== false,
    events: strArray(a.events),
  };
}

/**
 * Phase 8: normalize the LLM's lifecycle block conservatively.
 * Missing/invalid enum values become "unspecified" — NEVER a silently-chosen
 * risky default. A missing lifecycle falls back to the heuristic (which may
 * be null for mechanics without a discrete resource).
 */
export function normalizeLifecycle(raw: unknown, fallback: LifecycleSpec | null): LifecycleSpec | null {
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const resourceType = str(o.resourceType, fallback?.resourceType ?? "");
  if (!resourceType) return fallback;

  const assignmentModel = ASSIGNMENT_MODELS.includes(o.assignmentModel as AssignmentModel)
    ? (o.assignmentModel as AssignmentModel)
    : (fallback?.assignmentModel ?? "unspecified");
  const requiresSubmission =
    o.requiresSubmission === "yes" || o.requiresSubmission === "no"
      ? o.requiresSubmission
      : (fallback?.requiresSubmission ?? "unspecified");
  const completionAuthority = COMPLETION_AUTHORITIES.includes(o.completionAuthority as CompletionAuthority)
    ? (o.completionAuthority as CompletionAuthority)
    : (fallback?.completionAuthority ?? "unspecified");
  const rewardReservationPoint = RESERVATION_POINTS.includes(o.rewardReservationPoint as RewardReservationPoint)
    ? (o.rewardReservationPoint as RewardReservationPoint)
    : (fallback?.rewardReservationPoint ?? "unspecified");
  const maxAssignees =
    typeof o.maxAssignees === "number" && Number.isFinite(o.maxAssignees) && o.maxAssignees >= 0
      ? Math.floor(o.maxAssignees)
      : assignmentModel === "single_assignee"
        ? 1
        : (fallback?.maxAssignees ?? 0);

  return {
    resourceType,
    resourceStates: strArray(o.resourceStates).length ? strArray(o.resourceStates) : (fallback?.resourceStates ?? []),
    userStates: strArray(o.userStates).length ? strArray(o.userStates) : (fallback?.userStates ?? []),
    assignmentModel,
    maxAssignees,
    requiresSubmission,
    completionAuthority,
    timeoutOrExpiry: str(o.timeoutOrExpiry, fallback?.timeoutOrExpiry ?? ""),
    abandonPath: str(o.abandonPath, fallback?.abandonPath ?? ""),
    cancelPath: str(o.cancelPath, fallback?.cancelPath ?? ""),
    rewardReservationPoint,
    stuckStateRisks: strArray(o.stuckStateRisks).length ? strArray(o.stuckStateRisks) : (fallback?.stuckStateRisks ?? []),
    userExitPaths: strArray(o.userExitPaths).length ? strArray(o.userExitPaths) : (fallback?.userExitPaths ?? []),
    managerExitPaths: strArray(o.managerExitPaths).length ? strArray(o.managerExitPaths) : (fallback?.managerExitPaths ?? []),
    stateVisibilityRequirements: strArray(o.stateVisibilityRequirements).length
      ? strArray(o.stateVisibilityRequirements)
      : (fallback?.stateVisibilityRequirements ?? []),
  };
}

function normalizeRuleAnalysis(raw: unknown, derived: MechanicRuleAnalysis): MechanicRuleAnalysis {
  const result = { ...derived };
  if (!raw || typeof raw !== "object") return result;
  const obj = raw as Record<string, unknown>;
  for (const id of FLAP_RULE_IDS) {
    const entryRaw = obj[id] ?? obj[getFlapRule(id).slug];
    if (!entryRaw || typeof entryRaw !== "object") continue;
    const e = entryRaw as Record<string, unknown>;
    result[id] = {
      // Structural applicability wins: an always-applies or structure-implied rule
      // cannot be switched off by the LLM, but the LLM may flag extra rules.
      applies: derived[id].applies || e.applies === true,
      strategy: str(e.strategy, derived[id].strategy),
      notes: strArray(e.notes ?? e.risks).length ? strArray(e.notes ?? e.risks) : derived[id].notes,
    };
  }
  return result;
}

export function normalizeMechanicSpec(raw: unknown, fallback: MechanicSpec): MechanicSpec {
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;

  const userActions = Array.isArray(o.userActions)
    ? o.userActions.map((a) => normalizeAction(a, "holder")).filter((a): a is ActionSpec => a !== null)
    : fallback.userActions;
  const managerActions = Array.isArray(o.managerActions)
    ? o.managerActions.map((a) => normalizeAction(a, "manager")).filter((a): a is ActionSpec => a !== null)
    : fallback.managerActions;

  const scheduledActions: ScheduledActionSpec[] = Array.isArray(o.scheduledActions)
    ? o.scheduledActions
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          action: str(s.action, ""),
          interval: str(s.interval, "recurring"),
          via: ["trigger_service", "manager", "keeper"].includes(s.via as string)
            ? (s.via as ScheduledActionSpec["via"])
            : "manager",
        }))
        .filter((s) => s.action)
    : fallback.scheduledActions;

  const oracleActions: OracleActionSpec[] = Array.isArray(o.oracleActions)
    ? o.oracleActions
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          request: str(x.request, ""),
          callback: str(x.callback, ""),
          refundPath: str(x.refundPath, "restore the exact fee once and clear pending state"),
        }))
        .filter((x) => x.request || x.callback)
    : fallback.oracleActions;

  const payoutRules: PayoutRuleSpec[] = Array.isArray(o.payoutRules)
    ? o.payoutRules
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x, i) => {
          const trigger = str(x.trigger, "");
          const source = str(x.source, "the funding bucket");
          const recipients = str(x.recipients, "");
          const mode = x.mode === "push_manager_only" ? ("push_manager_only" as const) : ("pull" as const);
          // Normalize against the matching fallback rule when present (index-aligned
          // best-effort), otherwise against the conservative text heuristic only.
          const semantics = normalizePayoutSemantics(x, recipients, fallback.payoutRules[i]);
          return { trigger, source, recipients, mode, ...semantics };
        })
        .filter((x) => x.trigger || x.recipients)
    : fallback.payoutRules;

  const buckets: BucketSpec[] = Array.isArray(o.buckets)
    ? o.buckets
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          name: str(x.name, ""),
          asset: x.asset === "taxToken" ? ("taxToken" as const) : ("BNB" as const),
          creditedBy: strArray(x.creditedBy),
          debitedBy: strArray(x.debitedBy),
        }))
        .filter((x) => x.name)
    : fallback.buckets;

  const actors: MechanicActor[] = Array.isArray(o.actors)
    ? o.actors
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          role: ["holder", "manager", "keeper", "oracle", "protocol", "external"].includes(x.role as string)
            ? (x.role as MechanicActor["role"])
            : ("external" as const),
          description: str(x.description, ""),
        }))
        .filter((x) => x.description)
    : fallback.actors;

  const fundsIn: FundsInSpec[] = Array.isArray(o.fundsIn)
    ? o.fundsIn
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          source: ["tax_bnb", "user_bnb", "user_token"].includes(x.source as string)
            ? (x.source as FundsInSpec["source"])
            : ("tax_bnb" as const),
          notes: str(x.notes, ""),
        }))
    : fallback.fundsIn;

  const uiMethods: UiMethodSketch[] = Array.isArray(o.uiMethods)
    ? o.uiMethods
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          name: str(x.name, ""),
          kind: x.kind === "write" ? ("write" as const) : ("view" as const),
          description: str(x.description, ""),
          inputs: Array.isArray(x.inputs)
            ? x.inputs
                .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
                .map((f) => ({ name: str(f.name, "value"), type: str(f.type, "uint256") }))
            : [],
          outputs: Array.isArray(x.outputs)
            ? x.outputs
                .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
                .map((f) => ({ name: str(f.name, "value"), type: str(f.type, "uint256") }))
            : [],
        }))
        .filter((x) => x.name)
    : fallback.uiMethods;

  const testScenarios = Array.isArray(o.testScenarios)
    ? o.testScenarios
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          name: str(x.name, ""),
          steps: strArray(x.steps),
          expect: str(x.expect, ""),
        }))
        .filter((x) => x.name)
    : fallback.testScenarios;

  const derived = deriveRuleAnalysis({
    payoutRules,
    oracleActions,
    scheduledActions,
    fairnessModel: str(o.fairnessModel, fallback.fairnessModel),
  });

  const launchRaw = o.launchCompatibility as Record<string, unknown> | undefined;

  return {
    productSummary: str(o.productSummary, fallback.productSummary),
    contractName: pascalCase(str(o.contractName, fallback.contractName)),
    actors: actors.length ? actors : fallback.actors,
    fundsIn: fundsIn.length ? fundsIn : fallback.fundsIn,
    buckets: buckets.length ? buckets : fallback.buckets,
    userActions,
    managerActions,
    scheduledActions,
    oracleActions,
    payoutRules,
    lifecycle: normalizeLifecycle(o.lifecycle, fallback.lifecycle),
    fairnessModel: str(o.fairnessModel, fallback.fairnessModel),
    emergencyControls: str(o.emergencyControls, fallback.emergencyControls),
    trustAssumptions: strArray(o.trustAssumptions).length ? strArray(o.trustAssumptions) : fallback.trustAssumptions,
    uiMethods: uiMethods.length ? uiMethods : fallback.uiMethods,
    viewMethods: strArray(o.viewMethods).length ? strArray(o.viewMethods) : fallback.viewMethods,
    ruleAnalysis: normalizeRuleAnalysis(o.ruleAnalysis, derived),
    launchCompatibility: { notes: strArray(launchRaw?.notes).length ? strArray(launchRaw?.notes) : fallback.launchCompatibility.notes },
    testScenarios: testScenarios.length ? testScenarios : fallback.testScenarios,
    invariants: strArray(o.invariants).length ? strArray(o.invariants) : fallback.invariants,
  };
}

// ── The planner: every prompt produces a MechanicSpec ────────────────────────

function plannerSystemPrompt(): string {
  const ruleList = getAllFlapRules()
    .map((r) => `Rule ${r.id} — ${r.title}: ${r.summary}`)
    .join("\n");
  return `You are the product planner for Flap Vault Gen (a Cursor/v0-style generator for Flap-compatible vaults).
The user describes ANY vault mechanic in plain English or Simplified Chinese. BEFORE any Solidity is
written, you produce a complete MechanicSpec — a free-form product/mechanic plan. This is NOT a template
and there is NO fixed menu of vault types. Design exactly the mechanic the user described.

LANGUAGE: understand the user's request fluently whether it is written in English, Simplified Chinese, or a
mix. Keys, "role"/"mode"/enum-style values, and "contractName" must stay in English (fixed schema / valid
Solidity identifier). Free-text fields meant for a human to read — "productSummary", "description", notes,
"strategy", risk notes — should mirror the user's language: write them in Simplified Chinese when the
user's prompt is primarily Chinese, otherwise in English.

RUNTIME FACTS (ground truth):
- The token is launched by Flap. The vault ONLY receives trade tax as plain BNB in receive() — msg.sender there is the protocol, never a user.
- The vault cannot mint tokens, run an AMM, or render custom UI. The panel is auto-generated from vaultUISchema() (methods + typed fields + countdowns).
- Random/AI outcomes go through the Flap AI Provider (authenticated callback). Scheduled execution uses the Flap Trigger Service or manager cadence.

FLAP CONSTITUTION (Rules 001–009):
${ruleList}

Return ONLY JSON with this shape (all arrays may be empty when genuinely not applicable):
{
  "productSummary": "one confirmable paragraph describing the product",
  "contractName": "PascalCaseName",
  "actors": [{ "role": "holder|manager|keeper|oracle|protocol|external", "description": "..." }],
  "fundsIn": [{ "source": "tax_bnb|user_bnb|user_token", "notes": "..." }],
  "buckets": [{ "name": "freeFormBucketName", "asset": "BNB|taxToken", "creditedBy": ["..."], "debitedBy": ["..."] }],
  "userActions": [{ "name": "freeFormActionName", "caller": "holder", "description": "...", "preconditions": ["..."], "effects": ["..."], "schemaExposed": true, "events": ["..."] }],
  "managerActions": [same shape, "caller": "manager|keeper"],
  "scheduledActions": [{ "action": "...", "interval": "...", "via": "trigger_service|manager|keeper" }],
  "oracleActions": [{ "request": "...", "callback": "...", "refundPath": "..." }],
  "payoutRules": [{
    "trigger": "...", "source": "bucketName", "recipients": "...", "mode": "pull|push_manager_only",
    "distributionMode": "manager_assigned_amount|fixed_per_user|pro_rata_snapshot|winner_takes_all|refund|milestone_unlock",
    "liabilityModel": "reserved_on_approval|credited_before_claim|calculated_from_snapshot|single_winner_pool|event_only_offchain_review",
    "eligibilitySource": "what makes an address eligible (e.g. manager approval of a submitted proof)",
    "claimAmountSource": "where the CLAIM AMOUNT comes from — a per-user mapping/snapshot, never \"the entire shared bucket\" unless winnerTakesAll",
    "winnerTakesAll": false,
    "perUserAccountingRequired": true
  }],
  "lifecycle": null OR {
    "resourceType": "bounty|quest|epoch|contest entry|... (the discrete thing users get attached to; omit/null when none exists)",
    "resourceStates": ["open", "accepted", "submitted", "approved", "claimed"],
    "userStates": ["not_assigned", "assigned", "submitted", "claimable", "claimed"],
    "assignmentModel": "single_assignee|multi_assignee|open_pool|unspecified|not_applicable",
    "maxAssignees": 1,
    "requiresSubmission": "yes|no|unspecified",
    "completionAuthority": "manager|keeper|oracle|automatic|user_self|unspecified",
    "timeoutOrExpiry": "deadline/expiry plan, or empty",
    "abandonPath": "how an assigned user exits on their own — empty means MISSING (stuck-state risk)",
    "cancelPath": "how the manager retires the resource without trapping users — empty means MISSING",
    "rewardReservationPoint": "on_post|on_accept|on_approval|on_settlement|unspecified|not_applicable",
    "stuckStateRisks": ["honest list of ways a user could get stuck"],
    "userExitPaths": ["..."], "managerExitPaths": ["..."],
    "stateVisibilityRequirements": ["views a non-coder needs to see their own state"]
  },
  "fairnessModel": "how Rule 003 is satisfied (committed state, snapshots, fixed pools, oracle outcomes)",
  "emergencyControls": "Rule 009 approach + disclosure",
  "trustAssumptions": ["keeper honesty, oracle trust, manager powers, ..."],
  "uiMethods": [{ "name": "...", "kind": "view|write", "description": "...", "inputs": [{"name":"...","type":"uint256"}], "outputs": [...] }],
  "viewMethods": ["every public state the panel should surface"],
  "ruleAnalysis": { "001": { "applies": true, "strategy": "...", "notes": ["risks or notes"] }, ... "009": {...} },
  "launchCompatibility": { "notes": ["scope/launch notes"] },
  "testScenarios": [{ "name": "...", "steps": ["..."], "expect": "..." }],
  "invariants": ["e.g. sum(buckets) <= balance", "claimables credited before claim"]
}

HARD RULES for the plan:
- Action names are FREE-FORM. Never force the mechanic into a stake/enter/claim/draw/buyback/survivor/lottery vocabulary — use names that fit the user's mechanic.
- Preserve the user's mechanic exactly. Do not silently approximate it into a different product.
- Every action must be a COMPLETE lifecycle edge: if users can claim, something must credit; if users register, something must consume the registration.
- Rule applicability comes from the mechanic structure: any random/AI outcome → Rule 007 applies; any scheduled/automated execution → Rule 008 applies; any payout to users → Rule 003 applies; Rules 001/002/004/005/006/009 always apply.
- receive() may only split tax into the named buckets (Rule 005) — every expensive action is a separate function draining a bucket.
- If the mechanic needs off-chain data (holder rankings, prices), plan a manager/keeper input action with on-chain validation and record the trust assumption.

PAYOUT SEMANTICS (economic correctness — set these explicitly on every payoutRule):
- Default rule: if MULTIPLE users can become eligible for a payout and it is NOT a genuine winner-takes-all/single-winner mechanic, set "winnerTakesAll": false and "perUserAccountingRequired": true, and make claimAmountSource a per-user mapping/snapshot (e.g. claimableRewards[user], pendingReward(user)) — never "the whole bucket".
- Only set "winnerTakesAll": true / distributionMode "winner_takes_all" / liabilityModel "single_winner_pool" when the mechanic genuinely pays ONE winner the entire pool (e.g. a lottery draw). Do not default to this just because a claim function is simple.
- If a user action only emits an event with no on-chain state (e.g. a submitted proof/entry that is not stored), record that as a trustAssumption ("proof review happens off-chain from event logs") unless you also plan on-chain state (a hash/commitment) for the approval step to reference.

LIFECYCLE & STUCK-STATE SAFETY (the user is a NON-CODER — decide or flag, never silently default):
- If the mechanic has a discrete assignable resource (bounty, task, quest, contest entry, ...), fill the "lifecycle" block. If the user did not decide something (single vs multi assignee, reward amount source, abandon/cancel paths, deadlines), set that field to "unspecified"/empty and list the consequence in stuckStateRisks — do NOT invent a risky default.
- Every assigned user must ALWAYS have an exit: claim, complete, abandon, or resource cancellation. Plan abandonPath and cancelPath explicitly.
- Deactivating a shared resource must never trap other assigned users: single_assignee → enforce one assignee on accept; multi_assignee → track completion PER USER and keep each user's exit independent.
- If completion depends on a manager decision, plan what happens when the manager never acts (timeout/expiry or abandon).
- Plan stateVisibilityRequirements so a non-coder can always see: their assignment, their claimable amount, the resource's status, and the funding bucket.`;
}

/**
 * Plan-first entry point: ALWAYS returns a MechanicSpec for any prompt.
 * LLM-planned when an API key is available; deterministic heuristic otherwise.
 * There is no keyword gate — every prompt gets a full lifecycle plan.
 */
export async function planMechanicSpec(
  prompt: string,
  apiKey: string | undefined,
  model: string
): Promise<MechanicSpec> {
  const fallback = inferMechanicSpecFromPrompt(prompt);
  if (!apiKey) return fallback;

  try {
    const { createAiClient } = await import("./ai-client.js");
    const client = createAiClient(apiKey);
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 24000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: plannerSystemPrompt() },
        { role: "user", content: prompt },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return fallback;
    const { extractJsonPayload } = await import("./ai-client.js");
    return normalizeMechanicSpec(JSON.parse(extractJsonPayload(raw)), fallback);
  } catch {
    return fallback;
  }
}

// ── Prompt/pipeline helpers ──────────────────────────────────────────────────

/** Spec block injected into the generation message. */
export function formatMechanicSpecForPrompt(spec: MechanicSpec): string {
  const applied = FLAP_RULE_IDS.filter((id) => spec.ruleAnalysis[id]?.applies);
  return `MECHANIC SPEC (plan-first — implement EXACTLY this mechanic; action names are intentional and free-form):
${JSON.stringify(spec, null, 2)}

Applicable Flap rules per the spec's ruleAnalysis: ${applied.map((id) => `Rule ${id}`).join(", ")}.`;
}

/** Short summary for failure memory / logs. */
export function summarizeMechanicSpec(spec: MechanicSpec): {
  productSummary: string;
  userActions: string[];
  managerActions: string[];
  buckets: string[];
  applicableRules: string[];
  invariants: string[];
} {
  return {
    productSummary: spec.productSummary,
    userActions: spec.userActions.map((a) => a.name),
    managerActions: spec.managerActions.map((a) => a.name),
    buckets: spec.buckets.map((b) => b.name),
    applicableRules: FLAP_RULE_IDS.filter((id) => spec.ruleAnalysis[id]?.applies).map((id) => `Rule ${id}`),
    invariants: spec.invariants,
  };
}

/**
 * Transitional compatibility: derive the legacy VaultPlan.mechanicDesign from
 * the spec so mechanic-completeness keeps working without its keyword gate.
 * requiredSchemaMethods is intentionally left EMPTY so the completeness
 * scanner keeps using its source-derived inference (planner-invented method
 * names must not become blocking requirements — Phase 2 keeps scanner
 * behavior stable).
 */
export function deriveMechanicDesignFromSpec(spec: MechanicSpec): MechanicDesign {
  const hasClaimables = spec.payoutRules.some((p) => p.mode === "pull");
  const mode: MechanicDesign["mode"] =
    spec.userActions.length === 0
      ? spec.payoutRules.length === 0
        ? "pure_accounting"
        : "manager_only"
      : hasClaimables || spec.payoutRules.length > 0
        ? "user_rewards"
        : "registration_only";
  return {
    mode,
    userActions: spec.userActions.map((a) => a.name),
    creditPaths: spec.payoutRules.map((p) => `credit recipients (${p.recipients}) from bucket "${p.source}" on ${p.trigger}`),
    consumptionPaths: spec.userActions
      .filter((a) => a.effects.length > 0)
      .map((a) => `${a.name}: ${a.effects.join("; ")}`),
    requiredSchemaMethods: [],
    lifecycleNotes: [
      ...spec.invariants,
      "Every vaultUISchema.methods[i].name must map to a real function or public variable.",
      "Every external user write and mechanism trigger must appear in vaultUISchema.methods.",
    ],
  };
}
