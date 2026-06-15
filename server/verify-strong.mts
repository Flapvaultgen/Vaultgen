/**
 * Strong verify: generate 10 varied vaults, run scanners + deep code review on each output.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { generateVaultCode, scanSafety, scanVaultLogic } from "./codegen.ts";

const OUT = path.join(import.meta.dirname, "verify-strong-runs");

const SCENARIOS: { name: string; prompt: string; tags: string[] }[] = [
  {
    name: "stake-dividend",
    tags: ["stake"],
    prompt:
      "Stake-to-earn: holders stake taxToken and earn pro-rata share of tax BNB using accRewardPerShare. stake, unstake, claimReward. Never size rewards from live balanceOf.",
  },
  {
    name: "buyback",
    tags: ["buyback"],
    prompt:
      "Buyback vault: split incoming tax BNB into buybackBudget and treasury buckets. Manager executes buyback with slippage via _buyAndBurn(minOut from caller). withdrawTreasury for creator.",
  },
  {
    name: "ai-lottery",
    tags: ["lottery"],
    prompt:
      "Weekly burn lottery: tax splits to buyback and jackpot. Holders enter once. Manager requestDraw uses FlapAIConsumerBase to pick winner from snapshotted entrants. Cap entrants at 255.",
  },
  {
    name: "survivor",
    tags: ["survivor", "lottery"],
    prompt:
      "Survivor vault: tax BNB goes to survivorPool. Users stake taxToken to join. Each round manager eliminates one staker using FlapAIConsumerBase random pick from active stakers snapshot. Last remaining staker wins the pool.",
  },
  {
    name: "dual-pool-stake",
    tags: ["stake"],
    prompt:
      "Dual pool staking: users stake into pool A or pool B (uint8 poolId). Tax BNB split 50/50 between pool rewards using separate accRewardPerShare per pool. stake, unstake, claimReward per pool. No live balanceOf payouts.",
  },
  {
    name: "stake-lock",
    tags: ["stake"],
    prompt:
      "Locked stake vault: stake taxToken with minimum 1000 tokens, locked 7 days before unstake. Tax BNB accrues to stakers via accRewardPerShare. claimReward anytime. Track stakeTime per user.",
  },
  {
    name: "charity-split",
    tags: ["buyback"],
    prompt:
      "Charity vault: split each tax deposit 40% buybackBudget, 40% charityBudget, 20% creator treasury. Manager executeBuyback with caller minOut. Creator withdrawCharity to a fixed charity wallet address set at deploy.",
  },
  {
    name: "king-of-hill",
    tags: ["stake"],
    prompt:
      "King of the hill: users stake taxToken to compete. Highest staked address is king. Tax BNB accumulates in rewardPool; king can claimReward once per day if still king. stake and unstake anytime; king updates on stake changes.",
  },
  {
    name: "trigger-buyback",
    tags: ["buyback"],
    prompt:
      "Automated buyback vault: tax fills buybackBudget. Use FlapTriggerService to schedule executeBuyback every 6 hours automatically. Split 90% buyback 10% treasury. trigger() validates sender and executes buyback when budget > 0.",
  },
  {
    name: "new-holder-lottery",
    tags: ["lottery"],
    prompt:
      "New-holder lottery: 24-hour entry window per round. Anyone who bought taxToken since roundStart can enter once. Tax splits to jackpot and buybackBudget. After 24h manager requestDraw uses FlapAIConsumerBase to pick winner from snapshotted entrants. Cap entrants at 255.",
  },
];

function extractChild(source: string, contractName: string): string {
  const i = source.indexOf(`contract ${contractName}`);
  return i >= 0 ? source.slice(i) : source;
}

function fnBody(source: string, name: string): string {
  return source.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)^\\s*\\}`, "m"))?.[1] ?? "";
}

function recvBody(source: string): string {
  return source.match(/receive\s*\(\s*\)\s*external\s+payable[^{]*\{([\s\S]*?)^\s*\}/m)?.[1] ?? "";
}

function stakesRewardPool(source: string): boolean {
  const stake = fnBody(source, "stake");
  if (/rewardPool|pendingRewards/.test(stake)) return true;
  if (/_updatePool\s*\(\)|updatePool\s*\(\)/.test(stake)) {
    return /function\s+_?updatePool[\s\S]*?(accRewardPerShare\s*\+=|rewardPool\s*=\s*0)/.test(source);
  }
  return false;
}

/** Deep manual-style review — checks actual code patterns, not just regex scanners. */
function deepCodeReview(source: string, tags: string[], prompt: string): string[] {
  const issues: string[] = [];
  const recv = recvBody(source);
  const isStake = tags.includes("stake") || (/accRewardPerShare/.test(source) && /function\s+stake\s*\(/.test(source));
  const isBuyback = tags.includes("buyback") || /buybackBudget/.test(source);
  const isLottery = tags.includes("lottery") || (/FlapAIConsumerBase/.test(source) && /entrants|requestDraw/.test(source));
  const isSurvivor = tags.includes("survivor") || /survivorPool|eliminat/i.test(prompt);

  if (isStake) {
    // Tax must not vanish when nobody staked.
    if (/accRewardPerShare\s*\+=/.test(recv) && /totalStaked\s*>\s*0/.test(recv)) {
      const hasFallback =
        /pendingRewards\s*\+=|rewardPool\s*\+=|treasury\s*\+=/.test(recv) ||
        /totalStaked\s*==\s*0[\s\S]{0,80}(pendingRewards|rewardPool|treasury)/.test(recv);
      if (!hasFallback) {
        issues.push("DEEP: receive() accrues only when staked — no pendingRewards/rewardPool fallback");
      }
    }
    if (/accRewardPerShare/.test(source) && /rewardPool\s*-=\s*/.test(source) && /accRewardPerShare\s*\+=/.test(source)) {
      issues.push("DEEP: rewardPool decremented while also using accRewardPerShare accrual");
    }
    const claim = fnBody(source, "claimReward") || fnBody(source, "claim");
    if (/updateUserReward|_updateReward/i.test(claim) && /require\s*\(\s*pending\s*>/.test(claim)) {
      issues.push("DEEP: claimReward harvests then requires pending > 0");
    }
    if (/rewardPool\s*\+=|pendingRewards\s*\+=/.test(recv) && /function\s+stake\s*\(/.test(source) && !stakesRewardPool(source)) {
      issues.push("DEEP: tax buffered in receive but never rolled into rewards on stake");
    }
    if (/pendingRewards\s*\+=/.test(recv) && /function\s+stake\s*\(/.test(source)) {
      const stake = fnBody(source, "stake");
      const rollsFirst =
        /totalStaked\s*\+\s*amount[\s\S]{0,120}pendingRewards|pendingRewards[\s\S]{0,120}totalStaked\s*\+\s*amount/.test(
          stake
        ) || /totalStaked\s*==\s*0[\s\S]{0,120}pendingRewards/.test(stake);
      if (/pendingRewards[\s\S]{0,80}totalStaked\s*>\s*0/.test(stake) && !rollsFirst) {
        issues.push("DEEP: pendingRewards only rolled when totalStaked > 0 — first staker loses pre-stake tax");
      }
    }
    if (/balanceOf\s*\(\s*address\s*\(\s*this\s*\)\s*\)/.test(source) && /claim|_sendNative|reward/i.test(source)) {
      const badSizing = /reward\s*=.*balanceOf|pending\s*=.*balanceOf|share\s*=.*balanceOf/i.test(source);
      if (badSizing) issues.push("DEEP: reward sized from live balanceOf instead of accRewardPerShare");
    }
    if (/function\s+stake\s*\(/.test(source) && !/function\s+claim(?:Reward)?\s*\(/i.test(source)) {
      issues.push("DEEP: stake vault missing claim/claimReward");
    }
    if (/stake-lock|locked|7 days/i.test(prompt)) {
      const unstake = fnBody(source, "unstake");
      if (!/stakeTime|lockUntil|lockDuration|7\s*days|604800/.test(unstake + source)) {
        issues.push("DEEP: lock vault missing time lock check on unstake");
      }
    }
    if (/king/i.test(prompt)) {
      if (!/\bking\b/i.test(source)) issues.push("DEEP: king-of-hill vault does not track king");
      const claim = fnBody(source, "claimReward") || fnBody(source, "claim");
      if (!/lastClaim|once per day|86400|1 days/.test(claim + source)) {
        issues.push("DEEP: king vault missing daily claim throttle");
      }
    }
    if (/dual pool|poolId|pool A/i.test(prompt)) {
      if (!/poolId|poolA|poolB|accRewardPerShareA|accRewardPerShareB/.test(source)) {
        issues.push("DEEP: dual-pool vault missing separate pool accounting");
      }
    }
  }

  if (isBuyback) {
    if (/swapExactInput|_buyAndBurn|_sendNative/.test(recv)) {
      issues.push("DEEP: buyback or payout executed inside receive()");
    }
    if (/buybackBudget|treasury|charityBudget/.test(source)) {
      const emerg = fnBody(source, "emergencyWithdrawNative");
      if (!emerg) {
        issues.push("DEEP: bucket vault missing emergencyWithdrawNative override");
      } else if (!/excess|balance\s*-/.test(emerg)) {
        issues.push("DEEP: emergencyWithdrawNative does not restrict to excess above buckets");
      }
    }
    const buyback = fnBody(source, "executeBuyback");
    if (buyback && !/minTokensOut|minOut|_buyAndBurn\s*\([^,]+,/.test(buyback)) {
      issues.push("DEEP: executeBuyback missing caller-supplied slippage minOut");
    }
    if (/trigger/i.test(prompt)) {
      const trigger = fnBody(source, "trigger");
      if (!trigger) issues.push("DEEP: trigger vault missing trigger() function");
      else if (!/TriggerService|_getFlapTriggerService|onlyTrigger/i.test(trigger + source)) {
        issues.push("DEEP: trigger() does not validate FlapTriggerService sender");
      }
    }
    if (/charity/i.test(prompt)) {
      if (!/charityBudget|charityWallet|charityAddress/.test(source)) {
        issues.push("DEEP: charity vault missing charity bucket or fixed charity address");
      }
    }
  }

  if (isLottery) {
    if (/block\.prevrandao|blockhash\s*\(/.test(source) && !/FlapAIConsumerBase/.test(source)) {
      issues.push("DEEP: lottery uses block entropy instead of FlapAIConsumerBase");
    }
    if (/entrants\.push/.test(source) && !/MAX_ENTRANTS|entrants\.length\s*[<>=]+\s*255/.test(source)) {
      issues.push("DEEP: lottery missing MAX_ENTRANTS cap at 255");
    }
    if (/FlapAIConsumerBase/.test(source) && /requestDraw|requestElimination/.test(source)) {
      if (!/drawSnapshot|entrantSnapshot|stakerSnapshot/.test(source)) {
        issues.push("DEEP: AI draw/elimination without entrant snapshot");
      }
    }
    const enter = fnBody(source, "enter");
    if (/lastDrawTime\s*\+|DRAW_INTERVAL|roundStart\s*\+/.test(enter)) {
      issues.push("DEEP: round timer enforced on enter() — should be on requestDraw only");
    }
    if (/weekly|1 weeks|DRAW_INTERVAL/.test(prompt + source)) {
      const fulfill = fnBody(source, "_fulfillReasoning") || fnBody(source, "drawWinner");
      if (/lastDrawTime/.test(source) && /requestDraw/.test(source)) {
        if (!/lastDrawTime\s*=\s*block\.timestamp/.test(fulfill)) {
          issues.push("DEEP: lastDrawTime not updated after successful draw");
        }
        if (!/lastDrawTime\s*=\s*block\.timestamp/.test(source)) {
          issues.push("DEEP: lastDrawTime not initialized in constructor");
        }
      }
    }
    if (/24.?hour|roundStart/i.test(prompt)) {
      const req = fnBody(source, "requestDraw");
      if (!/roundStart|24\s*hours|86400/.test(req + enter + source)) {
        issues.push("DEEP: timed-round lottery missing 24h window logic");
      }
    }
  }

  if (isSurvivor) {
    if (!/FlapAIConsumerBase/.test(source)) issues.push("DEEP: survivor vault missing FlapAIConsumerBase");
    if (!/survivorPool|prizePool|rewardPool/.test(source)) issues.push("DEEP: survivor vault missing prize pool");
    if (/requestElimination|requestDraw/.test(source) && !/drawSnapshot|Snapshot/.test(source)) {
      issues.push("DEEP: survivor elimination without staker snapshot");
    }
  }

  return issues;
}

await mkdir(OUT, { recursive: true });

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? "gpt-4o";
if (!apiKey) {
  console.error("OPENAI_API_KEY missing");
  process.exit(1);
}

type Row = {
  name: string;
  contractName: string;
  pipelineOk: boolean;
  compiled: boolean;
  safety: string;
  spec: string;
  attempts: number;
  elapsedSec: string;
  scannerBlocks: string[];
  logicIssues: string[];
  deepIssues: string[];
  reviewed: Record<string, boolean>;
};

const rows: Row[] = [];
let anyFail = false;

for (const s of SCENARIOS) {
  console.log(`\n========== ${s.name} ==========`);
  const t0 = Date.now();
  let result;
  try {
    result = await generateVaultCode(s.prompt, apiKey, model);
  } catch (e) {
    console.log("FAIL — generation error:", e instanceof Error ? e.message : e);
    rows.push({
      name: s.name,
      contractName: "?",
      pipelineOk: false,
      compiled: false,
      safety: "fail",
      spec: "fail",
      attempts: 0,
      elapsedSec: "0",
      scannerBlocks: [],
      logicIssues: [],
      deepIssues: [`Generation threw: ${e instanceof Error ? e.message : e}`],
      reviewed: {},
    });
    anyFail = true;
    continue;
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  const child = extractChild(result.source, result.contractName);
  const rescan = scanSafety(child, result.contractName, s.prompt);
  const logic = scanVaultLogic(child, s.prompt);
  const deep = deepCodeReview(child, s.tags, s.prompt);
  const scannerBlocks = rescan.findings.filter((f) => f.level === "block").map((f) => f.rule);

  const reviewed = {
    receiveOk: !deep.some((d) => d.includes("receive()")),
    stakeRewardsOk: !deep.some((d) => /stake|reward|pending|first staker|balanceOf/.test(d)),
    buybackOk: !deep.some((d) => /buyback|bucket|emergency|slippage|trigger|charity/.test(d)),
    lotteryOk: !deep.some((d) => /lottery|entropy|entrant|snapshot|lastDraw|timer|24h/.test(d)),
    survivorOk: !deep.some((d) => /survivor/.test(d)),
  };

  const pipelineOk =
    result.compiled &&
    result.safety.level !== "fail" &&
    result.specAudit.level !== "fail" &&
    logic.length === 0 &&
    deep.length === 0;

  await writeFile(path.join(OUT, `${s.name}.sol`), result.source);
  const row: Row = {
    name: s.name,
    contractName: result.contractName,
    pipelineOk,
    compiled: result.compiled,
    safety: result.safety.level,
    spec: result.specAudit.level,
    attempts: result.attempts,
    elapsedSec: sec,
    scannerBlocks,
    logicIssues: logic,
    deepIssues: deep,
    reviewed,
  };
  rows.push(row);

  console.log(
    pipelineOk ? "PASS" : "FAIL",
    result.contractName,
    `compile=${result.compiled} safety=${result.safety.level} spec=${result.specAudit.level} attempts=${result.attempts} (${sec}s)`
  );
  if (scannerBlocks.length) console.log("  scanner:", scannerBlocks.join(", "));
  if (logic.length) console.log("  logic:", logic.join("; "));
  if (deep.length) console.log("  deep:", deep.join("; "));

  if (!pipelineOk) anyFail = true;
}

const summary = {
  runAt: new Date().toISOString(),
  model,
  total: SCENARIOS.length,
  passed: rows.filter((r) => r.pipelineOk).length,
  failed: rows.filter((r) => !r.pipelineOk).length,
  rows,
};

await writeFile(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

console.log("\n========== SUMMARY ==========");
console.log(`${summary.passed}/${summary.total} passed (pipeline + logic + deep review)`);
for (const r of rows) {
  console.log(`  ${r.pipelineOk ? "✓" : "✗"} ${r.name} → ${r.contractName} (${r.elapsedSec}s)`);
  if (r.deepIssues.length) console.log(`      deep: ${r.deepIssues.join("; ")}`);
}
console.log(`\nOutputs: ${OUT}/`);

process.exit(anyFail ? 1 : 0);
