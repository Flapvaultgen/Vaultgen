import type { FixLogEntry } from "./codegen";

export const MAX_PIPELINE_ATTEMPTS = 12;
export const MAX_TEST_FIX_ATTEMPTS = 8;
export const MAX_TOTAL_PIPELINE_ATTEMPTS = MAX_PIPELINE_ATTEMPTS + MAX_TEST_FIX_ATTEMPTS;

export type PipelinePhase =
  | "idle"
  | "writing"
  | "classifying"
  | "fixing"
  | "fixing_spec"
  | "test_fix"
  | "compiling"
  | "compile_failed"
  | "auditing"
  | "generating_tests"
  | "ui_gen"
  | "done"
  | "error";

export type CodeResetInfo = {
  attempt: number;
  reason: "initial" | "retry";
  retryKind?: FixLogEntry["phase"];
  message?: string;
};

export const FIX_PHASE_LABEL: Record<FixLogEntry["phase"], string> = {
  writing: "Initial draft",
  classifying: "Vault classification",
  compile_fix: "Compile error",
  safety_fix: "Safety fix",
  test_fix: "Test failure",
  spec_fix: "Spec fix",
  generating_tests: "Test generation",
  auditing: "Pre-audit",
  critic_repair: "Economic repair",
};

export function describeFixEntry(entry: FixLogEntry): string {
  switch (entry.phase) {
    case "compile_fix":
      return entry.message.slice(0, 160);
    case "safety_fix":
      return entry.rule ? `${entry.rule}: ${entry.message.slice(0, 120)}` : entry.message.slice(0, 140);
    case "spec_fix":
      return entry.rule ? `Rules ${entry.rule} — ${entry.message.slice(0, 100)}` : entry.message.slice(0, 140);
    case "test_fix":
      return entry.message.slice(0, 140);
    case "classifying":
      return "Classifying vault mechanic";
    case "generating_tests":
      return entry.message.includes("/") ? "Integration test written" : entry.message.slice(0, 120);
    case "auditing":
      return entry.message;
    default:
      return entry.message;
  }
}

export function describeCodeReset(info: CodeResetInfo): { title: string; detail: string } {
  if (info.reason === "initial" || info.attempt <= 1) {
    return {
      title: "Starting first draft",
      detail: "The AI is writing your vault contract. This is not a retry.",
    };
  }
  if (info.message) {
    return {
      title: `Pass ${info.attempt} — rewriting contract`,
      detail: info.message,
    };
  }
  const kind = info.retryKind ? FIX_PHASE_LABEL[info.retryKind] : "Auto-fix";
  return {
    title: `Pass ${info.attempt} — rewriting contract`,
    detail: `${kind} required a fresh rewrite. The editor clears so you only see the new draft — this is expected, not a crash.`,
  };
}

export function describePipelineHeadline(
  phase: PipelinePhase,
  attempt: number,
  maxAttempts: number,
  statusMsg: string | null
): string {
  if (statusMsg) return statusMsg;
  switch (phase) {
    case "writing":
      return attempt <= 1 ? "Drafting your vault contract…" : `Rewriting contract (pass ${attempt} of ${maxAttempts})…`;
    case "compiling":
      return "Compiling with solc…";
    case "compile_failed":
      return "Compile failed — preparing another AI pass…";
    case "fixing":
    case "fixing_spec":
    case "test_fix":
      return `Auto-fixing issues (pass ${attempt} of ${maxAttempts})…`;
    case "classifying":
      return "Classifying vault mechanic…";
    case "generating_tests":
      return "Generating integration test…";
    case "auditing":
      return "Running Flap pre-audit (advisory)…";
    case "ui_gen":
      return "Designing the custom vault UI…";
    default:
      return "Working…";
  }
}
