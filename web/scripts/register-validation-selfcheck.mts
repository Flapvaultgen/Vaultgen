/**
 * Deterministic selfchecks for the registerVault validation + error decoding
 * (web/src/lib/register-validation.ts). No chain access, no wallet.
 *
 * Run: npm run test:register  (from web/)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodeErrorResult, toFunctionSelector, toFunctionSignature } from "viem";
import {
  CODEGEN_FACTORY_REGISTER_ABI,
  KNOWN_RPC_GAS_CAP,
  MAX_REGISTER_INIT_CODE,
  MIN_PLAUSIBLE_CREATION_BYTECODE,
  REGISTER_FUNCTION_SIGNATURE,
  checkRegisterPayload,
  creationBytecodeByteLength,
  decodeRegisterRevert,
  exceedsKnownRpcGasCap,
  isUsableCreationBytecode,
  registerVaultGasLimit,
} from "../src/lib/register-validation";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));

// ── 1. ABI matches src/CodegenVaultFactory.sol ───────────────────────────────

const soliditySource = readFileSync(join(here, "../../src/CodegenVaultFactory.sol"), "utf8");
check(
  "Solidity registerVault(bytes,string) signature present",
  /function registerVault\(bytes calldata creationCode, string calldata vaultDescription\) external/.test(soliditySource)
);

const abiRegister = CODEGEN_FACTORY_REGISTER_ABI.find((e) => e.type === "function" && e.name === "registerVault");
check(
  "frontend ABI registerVault selector matches Solidity signature",
  abiRegister !== undefined &&
    toFunctionSelector(toFunctionSignature(abiRegister as never)) ===
      toFunctionSelector("registerVault(bytes,string)")
);
check(
  "REGISTER_FUNCTION_SIGNATURE constant matches ABI",
  REGISTER_FUNCTION_SIGNATURE.startsWith("registerVault(bytes") && REGISTER_FUNCTION_SIGNATURE.includes("string")
);

for (const errName of ["EmptyInitCode", "InitCodeTooLarge", "DeployFailed", "NotRegistered"]) {
  check(
    `factory custom error ${errName} in Solidity and frontend ABI`,
    soliditySource.includes(`error ${errName}`) &&
      CODEGEN_FACTORY_REGISTER_ABI.some((e) => e.type === "error" && e.name === errName)
  );
}

// ── 2. payload validation ─────────────────────────────────────────────────────

const address20Bytes = `0x${"ab".repeat(20)}`;
const plausible = `0x6080604052${"00".repeat(MIN_PLAUSIBLE_CREATION_BYTECODE)}`;

check("missing payload rejected", checkRegisterPayload(null)?.code === "missing");
check("empty 0x rejected", checkRegisterPayload("0x")?.code === "missing");
check("non-hex rejected", checkRegisterPayload("0xzz1122")?.code === "not_hex");
check("odd-length hex rejected", checkRegisterPayload("0xabc")?.code === "odd_length");
check("20-byte address-like payload rejected", checkRegisterPayload(address20Bytes)?.code === "address_like");
check(
  "20-byte rejection message names the cause",
  checkRegisterPayload(address20Bytes)!.message.includes("address, not creation bytecode")
);
check("tiny payload rejected", checkRegisterPayload("0x60806040")?.code === "too_small");
check(
  "oversized payload rejected",
  checkRegisterPayload(`0x${"00".repeat(MAX_REGISTER_INIT_CODE + 1)}`)?.code === "too_large"
);
check("plausible compiler bytecode accepted", checkRegisterPayload(plausible) === null);
check("isUsableCreationBytecode agrees with checkRegisterPayload", isUsableCreationBytecode(plausible));
check("isUsableCreationBytecode rejects 20-byte payload", !isUsableCreationBytecode(address20Bytes));
check("byte length math", creationBytecodeByteLength(address20Bytes) === 20);

// ── 3. gas limit is a floor-clamped formula, never for invalid payloads ──────

const bigBytecode = `0x${"00".repeat(25_000)}` as `0x${string}`;
const gasBig = registerVaultGasLimit(bigBytecode);
// Calibrated against real on-chain BytecodeStorage (SSTORE2-chunked) gas measurements —
// see test/BytecodeStorage.t.sol's console.log output. The factory's storage cost is now
// low enough that even the max-size payload stays comfortably under the known RPC cap.
check("gas limit for 25KB bytecode comfortably under the 16.7M RPC cap", gasBig < 16_000_000n && gasBig > 4_000_000n);
check("gas limit floor is 1M", registerVaultGasLimit("0x60806040") === 1_000_000n);
check("KNOWN_RPC_GAS_CAP matches the documented go-ethereum default", KNOWN_RPC_GAS_CAP === 16_777_216n);
check(
  "max-size (49,152 byte) payload no longer exceeds the known RPC gas cap post-fix",
  !exceedsKnownRpcGasCap(`0x${"00".repeat(MAX_REGISTER_INIT_CODE)}` as `0x${string}`)
);
check(
  "small bytecode (~1KB) does not trip the cap warning",
  !exceedsKnownRpcGasCap(`0x${"00".repeat(1_000)}` as `0x${string}`)
);

// ── 4. revert decoding ────────────────────────────────────────────────────────

const ctx = {
  chainId: 97,
  factoryAddress: "0x71fb0a7fa1ac291cf77975a6fe0848cac8ce6c65",
  wallet: "0x1111111111111111111111111111111111111111",
  bytecodeBytes: 25_615,
  descriptionLength: 120,
};

// Blank revert reason (the reported bug): must never yield a blank message.
const blankRevert = new Error('The contract function "registerVault" reverted with the following reason:\n\n');
const decodedBlank = decodeRegisterRevert(blankRevert, ctx);
check("blank revert reason replaced with diagnostics", decodedBlank.reason.length > 40);
check("blank revert diagnostics include factory + chain", decodedBlank.reason.includes(ctx.factoryAddress) && decodedBlank.reason.includes("97"));
check("blank revert diagnostics include payload size", decodedBlank.reason.includes("25,615"));

// Custom error decoding from raw revert data in the error chain.
const initTooLargeData = encodeErrorResult({
  abi: CODEGEN_FACTORY_REGISTER_ABI,
  errorName: "InitCodeTooLarge",
  args: [50_000n],
});
const errWithData = Object.assign(new Error("execution reverted"), { cause: { data: initTooLargeData } });
const decodedCustom = decodeRegisterRevert(errWithData, ctx);
check("InitCodeTooLarge decoded from raw revert data", decodedCustom.errorName === "InitCodeTooLarge");
check("InitCodeTooLarge message readable", decodedCustom.reason.includes("50,000"));

const emptyInitData = encodeErrorResult({ abi: CODEGEN_FACTORY_REGISTER_ABI, errorName: "EmptyInitCode" });
check(
  "EmptyInitCode decoded from raw revert data",
  decodeRegisterRevert(Object.assign(new Error("reverted"), { cause: { data: emptyInitData } }), ctx).errorName ===
    "EmptyInitCode"
);
check(
  "NotRegistered decoded",
  decodeRegisterRevert(
    Object.assign(new Error("reverted"), {
      cause: { data: encodeErrorResult({ abi: CODEGEN_FACTORY_REGISTER_ABI, errorName: "NotRegistered" }) },
    }),
    ctx
  ).reason.includes("Register vault first")
);

// viem-style decoded error object (ContractFunctionRevertedError.data).
const viemStyle = Object.assign(new Error("execution reverted"), {
  cause: { data: { errorName: "DeployFailed", args: [] } },
});
check("viem pre-decoded custom error honored", decodeRegisterRevert(viemStyle, ctx).errorName === "DeployFailed");

// Error(string) and Panic paths.
const errorString = encodeErrorResult({
  abi: [{ name: "Error", type: "error", inputs: [{ name: "message", type: "string" }] }],
  errorName: "Error",
  args: ["init code hash mismatch"],
});
check(
  "Error(string) reason surfaced",
  decodeRegisterRevert(Object.assign(new Error("reverted"), { cause: { data: errorString } }), ctx).reason.includes(
    "init code hash mismatch"
  )
);

// User-side failures get direct guidance.
check(
  "user rejection mapped",
  decodeRegisterRevert(new Error("User rejected the request."), ctx).reason === "Transaction rejected in the wallet."
);
check(
  "insufficient funds mapped",
  decodeRegisterRevert(new Error("insufficient funds for gas * price + value"), ctx).reason.includes("tBNB")
);
check(
  "chain mismatch mapped",
  decodeRegisterRevert(new Error("The current chain of the wallet (id: 56) does not match the target chain"), ctx)
    .reason.includes("chain 97")
);

// The exact "transaction gas limit too high" send-side rejection reported in
// production: the wallet's RPC node enforces a hard per-tx cap independent
// of the (different) RPC used for the earlier preflight simulation.
const gasCapErr = new Error(
  "RPC 0x61 Custom eth_sendRawTransaction: transaction gas limit too high (cap: 16777216, tx: 28949965)"
);
const decodedGasCap = decodeRegisterRevert(gasCapErr, ctx);
check("RPC gas-cap rejection decoded with the cap value", decodedGasCap.reason.includes("16,777,216"));
check("RPC gas-cap rejection decoded with the requested value", decodedGasCap.reason.includes("28,949,965"));
check(
  "RPC gas-cap rejection points at redeploying an outdated factory (root cause is now fixed contract-side)",
  decodedGasCap.reason.toLowerCase().includes("outdated factory") && decodedGasCap.reason.toLowerCase().includes("redeploy factory")
);

// Never blank, even for junk input.
check("junk input yields non-empty reason", decodeRegisterRevert(undefined, ctx).reason.length > 0);
check("string error yields non-empty reason", decodeRegisterRevert("boom", ctx).reason.length > 0);

// ── result ────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll register-validation selfchecks passed");
