/**
 * Generate N vaults, rescan with latest rules, and run logic checks on child contract.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { generateVaultCode, scanSafety, scanVaultLogic } from "./codegen.ts";
import { resolveOpenAiModel } from "./openai-model.js";

const OUT = path.join(import.meta.dirname, "verify-runs");

const PROMPTS = [
  {
    name: "stake-dividend",
    prompt:
      "Stake-to-earn: holders stake taxToken and earn pro-rata share of tax BNB using accRewardPerShare. stake, unstake, claimReward. Never size rewards from live balanceOf.",
  },
  {
    name: "buyback",
    prompt:
      "Buyback vault: split incoming tax BNB into buybackBudget and treasury buckets. Manager executes buyback with slippage via _buyAndBurn(minOut from caller). withdrawTreasury for creator.",
  },
  {
    name: "ai-lottery",
    prompt:
      "Weekly burn lottery: tax splits to buyback and jackpot. Holders enter once. Manager requestDraw uses FlapAIConsumerBase to pick winner from snapshotted entrants. Cap entrants at 255.",
  },
];

function extractChild(source: string, name: string): string {
  const i = source.indexOf(`contract ${name}`);
  return i >= 0 ? source.slice(i) : source;
}

await mkdir(OUT, { recursive: true });

const apiKey = process.env.OPENAI_API_KEY;
const model = resolveOpenAiModel();
let anyFail = false;

for (const p of PROMPTS) {
  console.log(`\n========== ${p.name} ==========`);
  const t0 = Date.now();
  const result = await generateVaultCode(p.prompt, apiKey, model);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  const child = extractChild(result.source, result.contractName);
  const rescan = scanSafety(child, result.contractName, p.prompt);
  const logic = scanVaultLogic(child, p.prompt);

  const safetyBlocks = rescan.findings.filter((f) => f.level === "block");
  const pipelineOk =
    result.compiled && result.safety.level !== "fail" && result.specAudit.level !== "fail" && logic.length === 0;

  await writeFile(path.join(OUT, `${p.name}.sol`), result.source);
  await writeFile(
    path.join(OUT, `${p.name}-report.json`),
    JSON.stringify(
      {
        contractName: result.contractName,
        compiled: result.compiled,
        safety: result.safety.level,
        safetyBlocks: safetyBlocks.map((b) => b.rule),
        rescanBlocks: safetyBlocks.map((b) => ({ rule: b.rule, detail: b.detail })),
        spec: result.specAudit.level,
        attempts: result.attempts,
        logicIssues: logic,
        pipelineOk,
        elapsedSec: sec,
        fixLog: result.fixLog,
      },
      null,
      2
    )
  );

  console.log(
    pipelineOk ? "PASS" : "FAIL",
    result.contractName,
    `compile=${result.compiled} safety=${result.safety.level} spec=${result.specAudit.level} attempts=${result.attempts} (${sec}s)`
  );
  if (safetyBlocks.length) console.log("  scanner blocks:", safetyBlocks.map((b) => b.rule).join(", "));
  if (logic.length) console.log("  logic issues:", logic);
  if (result.fixLog.length) console.log("  fixLog:", result.fixLog.map((f) => f.phase + (f.rule ? `:${f.rule}` : "")).join(" -> "));

  if (!pipelineOk) anyFail = true;
}

console.log(`\n${anyFail ? "SOME FAILED" : "ALL 3 PASSED (pipeline + logic review)"}`);
process.exit(anyFail ? 1 : 0);
