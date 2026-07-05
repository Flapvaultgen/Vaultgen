/**
 * Phase 7 — Economic critic pass.
 *
 * A deterministic scanner (mechanic-completeness.ts) already blocks the
 * clear-cut "first claimer drains a shared pool" shape. This module adds an
 * ADVISORY LLM review pass on top of that: it re-reads the generated
 * Solidity against the MechanicSpec and looks for economic/product-quality
 * issues that are real but harder to express as a deterministic regex (e.g.
 * "the description promises multi-user rewards but the code is winner-takes-
 * all", or "manager powers are broader than disclosed").
 *
 * Hard constraints:
 *  - Uses the SAME configured model as the rest of the pipeline (GPT-4o by
 *    default) — no new model names, no routing changes.
 *  - The critic NEVER overrides deterministic scanner results. It is an
 *    additional, advisory quality gate: its findings are attached to the
 *    CodegenResult for display/repair-guidance purposes but never flip
 *    `safety.level` or block compilation/launch on their own.
 */
import type { MechanicSpec } from "./mechanic-spec.js";
import { FLAP_RULE_IDS, formatRuleLabel, type FlapRuleId } from "./constitution.js";

export type CriticSeverity = "blocking" | "high" | "medium" | "low";

export type CriticFinding = {
  severity: CriticSeverity;
  ruleIds: FlapRuleId[];
  finding: string;
  explanation: string;
  suggestedRepair: string;
};

export type EconomicCriticReport = {
  /** False when the critic could not run at all (no API key / call failed) — never treated as "clean". */
  reviewed: boolean;
  model: string;
  summary: string;
  findings: CriticFinding[];
};

/** The checklist the critic must apply — kept in one place so prompt + selfchecks stay in sync. */
export const CRITIC_CHECKLIST: string[] = [
  "first claimant drains a shared pool meant for multiple eligible users",
  "missing per-user accounting (no claimable/credited mapping) for a multi-user payout",
  "approval/eligibility granted to an address without referencing what that address submitted",
  "an event-only user action that should have created on-chain state instead",
  "payout amount sourced from a global/shared bucket without explicit winner-takes-all semantics",
  "missing claimableRewards (or equivalent) per-user liability mapping",
  "manager/creator powers broader than what description() or vaultUISchema discloses",
  "Guardian/emergency reach over user-custodied funds not disclosed (Rule 009)",
  "description() or the MechanicSpec promises multi-user rewards but the code implements winner-takes-all (or vice versa)",
  "vaultUISchema lacks a useful view for the user's own status or claimable amount",
  // Phase 8: lifecycle / stuck-state review.
  "a user can become stuck: assigned/accepted with no way to claim, complete, abandon, or move on",
  "missing abandon or cancel path for an assignable resource (bounty/task/quest/entry)",
  "manager can mark completion/approval without the required user submission existing on-chain",
  "multiple users can accept a single-assignee resource (no assignee/status enforcement on accept)",
  "deactivating a shared resource traps other assigned users' per-user state",
  "missing user status views: the user cannot see whether they are eligible, assigned, or able to claim (and how much)",
  "description() says 'holders' but the code never checks holder eligibility",
  "hardcoded reward constants not derived from the MechanicSpec (an amount the user never chose)",
  "vaultUISchema hides important state (resource status, assignment, claimable amount, funding bucket)",
  "description() promises a mechanic (deadline, proof, exclusivity, exit) that the code does not enforce",
  "any other mismatch between the MechanicSpec's stated economics and what the Solidity actually does",
];

function buildEconomicCriticPrompt(contractName: string, spec: MechanicSpec): string {
  const checklist = CRITIC_CHECKLIST.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const applicableRules = FLAP_RULE_IDS.filter((id) => spec.ruleAnalysis[id]?.applies).map((id) => formatRuleLabel(id));
  return `You are the ECONOMIC CRITIC for Flap Vault Gen. Deterministic scanners already caught structural bugs
(missing base, unsafe receive(), custom errors, ...). Your job is different: read the generated Solidity for
${contractName} against its MechanicSpec and judge whether the MECHANIC is economically honest and fair —
not whether it compiles.

You do NOT block generation and you do NOT replace the deterministic scanners. You produce an advisory report
that a human (or the repair loop) can act on. Be concrete: cite the exact function/mapping involved.

Checklist — look specifically for:
${checklist}

MechanicSpec (authoritative product plan — judge the code against THIS, not a generic template):
${JSON.stringify(
  {
    productSummary: spec.productSummary,
    buckets: spec.buckets,
    userActions: spec.userActions,
    managerActions: spec.managerActions,
    payoutRules: spec.payoutRules,
    lifecycle: spec.lifecycle,
    fairnessModel: spec.fairnessModel,
    trustAssumptions: spec.trustAssumptions,
    invariants: spec.invariants,
  },
  null,
  1
)}

Applicable Flap rules for this mechanic: ${applicableRules.join(", ") || "Rules 001-009 (general)"}.

Return ONLY JSON with this shape:
{
  "summary": "one short paragraph: is the mechanic's economics honest and fair as implemented?",
  "findings": [
    {
      "severity": "blocking|high|medium|low",
      "ruleIds": ["001", "003", "004"],
      "finding": "short finding name, e.g. first-claimer-drains-shared-pool",
      "explanation": "what is wrong, citing the exact function/mapping",
      "suggestedRepair": "concrete Solidity-level fix"
    }
  ]
}

If the mechanic is economically sound and matches its MechanicSpec, return an empty "findings" array.
Use "blocking" severity ONLY for issues that let one user take funds owed to another eligible user, that
leave an accepted/assigned user permanently stuck (cannot claim, complete, abandon, or exit), or that
contradict an explicit MechanicSpec guarantee. Use "high" for undisclosed trust/manager-power mismatches
and missing abandon/cancel paths. Use "medium"/"low" for missing views or minor honesty gaps.`;
}

function normalizeSeverity(v: unknown): CriticSeverity {
  return v === "blocking" || v === "high" || v === "medium" || v === "low" ? v : "medium";
}

function normalizeRuleIds(v: unknown): FlapRuleId[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.replace(/^Rule\s*/i, "").trim() : ""))
    .filter((x): x is FlapRuleId => (FLAP_RULE_IDS as readonly string[]).includes(x));
}

/** Normalize raw LLM JSON into CriticFinding[] — malformed/missing fields are dropped, never invented. */
export function normalizeCriticFindings(raw: unknown): CriticFinding[] {
  if (!Array.isArray(raw)) return [];
  const findings: CriticFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const finding = typeof o.finding === "string" ? o.finding.trim() : "";
    if (!finding) continue;
    findings.push({
      severity: normalizeSeverity(o.severity),
      ruleIds: normalizeRuleIds(o.ruleIds),
      finding,
      explanation: typeof o.explanation === "string" ? o.explanation.trim() : "",
      suggestedRepair: typeof o.suggestedRepair === "string" ? o.suggestedRepair.trim() : "",
    });
  }
  return findings;
}

/**
 * Run the economic critic pass. Uses the SAME model/apiKey already configured
 * for the pipeline (no new model, no routing change). Never throws — a
 * failed/unavailable critic returns `reviewed: false` with no findings, and
 * the caller must treat that as "not reviewed", never as "clean".
 */
export async function runEconomicCriticPass(
  contractName: string,
  source: string,
  spec: MechanicSpec,
  apiKey: string | undefined,
  model: string
): Promise<EconomicCriticReport> {
  if (!apiKey) {
    return { reviewed: false, model, summary: "Skipped: no API key configured.", findings: [] };
  }
  try {
    const { createAiClient } = await import("./ai-client.js");
    const client = createAiClient(apiKey);
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 8000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildEconomicCriticPrompt(contractName, spec) },
        { role: "user", content: source.slice(0, 60_000) },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { reviewed: true, model, summary: "Critic returned no content.", findings: [] };
    const { extractJsonPayload } = await import("./ai-client.js");
    const parsed = JSON.parse(extractJsonPayload(raw)) as { summary?: unknown; findings?: unknown };
    return {
      reviewed: true,
      model,
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      findings: normalizeCriticFindings(parsed.findings),
    };
  } catch (err) {
    return {
      reviewed: false,
      model,
      summary: `Critic pass failed: ${err instanceof Error ? err.message : String(err)}`,
      findings: [],
    };
  }
}

/** Exported for prompt-content selfchecks. */
export { buildEconomicCriticPrompt };
