/**
 * In-iframe side of the vault UI bridge: request/response RPC to the host
 * page over postMessage (structured clone — bigints pass through natively),
 * plus a subscribable wallet-state cache fed by unsolicited host pushes.
 */
import {
  VAULT_UI_BRIDGE_MARKER,
  type VaultUiBridgeResponse,
  type VaultUiCallPayload,
  type VaultUiWalletPush,
  type VaultUiWalletState,
} from "../lib/vault-ui-bridge";

let wallet: VaultUiWalletState = { address: null, chainId: null };
const walletListeners = new Set<() => void>();
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const data = e.data as Partial<VaultUiBridgeResponse & VaultUiWalletPush> | null;
  if (!data || data[VAULT_UI_BRIDGE_MARKER] !== 1) return;
  if (data.kind === "wallet" && data.wallet) {
    wallet = data.wallet;
    walletListeners.forEach((fn) => fn());
    return;
  }
  if (typeof data.id !== "number") return;
  const entry = pending.get(data.id);
  if (!entry) return;
  pending.delete(data.id);
  clearTimeout(entry.timer);
  if (data.ok) entry.resolve(data.result);
  else entry.reject(new Error(data.error || "Bridge call failed"));
});

export function bridgeCall<T>(kind: "read" | "write" | "switchChain", payload: VaultUiCallPayload, timeoutMs = 60_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error("The host page did not respond in time."));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    window.parent.postMessage({ [VAULT_UI_BRIDGE_MARKER]: 1, id, kind, payload }, "*");
  });
}

/** Tells the host the runtime booted so it replies with the current wallet state. */
export function announceReady(): void {
  window.parent.postMessage({ [VAULT_UI_BRIDGE_MARKER]: 1, id: ++seq, kind: "ready" }, "*");
}

export function getWalletState(): VaultUiWalletState {
  return wallet;
}

export function subscribeWalletState(fn: () => void): () => void {
  walletListeners.add(fn);
  return () => walletListeners.delete(fn);
}
