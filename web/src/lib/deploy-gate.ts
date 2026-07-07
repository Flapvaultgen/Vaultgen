import type { CodegenResult, ScopeVerdict } from "./codegen";
import { isUsableCreationBytecode } from "./flap-register";

export const MAX_TOTAL_PIPELINE_ATTEMPTS = 20;

/**
 * Phase 6: launch is allowed only when the scope verdict says the idea is
 * launch-ready as requested. Missing scope (older results) is treated as
 * launch-ready so existing objective gates keep deciding alone.
 */
export function scopeAllowsLaunch(result: Pick<CodegenResult, "scope" | "deliverable">): boolean {
  if (result.deliverable && result.deliverable !== "contract") return false;
  const verdict = result.scope?.verdict;
  return !verdict || verdict === "launch_ready_possible";
}

/** Human explanation for a scope-verdict launch block. */
export function scopeBlockReason(verdict: ScopeVerdict): string {
  switch (verdict) {
    case "draft_only":
      return "Draft only: the mechanic depends on off-chain/external pieces. Review and redesign the trust model before any launch.";
    case "needs_custom_ui":
      return "The contract may be sound, but the standard Flap panel cannot render the requested experience — build a custom frontend before launching the full product.";
    case "needs_protocol_extension":
      return "Cannot launch as-is: the idea needs primitives outside the Flap vault runtime (second token, AMM/market, or NFTs).";
    case "unsafe_or_unsupported":
      return "Blocked: the mechanic is unsafe or cannot be honestly disclosed.";
    default:
      return "";
  }
}

export function isDeployReady(result: CodegenResult): boolean {
  return (
    result.compiled &&
    result.safety.level !== "fail" &&
    result.integrationTestsPassed &&
    scopeAllowsLaunch(result)
  );
}

/** Compiled vault with bytecode — enough to copy payload and open Flap (even if tests still running/failed). */
export function isLaunchReady(result: CodegenResult): boolean {
  return (
    result.compiled &&
    result.safety.level !== "fail" &&
    isUsableCreationBytecode(result.creationBytecode) &&
    scopeAllowsLaunch(result)
  );
}

export function getDeployBlockReason(result: CodegenResult): string | null {
  if (isDeployReady(result)) return null;
  if (!scopeAllowsLaunch(result)) {
    if (result.deliverable === "spec_only") return "Spec-only draft (your choice) — no contract was generated.";
    if (result.deliverable === "consent_required") return "Waiting for your choice — this idea is not launch-ready as requested.";
    if (result.deliverable === "refused_unsafe") return "Blocked: the mechanic is unsafe or cannot be honestly disclosed.";
    const verdict = result.scope?.verdict;
    if (verdict) return scopeBlockReason(verdict);
  }
  if (!result.compiled) {
    return result.compileErrors
      ? `Compile failed: ${result.compileErrors.split("\n").filter(Boolean).slice(0, 2).join(" ")}`
      : "Contract did not compile.";
  }
  if (result.safety.level === "fail") {
    const rules = result.safety.findings
      .filter((f) => f.level === "block")
      .map((f) => f.rule)
      .slice(0, 3);
    return rules.length ? `Safety blocked: ${rules.join(", ")}` : "Safety scanners blocked deploy.";
  }
  if (!result.integrationTestsPassed) {
    const testFixes = result.fixLog.filter((f) => f.phase === "test_fix");
    const last = testFixes.length > 0 ? testFixes[testFixes.length - 1] : undefined;
    if (last?.rule === "integration-test-infra") {
      return last.message.slice(0, 220);
    }
    const failMatch = last?.message.match(/\[FAIL:[^\]]+\]/);
    if (failMatch) {
      return `Integration tests failed: ${failMatch[0]}`;
    }
    if (last?.message) {
      return `Integration tests failed — auto-fix still in progress or exhausted. ${last.message.slice(0, 140)}`;
    }
    if (result.autoFixExhausted) {
      return "Integration tests still failing after auto-fix attempts. Try a refinement message describing the failure.";
    }
    return "Integration tests did not pass yet.";
  }
  return "Not deploy-ready yet.";
}
