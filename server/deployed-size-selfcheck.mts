/**
 * Static self-check: prove the EIP-170 deployed-bytecode-size guard fires exactly
 * when a compiled vault's runtime code exceeds the 24,576-byte on-chain limit.
 *
 * Motivation: a real generated vault (CharityVoteVault) compiled to 40,800 bytes
 * of deployed bytecode — 66% over the EIP-170 cap — and sailed through the
 * pipeline (compile + scanners + advisory audit) undetected, only failing for
 * real on BSC testnet with a cryptic DeployFailed() revert. This check ensures
 * that class of bug is caught deterministically, at compile time, going forward.
 *
 * Run: npx tsx deployed-size-selfcheck.mts
 */
import { MAX_DEPLOYED_BYTECODE_SIZE, deployedSizeFinding } from "./codegen.ts";

let failures = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`OK ${name}`);
  } else {
    console.error(`FAIL ${name}`);
    failures++;
  }
}

check("constant matches EIP-170 (24,576 bytes)", MAX_DEPLOYED_BYTECODE_SIZE === 24_576);

check("null size -> no finding (artifact unreadable, not our call to block)", deployedSizeFinding(null) === null);

check("well under the limit -> no finding", deployedSizeFinding(7_459) === null);

check("exactly at the limit -> no finding", deployedSizeFinding(24_576) === null);

const oneOver = deployedSizeFinding(24_577);
check("one byte over -> blocking finding", oneOver !== null && oneOver.level === "block");
check("one byte over -> correct rule id", oneOver?.rule === "deployed-bytecode-exceeds-eip170");

// Real regression case: CharityVoteVault compiled to 40,800 bytes deployed.
const charityVote = deployedSizeFinding(40_800);
check("CharityVoteVault-sized (40,800 bytes) -> blocking finding", charityVote !== null && charityVote.level === "block");
check(
  "finding detail names the actual byte counts (actionable, not vague)",
  Boolean(charityVote?.detail.includes("40800") && charityVote?.detail.includes("24576"))
);
check(
  "finding detail explains WHY (EIP-170 / DeployFailed), not just a raw number",
  Boolean(charityVote?.detail.includes("EIP-170") && charityVote?.detail.includes("DeployFailed"))
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll deployed-bytecode-size checks passed.");
