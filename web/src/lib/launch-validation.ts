/**
 * Pure validation + revert-decoding helpers for VaultPortal.newTokenV6WithVault.
 * No wagmi/window imports so deterministic selfchecks can run in Node.
 *
 * Solidity source of truth:
 *   src/flap/IVaultPortal.sol — newTokenV6WithVault(NewTokenV6WithVaultParams)
 *   Successful register-first launches pass vaultData = "" (empty bytes); see
 *   broadcast/RegisterAndLaunch.s.sol/97/run-latest.json.
 */
import { decodeErrorResult, type Address, type Hex } from "viem";
import { FLAP_BSC_TESTNET, FLAP_LAUNCH_DEFAULTS } from "./flap-testnet";

export const LAUNCH_PORTAL_ADDRESS = FLAP_BSC_TESTNET.vaultPortal;
export const LAUNCH_CHAIN_ID = FLAP_BSC_TESTNET.chainId;

/** Matches broadcast RegisterAndLaunch.s.sol on BSC testnet chain 97. */
export const LAUNCH_FUNCTION_SIGNATURE =
  "newTokenV6WithVault((string,string,string,uint8,bytes32,uint8,address,uint256,bytes,bytes32,bytes,uint8,uint8,uint16,uint16,uint64,uint64,uint16,uint16,uint16,uint16,uint256,address,address,uint8,address,bytes))";

/** Portal InvalidTaxRate: tax must be > 0 and <= 1000 bps (10%). */
export const MAX_PORTAL_TAX_BPS = 1_000;
export const DEFAULT_LAUNCH_TAX_BPS = 500;

/** Custom errors from IVaultPortal + common factory errors surfaced during launch. */
export const VAULT_PORTAL_LAUNCH_ABI = [
  { name: "InvalidTaxRate", type: "error", inputs: [{ name: "taxRate", type: "uint256" }] },
  { name: "InvalidMktBps", type: "error", inputs: [] },
  { name: "UnsupportedQuoteToken", type: "error", inputs: [{ name: "quoteToken", type: "address" }] },
  { name: "VaultFactoryNotRegistered", type: "error", inputs: [{ name: "factory", type: "address" }] },
  { name: "InvalidVanity", type: "error", inputs: [{ name: "predictedAddress", type: "address" }] },
  { name: "VaultNotFound", type: "error", inputs: [{ name: "taxToken", type: "address" }] },
  { name: "TokenAddressMismatch", type: "error", inputs: [] },
  { name: "BnbTransferFailed", type: "error", inputs: [] },
  { name: "OnlyV3TaxTokenAllowed", type: "error", inputs: [] },
  { name: "FeatureDisabled", type: "error", inputs: [] },
  { name: "ZeroPortalAddress", type: "error", inputs: [] },
  { name: "ZeroTokenImplAddress", type: "error", inputs: [] },
  { name: "TokenNotFound", type: "error", inputs: [{ name: "taxToken", type: "address" }] },
  {
    name: "RateLimitExceeded",
    type: "error",
    inputs: [{ name: "user", type: "address" }, { name: "lastCreationTime", type: "uint256" }],
  },
  // CodegenVaultFactory errors that bubble up when vault deploy fails
  { name: "EmptyInitCode", type: "error", inputs: [] },
  { name: "InitCodeTooLarge", type: "error", inputs: [{ name: "size", type: "uint256" }] },
  { name: "DeployFailed", type: "error", inputs: [] },
  { name: "NotRegistered", type: "error", inputs: [] },
  {
    name: "newTokenV6WithVault",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "meta", type: "string" },
          { name: "dexThresh", type: "uint8" },
          { name: "salt", type: "bytes32" },
          { name: "migratorType", type: "uint8" },
          { name: "quoteToken", type: "address" },
          { name: "quoteAmt", type: "uint256" },
          { name: "permitData", type: "bytes" },
          { name: "extensionID", type: "bytes32" },
          { name: "extensionData", type: "bytes" },
          { name: "dexId", type: "uint8" },
          { name: "lpFeeProfile", type: "uint8" },
          { name: "buyTaxRate", type: "uint16" },
          { name: "sellTaxRate", type: "uint16" },
          { name: "taxDuration", type: "uint64" },
          { name: "antiFarmerDuration", type: "uint64" },
          { name: "mktBps", type: "uint16" },
          { name: "deflationBps", type: "uint16" },
          { name: "dividendBps", type: "uint16" },
          { name: "lpBps", type: "uint16" },
          { name: "minimumShareBalance", type: "uint256" },
          { name: "dividendToken", type: "address" },
          { name: "commissionReceiver", type: "address" },
          { name: "tokenVersion", type: "uint8" },
          { name: "vaultFactory", type: "address" },
          { name: "vaultData", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    name: "getVault",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "taxToken", type: "address" }],
    outputs: [
      {
        name: "info",
        type: "tuple",
        components: [
          { name: "vault", type: "address" },
          { name: "vaultFactory", type: "address" },
          { name: "description", type: "string" },
          { name: "isOfficial", type: "bool" },
          { name: "riskLevel", type: "uint8" },
        ],
      },
    ],
  },
] as const;

export type VaultDataMode = "registered" | "inline_bytecode";

export type LaunchValidationInput = {
  walletAddress?: string | null;
  chainId?: number | null;
  factoryAddress?: string | null;
  tokenName?: string;
  tokenSymbol?: string;
  buyTaxRateBps?: number;
  sellTaxRateBps?: number;
  /** When true, vault must be registered on-chain for this wallet before launch. */
  registeredOnChain?: boolean;
  registeredDescription?: string | null;
  expectedDescription?: string | null;
  vaultDataMode?: VaultDataMode;
  creationBytecode?: string | null;
  /** Initial dev buy in wei (quoteAmt / msg.value). */
  devBuyWei?: bigint;
  /** IPFS CID for token metadata (image/description/socials), from Flap's upload API. */
  metaCid?: string | null;
};

export type LaunchPayloadIssue = {
  code: string;
  message: string;
};

export type LaunchCallContext = {
  chainId: number;
  portalAddress: string;
  wallet?: string | null;
  tokenName: string;
  tokenSymbol: string;
  buyTaxRateBps: number;
  sellTaxRateBps: number;
  factoryAddress: string;
  vaultDataMode: VaultDataMode;
  vaultDataBytes: number;
  payableValue: bigint;
  registeredOnChain: boolean;
  metaCid?: string | null;
};

export type DecodedLaunchError = {
  reason: string;
  errorName: string | null;
  raw: string;
};

const PANIC_CODES: Record<number, string> = {
  0x01: "assertion failed",
  0x11: "arithmetic overflow/underflow",
  0x12: "division by zero",
  0x21: "invalid enum value",
  0x22: "corrupted storage byte array",
  0x31: "pop on empty array",
  0x32: "array index out of bounds",
  0x41: "out of memory",
  0x51: "call to uninitialized function",
};

function friendlyLaunchError(errorName: string, args: readonly unknown[] | undefined): string | null {
  switch (errorName) {
    case "InvalidTaxRate": {
      const rate = typeof args?.[0] === "bigint" ? args[0].toString() : String(args?.[0] ?? "?");
      return `Portal rejected tax rate ${rate} bps — buy/sell tax must be between 1 and ${MAX_PORTAL_TAX_BPS} (10%).`;
    }
    case "InvalidMktBps":
      return "Portal rejected mktBps — market allocation must be > 0 (the app defaults to 100%).";
    case "UnsupportedQuoteToken":
      return "Portal rejected quote token — codegen vaults only support native BNB (address(0)).";
    case "VaultFactoryNotRegistered": {
      const factory = typeof args?.[0] === "string" ? args[0] : "unknown";
      return `Vault factory ${factory} is not registered on the Portal — redeploy the factory or use a registered address.`;
    }
    case "InvalidVanity": {
      const addr = typeof args?.[0] === "string" ? args[0] : "unknown";
      return `Token vanity check failed — predicted address ${addr} does not end in 0x7777. Retry launch (salt search runs again).`;
    }
    case "NotRegistered":
      return "Factory has no registered bytecode for your wallet (NotRegistered) — complete Register vault (step 2) first, then launch with empty vaultData.";
    case "EmptyInitCode":
      return "Factory rejected: no creation bytecode available (EmptyInitCode). Register the vault first or pass valid vaultData.";
    case "InitCodeTooLarge": {
      const size = typeof args?.[0] === "bigint" ? args[0].toLocaleString() : String(args?.[0] ?? "?");
      return `Factory rejected: creation bytecode is ${size} bytes (InitCodeTooLarge).`;
    }
    case "DeployFailed":
      return "Vault constructor reverted during launch (DeployFailed) — the generated vault may fail at deploy time; regenerate and re-register.";
    case "OnlyV3TaxTokenAllowed":
    case "FeatureDisabled":
      return `Portal rejected token version ( ${errorName} ) — only TOKEN_TAXED_V3 (version 6) is supported on this network.`;
    case "RateLimitExceeded":
      return "Portal rate limit — wait before launching another token from this wallet.";
    case "BnbTransferFailed":
      return "BNB transfer failed during launch — check wallet balance and payable value.";
    case "TokenAddressMismatch":
      return "Token address mismatch after deployment — retry launch.";
    case "Error":
      return typeof args?.[0] === "string" && args[0].length > 0 ? `Reverted: ${args[0]}` : "Reverted with an empty Error(string).";
    case "Panic": {
      const code = typeof args?.[0] === "bigint" ? Number(args[0]) : Number(args?.[0] ?? -1);
      return `Solidity panic 0x${code.toString(16)} (${PANIC_CODES[code] ?? "unknown panic"}).`;
    }
    default:
      return null;
  }
}

/** Validates launch prerequisites before any wallet prompt or preflight simulation. */
export function checkLaunchPayload(input: LaunchValidationInput): LaunchPayloadIssue | null {
  if (!input.walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(input.walletAddress)) {
    return { code: "wallet", message: "Connect MetaMask first." };
  }
  if (input.chainId !== undefined && input.chainId !== null && input.chainId !== LAUNCH_CHAIN_ID) {
    return { code: "chain", message: "Switch to BNB Smart Chain testnet (chain 97) before launching." };
  }
  if (!input.factoryAddress || !/^0x[a-fA-F0-9]{40}$/.test(input.factoryAddress)) {
    return { code: "factory", message: "Deploy the CodegenVaultFactory first (step 1)." };
  }
  const name = (input.tokenName ?? "").trim();
  const symbol = (input.tokenSymbol ?? "").trim().toUpperCase();
  if (!name) return { code: "name", message: "Enter a token name before launching." };
  if (!symbol) return { code: "symbol", message: "Enter a token symbol before launching." };
  if (name.length > 64) return { code: "name", message: "Token name is too long (max 64 characters)." };
  if (symbol.length > 16) return { code: "symbol", message: "Token symbol is too long (max 16 characters)." };

  const buy = input.buyTaxRateBps ?? DEFAULT_LAUNCH_TAX_BPS;
  const sell = input.sellTaxRateBps ?? DEFAULT_LAUNCH_TAX_BPS;
  if (buy <= 0 || buy > MAX_PORTAL_TAX_BPS) {
    return { code: "buy_tax", message: `Buy tax must be between 1 and ${MAX_PORTAL_TAX_BPS} bps (0.01%–10%).` };
  }
  if (sell <= 0 || sell > MAX_PORTAL_TAX_BPS) {
    return { code: "sell_tax", message: `Sell tax must be between 1 and ${MAX_PORTAL_TAX_BPS} bps (0.01%–10%).` };
  }

  const mode = input.vaultDataMode ?? "registered";
  if (mode === "registered") {
    if (input.registeredOnChain !== true) {
      return {
        code: "not_registered",
        message: "Register the vault on-chain first (step 2). Launch uses your registered bytecode with empty vaultData.",
      };
    }
    if (
      input.expectedDescription &&
      input.registeredDescription &&
      input.registeredDescription !== input.expectedDescription
    ) {
      return {
        code: "registration_mismatch",
        message:
          "On-chain registration description does not match this vault — re-register (step 2) before launching.",
      };
    }
  } else if (!input.creationBytecode || !input.creationBytecode.startsWith("0x")) {
    return { code: "bytecode", message: "Inline launch mode requires creation bytecode." };
  }

  if (input.devBuyWei !== undefined && input.devBuyWei < 0n) {
    return { code: "dev_buy", message: "Dev buy cannot be negative." };
  }
  if (input.metaCid && !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{20,})$/.test(input.metaCid)) {
    return {
      code: "meta",
      message: "Token metadata CID doesn't look like an IPFS CID — re-upload the image/description.",
    };
  }

  return null;
}

/**
 * msg.value for newTokenV6WithVault. Per Flap docs, the tx value must match or
 * exceed quoteAmt — quoteAmt is the initial dev buy spent buying the token at launch.
 */
export function launchPayableValue(devBuyWei?: bigint): bigint {
  return devBuyWei !== undefined && devBuyWei > 0n ? devBuyWei : FLAP_LAUNCH_DEFAULTS.quoteAmt;
}

export function launchGasLimit(): bigint {
  return FLAP_LAUNCH_DEFAULTS.maxOpGas;
}

function tryDecodeRevertData(data: string): { errorName: string; args: readonly unknown[] | undefined } | null {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;
  try {
    const decoded = decodeErrorResult({ abi: VAULT_PORTAL_LAUNCH_ABI, data: data as Hex });
    return { errorName: decoded.errorName, args: decoded.args };
  } catch {
    return null;
  }
}

type ErrLike = {
  message?: unknown;
  shortMessage?: unknown;
  cause?: unknown;
  data?: unknown;
  raw?: unknown;
};

function walkErrorChain(err: unknown): {
  messages: string[];
  revertDataCandidates: string[];
  decodedFromViem: { errorName: string; args: readonly unknown[] | undefined } | null;
} {
  const messages: string[] = [];
  const revertDataCandidates: string[] = [];
  let decodedFromViem: { errorName: string; args: readonly unknown[] | undefined } | null = null;

  let current: unknown = err;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const e = current as ErrLike;
    if (typeof e.shortMessage === "string" && e.shortMessage) messages.push(e.shortMessage);
    if (typeof e.message === "string" && e.message) messages.push(e.message);
    if (e.data && typeof e.data === "object") {
      const d = e.data as { errorName?: unknown; args?: unknown };
      if (typeof d.errorName === "string" && !decodedFromViem) {
        decodedFromViem = { errorName: d.errorName, args: Array.isArray(d.args) ? d.args : undefined };
      }
    }
    if (typeof e.data === "string") revertDataCandidates.push(e.data);
    if (typeof e.raw === "string") revertDataCandidates.push(e.raw);
    current = e.cause;
  }
  return { messages, revertDataCandidates, decodedFromViem };
}

function fallbackLaunchDiagnostics(ctx: LaunchCallContext | undefined): string {
  if (!ctx) {
    return (
      "newTokenV6WithVault reverted without a reason from the node. " +
      "Likely causes: vault not registered (step 2), wrong network, stale factory, or RPC dropped revert data — retry after a hard refresh."
    );
  }
  const wallet = ctx.wallet ? ` from ${ctx.wallet}` : "";
  const vaultDataHint =
    ctx.vaultDataMode === "registered"
      ? "vaultData is empty (register-first flow)"
      : `vaultData carries ${ctx.vaultDataBytes.toLocaleString()} bytes inline`;
  return (
    `newTokenV6WithVault on ${ctx.portalAddress} (chain ${ctx.chainId})${wallet} reverted without a decoded reason. ` +
    `Token: ${ctx.tokenName} (${ctx.tokenSymbol}), buy/sell tax: ${ctx.buyTaxRateBps}/${ctx.sellTaxRateBps} bps, ` +
    `factory: ${ctx.factoryAddress}, ${vaultDataHint}, payable: ${ctx.payableValue.toString()} wei, ` +
    `registered on-chain: ${ctx.registeredOnChain ? "yes" : "no"}. ` +
    "Likely causes: vault not registered for this wallet, registration consumed by a prior launch, " +
    "factory not registered on Portal, vanity salt failure, or vault constructor revert (DeployFailed)."
  );
}

/** Decodes a newTokenV6WithVault failure into a non-blank, actionable message. */
export function decodeLaunchRevert(err: unknown, ctx?: LaunchCallContext): DecodedLaunchError {
  if (!(err instanceof Error) && (typeof err !== "object" || err === null)) {
    return { reason: fallbackLaunchDiagnostics(ctx), errorName: null, raw: String(err) };
  }

  const { messages, revertDataCandidates, decodedFromViem } = walkErrorChain(err);
  const raw = messages.join("\n---\n") || String(err);
  const combined = messages.join("\n");
  const lower = combined.toLowerCase();

  if (lower.includes("user rejected") || lower.includes("user denied")) {
    return { reason: "Transaction rejected in the wallet.", errorName: null, raw };
  }
  if (lower.includes("connector not connected") || lower.includes("connect wallet")) {
    return { reason: "Connect MetaMask first.", errorName: null, raw };
  }
  if (lower.includes("insufficient funds")) {
    return { reason: "Not enough tBNB for gas — top up from the faucet and retry.", errorName: null, raw };
  }
  if (lower.includes("chain mismatch") || lower.includes("does not match the target chain")) {
    return { reason: "Wallet is on the wrong network — switch to BNB Smart Chain testnet (chain 97).", errorName: null, raw };
  }

  // viem's unhelpful blank-signature message
  if (lower.includes("reverted with the following signature") && !combined.match(/0x[0-9a-fA-F]{8}/)) {
    return { reason: fallbackLaunchDiagnostics(ctx), errorName: null, raw };
  }

  if (decodedFromViem) {
    const friendly = friendlyLaunchError(decodedFromViem.errorName, decodedFromViem.args);
    if (friendly) return { reason: friendly, errorName: decodedFromViem.errorName, raw };
    return { reason: `Launch reverted with ${decodedFromViem.errorName}.`, errorName: decodedFromViem.errorName, raw };
  }

  for (const candidate of revertDataCandidates) {
    const decoded = tryDecodeRevertData(candidate);
    if (decoded) {
      const friendly = friendlyLaunchError(decoded.errorName, decoded.args);
      return {
        reason: friendly ?? `Launch reverted with ${decoded.errorName}.`,
        errorName: decoded.errorName,
        raw,
      };
    }
  }

  // Known selectors inline in messages
  for (const name of ["NotRegistered", "DeployFailed", "InvalidVanity", "VaultFactoryNotRegistered", "InvalidTaxRate"]) {
    if (combined.includes(name)) {
      return { reason: friendlyLaunchError(name, undefined)!, errorName: name, raw };
    }
  }

  const reasonMatch = combined.match(/reverted with the following reason:\s*\n?\s*(\S[^\n]*)/);
  if (reasonMatch?.[1]) {
    return { reason: `Reverted: ${reasonMatch[1]}`, errorName: null, raw };
  }

  if (lower.includes("revert")) {
    return { reason: fallbackLaunchDiagnostics(ctx), errorName: null, raw };
  }

  const firstLine = combined.split("\n").find((l) => l.trim().length > 0);
  return { reason: firstLine ?? fallbackLaunchDiagnostics(ctx), errorName: null, raw };
}

/** Builds LaunchCallContext for debug panels and error decoding. */
export function buildLaunchCallContext(input: {
  wallet?: string | null;
  factoryAddress: Address;
  tokenName: string;
  tokenSymbol: string;
  buyTaxRateBps?: number;
  sellTaxRateBps?: number;
  vaultDataMode?: VaultDataMode;
  vaultDataBytes?: number;
  registeredOnChain?: boolean;
  devBuyWei?: bigint;
  metaCid?: string | null;
}): LaunchCallContext {
  const mode = input.vaultDataMode ?? "registered";
  return {
    chainId: LAUNCH_CHAIN_ID,
    portalAddress: LAUNCH_PORTAL_ADDRESS,
    wallet: input.wallet ?? null,
    tokenName: input.tokenName.trim(),
    tokenSymbol: input.tokenSymbol.trim().toUpperCase(),
    buyTaxRateBps: input.buyTaxRateBps ?? DEFAULT_LAUNCH_TAX_BPS,
    sellTaxRateBps: input.sellTaxRateBps ?? DEFAULT_LAUNCH_TAX_BPS,
    factoryAddress: input.factoryAddress,
    vaultDataMode: mode,
    vaultDataBytes: input.vaultDataBytes ?? (mode === "registered" ? 0 : 0),
    payableValue: launchPayableValue(input.devBuyWei),
    registeredOnChain: input.registeredOnChain ?? false,
    metaCid: input.metaCid ?? null,
  };
}
