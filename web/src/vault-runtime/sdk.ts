/**
 * The `@/src/sdk` module the AI-generated component imports — a faithful
 * subset of Flap's vault-component-template SDK, backed by the postMessage
 * bridge instead of a direct wallet/RPC.
 *
 * MUST stay in sync with FLAP_SDK_SURFACE_DOC in server/ui-gen.ts: every name
 * documented there is implemented here with the same semantics, so the same
 * Component.tsx also runs unmodified inside Flap's real template.
 */
import { useMemo, useSyncExternalStore } from "react";
import { synthesizeZeroResult, type VaultUiRuntimeInit } from "../lib/vault-ui-bridge";
import { bridgeCall, getWalletState, subscribeWalletState } from "./bridge-client";

export type Address = `0x${string}`;
export type VaultComponentProps = Record<string, never>;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

function getInit(): VaultUiRuntimeInit {
  return (window as unknown as { __VAULT_UI_INIT__: VaultUiRuntimeInit }).__VAULT_UI_INIT__;
}

export function isValidAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function formatTokenAmount(value: bigint, decimals: number, maxFraction = 4): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let fraction = (abs % base).toString().padStart(decimals, "0").slice(0, Math.max(0, maxFraction)).replace(/0+$/, "");
  // Tiny-but-nonzero amounts shouldn't render as "0"
  if (fraction === "" && whole === 0n && abs > 0n) fraction = "0".repeat(Math.max(0, maxFraction - 1)) + "…";
  return `${negative ? "-" : ""}${wholeStr}${fraction ? `.${fraction}` : ""}`;
}

export function parseTokenAmount(text: string, decimals: number): bigint {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`"${text}" is not a valid amount.`);
  const [whole, fraction = ""] = trimmed.split(".") as [string, string?];
  if ((fraction ?? "").length > decimals) throw new Error(`Too many decimal places (max ${decimals}).`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction ?? "").padEnd(decimals, "0") || "0");
}

export function formatPercentBps(bps: bigint | number): string {
  const value = Number(bps) / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

export function handleTxError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split("\n")[0]!.trim();
  if (/user rejected|user denied|rejected the request/i.test(first)) return "Transaction rejected in wallet.";
  return first.length > 180 ? `${first.slice(0, 177)}…` : first || "Transaction failed.";
}

export type TaxVaultHostContext = { marketPhase: "internal-market" | "dex-listed" | "unknown" };

export function readTaxVaultHostContext(host: unknown): TaxVaultHostContext {
  const phase =
    host && typeof host === "object" && typeof (host as Record<string, unknown>).marketPhase === "string"
      ? ((host as Record<string, unknown>).marketPhase as string)
      : "unknown";
  return { marketPhase: phase === "internal-market" || phase === "dex-listed" ? phase : "unknown" };
}

export function isActionAvailableForPhase(stage: "internal-market" | "dex-listed" | "both", phase: string): boolean {
  if (stage === "both") return true;
  if (phase === "unknown") return true; // never dead-lock the UI on missing host data
  return stage === phase;
}

// ── useFlapSdk ────────────────────────────────────────────────────────────────

type ReadArgs = { address?: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };
type WriteArgs = ReadArgs & { value?: bigint };

export type FlapSdk = {
  context: VaultUiRuntimeInit["context"];
  i18n: { t(key: string): string; locale: "en" | "zh" };
  wallet: {
    address: Address | null;
    isConnected: boolean;
    isWrongNetwork: boolean;
    switchChain(): Promise<void>;
  };
  readContract<T = unknown>(args: ReadArgs): Promise<T>;
  writeContract(args: WriteArgs): Promise<{ txHash: string }>;
};

export function useFlapSdk(): FlapSdk {
  const walletState = useSyncExternalStore(subscribeWalletState, getWalletState);
  return useMemo<FlapSdk>(() => {
    const init = getInit();
    const { context, preview, locale, i18n } = init;
    const dict = i18n[locale] ?? i18n.en ?? {};
    const fallback = i18n.en ?? {};
    return {
      context,
      i18n: {
        t: (key: string) => dict[key] ?? fallback[key] ?? key,
        locale,
      },
      wallet: {
        address: (walletState.address as Address | null) ?? null,
        isConnected: Boolean(walletState.address),
        isWrongNetwork: Boolean(walletState.address) && walletState.chainId !== context.chainId,
        switchChain: () => bridgeCall<void>("switchChain", {}, 60_000),
      },
      readContract: <T,>(args: ReadArgs): Promise<T> => {
        if (preview) return Promise.resolve(synthesizeZeroResult(args.abi as unknown[], args.functionName) as T);
        return bridgeCall<T>("read", {
          address: args.address ?? context.vaultAddress ?? undefined,
          abi: args.abi as unknown[],
          functionName: args.functionName,
          args: (args.args ?? []) as unknown[],
        });
      },
      writeContract: (args: WriteArgs) => {
        if (preview) return Promise.reject(new Error("Preview mode — launch the token to enable transactions."));
        return bridgeCall<{ txHash: string }>(
          "write",
          {
            address: args.address ?? context.vaultAddress ?? undefined,
            abi: args.abi as unknown[],
            functionName: args.functionName,
            args: (args.args ?? []) as unknown[],
            value: args.value,
          },
          300_000
        );
      },
    };
  }, [walletState]);
}
