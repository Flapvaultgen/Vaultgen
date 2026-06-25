/** Vault kind classification — semantic contract before codegen (not a template). */

export type VaultKind =
  | "staking_rewards"
  | "ai_lottery"
  | "survivor_elimination"
  | "buyback"
  | "treasury"
  | "hybrid";

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
  ],
};

export function getVaultKindInvariants(kind: VaultKind): string[] {
  return KIND_INVARIANTS[kind] ?? KIND_INVARIANTS.treasury;
}

/** Regex fallback when OpenAI is unavailable. */
export function inferVaultPlanFromPrompt(prompt: string): VaultPlan {
  const p = prompt.toLowerCase();
  const isStake = /stake|dividend|earn reward|staking/.test(p);
  const isSurvivor = /survivor|eliminat/.test(p);
  const isLottery = /lottery|raffle|jackpot|burn lottery|weekly draw/.test(p);
  const isBuyback = /buyback|buy.?back|burn tax/.test(p);
  const kinds: VaultKind[] = [];
  if (isStake) kinds.push("staking_rewards");
  if (isSurvivor) kinds.push("survivor_elimination");
  if (isLottery) kinds.push("ai_lottery");
  if (isBuyback) kinds.push("buyback");
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
        : isBuyback
          ? ["buybackBudget", "treasury"]
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
  const invariants = getVaultKindInvariants(plan.kind);
  return `
VAULT PLAN (mandatory — you are generating kind: ${plan.kind}):
${JSON.stringify(plan, null, 2)}

NON-NEGOTIABLE INVARIANTS for ${plan.kind}:
${invariants.map((i) => `- ${i}`).join("\n")}

Required public views: ${plan.requiredPublicViews.join(", ") || "none"}
Required events: ${plan.requiredEvents.join(", ") || "none"}
Forbidden patterns: ${plan.forbiddenPatterns.join("; ") || "none"}
Payout mode: ${plan.payoutMode}
Risk disclosures: ${plan.riskDisclosure.join("; ")}

Before returning code, verify the entire ${plan.kind} lifecycle against ALL invariants above.
`;
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
