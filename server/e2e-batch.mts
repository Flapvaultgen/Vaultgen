import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateVaultCode, scanSafety } from "./codegen.ts";

const OUT = path.join(import.meta.dirname, "e2e-runs");

const SCENARIOS: { name: string; prompt: string }[] = [
  {
    name: "buyback",
    prompt:
      "Buyback vault: split incoming tax BNB into buybackBudget and treasury buckets. Manager executes buyback with slippage via _buyAndBurn(minOut from caller). withdrawTreasury for creator.",
  },
  {
    name: "stake-dividend",
    prompt:
      "Stake-to-earn: holders stake taxToken and earn pro-rata share of tax BNB using accRewardPerShare. stake, unstake, claimReward. Never size rewards from live balanceOf.",
  },
  {
    name: "ai-lottery",
    prompt:
      "Weekly burn lottery: each tax deposit splits to buyback bucket and jackpot. Users enter once if they hold tokens. Manager requestDraw uses FlapAIConsumerBase to pick winner from snapshotted entrants. Freeze enter during pending draw.",
  },
  {
    name: "demo-burn-lottery",
    prompt:
      "Weekly burn lottery: split tax to buybackBudget and jackpot. Holders enter once per round. Manager requestDraw uses FlapAIConsumerBase to pick winner from snapshotted entrants. Weekly cadence on requestDraw only. Cap entrants at 255.",
  },
  {
    name: "survivor",
    prompt:
      "Survivor vault: tax BNB goes to survivorPool. Users stake taxToken to join. Each round manager eliminates one staker using FlapAIConsumerBase random pick from active stakers snapshot. Last remaining staker wins the pool. unstake only when eliminated or after winning.",
  },
  {
    name: "new-holder-lottery",
    prompt:
      "New-holder lottery (nieuw style): 24-hour entry window per round. Anyone who bought taxToken since roundStart can enter once. Tax splits to jackpot and buybackBudget. After 24h manager requestDraw uses FlapAIConsumerBase to pick winner from snapshotted entrants. Cap entrants at 255.",
  },
  {
    name: "charity-split",
    prompt:
      "Charity vault: split each tax deposit 40% buybackBudget, 40% charityBudget, 20% creator treasury. Manager executeBuyback with caller minOut. Creator withdrawCharity to a fixed charity wallet address set at deploy.",
  },
  {
    name: "stake-lock",
    prompt:
      "Locked stake vault: stake taxToken with minimum 1000 tokens, locked 7 days before unstake. Tax BNB accrues to stakers via accRewardPerShare. claimReward anytime. Track stakeTime per user.",
  },
  {
    name: "king-of-hill",
    prompt:
      "King of the hill: users stake taxToken to compete. Highest staked address is king. Tax BNB accumulates in rewardPool; king can claimReward once per day if still king. stake and unstake anytime; king updates on stake changes.",
  },
  {
    name: "trigger-buyback",
    prompt:
      "Automated buyback vault: tax fills buybackBudget. Use FlapTriggerService to schedule executeBuyback every 6 hours automatically (no manager timing). Split 90% buyback 10% treasury. trigger() validates sender and executes buyback when budget > 0.",
  },
  {
    name: "milestone-burn",
    prompt:
      "Milestone burn vault: track totalReceived from tax. At every 1 BNB milestone manager can executeBuyback from buybackBudget. Remaining tax goes to treasury. Emit MilestoneReached events.",
  },
  {
    name: "dual-pool-stake",
    prompt:
      "Dual pool staking: users stake into pool A or pool B (uint8 poolId). Tax BNB split 50/50 between pool rewards using separate accRewardPerShare per pool. stake, unstake, claimReward per pool. No live balanceOf payouts.",
  },
];

await mkdir(OUT, { recursive: true });

type Row = {
  scenario: string;
  ok: boolean;
  contractName: string;
  compiled: boolean;
  safety: string;
  safetyBlocks: string[];
  safetyWarns: string[];
  spec: string;
  specFails: string[];
  attempts: number;
  autoFixExhausted: boolean;
  elapsedSec: number;
  error?: string;
};

const rows: Row[] = [];

for (const s of SCENARIOS) {
  const t0 = Date.now();
  process.stdout.write(`\n=== ${s.name} ===\n`);
  try {
    const result = await generateVaultCode(s.prompt, process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL ?? "gpt-4o");
    const elapsedSec = (Date.now() - t0) / 1000;
    const childStart = result.source.indexOf(`contract ${result.contractName}`);
    const childBody = childStart >= 0 ? result.source.slice(childStart) : result.source;
    const rescan = scanSafety(childBody, result.contractName, s.prompt);
    const specFails = result.specAudit.items.filter((i) => i.status === "fail").map((i) => i.id);
    const safetyBlocks = result.safety.findings.filter((f) => f.level === "block").map((f) => f.rule);
    const rescanBlocks = rescan.findings.filter((f) => f.level === "block").map((f) => f.rule);
    const allWarns = [...result.safety.findings, ...rescan.findings]
      .filter((f) => f.level === "warn")
      .map((f) => f.rule);
    const ok =
      result.compiled &&
      result.safety.level !== "fail" &&
      result.specAudit.level !== "fail" &&
      rescanBlocks.length === 0;

    await writeFile(path.join(OUT, `${s.name}-${result.contractName}.sol`), result.source);
    await writeFile(path.join(OUT, `${s.name}-meta.json`), JSON.stringify({ ...result, source: undefined }, null, 2));

    rows.push({
      scenario: s.name,
      ok,
      contractName: result.contractName,
      compiled: result.compiled,
      safety: result.safety.level,
      safetyBlocks: [...new Set([...safetyBlocks, ...rescanBlocks])],
      safetyWarns: [...new Set(allWarns)],
      spec: result.specAudit.level,
      specFails,
      attempts: result.attempts,
      autoFixExhausted: result.autoFixExhausted,
      elapsedSec: Math.round(elapsedSec * 10) / 10,
    });

    console.log(
      ok ? "PASS" : "FAIL",
      result.contractName,
      `compile=${result.compiled} safety=${result.safety.level} spec=${result.specAudit.level} attempts=${result.attempts}`
    );
    if (safetyBlocks.length || rescanBlocks.length) console.log("  safety blocks:", [...new Set([...safetyBlocks, ...rescanBlocks])]);
    if (allWarns.length) console.log("  safety warns:", [...new Set(allWarns)]);
    if (specFails.length) console.log("  spec fails:", specFails);
    if (result.fixLog.length) console.log("  fixLog:", result.fixLog.map((f) => `${f.phase}:${f.rule ?? ""}`).join(" -> "));
  } catch (err) {
    rows.push({
      scenario: s.name,
      ok: false,
      contractName: "?",
      compiled: false,
      safety: "fail",
      safetyBlocks: [],
      safetyWarns: [],
      spec: "fail",
      specFails: [],
      attempts: 0,
      autoFixExhausted: false,
      elapsedSec: (Date.now() - t0) / 1000,
      error: err instanceof Error ? err.message : String(err),
    });
    console.log("ERROR", err);
  }
}

await writeFile(path.join(OUT, "summary.json"), JSON.stringify(rows, null, 2));
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
