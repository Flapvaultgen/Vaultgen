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
import { buildMoneyFlowTable, formatMoneyFlowTable, hasNontrivialLedger } from "./money-flow.js";

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
  // Solvency: the arithmetic across functions, not any single suspicious line.
  "a bucket's free/available balance is computed without subtracting everything already owed (per-user claimables included), so the same BNB can be promised twice",
  "an amount stops being counted as reserved at the moment it becomes owed to a user, with nothing tracking it in between",
  "missing user status views: the user cannot see whether they are eligible, assigned, or able to claim (and how much)",
  "description() says 'holders' but the code never checks holder eligibility",
  "hardcoded reward constants not derived from the MechanicSpec (an amount the user never chose)",
  "vaultUISchema hides important state (resource status, assignment, claimable amount, funding bucket)",
  "description() promises a mechanic (deadline, proof, exclusivity, exit) that the code does not enforce",
  "any other mismatch between the MechanicSpec's stated economics and what the Solidity actually does",
];

/**
 * The obligation that turns "read this and spot the bug" into "check this
 * arithmetic". A vault can match none of the known bad shapes and still be
 * insolvent, because solvency is a property of every write to every money
 * variable at once. The ledger is extracted deterministically (money-flow.ts) so
 * the model spends its budget verifying rather than transcribing.
 *
 * The `solvency` array in the response is a required scratchpad, not data we
 * consume: forcing the per-bucket enumeration is what makes the model actually
 * do the addition instead of pattern-matching. Do not "optimise" it away.
 */
function buildSolvencyObligation(ledger: string): string {
  return `${ledger}

PROOF OBLIGATION — you MUST work through this before writing any finding:
For EACH native bucket in the ledger above:
  a. List every claim on it: aggregate counters that reserve it, AND every per-user
     liability mapping that is credited from it.
  b. Using the writes table, check the identity: after ANY sequence of calls,
     sum(all claims on the bucket) <= bucket.
  c. A function that credits a per-user liability MUST do one of two things, or the
     identity breaks: debit the bucket right there, or increment an aggregate that
     EVERY free-balance expression subtracts. Check which one it does. "There is a
     claimable mapping" is NOT sufficient — do the arithmetic.
  d. If a free-balance expression omits a claim, give the concrete call sequence
     that leaves a user unable to be paid, and report it as "blocking".
Treating an amount as reserved and then releasing that reservation at the moment it
becomes owed to a user — without anything else tracking it — always breaks the
identity. Look specifically for that.`;
}

function buildEconomicCriticPrompt(contractName: string, spec: MechanicSpec, ledger?: string): string {
  const checklist = CRITIC_CHECKLIST.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const solvency = ledger ? `\n\n${buildSolvencyObligation(ledger)}` : "";
  const applicableRules = FLAP_RULE_IDS.filter((id) => spec.ruleAnalysis[id]?.applies).map((id) => formatRuleLabel(id));
  return `You are the ECONOMIC CRITIC for Flap Vault Gen. Deterministic scanners already caught structural bugs
(missing base, unsafe receive(), custom errors, ...). Your job is different: read the generated Solidity for
${contractName} against its MechanicSpec and judge whether the MECHANIC is economically honest and fair —
not whether it compiles.

You do NOT block generation and you do NOT replace the deterministic scanners. You produce an advisory report
that a human (or the repair loop) can act on. Be concrete: cite the exact function/mapping involved.

Checklist — look specifically for:
${checklist}${solvency}

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
  "solvency": [
    {
      "bucket": "bucket variable name",
      "claims": ["every counter and per-user mapping that has a claim on it"],
      "creditSites": ["function -> does it debit the bucket, increment a tracked aggregate, or neither?"],
      "verdict": "sound|unsound",
      "worstCaseSequence": "if unsound: the call sequence that leaves a user unpaid"
    }
  ],
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

Every bucket you mark "unsound" MUST have a matching "blocking" finding. Fill "solvency" for every
bucket even when everything checks out — that enumeration is the work, not paperwork.

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
    const ledger = formatMoneyFlowTable(buildMoneyFlowTable(source));
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 8000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildEconomicCriticPrompt(contractName, spec, ledger) },
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

/**
 * Whether this source deserves the stronger model for its critic pass: it holds
 * pooled BNB and owes per-user amounts out of it, so a solvency mistake is the
 * difference between a launchable vault and one that cannot pay its users. One
 * stronger critic call costs a fraction of the rewrite passes a missed finding
 * causes later, so the spend is targeted rather than across the board.
 */
export function ledgerWarrantsStrongCritic(source: string): boolean {
  return hasNontrivialLedger(buildMoneyFlowTable(source));
}

/** Exported for prompt-content selfchecks. */
export { buildEconomicCriticPrompt, buildSolvencyObligation };
