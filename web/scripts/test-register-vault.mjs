#!/usr/bin/env node
/**
 * Preflight test for registerVault against a factory on BSC testnet.
 * Usage: node scripts/test-register-vault.mjs [factoryAddress] [bytecodeBinPath]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeFunctionData, http } from "viem";
import { bscTestnet } from "viem/chains";

const factory = (process.argv[2] ?? "0x71fb0a7fa1ac291cf77975a6fe0848cac8ce6c65");
const defaultBin = fileURLToPath(new URL("../../test/_codegen/QuestProofRewardVault.bin", import.meta.url));
const binPath = process.argv[3] ?? defaultBin;
const launcher = (process.argv[4] ?? "0xcec6b3c84d0158fca7b3b326e0e8d7798bcb3e39");

const bytecode = `0x${readFileSync(binPath).toString("hex")}`;
const desc = "QuestProofRewardVault: preflight test";

function registerVaultGasLimit(hex) {
  const bytes = BigInt((hex.length - 2) / 2);
  const storageGas = ((bytes + 31n) / 32n) * 20_000n;
  const calldataGas = bytes * 16n;
  const estimate = 1_000_000n + storageGas + calldataGas;
  const withMargin = estimate + estimate / 6n;
  return withMargin > 25_000_000n ? withMargin : 25_000_000n;
}

const abi = [
  { name: "EmptyInitCode", type: "error", inputs: [] },
  { name: "InitCodeTooLarge", type: "error", inputs: [{ name: "size", type: "uint256" }] },
  {
    name: "registerVault",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "creationCode", type: "bytes" },
      { name: "vaultDescription", type: "string" },
    ],
    outputs: [],
  },
  { name: "factorySpecVersion", type: "function", stateMutability: "pure", inputs: [], outputs: [{ type: "string" }] },
];

const rpc = "https://data-seed-prebsc-1-s1.binance.org:8545/";
const client = createPublicClient({ chain: bscTestnet, transport: http(rpc) });

const bytes = (bytecode.length - 2) / 2;
const gas = registerVaultGasLimit(bytecode);
console.log("factory", factory);
console.log("launcher", launcher);
console.log("bytecode bytes", bytes);
console.log("computed gas", gas.toString());

const spec = await client.readContract({ address: factory, abi, functionName: "factorySpecVersion" });
console.log("factorySpecVersion", spec);

try {
  await client.estimateGas({
    account: launcher,
    to: factory,
    data: encodeFunctionData({
      abi,
      functionName: "registerVault",
      args: [bytecode, desc],
    }),
  });
  console.log("eth_estimateGas: OK (unexpected for large bytecode on BSC RPC)");
} catch (e) {
  console.log("eth_estimateGas:", e.shortMessage ?? e.message);
}

try {
  await client.simulateContract({
    address: factory,
    abi,
    functionName: "registerVault",
    args: [bytecode, desc],
    account: launcher,
    gas,
  });
  console.log(`simulateContract (gas=${gas}): OK — register should succeed if wallet sends enough gas`);
} catch (e) {
  console.log("simulateContract FAIL:", e.shortMessage ?? e.message);
  process.exitCode = 1;
}
