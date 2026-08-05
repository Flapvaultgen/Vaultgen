import type { Address, Hex } from "viem";
import { getAccount, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { flapPublicClient } from "./flap-networks";
import type { FlapLaunchNetworkId } from "./flap-networks";
import { DEFAULT_LAUNCH_NETWORK } from "./flap-networks";
import { wagmiConfig } from "./wagmi";
import {
  CODEGEN_FACTORY_REGISTER_ABI,
  checkRegisterPayload,
  creationBytecodeByteLength,
  decodeRegisterRevert,
  registerVaultGasLimit,
  type RegisterCallContext,
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
  account: Address,
  chainId: FlapLaunchNetworkId = DEFAULT_LAUNCH_NETWORK.chainId
): Promise<RegisterPreflightResult> {
  const issue = checkRegisterPayload(creationBytecode);
  if (issue) return { ok: false, reason: issue.message, errorName: null, raw: issue.code };

  const bytecode = creationBytecode as Hex;
  const gas = registerVaultGasLimit(bytecode);
  const client = flapPublicClient(chainId);
  const ctx: RegisterCallContext = {
    chainId,
    factoryAddress,
    wallet: account,
    bytecodeBytes: creationBytecodeByteLength(bytecode),
    descriptionLength: vaultDescription.length,
  };
  try {
    await client.simulateContract({
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
  vaultDescription: string,
  chainId: FlapLaunchNetworkId = DEFAULT_LAUNCH_NETWORK.chainId
): Promise<Hex> {
  const account = getAccount(wagmiConfig);
  if (!account.address) {
    throw new Error("Connect MetaMask first.");
  }

  const preflight = await preflightRegisterVault(
    factoryAddress,
    creationBytecode,
    vaultDescription,
    account.address,
    chainId
  );
  if (!preflight.ok) {
    throw new Error(preflight.reason);
  }

  const hash = await writeContract(wagmiConfig, {
    address: factoryAddress,
    abi: CODEGEN_FACTORY_REGISTER_ABI,
    functionName: "registerVault",
    args: [creationBytecode, vaultDescription],
    chainId,
    account: account.address,
    gas: preflight.gasLimit,
  });

  const receipt = await waitForTransactionReceipt(wagmiConfig, {
    hash,
    chainId,
  });
  if (receipt.status !== "success") {
    throw new Error("Register vault transaction reverted on-chain (see the tx on the explorer for details).");
  }
  return hash;
}

export async function readRegisteredVault(
  factoryAddress: Address,
  launcher: Address,
  chainId: FlapLaunchNetworkId = DEFAULT_LAUNCH_NETWORK.chainId
): Promise<{ registered: boolean; description: string }> {
  const client = flapPublicClient(chainId);
  const [registered, description] = await Promise.all([
    client.readContract({
      address: factoryAddress,
      abi: CODEGEN_FACTORY_REGISTER_ABI,
      functionName: "hasRegisteredBytecode",
      args: [launcher],
    }),
    client.readContract({
      address: factoryAddress,
      abi: CODEGEN_FACTORY_REGISTER_ABI,
      functionName: "registeredVaultDescription",
      args: [launcher],
    }),
  ]);
  return { registered, description };
}
