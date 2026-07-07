import {
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { getAccount, readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { flapTestnetPublicClient } from "./flap-factory";
import { FLAP_BSC_TESTNET, FLAP_LAUNCH_DEFAULTS } from "./flap-testnet";
import {
  LAUNCH_CHAIN_ID,
  LAUNCH_FUNCTION_SIGNATURE,
  LAUNCH_PORTAL_ADDRESS,
  VAULT_PORTAL_LAUNCH_ABI,
  buildLaunchCallContext,
  checkLaunchPayload,
  decodeLaunchRevert,
  launchGasLimit,
  launchPayableValue,
  type LaunchCallContext,
  type LaunchValidationInput,
  type VaultDataMode,
} from "./launch-validation";
import { findVanity7777Salt, predictCloneAddress } from "./vanity-salt";
import { wagmiConfig } from "./wagmi";

export {
  LAUNCH_CHAIN_ID,
  LAUNCH_FUNCTION_SIGNATURE,
  LAUNCH_PORTAL_ADDRESS,
  VAULT_PORTAL_LAUNCH_ABI,
  buildLaunchCallContext,
  checkLaunchPayload,
  decodeLaunchRevert,
  launchGasLimit,
  launchPayableValue,
  type LaunchCallContext,
  type VaultDataMode,
} from "./launch-validation";

/** @deprecated Use VAULT_PORTAL_LAUNCH_ABI — kept for existing imports. */
export const VAULT_PORTAL_ABI = VAULT_PORTAL_LAUNCH_ABI;

export type LaunchTokenInput = {
  name: string;
  symbol: string;
  factoryAddress: Address;
  /** Required only when vaultDataMode is inline_bytecode. */
  creationBytecode?: Hex;
  buyTaxRateBps?: number;
  sellTaxRateBps?: number;
  /**
   * register-first (default): vaultData = 0x — factory reads bytecode registered
   * in step 2. Matches broadcast/RegisterAndLaunch.s.sol successful launches.
   * inline_bytecode: embeds abi.encode(bytes) creation code (test/fork path only).
   */
  vaultDataMode?: VaultDataMode;
  /** On-chain registration state from readRegisteredVault — required for registered mode. */
  registeredOnChain?: boolean;
  registeredDescription?: string | null;
  expectedDescription?: string | null;
  /** IPFS CID from Flap's upload API (image/description/socials). Empty = no metadata. */
  metaCid?: string | null;
  /** Initial dev buy in wei — becomes quoteAmt and the tx's msg.value. */
  devBuyWei?: bigint;
};

export type LaunchTokenResult = {
  txHash: Hex;
  token: Address;
  vault: Address;
  factory: Address;
};

export type LaunchPreflightResult =
  | { ok: true; gasLimit: bigint; predictedToken: Address }
  | { ok: false; reason: string; errorName: string | null; raw: string };

/** ABI-encode creation bytecode for inline vaultData launches (fork tests). */
export function encodeCodegenVaultData(creationBytecode: Hex): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes"), [creationBytecode]);
}

export function buildLaunchParams(input: LaunchTokenInput, salt: Hex) {
  const buy = input.buyTaxRateBps ?? 500;
  const sell = input.sellTaxRateBps ?? 500;
  const mode = input.vaultDataMode ?? "registered";
  const vaultData: Hex =
    mode === "inline_bytecode" && input.creationBytecode
      ? encodeCodegenVaultData(input.creationBytecode)
      : "0x";

  return {
    name: input.name,
    symbol: input.symbol,
    // IPFS CID pinned via Flap's upload API — flap.sh reads image/description/socials from it.
    meta: input.metaCid ?? "",
    dexThresh: FLAP_LAUNCH_DEFAULTS.dexThresh,
    salt,
    migratorType: FLAP_LAUNCH_DEFAULTS.migratorType,
    quoteToken: "0x0000000000000000000000000000000000000000" as Address,
    // Initial dev buy: portal spends msg.value (>= quoteAmt) buying the token at launch.
    quoteAmt: input.devBuyWei ?? FLAP_LAUNCH_DEFAULTS.quoteAmt,
    permitData: "0x" as Hex,
    extensionID: `0x${"0".repeat(64)}` as Hex,
    extensionData: "0x" as Hex,
    dexId: FLAP_LAUNCH_DEFAULTS.dexId,
    lpFeeProfile: FLAP_LAUNCH_DEFAULTS.lpFeeProfile,
    buyTaxRate: buy,
    sellTaxRate: sell,
    taxDuration: FLAP_LAUNCH_DEFAULTS.taxDuration,
    antiFarmerDuration: FLAP_LAUNCH_DEFAULTS.antiFarmerDuration,
    mktBps: FLAP_LAUNCH_DEFAULTS.mktBps,
    deflationBps: FLAP_LAUNCH_DEFAULTS.deflationBps,
    dividendBps: FLAP_LAUNCH_DEFAULTS.dividendBps,
    lpBps: FLAP_LAUNCH_DEFAULTS.lpBps,
    minimumShareBalance: FLAP_LAUNCH_DEFAULTS.minimumShareBalance,
    dividendToken: "0x0000000000000000000000000000000000000000" as Address,
    commissionReceiver: "0x0000000000000000000000000000000000000000" as Address,
    tokenVersion: FLAP_LAUNCH_DEFAULTS.tokenVersion,
    vaultFactory: input.factoryAddress,
    vaultData,
  } as const;
}

function validationFromInput(input: LaunchTokenInput, wallet: Address, chainId: number): LaunchValidationInput {
  return {
    walletAddress: wallet,
    chainId,
    factoryAddress: input.factoryAddress,
    tokenName: input.name,
    tokenSymbol: input.symbol,
    buyTaxRateBps: input.buyTaxRateBps,
    sellTaxRateBps: input.sellTaxRateBps,
    registeredOnChain: input.registeredOnChain,
    registeredDescription: input.registeredDescription,
    expectedDescription: input.expectedDescription,
    vaultDataMode: input.vaultDataMode ?? "registered",
    creationBytecode: input.creationBytecode,
    devBuyWei: input.devBuyWei,
    metaCid: input.metaCid,
  };
}

/** Simulates newTokenV6WithVault on the public RPC (no wallet popup, no gas spent). */
export async function preflightLaunchToken(
  input: LaunchTokenInput,
  account: Address,
  salt: Hex
): Promise<LaunchPreflightResult> {
  const issue = checkLaunchPayload(validationFromInput(input, account, LAUNCH_CHAIN_ID));
  if (issue) return { ok: false, reason: issue.message, errorName: null, raw: issue.code };

  const params = buildLaunchParams(input, salt);
  const mode = input.vaultDataMode ?? "registered";
  const vaultDataBytes =
    mode === "inline_bytecode" && input.creationBytecode
      ? (input.creationBytecode.length - 2) / 2
      : 0;
  const ctx = buildLaunchCallContext({
    wallet: account,
    factoryAddress: input.factoryAddress,
    tokenName: input.name,
    tokenSymbol: input.symbol,
    buyTaxRateBps: input.buyTaxRateBps,
    sellTaxRateBps: input.sellTaxRateBps,
    vaultDataMode: mode,
    vaultDataBytes,
    registeredOnChain: input.registeredOnChain,
    devBuyWei: input.devBuyWei,
    metaCid: input.metaCid,
  });

  try {
    await flapTestnetPublicClient.simulateContract({
      address: LAUNCH_PORTAL_ADDRESS,
      abi: VAULT_PORTAL_LAUNCH_ABI,
      functionName: "newTokenV6WithVault",
      args: [params],
      account,
      value: launchPayableValue(input.devBuyWei),
      gas: launchGasLimit(),
    });
    const predictedToken = predictCloneAddress(
      FLAP_BSC_TESTNET.tokenImplTaxedV3,
      FLAP_BSC_TESTNET.portal,
      salt
    );
    return { ok: true, gasLimit: launchGasLimit(), predictedToken };
  } catch (err) {
    const decoded = decodeLaunchRevert(err, ctx);
    return { ok: false, reason: decoded.reason, errorName: decoded.errorName, raw: decoded.raw };
  }
}

export async function launchCodegenTokenOnTestnet(
  input: LaunchTokenInput,
  opts?: {
    onProgress?: (message: string) => void;
    /** Pre-computed salt from preflight — skips re-search when provided. */
    salt?: Hex;
  }
): Promise<LaunchTokenResult> {
  const account = getAccount(wagmiConfig);
  if (!account.address) throw new Error("Connect MetaMask first.");

  const issue = checkLaunchPayload(validationFromInput(input, account.address, LAUNCH_CHAIN_ID));
  if (issue) throw new Error(issue.message);

  opts?.onProgress?.("Finding vanity token address (…7777)…");
  const salt =
    opts?.salt ??
    (await findVanity7777Salt(FLAP_BSC_TESTNET.tokenImplTaxedV3, FLAP_BSC_TESTNET.portal, (p) => {
      if (p.attempts % 50_000 === 0) {
        opts?.onProgress?.(
          `Finding vanity address… ${p.attempts.toLocaleString()} tries (${Math.round(p.ratePerSec).toLocaleString()}/s)`
        );
      }
    }));

  const preflight = await preflightLaunchToken(input, account.address, salt);
  if (!preflight.ok) throw new Error(preflight.reason);

  const params = buildLaunchParams(input, salt);
  opts?.onProgress?.("Submitting launch transaction…");

  const mode = input.vaultDataMode ?? "registered";
  const vaultDataBytes =
    mode === "inline_bytecode" && input.creationBytecode ? (input.creationBytecode.length - 2) / 2 : 0;
  const ctx = buildLaunchCallContext({
    wallet: account.address,
    factoryAddress: input.factoryAddress,
    tokenName: input.name,
    tokenSymbol: input.symbol,
    buyTaxRateBps: input.buyTaxRateBps,
    sellTaxRateBps: input.sellTaxRateBps,
    vaultDataMode: mode,
    vaultDataBytes,
    registeredOnChain: input.registeredOnChain,
    devBuyWei: input.devBuyWei,
    metaCid: input.metaCid,
  });

  let hash: Hex;
  try {
    hash = await writeContract(wagmiConfig, {
      address: LAUNCH_PORTAL_ADDRESS,
      abi: VAULT_PORTAL_LAUNCH_ABI,
      functionName: "newTokenV6WithVault",
      args: [params],
      value: launchPayableValue(input.devBuyWei),
      chainId: LAUNCH_CHAIN_ID,
      account: account.address,
      gas: preflight.gasLimit,
    });
  } catch (err) {
    throw new Error(decodeLaunchRevert(err, ctx).reason);
  }

  opts?.onProgress?.("Waiting for confirmation…");
  const receipt = await waitForTransactionReceipt(wagmiConfig, {
    hash,
    chainId: LAUNCH_CHAIN_ID,
  });
  if (receipt.status !== "success") {
    throw new Error("Launch transaction reverted on-chain (see the tx on the explorer for details).");
  }

  const token = preflight.predictedToken;
  const info = await readContract(wagmiConfig, {
    address: LAUNCH_PORTAL_ADDRESS,
    abi: VAULT_PORTAL_LAUNCH_ABI,
    functionName: "getVault",
    args: [token],
    chainId: LAUNCH_CHAIN_ID,
  });
  return {
    txHash: hash,
    token,
    vault: info.vault,
    factory: info.vaultFactory,
  };
}

export async function readVaultInfo(token: Address) {
  return readContract(wagmiConfig, {
    address: LAUNCH_PORTAL_ADDRESS,
    abi: VAULT_PORTAL_LAUNCH_ABI,
    functionName: "getVault",
    args: [token],
    chainId: LAUNCH_CHAIN_ID,
  });
}

export async function verifyDeployedVault(
  publicClient: PublicClient,
  vault: Address
): Promise<{ ok: boolean; codeSize: number; description?: string; reason?: string }> {
  const code = await publicClient.getBytecode({ address: vault });
  const codeSize = code ? (code.length - 2) / 2 : 0;
  if (codeSize === 0) {
    return { ok: false, codeSize, reason: "Vault address has no contract code." };
  }

  try {
    const description = await publicClient.readContract({
      address: vault,
      abi: [{ name: "description", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const,
      functionName: "description",
    });
    return { ok: true, codeSize, description };
  } catch {
    return { ok: false, codeSize, reason: "Vault deployed but description() is missing." };
  }
}
