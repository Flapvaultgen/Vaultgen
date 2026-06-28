import type { CodegenResult } from "./codegen";

export const MAX_TOTAL_PIPELINE_ATTEMPTS = 20;

export function isDeployReady(result: CodegenResult): boolean {
  return result.compiled && result.safety.level !== "fail" && result.integrationTestsPassed;
}

export function getDeployBlockReason(result: CodegenResult): string | null {
  if (isDeployReady(result)) return null;
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
