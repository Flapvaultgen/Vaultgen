/** Vault kind classification — semantic contract before codegen (not a template). */

export type VaultKind =
  | "staking_rewards"
  | "ai_lottery"
  | "survivor_elimination"
  | "buyback"
  | "treasury"
  | "hybrid";

export type MechanicDesign = {
  mode: "pure_accounting" | "user_rewards" | "registration_only" | "manager_only";
  userActions: string[];
  creditPaths: string[];
  consumptionPaths: string[];
  requiredSchemaMethods: string[];
  lifecycleNotes: string[];
};

export type VaultPlan = {
  kind: VaultKind;
  usesNativeRewards: boolean;
  usesEntrants: boolean;
  usesFlapAI: boolean;
  usesStaking: boolean;
  requiresTokenHolding: boolean;
  requiresPullPayments: boolean;
  nativeBuckets: string[];
  tokenCustodyBuckets: string[];
  requiredPublicViews: string[];
  requiredEvents: string[];
  forbiddenPatterns: string[];
  stateVariables: string[];
  payoutMode: string;
  riskDisclosure: string[];
  mechanicDesign?: MechanicDesign;
};

const DEFAULT_PLAN: VaultPlan = {
  kind: "treasury",
  usesNativeRewards: true,
  usesEntrants: false,
  usesFlapAI: false,
  usesStaking: false,
  requiresTokenHolding: false,
  requiresPullPayments: false,
  nativeBuckets: ["treasury"],
  tokenCustodyBuckets: [],
  requiredPublicViews: ["treasury"],
  requiredEvents: [],
  forbiddenPatterns: [],
  stateVariables: ["treasury"],
  payoutMode: "manager-withdraw",
  riskDisclosure: ["Guardian Rule 009 can recover funds"],
};

const KIND_INVARIANTS: Record<VaultKind, string[]> = {
  staking_rewards: [
    "receive(): if totalStaked == 0 store in undistributedRewards; else accRewardPerShare += msg.value * 1e18 / totalStaked",
    "stake(): require(amount > 0); claim or preserve pending BEFORE changing user.amount; use balance delta for fee-on-transfer",
    "claimReward(): pay exactly once; update rewardDebt before _sendNative",
    "Do NOT auto-pay in stake() if claimReward() exists",
    "pendingReward(user) must match what claimReward() can pay — do not include undistributedRewards unless claimable",
    "Disclose Guardian Rule 009 emergency recovery in description() and vaultUISchema",
  ],
  ai_lottery: [
    "Snapshot entrants to drawSnapshot before AI request",
    "require(jackpot > fee) not >=",
    "Pull payment: claimablePrize[winner] += prize in _fulfillReasoning — never _sendNative(winner) in callback",
    "Emit DrawRequested, DrawRefunded, AiModelUpdated",
    "Clear lastDrawFee after fulfill/refund; delete drawSnapshot on refund",
    "Wording: AI-provider selected — not secure random",
  ],
  survivor_elimination: [
    "Rebuild entrants from drawSnapshot BEFORE delete drawSnapshot",
    "Never use drawSnapshot.length == 1 for winner — count survivors after elimination",
    "Reset hasEntered[winner] = false on final win",
    "Pull payment for survivor pool payout",
  ],
  buyback: [
    "receive() only increments buybackBudget/treasury buckets",
    "executeBuyback zeros buybackBudget before _buyAndBurn",
    "Only burn swap-received token delta",
  ],
  treasury: [
    "receive() only increments named buckets",
    "Pay from specific buckets — never address(this).balance",
  ],
  hybrid: [
    "Satisfy ALL applicable mechanic invariants from the combined design",
    "Keep receive() cheap — bucket accounting only",
    "Every user-facing function must have a complete lifecycle — no dead register/claim paths",
  ],
};

const NOVEL_MECHANIC_INVARIANTS = [
  "If you expose register*() AND claim*(), advance/distribute MUST credit claimableRewards[user] += share OR remove unused paths",
  "If claimableRewards/claimablePrize mapping exists, some function MUST do mapping[user] += amount before claim reads it",
  "If register*() sets flags, advance/distribute MUST read those flags or a registrant address[] and loop payouts",
  "milestoneIndex + milestoneTargets[] MUST use require(milestoneIndex < milestoneTargets.length) before indexing",
  "Every external user write (register, claim, stake, enter) MUST appear in vaultUISchema.methods",
  "Do NOT zero milestonePool/rewardPool on advance unless rewards are distributed or vault is pure burn-only (no claim)",
];

export function getVaultKindInvariants(kind: VaultKind): string[] {
  return KIND_INVARIANTS[kind] ?? KIND_INVARIANTS.treasury;
}

/** Regex fallback when OpenAI is unavailable. */
export function inferVaultPlanFromPrompt(prompt: string): VaultPlan {
  const p = prompt.toLowerCase();
  const isStake = /stake|dividend|earn reward|staking/.test(p);
  const isSurvivor = /survivor|eliminat/.test(p);
  const isLottery = /lottery|raffle|jackpot|burn lottery|weekly draw/.test(p);
  const isBuyback = /buyback|buy.?back|burn tax|milestone burn/.test(p);
  const isMilestone = /milestone|threshold|tier|epoch target/.test(p);
  const kinds: VaultKind[] = [];
  if (isStake) kinds.push("staking_rewards");
  if (isSurvivor) kinds.push("survivor_elimination");
  if (isLottery) kinds.push("ai_lottery");
  if (isBuyback) kinds.push("buyback");
  if (isMilestone && !isStake && !isLottery) kinds.push("buyback");
  const kind: VaultKind =
    kinds.length > 1 ? "hybrid" : kinds[0] ?? (/treasury|split|bucket/.test(p) ? "treasury" : "treasury");

  const usesFlapAI = isLottery || isSurvivor || /ai oracle|flap ai/.test(p);
  const usesStaking = isStake;
  const usesEntrants = isLottery || isSurvivor;

  return {
    kind,
    usesNativeRewards: true,
    usesEntrants,
    usesFlapAI,
    usesStaking,
    requiresTokenHolding: /holder|hold token|must hold/.test(p),
    requiresPullPayments: usesFlapAI || isLottery || isSurvivor,
    nativeBuckets: isStake
      ? ["undistributedRewards"]
      : isLottery
        ? ["jackpot", "buybackBudget"]
        : isBuyback || isMilestone
          ? ["buybackBudget", "milestonePool", "treasury"]
          : ["treasury"],
    tokenCustodyBuckets: usesStaking ? ["staked taxToken"] : [],
    requiredPublicViews: usesStaking
      ? ["totalStaked", "accRewardPerShare", "pendingReward"]
      : isLottery
        ? ["jackpot", "pendingRequestId"]
        : ["treasury"],
    requiredEvents: usesFlapAI
      ? ["DrawRequested", "DrawRefunded", "AiModelUpdated"]
      : [],
    forbiddenPatterns: [
      ...(usesFlapAI ? ["_sendNative(winner) in _fulfillReasoning", "block.prevrandao for winner"] : []),
      ...(usesStaking ? ["auto-pay in stake() when claimReward exists"] : []),
    ],
    stateVariables: usesStaking
      ? ["totalStaked", "accRewardPerShare", "undistributedRewards", "userInfo"]
      : isLottery
        ? ["jackpot", "entrants", "drawSnapshot", "claimablePrize", "pendingRequestId"]
        : ["treasury"],
    payoutMode: usesStaking ? "pull-or-explicit-claim" : usesFlapAI ? "pull" : "manager-withdraw",
    riskDisclosure: usesStaking
      ? ["Guardian Rule 009 can recover staked tokens and reward BNB"]
      : ["Guardian Rule 009 can recover funds"],
  };
}

export function buildVaultPlanPromptAppendix(plan: VaultPlan): string {
  const invariants = [
    ...getVaultKindInvariants(plan.kind),
    ...(plan.mechanicDesign || plan.kind === "hybrid" ? NOVEL_MECHANIC_INVARIANTS : []),
  ];
  const designBlock = plan.mechanicDesign
    ? `
MECHANIC DESIGN (commit before writing Solidity — every path must be wired):
${JSON.stringify(plan.mechanicDesign, null, 2)}
`
    : "";
  return `
VAULT PLAN (mandatory — you are generating kind: ${plan.kind}):
${JSON.stringify({ ...plan, mechanicDesign: plan.mechanicDesign ?? undefined }, null, 2)}
${designBlock}
NON-NEGOTIABLE INVARIANTS for ${plan.kind}:
${invariants.map((i) => `- ${i}`).join("\n")}

Required public views: ${plan.requiredPublicViews.join(", ") || "none"}
Required events: ${plan.requiredEvents.join(", ") || "none"}
Forbidden patterns: ${plan.forbiddenPatterns.join("; ") || "none"}
Payout mode: ${plan.payoutMode}
Risk disclosures: ${plan.riskDisclosure.join("; ")}

Before returning code, verify the entire ${plan.kind} lifecycle against ALL invariants above.
If mode is pure_accounting: do NOT add register/claim unless they do something real.
If mode is user_rewards: every claim mapping MUST be credited in advance/distribute.
`;
}

export { isNovelMechanicPrompt } from "./mechanic-completeness.js";

/** Expand novel/hybrid prompts into an explicit lifecycle contract before codegen. */
export async function expandMechanicDesign(
  prompt: string,
  plan: VaultPlan,
  apiKey: string | undefined,
  model: string
): Promise<VaultPlan> {
  const { isNovelMechanicPrompt } = await import("./mechanic-completeness.js");
  if (!isNovelMechanicPrompt(prompt) && plan.kind !== "hybrid") return plan;

  const fallback: MechanicDesign = {
    mode: /\bclaim\b|\breward\b/i.test(prompt) ? "user_rewards" : "pure_accounting",
    userActions: [],
    creditPaths: /\bclaim\b/i.test(prompt) ? ["claimableRewards[user] += in advance/distribute"] : [],
    consumptionPaths: /\bregister\b/i.test(prompt) ? ["registeredInterest read in advanceMilestone"] : [],
    requiredSchemaMethods: [],
    lifecycleNotes: [
      "Either implement full register -> advance -> credit -> claim, or remove dead user actions",
    ],
  };

  if (!apiKey) return { ...plan, mechanicDesign: fallback };

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Design a complete mechanic lifecycle for a Flap tax vault BEFORE Solidity is written.
Return JSON:
{
  "mode": "pure_accounting|user_rewards|registration_only|manager_only",
  "userActions": ["registerInterest", "claimReward", ...],
  "creditPaths": ["where claimableRewards gets += ..."],
  "consumptionPaths": ["where registration flags/arrays are read ..."],
  "requiredSchemaMethods": ["every user external write + key views"],
  "lifecycleNotes": ["plain English wiring rules"]
}

Rules:
- pure_accounting: milestone burn only — NO register/claim unless purely informational with no claimReward
- user_rewards: register MUST connect to advance/distribute which MUST credit claimable* before claim
- If prompt says "eligibility only" / "no payout" -> registration_only, no claimReward
- List every function the UI must expose in requiredSchemaMethods`,
        },
        { role: "user", content: `Vault plan kind: ${plan.kind}\nPrompt:\n${prompt}` },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { ...plan, mechanicDesign: fallback };
    const d = JSON.parse(raw) as Partial<MechanicDesign>;
    return {
      ...plan,
      kind: plan.kind === "treasury" && isNovelMechanicPrompt(prompt) ? "hybrid" : plan.kind,
      mechanicDesign: {
        mode: (d.mode as MechanicDesign["mode"]) ?? fallback.mode,
        userActions: Array.isArray(d.userActions) ? d.userActions : fallback.userActions,
        creditPaths: Array.isArray(d.creditPaths) ? d.creditPaths : fallback.creditPaths,
        consumptionPaths: Array.isArray(d.consumptionPaths) ? d.consumptionPaths : fallback.consumptionPaths,
        requiredSchemaMethods: Array.isArray(d.requiredSchemaMethods) ? d.requiredSchemaMethods : fallback.requiredSchemaMethods,
        lifecycleNotes: Array.isArray(d.lifecycleNotes) ? d.lifecycleNotes : fallback.lifecycleNotes,
      },
    };
  } catch {
    return { ...plan, mechanicDesign: fallback };
  }
}

export async function classifyVaultPlan(
  prompt: string,
  apiKey: string | undefined,
  model: string
): Promise<VaultPlan> {
  const fallback = inferVaultPlanFromPrompt(prompt);
  if (!apiKey) return fallback;

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Classify a Flap tax vault idea into a VaultPlan JSON. This is NOT a template — it is a semantic contract the generated Solidity must obey.

Return ONLY valid JSON matching this shape:
{
  "kind": "staking_rewards|ai_lottery|survivor_elimination|buyback|treasury|hybrid",
  "usesNativeRewards": boolean,
  "usesEntrants": boolean,
  "usesFlapAI": boolean,
  "usesStaking": boolean,
  "requiresTokenHolding": boolean,
  "requiresPullPayments": boolean,
  "nativeBuckets": ["string"],
  "tokenCustodyBuckets": ["string"],
  "requiredPublicViews": ["string"],
  "requiredEvents": ["string"],
  "forbiddenPatterns": ["string"],
  "stateVariables": ["string"],
  "payoutMode": "pull|pull-or-explicit-claim|manager-withdraw",
  "riskDisclosure": ["string"]
}

Rules:
- AI lottery / burn lottery / weekly draw -> ai_lottery, usesFlapAI true, requiresPullPayments true
- Survivor / elimination -> survivor_elimination, usesFlapAI true
- Stake / dividend / earn -> staking_rewards, usesStaking true
- Buyback / burn -> buyback
- Multiple mechanics -> hybrid with union of requirements
- Staking: include undistributedRewards bucket, pendingReward view, Guardian Rule 009 disclosure`,
        },
        { role: "user", content: prompt },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return fallback;
    const obj = JSON.parse(raw) as Partial<VaultPlan>;
    const kind = (obj.kind ?? fallback.kind) as VaultKind;
    return {
      kind: ["staking_rewards", "ai_lottery", "survivor_elimination", "buyback", "treasury", "hybrid"].includes(kind)
        ? kind
        : fallback.kind,
      usesNativeRewards: obj.usesNativeRewards ?? fallback.usesNativeRewards,
      usesEntrants: obj.usesEntrants ?? fallback.usesEntrants,
      usesFlapAI: obj.usesFlapAI ?? fallback.usesFlapAI,
      usesStaking: obj.usesStaking ?? fallback.usesStaking,
      requiresTokenHolding: obj.requiresTokenHolding ?? fallback.requiresTokenHolding,
      requiresPullPayments: obj.requiresPullPayments ?? fallback.requiresPullPayments,
      nativeBuckets: Array.isArray(obj.nativeBuckets) ? obj.nativeBuckets : fallback.nativeBuckets,
      tokenCustodyBuckets: Array.isArray(obj.tokenCustodyBuckets) ? obj.tokenCustodyBuckets : fallback.tokenCustodyBuckets,
      requiredPublicViews: Array.isArray(obj.requiredPublicViews) ? obj.requiredPublicViews : fallback.requiredPublicViews,
      requiredEvents: Array.isArray(obj.requiredEvents) ? obj.requiredEvents : fallback.requiredEvents,
      forbiddenPatterns: Array.isArray(obj.forbiddenPatterns) ? obj.forbiddenPatterns : fallback.forbiddenPatterns,
      stateVariables: Array.isArray(obj.stateVariables) ? obj.stateVariables : fallback.stateVariables,
      payoutMode: obj.payoutMode ?? fallback.payoutMode,
      riskDisclosure: Array.isArray(obj.riskDisclosure) ? obj.riskDisclosure : fallback.riskDisclosure,
    };
  } catch {
    return fallback;
  }
}

export function isStakingPlan(plan: VaultPlan): boolean {
  return plan.kind === "staking_rewards" || (plan.kind === "hybrid" && plan.usesStaking);
}

export function isLotteryPlan(plan: VaultPlan): boolean {
  return plan.kind === "ai_lottery" || (plan.kind === "hybrid" && plan.usesFlapAI && plan.usesEntrants);
}

export function isSurvivorPlan(plan: VaultPlan): boolean {
  return plan.kind === "survivor_elimination" || (plan.kind === "hybrid" && /survivor|eliminat/i.test(plan.stateVariables.join(" ")));
}
