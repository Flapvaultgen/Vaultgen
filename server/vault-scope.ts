/**
 * Scope verdict — Phase 6 Draft/Launch model.
 *
 * Replaces the old fit taxonomy (native / approximate / custom_ui / out_of_scope)
 * with an explicit launch-readiness verdict. The question is never "does this
 * match an archetype?" — it is:
 *
 *   1. Can this be expressed as a Flap-compatible vault under Rules 001–009?
 *   2. Can the standard Flap panel render it through vaultUISchema()?
 *   3. Does it require a custom UI?
 *   4. Does it require non-Flap protocol primitives (second token, AMM, NFT,
 *      external market, backend service)?
 *   5. Can we still produce a useful draft/spec even if it is not launch-ready?
 *
 * Any verdict other than `launch_ready_possible` requires EXPLICIT user consent
 * before generation proceeds — silent approximation is forbidden.
 */

export type ScopeVerdict =
  | "launch_ready_possible" //  Flap-compatible vault; can launch once compile/safety/test gates are green
  | "draft_only" //             expressible as a spec/draft, but depends on off-chain/external pieces — not launch-ready
  | "needs_custom_ui" //        the contract can work, but the standard Flap panel cannot render the requested experience
  | "needs_protocol_extension" // needs primitives Flap vaults don't have (second token, AMM, NFT, external market)
  | "unsafe_or_unsupported"; // the mechanic itself is unsafe or forbidden — do not build it

export const SCOPE_VERDICTS: ScopeVerdict[] = [
  "launch_ready_possible",
  "draft_only",
  "needs_custom_ui",
  "needs_protocol_extension",
  "unsafe_or_unsupported",
];

export type VaultScope = {
  verdict: ScopeVerdict;
  /** One-line honest summary shown to the user before generation. */
  summary: string;
  /** What a Flap vault + standard panel WILL deliver for this idea. */
  supported: string[];
  /** What it will NOT deliver as requested, and why. */
  unsupported: string[];
  /** What would be required to make the ORIGINAL idea launch-ready. */
  requiredForLaunch: string[];
  /** How to proceed. */
  suggestion: string;
  /** True whenever generation must not continue without an explicit user choice. */
  requiresApproximationConsent: boolean;
};

/** The user's explicit choice when the idea is not launch-ready as requested. */
export type ApproximationConsent = "closest_draft" | "spec_only";

export type ConsentGateDecision =
  | { action: "proceed"; asDraft: boolean }
  | { action: "spec_only" }
  | { action: "await_consent" }
  | { action: "refuse_unsafe" };

/**
 * Central consent gate: silent approximation is impossible.
 * - launch-ready ideas proceed normally;
 * - unsafe ideas are refused regardless of consent;
 * - everything else halts until the user explicitly picks
 *   "closest_draft" or "spec_only".
 */
export function consentGate(scope: VaultScope, consent?: ApproximationConsent): ConsentGateDecision {
  if (scope.verdict === "unsafe_or_unsupported") return { action: "refuse_unsafe" };
  if (scope.verdict === "launch_ready_possible") return { action: "proceed", asDraft: false };
  if (consent === "closest_draft") return { action: "proceed", asDraft: true };
  if (consent === "spec_only") return { action: "spec_only" };
  return { action: "await_consent" };
}

/** Honest record of what an approximated draft kept vs dropped. */
export type ApproximationReport = {
  requested: string;
  preserved: string[];
  dropped: string[];
  whyNotLaunchReady: string;
  requiredForLaunch: string[];
};

export function buildApproximationReport(userPrompt: string, scope: VaultScope): ApproximationReport {
  return {
    requested: userPrompt.trim().slice(0, 400),
    preserved: scope.supported,
    dropped: scope.unsupported,
    whyNotLaunchReady: scope.summary,
    requiredForLaunch: scope.requiredForLaunch,
  };
}

const RUNTIME_SUPPORTED = [
  "Accumulating trade-tax BNB in receive() and splitting it into named buckets",
  "User/manager/keeper actions, timers, pull-payment claims, oracle draws (Flap AI)",
  "Buyback & burn of the launched token via the Flap Portal",
  "Auto-generated UI from vaultUISchema() (methods, typed inputs, live views, countdowns)",
];

function withConsentFlag(scope: Omit<VaultScope, "requiresApproximationConsent">): VaultScope {
  return { ...scope, requiresApproximationConsent: scope.verdict !== "launch_ready_possible" };
}

/**
 * Heuristic verdict (zero-latency, no API key needed) — seed the LLM refines.
 * Conservative: when unsure it returns launch_ready_possible so buildable ideas
 * are never scared away. Never keyed on archetype matching.
 */
export function inferVaultScopeFromPrompt(prompt: string): VaultScope {
  const p = prompt.toLowerCase();

  // ── Unsafe or forbidden mechanics — refuse regardless of consent. ──
  const unsafe =
    /\bponzi\b|\bpyramid scheme\b|\brug\s?(pull)?\b|\bhoneypot\b|\bexit scam\b/.test(p) ||
    /\b(block|prevent|disable|stop)\b[^.]{0,25}\b(sell|selling|sells|withdraw)/.test(p) ||
    /\bguaranteed\b[^.]{0,20}\b(profit|return|apy|yield)/.test(p) ||
    /\b(hidden|secret)\b[^.]{0,20}\b(fee|mint|owner|backdoor|switch)/.test(p) ||
    /\bdrain\b[^.]{0,20}\b(user|holder|wallet)/.test(p) ||
    /\bsteal\b/.test(p);
  if (unsafe) {
    return withConsentFlag({
      verdict: "unsafe_or_unsupported",
      summary:
        "This mechanic involves guarantees, restrictions, or hidden behavior that is unsafe for holders and violates the Flap constitution (Rules 001/004/009 honesty and custody requirements).",
      supported: [],
      unsupported: [
        "Guaranteed returns, sell-blocking, hidden owner powers, or holder-draining mechanics",
        "Any behavior that cannot be truthfully disclosed in description() and vaultUISchema()",
      ],
      requiredForLaunch: ["A redesigned mechanic with honest disclosure and no holder-hostile behavior"],
      suggestion: "Describe the honest version of the incentive you want — e.g. disclosed taxes, time locks users opt into, or transparent reward pools.",
    });
  }

  // ── Needs primitives a Flap tax vault does not have. ──
  const newOrSecondToken =
    /\b(dual|second|paired|two)[-\s]?token\b/.test(p) ||
    /\bsatokey\b/.test(p) ||
    /\b(mint|issue|create|launch|deploy)\b[^.]{0,40}\b(new |its own |our own |a |an )?(erc-?20|erc-?721|erc-?1155|nft|token|coin)\b/.test(p);
  const ownMarket =
    /\bbonding curve\b[^.]{0,30}\b(market|amm|exchange|pricing|mint|sell|buy)\b/.test(p) ||
    /\b(own|custom|internal)\b[^.]{0,20}\b(amm|dex|exchange|order ?book|liquidity pool)\b/.test(p) ||
    /\border ?book\b/.test(p);
  const nft = /\bnft\b|\berc-?721\b|\berc-?1155\b|non-?fungible/.test(p);
  if (newOrSecondToken || ownMarket || nft) {
    const what = nft
      ? "minting/managing NFTs"
      : ownMarket
        ? "running its own AMM / bonding-curve market"
        : "issuing or pairing a second token";
    return withConsentFlag({
      verdict: "needs_protocol_extension",
      summary: `This idea involves ${what}, which a Flap vault cannot do — the token is launched by Flap and the vault only receives trade tax as BNB.`,
      supported: RUNTIME_SUPPORTED,
      unsupported: [
        "Minting a new or second token from the vault",
        "Running an in-vault AMM / bonding-curve market or order book",
        "NFT minting or custody as a product mechanic",
      ],
      requiredForLaunch: [
        "Separate contracts for the second token / market / NFT (outside the Flap vault runtime)",
        "A custom frontend for the non-standard trading experience",
      ],
      suggestion:
        "Choose: build the closest Flap-compatible draft (e.g. tax-funded buyback/treasury version), keep this as a spec-only draft, or plan a separate protocol-extension track.",
    });
  }

  // ── Depends on off-chain/backend pieces — draftable, not launch-ready. ──
  const offChain =
    /\boff-?chain\b|\bbackend\b|\bweb ?api\b|\bserver(-side)?\b|\bdatabase\b|\bkyc\b/.test(p) ||
    /\b(chainlink|external|real-?world|sports?|match|weather|stock|fiat)\b[^.]{0,30}\b(data|feed|score|result|price|event)/.test(p) ||
    /\b(twitter|x\.com|discord|telegram|instagram)\b/.test(p);
  if (offChain) {
    return withConsentFlag({
      verdict: "draft_only",
      summary:
        "The core vault can be drafted, but the mechanic depends on off-chain/external data or services that the Flap vault runtime cannot verify on its own.",
      supported: RUNTIME_SUPPORTED,
      unsupported: [
        "Trustless consumption of external/off-chain data (scores, social activity, fiat prices)",
        "Backend services — the vault only sees on-chain state and Flap oracle callbacks",
      ],
      requiredForLaunch: [
        "An on-chain-verifiable replacement for the external dependency (e.g. manager attestation with disclosed trust, or the Flap AI oracle)",
        "Review of the trust assumptions the replacement introduces",
      ],
      suggestion:
        "Choose: generate a draft where the manager (or Flap AI oracle) supplies the external outcome with disclosed trust, or keep this as a spec-only draft.",
    });
  }

  // ── Contract can work, but the standard panel cannot render the request. ──
  const customUi =
    /\b(price |candlestick |trading ?view )?chart\b|\bgraph\b|\bdashboard\b|\bleaderboard\b|\bcustom (ui|interface|frontend|front-end|page|app)\b/.test(
      p
    ) || /\bmint\b[^.]{0,20}\bsell\b|\bbuy\b[^.]{0,20}\bsell\b[^.]{0,20}\bcurve\b/.test(p);
  if (customUi) {
    return withConsentFlag({
      verdict: "needs_custom_ui",
      summary:
        "The on-chain mechanic fits a Flap vault, but the requested experience (charts/dashboard/custom widgets) will not render on the standard Flap panel — it only shows methods, fields, and countdowns.",
      supported: RUNTIME_SUPPORTED,
      unsupported: [
        "Price charts, candlesticks, leaderboard graphics, or bespoke dashboards",
        "Custom trading widgets — the standard panel renders forms and buttons only",
      ],
      requiredForLaunch: ["A custom frontend on top of the vault's view methods (the contract itself can still be sound)"],
      suggestion:
        "Choose: build the mechanic now for the standard panel (draft), keep it as spec-only, or plan a custom frontend before launching the full experience.",
    });
  }

  return withConsentFlag({
    verdict: "launch_ready_possible",
    summary: "This can be expressed as a Flap-compatible vault under Rules 001–009 and rendered by the standard panel.",
    supported: RUNTIME_SUPPORTED,
    unsupported: [],
    requiredForLaunch: [],
    suggestion: "Generate, review the plan and tests, then launch when every gate is green.",
  });
}

/**
 * Scope verdict: heuristic seed refined by the LLM when available.
 * Uses the SAME production model passed by the caller (GPT-4o) — no new routing.
 */
export async function classifyVaultScope(
  prompt: string,
  apiKey: string | undefined,
  model: string
): Promise<VaultScope> {
  const fallback = inferVaultScopeFromPrompt(prompt);
  if (!apiKey) return fallback;

  try {
    const { createAiClient } = await import("./ai-client.js");
    const client = createAiClient(apiKey);
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You judge whether a vault idea can LAUNCH as a Flap vault under Flap Rules 001–009, rendered by the standard auto-generated panel. Never judge by matching an archetype — judge by capability.

RUNTIME FACTS (ground truth — do not assume more):
- The token is launched by Flap. The vault only RECEIVES trade tax as BNB in receive().
- The vault CANNOT mint a new/second token, run its own AMM/bonding-curve market, order book, or NFTs.
- The vault CANNOT read off-chain data (sports scores, social activity, fiat prices) by itself; it only sees on-chain state and authenticated Flap AI oracle callbacks.
- The vault CAN: split BNB into buckets, buyback&burn the launched token via the Flap Portal, custody the launched token, run oracle draws, timers, registrations, votes, pull-payment claims, treasury.
- The UI is auto-generated from vaultUISchema(): view/write METHODS with typed inputs, output fields, countdowns. It CANNOT render charts, dashboards, leaderboard graphics, or bespoke trading widgets.
- Unsafe mechanics (guaranteed returns, sell-blocking, hidden owner powers, holder-draining) are forbidden regardless of demand.

Return ONLY JSON:
{
  "verdict": "launch_ready_possible|draft_only|needs_custom_ui|needs_protocol_extension|unsafe_or_unsupported",
  "summary": "one honest sentence the user reads before generation",
  "supported": ["what a Flap vault WILL deliver for this idea"],
  "unsupported": ["what it will NOT deliver as requested, and why"],
  "requiredForLaunch": ["what would be required to make the ORIGINAL idea launch-ready"],
  "suggestion": "how to proceed"
}

verdict guide:
- launch_ready_possible: expressible as a Flap vault under Rules 001–009; standard panel renders it
- draft_only: a useful spec/draft exists, but it depends on off-chain/external pieces or unresolved trust
- needs_custom_ui: the contract can work; the standard panel cannot render the requested experience
- needs_protocol_extension: needs a second token, AMM/market, NFT, or other non-Flap primitive
- unsafe_or_unsupported: the mechanic is holder-hostile or cannot be honestly disclosed — refuse
Be encouraging for launch-ready ideas; be honest (not dismissive) for the rest.

LANGUAGE: the idea may be described in English or Simplified Chinese — read either fluently. "verdict" must
stay the exact enum token in English (fixed schema value). Write "summary", "supported", "unsupported",
"requiredForLaunch", and "suggestion" in Simplified Chinese when the user's prompt is primarily Chinese;
otherwise write them in English.`,
        },
        { role: "user", content: prompt },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return fallback;
    const { extractJsonPayload } = await import("./ai-client.js");
    const obj = JSON.parse(extractJsonPayload(raw)) as Partial<VaultScope>;
    const verdict = obj.verdict as ScopeVerdict;
    return withConsentFlag({
      verdict: SCOPE_VERDICTS.includes(verdict) ? verdict : fallback.verdict,
      summary: typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim() : fallback.summary,
      supported: Array.isArray(obj.supported) && obj.supported.length ? obj.supported : fallback.supported,
      unsupported: Array.isArray(obj.unsupported) ? obj.unsupported : fallback.unsupported,
      requiredForLaunch: Array.isArray(obj.requiredForLaunch) ? obj.requiredForLaunch : fallback.requiredForLaunch,
      suggestion: typeof obj.suggestion === "string" && obj.suggestion.trim() ? obj.suggestion.trim() : fallback.suggestion,
    });
  } catch {
    return fallback;
  }
}
