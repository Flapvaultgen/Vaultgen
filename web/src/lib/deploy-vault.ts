import { decodeEventLog, type Hex } from "viem";

/** CodegenVaultSandboxDeployer — matches src/CodegenVaultSandboxDeployer.sol */
export const SANDBOX_DEPLOYER_ABI = [
  {
    type: "event",
    name: "SandboxVaultDeployed",
    inputs: [
      { name: "vault", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "taxToken", type: "address", indexed: true },
      { name: "initCodeSize", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "deployVault",
    inputs: [
      { name: "creationCode", type: "bytes" },
      { name: "taxToken", type: "address" },
    ],
    outputs: [
      { name: "vault", type: "address" },
      { name: "tokenOut", type: "address" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

export type SandboxDeployResult = {
  vault: `0x${string}`;
  taxToken: `0x${string}`;
  txHash: `0x${string}`;
};

type ReceiptLog = {
  address: `0x${string}`;
  topics: readonly Hex[];
  data: Hex;
};

export function parseSandboxDeployReceipt(
  logs: ReceiptLog[],
  deployerAddress: `0x${string}`
): SandboxDeployResult | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== deployerAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: SANDBOX_DEPLOYER_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== "SandboxVaultDeployed") continue;
      const args = decoded.args as {
        vault: `0x${string}`;
        taxToken: `0x${string}`;
      };
      return {
        vault: args.vault,
        taxToken: args.taxToken,
        txHash: "0x" as `0x${string}`,
      };
    } catch {
      continue;
    }
  }
  return null;
}
