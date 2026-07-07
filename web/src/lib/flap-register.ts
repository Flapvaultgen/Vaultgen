import type { Address, Hex } from "viem";
import { getAccount, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { bscTestnet } from "viem/chains";
import { flapTestnetPublicClient } from "./flap-factory";
import { wagmiConfig } from "./wagmi";
import {
  CODEGEN_FACTORY_REGISTER_ABI,
  checkRegisterPayload,
  creationBytecodeByteLength,
  decodeRegisterRevert,
  isUsableCreationBytecode,
  registerVaultGasLimit,
  type RegisterCallContext,
  MAX_REGISTER_INIT_CODE,
} from "./register-validation";

export {
  CODEGEN_FACTORY_REGISTER_ABI,
  KNOWN_RPC_GAS_CAP,
  MAX_DEPLOYED_BYTECODE_SIZE,
  MAX_REGISTER_INIT_CODE,
  REGISTER_FUNCTION_SIGNATURE,
  checkRegisterPayload,
  creationBytecodeByteLength,
  decodeRegisterRevert,
  exceedsDeployedBytecodeLimit,
  exceedsKnownRpcGasCap,
  isUsableCreationBytecode,
  registerVaultGasLimit,
} from "./register-validation";

export function validateCreationBytecode(creationBytecode: Hex): void {
  const issue = checkRegisterPayload(creationBytecode);
  if (issue) throw new Error(issue.message);
}

/** Kept for existing callers; delegates to the structured decoder. */
export function formatRegisterVaultError(err: unknown, ctx?: RegisterCallContext): string {
  return decodeRegisterRevert(err, ctx).reason;
}

export type RegisterPreflightResult =
  | { ok: true; bytecodeBytes: number; gasLimit: bigint }
  | { ok: false; reason: string; errorName: string | null; raw: string };

/**
 * Simulates registerVault via the public RPC (no wallet popup, no gas spent).
 * Any failure comes back decoded so the UI never shows a blank reason.
 */
export async function preflightRegisterVault(
  factoryAddress: Address,
  creationBytecode: string | null | undefined,
  vaultDescription: string,
  account: Address
): Promise<RegisterPreflightResult> {
  const issue = checkRegisterPayload(creationBytecode);
  if (issue) return { ok: false, reason: issue.message, errorName: null, raw: issue.code };

  const bytecode = creationBytecode as Hex;
  const gas = registerVaultGasLimit(bytecode);
  const ctx: RegisterCallContext = {
    chainId: bscTestnet.id,
    factoryAddress,
    wallet: account,
    bytecodeBytes: creationBytecodeByteLength(bytecode),
    descriptionLength: vaultDescription.length,
  };
  try {
    await flapTestnetPublicClient.simulateContract({
      address: factoryAddress,
      abi: CODEGEN_FACTORY_REGISTER_ABI,
      functionName: "registerVault",
      args: [bytecode, vaultDescription],
      account,
      gas,
    });
    return { ok: true, bytecodeBytes: ctx.bytecodeBytes, gasLimit: gas };
  } catch (err) {
    const decoded = decodeRegisterRevert(err, ctx);
    return { ok: false, reason: decoded.reason, errorName: decoded.errorName, raw: decoded.raw };
  }
}

export async function registerVaultForFlap(
  factoryAddress: Address,
  creationBytecode: Hex,
  vaultDescription: string
): Promise<Hex> {
  const account = getAccount(wagmiConfig);
  if (!account.address) {
    throw new Error("Connect MetaMask first.");
  }

  // Preflight before the wallet prompt so the user never pays gas for an
  // obviously-reverting transaction; failures carry the decoded reason.
  const preflight = await preflightRegisterVault(factoryAddress, creationBytecode, vaultDescription, account.address);
  if (!preflight.ok) {
    throw new Error(preflight.reason);
  }

  const hash = await writeContract(wagmiConfig, {
    address: factoryAddress,
    abi: CODEGEN_FACTORY_REGISTER_ABI,
    functionName: "registerVault",
    args: [creationBytecode, vaultDescription],
    chainId: bscTestnet.id,
    account: account.address,
    gas: preflight.gasLimit,
  });

  const receipt = await waitForTransactionReceipt(wagmiConfig, {
    hash,
    chainId: bscTestnet.id,
  });
  if (receipt.status !== "success") {
    throw new Error("Register vault transaction reverted on-chain (see the tx on the explorer for details).");
  }
  return hash;
}

export async function readRegisteredVault(
  factoryAddress: Address,
  launcher: Address
): Promise<{ registered: boolean; description: string }> {
  const [registered, description] = await Promise.all([
    flapTestnetPublicClient.readContract({
      address: factoryAddress,
      abi: CODEGEN_FACTORY_REGISTER_ABI,
      functionName: "hasRegisteredBytecode",
      args: [launcher],
    }),
    flapTestnetPublicClient.readContract({
      address: factoryAddress,
      abi: CODEGEN_FACTORY_REGISTER_ABI,
      functionName: "registeredVaultDescription",
      args: [launcher],
    }),
  ]);
  return { registered, description };
}
