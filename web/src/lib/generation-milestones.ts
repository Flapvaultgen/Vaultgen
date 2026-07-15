import type { RunStreamEvent } from "./chat-api";

/** Ordered pipeline milestones shown in the chat stepper. */
export const MILESTONE_ORDER = ["plan", "code", "build", "test", "review", "ui", "finalize"] as const;
export type MilestoneId = (typeof MILESTONE_ORDER)[number];

/** Advance the active milestone — retries never move the stepper backwards. */
export function advanceMilestone(current: MilestoneId | null, next: MilestoneId): MilestoneId {
  const curIdx = current ? MILESTONE_ORDER.indexOf(current) : -1;
  const nextIdx = MILESTONE_ORDER.indexOf(next);
  return nextIdx > curIdx ? next : (current ?? next);
}

/** Map a streamed pipeline event to a milestone (if any). */
export function milestoneForEvent(ev: RunStreamEvent): MilestoneId | null {
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "run_started":
      return "plan";
    case "status": {
      if (payload.connected) return "plan";
      if (payload.codeReset) return "code";
      if (typeof payload.contractName === "string") return "build";
      if (typeof payload.explanation === "string") return "finalize";
      switch (payload.phase) {
        case "classifying":
          return "plan";
        case "writing":
          return "code";
        case "compiling":
        case "compile_failed":
        case "fixing":
        case "fixing_spec":
          return "build";
        case "generating_tests":
        case "test_fix":
          return "test";
        case "auditing":
          return "review";
        case "ui_gen":
          return "ui";
        case "done":
          return "finalize";
        default:
          return null;
      }
    }
    case "repair_attempt":
      return "review";
    case "simulation_report":
      return "test";
    case "economic_critique":
      return "review";
    case "code_complete":
    case "run_completed":
      return "finalize";
    default:
      return null;
  }
}
