/**
 * Optional local E2E trial for the critic-driven auto-repair loop.
 * Generation + local compile/scan/fork-test only — NO deployment, NO
 * mainnet/live transactions.
 *
 * Run: npx tsx critic-repair-e2e-trial.mts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", override: true });
dotenv.config();

import { mkdir, writeFile } from "node:fs/promises";
import { generateVaultCode, cleanupCodegen } from "./codegen.ts";
import { resolveAiModel, resolveEscalationModel } from "./ai-model.js";
import { isDeployReady, getDeployBlockReason } from "../web/src/lib/deploy-gate.ts";

const PROMPT =
  "Make a quest-proof reward vault where holders submit quest proof, the manager approves or rejects each submission, and approved users claim manager-assigned BNB rewards from the tax reward bucket.";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("SKIPPED: ANTHROPIC_API_KEY missing — no live E2E trial possible.");
  process.exit(2);
}

const start = Date.now();
console.log(`Model: ${resolveAiModel()} | escalation: ${resolveEscalationModel() ?? "(unset — disabled)"}`);
console.log("Generating (this can take a few minutes)…");

let result = await generateVaultCode(PROMPT, process.env.ANTHROPIC_API_KEY, resolveAiModel());
if (result.deliverable === "design_questions" || result.deliverable === "consent_required") {
  console.log(
    `Pipeline paused (${result.deliverable}) — answering with explicit "closest_draft" consent like the studio UI:`
  );
  for (const q of result.designQuestions) console.log(`  Q: ${q.question}`);
  result = await generateVaultCode(PROMPT, process.env.ANTHROPIC_API_KEY, resolveAiModel(), "closest_draft");
}
const elapsedSec = Math.round((Date.now() - start) / 100) / 10;

const highBlocking =
  result.economicCritique?.findings.filter((f) => f.severity === "high" || f.severity === "blocking") ?? [];

const summary = {
  elapsedSec,
  model: resolveAiModel(),
  escalationModel: resolveEscalationModel(),
  deliverable: result.deliverable,
  compiled: result.compiled,
  safetyLevel: result.safety.level,
  integrationTestsPassed: result.integrationTestsPassed,
  simulationSkipped: result.simulationReport?.skipped ?? null,
  scopeVerdict: result.scope?.verdict ?? null,
  criticReviewed: result.economicCritique?.reviewed ?? false,
  criticFindingCount: result.economicCritique?.findings.length ?? 0,
  highBlockingCritic: highBlocking.map((f) => `[${f.severity}] ${f.finding}`),
  repairAttemptCount: result.repairAttempts.length,
  repairAttempts: result.repairAttempts,
  deployReady: isDeployReady(result),
  deployBlockReason: getDeployBlockReason(result),
  fixLogPhases: result.fixLog.map((f) => `${f.phase}#${f.attempt}`),
};

await mkdir("e2e-runs", { recursive: true });
await writeFile("e2e-runs/critic-repair-trial.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

// Invariants the trial must uphold
let bad = 0;
const must = (name: string, ok: boolean) => {
  console.log(`${ok ? "OK" : "VIOLATION"} ${name}`);
  if (!ok) bad++;
};
must(
  "repair ran when high/blocking critic findings existed (or none existed)",
  highBlocking.length === 0 || result.repairAttempts.length > 0 || !result.compiled || result.safety.level === "fail"
);
must("repair attempts bounded (<= 2 normal + 1 escalation)", result.repairAttempts.length <= (resolveEscalationModel() ? 3 : 2));
must(
  "not deploy-ready unless compile+scanners+tests pass",
  !isDeployReady(result) || (result.compiled && result.safety.level !== "fail" && result.integrationTestsPassed)
);

await cleanupCodegen();
if (bad > 0) process.exit(1);
console.log("\nE2E trial invariants held. No deployment or live transaction was made.");
