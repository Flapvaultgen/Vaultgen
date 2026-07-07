export type SafetyFinding = { level: "block" | "warn"; rule: string; detail: string; sourceScope?: "child" | "full-injected" };

export type SpecCheckStatus = "pass" | "warn" | "fail" | "na";

export type SpecCheckItem = {
  id: string;
  title: string;
  status: SpecCheckStatus;
  detail: string;
};

export type SpecAuditResult = {
  level: "pass" | "warn" | "fail" | "skipped";
  summary: string;
  items: SpecCheckItem[];
  mode: "openai" | "skipped";
};

export type FixLogEntry = {
  phase: "writing" | "classifying" | "compile_fix" | "safety_fix" | "test_fix" | "spec_fix" | "generating_tests" | "auditing" | "critic_repair";
  attempt: number;
  rule?: string;
  message: string;
};

/** Cleanup pass: one bounded automatic repair attempt triggered by serious critic findings (+ test failures). */
export type RepairAttempt = {
  attempt: number;
  reason: "critic_finding" | "test_failure" | "critic_and_test";
  model: string;
  escalated: boolean;
  findingsAddressed: string[];
  compileResult: "pass" | "fail";
  scannerResult: "pass" | "fail" | "skip";
  testResult: "pass" | "fail" | "skip";
  criticResult: "clean" | "findings_remain" | "not_rerun";
  remainingIssues: string[];
};

// Phase 6: the VaultKind/VaultPlan taxonomy is retired — the MechanicSpec below
// is the only plan object the UI knows about.

/** Plan-first product spec (Phase 2) — free-form action names, rule-derived analysis. */
export type MechanicActionSpec = {
  name: string;
  caller: "holder" | "manager" | "keeper" | "oracle";
  description: string;
  preconditions: string[];
  effects: string[];
  schemaExposed: boolean;
  events: string[];
};

export type MechanicRuleAnalysisEntry = { applies: boolean; strategy: string; notes: string[] };

/** Phase 8: generic resource/assignment lifecycle (bounty/task/quest/epoch/contest primitives — not templates). */
export type MechanicLifecycleSpec = {
  resourceType: string;
  resourceStates: string[];
  userStates: string[];
  assignmentModel: "single_assignee" | "multi_assignee" | "open_pool" | "unspecified" | "not_applicable";
  maxAssignees: number;
  requiresSubmission: "yes" | "no" | "unspecified";
  completionAuthority: "manager" | "keeper" | "oracle" | "automatic" | "user_self" | "unspecified";
  timeoutOrExpiry: string;
  abandonPath: string;
  cancelPath: string;
  rewardReservationPoint: "on_post" | "on_accept" | "on_approval" | "on_settlement" | "unspecified" | "not_applicable";
  stuckStateRisks: string[];
  userExitPaths: string[];
  managerExitPaths: string[];
  stateVisibilityRequirements: string[];
};

/** Phase 8: one plain-English design decision the user still needs to make. */
export type DesignQuestion = {
  id: string;
  question: string;
  whyItMatters: string;
  options: string[];
  critical: boolean;
};

export type MechanicSpec = {
  productSummary: string;
  contractName: string;
  actors: { role: string; description: string }[];
  fundsIn: { source: "tax_bnb" | "user_bnb" | "user_token"; notes: string }[];
  buckets: { name: string; asset: "BNB" | "taxToken"; creditedBy: string[]; debitedBy: string[] }[];
  userActions: MechanicActionSpec[];
  managerActions: MechanicActionSpec[];
  scheduledActions: { action: string; interval: string; via: "trigger_service" | "manager" | "keeper" }[];
  oracleActions: { request: string; callback: string; refundPath: string }[];
  payoutRules: {
    trigger: string;
    source: string;
    recipients: string;
    mode: "pull" | "push_manager_only";
    /** Phase 7: how the payout amount is decided. */
    distributionMode?: "manager_assigned_amount" | "fixed_per_user" | "pro_rata_snapshot" | "winner_takes_all" | "refund" | "milestone_unlock";
    /** Phase 7: how the liability is tracked before the claim/send. */
    liabilityModel?: "reserved_on_approval" | "credited_before_claim" | "calculated_from_snapshot" | "single_winner_pool" | "event_only_offchain_review";
    eligibilitySource?: string;
    claimAmountSource?: string;
    winnerTakesAll?: boolean;
    perUserAccountingRequired?: boolean;
  }[];
  /** Phase 8: generic resource/assignment lifecycle — null/absent when the mechanic has no discrete lifecycle. */
  lifecycle?: MechanicLifecycleSpec | null;
  fairnessModel: string;
  emergencyControls: string;
  trustAssumptions: string[];
  uiMethods: {
    name: string;
    kind: "view" | "write";
    description: string;
    inputs: { name: string; type: string }[];
    outputs: { name: string; type: string }[];
  }[];
  viewMethods: string[];
  ruleAnalysis: Record<string, MechanicRuleAnalysisEntry>;
  launchCompatibility: { notes: string[] };
  testScenarios: { name: string; steps: string[]; expect: string }[];
  invariants: string[];
};

/** Phase 6 Draft/Launch scope verdict — capability-based, never archetype-based. */
export type ScopeVerdict =
  | "launch_ready_possible"
  | "draft_only"
  | "needs_custom_ui"
  | "needs_protocol_extension"
  | "unsafe_or_unsupported";

export type VaultScope = {
  verdict: ScopeVerdict;
  summary: string;
  supported: string[];
  unsupported: string[];
  /** What would be required to make the ORIGINAL idea launch-ready. */
  requiredForLaunch: string[];
  suggestion: string;
  /** True whenever generation must not continue without an explicit user choice. */
  requiresApproximationConsent: boolean;
};

/** The user's explicit choice when the idea is not launch-ready as requested. */
export type ApproximationConsent = "closest_draft" | "spec_only";

/** Honest record of what an approximated draft kept vs dropped. */
export type ApproximationReport = {
  requested: string;
  preserved: string[];
  dropped: string[];
  whyNotLaunchReady: string;
  requiredForLaunch: string[];
};

export type CodegenResult = {
  contractName: string;
  explanation: string;
  source: string;
  compiled: boolean;
  compileErrors: string;
  safety: { level: "pass" | "warn" | "fail"; findings: SafetyFinding[] };
  specAudit: SpecAuditResult;
  /** THE plan object — the authoritative mechanic plan (primary since Phase 6). */
  mechanicSpec?: MechanicSpec;
  /** Launch-readiness verdict (Phase 6 Draft/Launch model). */
  scope?: VaultScope;
  /** What this result is in the draft/launch flow (Phase 6; Phase 8 adds design_questions). */
  deliverable?: "contract" | "spec_only" | "consent_required" | "refused_unsafe" | "design_questions";
  /** Honest preserved/dropped record when the user consented to a closest-draft approximation. */
  approximation?: ApproximationReport | null;
  /** Phase 8: open plain-English design questions (critical ones pause generation). */
  designQuestions?: DesignQuestion[];
  /** Phase 8: plain-English record of conservative defaults chosen on the user's behalf (after explicit consent). */
  designDecisions?: string[];
  abi: unknown[] | null;
  creationBytecode: string | null;
  bytecodeSize: number | null;
  /** Deployed (runtime) bytecode size in bytes — must stay ≤24,576 (EIP-170) or CREATE2 will always fail. */
  deployedBytecodeSize?: number | null;
  attempts: number;
  integrationTestPath: string | null;
  integrationTestsPassed: boolean;
  /** Structured Rule 006 fork-simulation results (Phase 5) — scenario × rule × pass/fail. */
  simulationReport?: SimulationReport | null;
  /** Phase 7: advisory economic-correctness critic report — never overrides deterministic scanners. */
  economicCritique?: EconomicCriticReport | null;
  /** Cleanup pass: bounded automatic repair attempts (advisory critic feeds repair; gates stay deterministic). */
  repairAttempts?: RepairAttempt[];
  fixLog: FixLogEntry[];
  autoFixExhausted: boolean;
  /**
   * AI-generated bespoke UI for this vault: a Flap vault-component-template
   * source package plus server-compiled JS, rendered in a sandboxed iframe
   * (see lib/vault-ui-bridge.ts VaultUiArtifact). Persisted replays omit the
   * files/compiled payload — it lives in the chat's `vault_ui` artifact.
   */
  uiArtifact?: {
    format?: string;
    files?: { componentTsx: string; vaultAbiTs: string; i18nJson: string; manifestJson: string };
    compiled?: { componentJs: string; vaultAbiJs: string };
    model: string;
    bytes: number;
  } | null;
  mode: "openai" | "stub";
  /** Per-run AI token usage + estimated cost (server-reported; null for stubs). */
  tokenUsage?: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
    estCostUsd: number | null;
  } | null;
};

/** One MechanicSpec-derived simulation scenario result (Phase 5). */
export type SimulationScenarioResult = {
  scenario: string;
  ruleIds: string[];
  actor: string;
  methods: string[];
  expected: string;
  actual: string;
  status: "pass" | "fail" | "skipped";
  failureSummary: string;
  blocksLaunch: boolean;
  notes: string;
};

export type SimulationReport = {
  contractName: string;
  suitePath: string;
  generatedFrom: "mechanic-spec";
  passed: boolean;
  skipped: boolean;
  scenarios: SimulationScenarioResult[];
  rawSummary: string;
};

/** Phase 7: advisory economic-correctness critic finding — never overrides deterministic scanners. */
export type EconomicCriticFinding = {
  severity: "blocking" | "high" | "medium" | "low";
  ruleIds: string[];
  finding: string;
  explanation: string;
  suggestedRepair: string;
};

export type EconomicCriticReport = {
  reviewed: boolean;
  model: string;
  summary: string;
  findings: EconomicCriticFinding[];
};

export type RefineChatTurn = { role: "user" | "assistant"; content: string };

export type RefineSession = {
  initialPrompt: string;
  contractName: string;
  source: string;
  chatHistory: RefineChatTurn[];
};

import { apiUrl, initApiBase } from "./api-base";

export type CodegenEvent =
  | {
      type: "status";
      phase: "writing" | "classifying" | "fixing" | "fixing_spec" | "test_fix" | "compiling" | "compile_failed" | "auditing" | "generating_tests" | "ui_gen" | "done" | "error";
      attempt: number;
      maxAttempts?: number;
      message?: string;
    }
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
      /** Phase 6: idea not launch-ready as requested — generation paused for an explicit choice. */
      type: "consent_required";
      scope: VaultScope;
      spec: MechanicSpec;
      options: { id: ApproximationConsent | "stop"; label: string }[];
    }
  | {
      /** Phase 8: safety-relevant design decisions are missing — generation paused for plain-English answers or an explicit choice. */
      type: "design_questions";
      spec: MechanicSpec;
      questions: DesignQuestion[];
      options: { id: ApproximationConsent | "stop"; label: string }[];
    }
  | { type: "result"; result: CodegenResult }
  | { type: "error"; error: string };

async function consumeSse(res: Response, onEvent: (ev: CodegenEvent) => void): Promise<void> {
  if (!res.body) throw new Error("Empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = raw.trim();
      if (line.startsWith("data:")) {
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as CodegenEvent);
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  }
}

export async function streamVault(
  prompt: string,
  onEvent: (ev: CodegenEvent) => void,
  approximationConsent?: ApproximationConsent
): Promise<void> {
  await initApiBase();
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/codegen-vault-stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, approximationConsent }),
    });
  } catch {
    throw new Error("Can't reach the AI server. Start it with `npm run dev:all`.");
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Codegen failed (${res.status})`);
  }
  await consumeSse(res, onEvent);
}

export async function streamVaultRefine(
  message: string,
  session: RefineSession,
  onEvent: (ev: CodegenEvent) => void
): Promise<void> {
  await initApiBase();
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/codegen-vault-refine-stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session }),
    });
  } catch {
    throw new Error("Can't reach the AI server. Start it with `npm run dev:all`.");
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Refine failed (${res.status})`);
  }
  await consumeSse(res, onEvent);
}

export async function generateVault(prompt: string): Promise<CodegenResult> {
  await initApiBase();
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/codegen-vault"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  } catch {
    throw new Error("Can't reach the AI server. Start it with `npm run dev:all`.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(body.error);
    throw new Error(`Codegen failed (${res.status})`);
  }
  return res.json() as Promise<CodegenResult>;
}
