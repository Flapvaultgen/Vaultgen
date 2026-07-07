/**
 * Pure validation + revert-decoding helpers for CodegenVaultFactory.registerVault.
 * No wagmi/window imports so deterministic selfchecks can run these in Node.
 *
 * Solidity source of truth (src/CodegenVaultFactory.sol):
 *   function registerVault(bytes calldata creationCode, string calldata vaultDescription) external
 *   error EmptyInitCode();
 *   error InitCodeTooLarge(uint256 size);
 *   error DeployFailed();
 *   error NotRegistered();
 */
import { decodeErrorResult, type Hex } from "viem";

export const MAX_REGISTER_INIT_CODE = 49_152;
/**
 * Generated vaults compile to ~15–30KB of creation bytecode. Anything under
 * this is not compiler output (an address is 20 bytes, a selector 4) and the
 * factory tx would either revert or register useless bytes.
 */
export const MIN_PLAUSIBLE_CREATION_BYTECODE = 1_000;

export const REGISTER_FUNCTION_SIGNATURE = "registerVault(bytes creationCode, string vaultDescription)";

export const CODEGEN_FACTORY_REGISTER_ABI = [
  { name: "EmptyInitCode", type: "error", inputs: [] },
  {
    name: "InitCodeTooLarge",
    type: "error",
    inputs: [{ name: "size", type: "uint256" }],
  },
  { name: "DeployFailed", type: "error", inputs: [] },
  { name: "NotRegistered", type: "error", inputs: [] },
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
  {
    name: "hasRegisteredBytecode",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "launcher", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "registeredVaultDescription",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "launcher", type: "address" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

// ── payload validation ────────────────────────────────────────────────────────

export type RegisterPayloadIssue = {
  code: "missing" | "not_hex" | "odd_length" | "address_like" | "too_small" | "too_large";
  message: string;
};

export function creationBytecodeByteLength(creationBytecode: string | null | undefined): number {
  if (!creationBytecode?.startsWith("0x")) return 0;
  return Math.floor((creationBytecode.length - 2) / 2);
}

/**
 * Everything that must hold before registerVault is worth sending. Returns
 * null when the payload looks like real compiler creation bytecode.
 */
export function checkRegisterPayload(creationBytecode: string | null | undefined): RegisterPayloadIssue | null {
  if (!creationBytecode || !creationBytecode.startsWith("0x") || creationBytecode.length <= 2) {
    return {
      code: "missing",
      message: "Cannot register vault: creation bytecode is missing. Regenerate the vault or paste the compiler output.",
    };
  }
  if (!/^0x[0-9a-fA-F]+$/.test(creationBytecode)) {
    return {
      code: "not_hex",
      message: "Cannot register vault: payload contains non-hex characters — expected 0x-prefixed compiler bytecode.",
    };
  }
  if ((creationBytecode.length - 2) % 2 !== 0) {
    return {
      code: "odd_length",
      message: "Cannot register vault: payload has an odd number of hex characters — it is truncated or corrupted.",
    };
  }
  const bytes = creationBytecodeByteLength(creationBytecode);
  if (bytes === 20) {
    return {
      code: "address_like",
      message:
        "Cannot register vault: payload is exactly 20 bytes — that is a wallet/contract address, not creation bytecode. Paste the full compiler creation bytecode (tens of KB), not an address.",
    };
  }
  if (bytes < MIN_PLAUSIBLE_CREATION_BYTECODE) {
    return {
      code: "too_small",
      message: `Cannot register vault: payload is only ${bytes} bytes. Full contract creation bytecode from the compiler is expected (generated vaults are ~15,000–30,000 bytes).`,
    };
  }
  if (bytes > MAX_REGISTER_INIT_CODE) {
    return {
      code: "too_large",
      message: `Cannot register vault: bytecode is ${bytes.toLocaleString()} bytes; the factory max is ${MAX_REGISTER_INIT_CODE.toLocaleString()}.`,
    };
  }
  return null;
}

export function isUsableCreationBytecode(creationBytecode: string | null | undefined): creationBytecode is Hex {
  return checkRegisterPayload(creationBytecode) === null;
}

// ── gas ───────────────────────────────────────────────────────────────────────

/**
 * Gas LIMIT for the register transaction (not an estimate): BSC testnet RPCs
 * cap eth_estimateGas at 16M while storing ~25KB of bytecode needs ~20M+, so
 * we compute a formula-based ceiling ourselves. Unused gas is refunded.
 */
/**
 * Below this, the formula estimate itself is already a safe minimum for any
 * registerVault call — no need to inflate small/medium payloads up to a
 * one-size-fits-all ceiling.
 */
const MIN_REGISTER_GAS_LIMIT = 1_000_000n;

/**
 * The factory (src/CodegenVaultFactory.sol) stores creation bytecode via
 * BytecodeStorage — an SSTORE2-style pattern (deploy each chunk as a
 * contract's runtime code, read it back with EXTCODECOPY) instead of a plain
 * `mapping(address => bytes)`. Plain SSTORE costs ~20,000 gas per 32-byte
 * word (~625 gas/byte) — a 37KB vault would need ~23M gas for storage alone,
 * over the ~16.7M gas-per-tx cap enforced by every major public BSC RPC node
 * (confirmed directly against data-seed-prebsc-1-s1.binance.org,
 * bsc-testnet-rpc.publicnode.com, and bsc-testnet.drpc.org — switching RPCs
 * does not avoid this cap). BytecodeStorage's code-deposit cost is only
 * ~200 gas/byte, so even the factory's max (49,152 bytes, 3 chunks) fits
 * comfortably under that cap. EIP-170 limits any one deployed contract's
 * runtime code to 24,576 bytes, so chunks are capped at 24,575 (minus the
 * pointer's 1-byte STOP prefix) — see BytecodeStorage.MAX_CHUNK_SIZE.
 */
const SSTORE2_CHUNK_SIZE = 24_575n;
/** Fit to on-chain gas measurements (`forge test -vv` in test/BytecodeStorage.t.sol): ~188 gas/byte + ~235k/chunk, rounded up for margin. */
const SSTORE2_GAS_PER_BYTE = 200n;
const SSTORE2_GAS_PER_CHUNK = 260_000n;

export function registerVaultGasLimit(creationBytecode: Hex): bigint {
  const bytes = BigInt(creationBytecodeByteLength(creationBytecode));
  const chunks = bytes === 0n ? 0n : (bytes + SSTORE2_CHUNK_SIZE - 1n) / SSTORE2_CHUNK_SIZE;
  const storageGas = bytes * SSTORE2_GAS_PER_BYTE + chunks * SSTORE2_GAS_PER_CHUNK;
  const calldataGas = bytes * 16n;
  const estimate = 21_000n + storageGas + calldataGas;
  const withMargin = estimate + estimate / 6n;
  return withMargin > MIN_REGISTER_GAS_LIMIT ? withMargin : MIN_REGISTER_GAS_LIMIT;
}

/**
 * Many public BSC node operators run go-ethereum with `--rpc.gascap
 * 16777216` (0x1000000) — a per-node policy enforced on eth_sendRawTransaction
 * (not just eth_estimateGas), independent of the chain's real block gas
 * limit. A preflight simulateContract against a *different* RPC can pass
 * while the wallet's own configured RPC still rejects the broadcast with
 * this exact cap, which is what "transaction gas limit too high" means.
 */
export const KNOWN_RPC_GAS_CAP = 16_777_216n;

/** True when the computed gas limit is likely to hit a capped node's send-side rejection. */
export function exceedsKnownRpcGasCap(creationBytecode: Hex): boolean {
  return registerVaultGasLimit(creationBytecode) > KNOWN_RPC_GAS_CAP;
}

/**
 * EIP-170 (Spurious Dragon, 2016): every EVM chain hard-caps a deployed contract's
 * runtime code at this many bytes. This is a protocol rule, not a Flap/gas/network
 * setting — a vault whose compiled deployedBytecode exceeds this will ALWAYS fail
 * CREATE2 (factory sees `vault == address(0)` → reverts DeployFailed()), no matter
 * how many times it's re-registered or re-launched.
 */
export const MAX_DEPLOYED_BYTECODE_SIZE = 24_576;

/** True when a vault's compiled deployed (runtime) bytecode can never be deployed on any EVM chain. */
export function exceedsDeployedBytecodeLimit(deployedBytecodeSize: number | null | undefined): boolean {
  return typeof deployedBytecodeSize === "number" && deployedBytecodeSize > MAX_DEPLOYED_BYTECODE_SIZE;
}

// ── revert decoding ───────────────────────────────────────────────────────────

export type RegisterCallContext = {
  chainId: number;
  factoryAddress: string;
  wallet?: string | null;
  bytecodeBytes: number;
  descriptionLength: number;
};

export type DecodedRegisterError = {
  /** Human-readable cause; never blank. */
  reason: string;
  /** Decoded Solidity error name when the revert data could be parsed. */
  errorName: string | null;
  /** Raw message/data for the collapsed diagnostics view. */
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

function friendlyFactoryError(errorName: string, args: readonly unknown[] | undefined): string | null {
  switch (errorName) {
    case "EmptyInitCode":
      return "Factory rejected: creation bytecode was empty (EmptyInitCode). Regenerate the vault before registering.";
    case "InitCodeTooLarge": {
      const size = typeof args?.[0] === "bigint" ? args[0].toLocaleString() : String(args?.[0] ?? "?");
      return `Factory rejected: creation bytecode is ${size} bytes; max is ${MAX_REGISTER_INIT_CODE.toLocaleString()} (InitCodeTooLarge).`;
    }
    case "DeployFailed":
      return "Factory rejected: the vault constructor reverted during deployment (DeployFailed).";
    case "NotRegistered":
      return "Factory has no registered bytecode for this wallet (NotRegistered) — run Register vault first.";
    case "Error":
      return typeof args?.[0] === "string" && args[0].length > 0 ? `Reverted: ${args[0]}` : "Reverted with an empty Error(string).";
    case "Panic": {
      const code = typeof args?.[0] === "bigint" ? Number(args[0]) : Number(args?.[0] ?? -1);
      const label = PANIC_CODES[code] ?? "unknown panic";
      return `Solidity panic 0x${code.toString(16)} (${label}).`;
    }
    default:
      return null;
  }
}

function tryDecodeRevertData(data: string): { errorName: string; args: readonly unknown[] | undefined } | null {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;
  try {
    const decoded = decodeErrorResult({ abi: CODEGEN_FACTORY_REGISTER_ABI, data: data as Hex });
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
  code?: unknown;
};

/** Collects the error, its viem `cause` chain, and any embedded revert data. */
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

    // viem ContractFunctionRevertedError: `data` is the decoded error, `raw` the hex.
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

function fallbackDiagnostics(ctx: RegisterCallContext | undefined): string {
  if (!ctx) {
    return (
      "registerVault reverted without a reason from the node. " +
      "Likely causes: outdated factory address (redeploy the factory), wrong network, or the RPC dropped the revert data — retry after a hard refresh."
    );
  }
  const wallet = ctx.wallet ? ` from ${ctx.wallet}` : "";
  return (
    `registerVault(bytes,string) on ${ctx.factoryAddress} (chain ${ctx.chainId})${wallet} reverted without a reason. ` +
    `Sent: ${ctx.bytecodeBytes.toLocaleString()}-byte bytecode, ${ctx.descriptionLength}-char description. ` +
    "Likely causes: outdated factory (redeploy it in step 1), wrong network in the wallet, or the RPC dropped the revert data — retry after a hard refresh."
  );
}

/** Decodes a registerVault failure into a non-blank, actionable message. */
export function decodeRegisterRevert(err: unknown, ctx?: RegisterCallContext): DecodedRegisterError {
  if (!(err instanceof Error) && (typeof err !== "object" || err === null)) {
    return { reason: fallbackDiagnostics(ctx), errorName: null, raw: String(err) };
  }

  const { messages, revertDataCandidates, decodedFromViem } = walkErrorChain(err);
  const raw = messages.join("\n---\n") || String(err);
  const combined = messages.join("\n");
  const lower = combined.toLowerCase();

  // Non-revert failures first: these have clear user-side fixes.
  if (lower.includes("user rejected") || lower.includes("user denied")) {
    return { reason: "Transaction rejected in the wallet.", errorName: null, raw };
  }
  if (lower.includes("connector not connected") || lower.includes("connect wallet")) {
    return { reason: "Connect MetaMask first.", errorName: null, raw };
  }
  if (lower.includes("insufficient funds")) {
    return {
      reason: "Not enough tBNB for gas — registering a large vault can need several million gas. Top up from the faucet and retry.",
      errorName: null,
      raw,
    };
  }
  if (lower.includes("chain mismatch") || lower.includes("does not match the target chain")) {
    return { reason: "Wallet is on the wrong network — switch to BNB Smart Chain testnet (chain 97).", errorName: null, raw };
  }
  const gasCapMatch = combined.match(/gas limit too high\s*\(cap:\s*([\d,]+),\s*tx:\s*([\d,]+)\)/i);
  if (gasCapMatch) {
    const cap = Number(gasCapMatch[1]!.replace(/,/g, ""));
    const requested = Number(gasCapMatch[2]!.replace(/,/g, ""));
    return {
      reason:
        `Your wallet's RPC node rejected the transaction before broadcast: it hard-caps gas at ${cap.toLocaleString()}, ` +
        `but this transaction requested ${requested.toLocaleString()}. Every major public BSC testnet RPC enforces this ` +
        `same ~16.7M cap (verified directly — switching RPC URLs will not help). The factory now stores creation ` +
        `bytecode far more cheaply (well under this cap for any vault up to the factory's max size), so seeing this ` +
        `almost always means you're registering against an OUTDATED factory deployed before that fix — ` +
        `use "Redeploy factory" in step 1, then register again against the new address.`,
      errorName: null,
      raw,
    };
  }
  if (lower.includes("gas required exceeds allowance") || lower.includes("out of gas")) {
    return {
      reason: "Ran out of gas — large vault bytecode can need several million gas. Keep enough tBNB and retry after a hard refresh.",
      errorName: null,
      raw,
    };
  }

  // Decoded custom error straight from viem's revert error object.
  if (decodedFromViem) {
    const friendly = friendlyFactoryError(decodedFromViem.errorName, decodedFromViem.args);
    if (friendly) return { reason: friendly, errorName: decodedFromViem.errorName, raw };
    return { reason: `Factory reverted with ${decodedFromViem.errorName}.`, errorName: decodedFromViem.errorName, raw };
  }

  // Raw revert data anywhere in the chain (JSON-RPC error.data etc).
  for (const candidate of revertDataCandidates) {
    const decoded = tryDecodeRevertData(candidate);
    if (decoded) {
      const friendly = friendlyFactoryError(decoded.errorName, decoded.args);
      return {
        reason: friendly ?? `Factory reverted with ${decoded.errorName}.`,
        errorName: decoded.errorName,
        raw,
      };
    }
  }

  // Known selectors that may appear inline in messages even when data is stripped.
  if (combined.includes("EmptyInitCode") || combined.includes("0xf1e85bf9")) {
    return { reason: friendlyFactoryError("EmptyInitCode", undefined)!, errorName: "EmptyInitCode", raw };
  }
  if (combined.includes("InitCodeTooLarge")) {
    return { reason: friendlyFactoryError("InitCodeTooLarge", undefined)!, errorName: "InitCodeTooLarge", raw };
  }

  // A real reason string from the node (viem puts it after "reason:").
  const reasonMatch = combined.match(/reverted with the following reason:\s*\n?\s*(\S[^\n]*)/);
  if (reasonMatch?.[1]) {
    return { reason: `Reverted: ${reasonMatch[1]}`, errorName: null, raw };
  }

  // Blank revert — replace with full diagnostics instead of an empty string.
  if (lower.includes("revert")) {
    return { reason: fallbackDiagnostics(ctx), errorName: null, raw };
  }

  const firstLine = combined.split("\n").find((l) => l.trim().length > 0);
  return { reason: firstLine ?? fallbackDiagnostics(ctx), errorName: null, raw };
}
