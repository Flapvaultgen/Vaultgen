/**
 * Renders an AI-generated custom vault UI (Flap component-template package)
 * inside a locked-down sandbox.
 *
 * `sandbox="allow-scripts"` (no allow-same-origin) gives the artifact a
 * unique origin: no cookies, no storage, no parent DOM, no wallet object.
 * The iframe loads our runtime shim (/vault-runtime.js) which evaluates the
 * server-compiled component; every chain call comes back here over
 * postMessage — reads via the public client, writes via the user's wallet on
 * the HOST page (the wallet prompt always comes from our site, never from AI
 * code), with write targets restricted to the vault/token.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { bscTestnet } from "viem/chains";
import type { Abi, Address } from "viem";
import { wagmiConfig } from "../lib/wagmi";
import { flapTestnetPublicClient } from "../lib/flap-factory";
import {
  VAULT_UI_BRIDGE_MARKER,
  buildVaultUiSrcDoc,
  checkWriteTarget,
  isVaultUiBridgeRequest,
  synthesizeZeroResult,
  type VaultUiArtifact,
  type VaultUiBridgeRequest,
  type VaultUiCallPayload,
} from "../lib/vault-ui-bridge";

type Props = {
  artifact: VaultUiArtifact;
  /** Deployed vault address; omit/null for preview mode (reads return zeros, writes rejected). */
  vaultAddress?: Address | null;
  tokenAddress?: Address | null;
  factoryAddress?: Address | null;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  className?: string;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export default function VaultCustomUI({
  artifact,
  vaultAddress = null,
  tokenAddress = null,
  factoryAddress = null,
  tokenName = null,
  tokenSymbol = null,
  className,
}: Props) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const addressRef = useRef(address);
  addressRef.current = address;
  const chainIdRef = useRef(chainId);
  chainIdRef.current = chainId;

  const preview = !vaultAddress;

  const pushWalletState = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        [VAULT_UI_BRIDGE_MARKER]: 1,
        kind: "wallet",
        wallet: { address: addressRef.current ?? null, chainId: chainIdRef.current ?? null },
      },
      "*"
    );
  }, []);

  // Keep the sandbox's wallet view in sync with the host wallet.
  useEffect(() => {
    pushWalletState();
  }, [address, chainId, pushWalletState]);

  const handleRequest = useCallback(
    async (req: VaultUiBridgeRequest): Promise<unknown> => {
      const payload: VaultUiCallPayload = req.payload ?? {};

      if (req.kind === "switchChain") {
        await switchChainAsync({ chainId: bscTestnet.id });
        return undefined;
      }

      if (req.kind === "read") {
        if (preview) return synthesizeZeroResult(payload.abi, payload.functionName);
        const target = payload.address ?? vaultAddress ?? "";
        if (!ADDRESS_RE.test(target)) throw new Error("Invalid read target address.");
        if (!Array.isArray(payload.abi) || typeof payload.functionName !== "string") {
          throw new Error("read requires { abi, functionName }.");
        }
        return flapTestnetPublicClient.readContract({
          address: target as Address,
          abi: payload.abi as Abi,
          functionName: payload.functionName,
          args: Array.isArray(payload.args) ? payload.args : [],
        });
      }

      // ── write ──
      if (preview || !vaultAddress) throw new Error("Preview mode — launch the token to enable transactions.");
      const denial = checkWriteTarget(payload, { vaultAddress, tokenAddress });
      if (denial) throw new Error(denial);
      if (!Array.isArray(payload.abi) || typeof payload.functionName !== "string") {
        throw new Error("write requires { abi, functionName }.");
      }
      const account = addressRef.current;
      if (!account) throw new Error("Connect a wallet first.");
      if (chainIdRef.current !== bscTestnet.id) {
        await switchChainAsync({ chainId: bscTestnet.id });
      }
      const value = typeof payload.value === "bigint" ? payload.value : undefined;
      if (value !== undefined && value < 0n) throw new Error("value must be non-negative.");

      const hash = await writeContract(wagmiConfig, {
        address: (payload.address ?? vaultAddress) as Address,
        abi: payload.abi as Abi,
        functionName: payload.functionName,
        args: Array.isArray(payload.args) ? payload.args : [],
        value,
        chainId: bscTestnet.id,
        account,
      });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: bscTestnet.id });
      if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
      return { txHash: hash };
    },
    [preview, vaultAddress, tokenAddress, switchChainAsync]
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!isVaultUiBridgeRequest(e.data)) return;
      const req = e.data;
      if (req.kind === "ready") {
        pushWalletState();
        return;
      }
      void handleRequest(req)
        .then((result) => {
          iframeRef.current?.contentWindow?.postMessage(
            { [VAULT_UI_BRIDGE_MARKER]: 1, id: req.id, ok: true, result },
            "*"
          );
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message.split("\n")[0]! : "Bridge call failed.";
          iframeRef.current?.contentWindow?.postMessage(
            { [VAULT_UI_BRIDGE_MARKER]: 1, id: req.id, ok: false, error: message },
            "*"
          );
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleRequest, pushWalletState]);

  const srcDoc = useMemo(
    () =>
      buildVaultUiSrcDoc(artifact, {
        context: {
          chainId: bscTestnet.id,
          vaultAddress,
          tokenAddress,
          factoryAddress,
          tokenName,
          tokenSymbol,
          host: { marketPhase: preview ? "unknown" : "internal-market" },
        },
        preview,
        runtimeUrl: `${window.location.origin}/vault-runtime.js`,
      }),
    [artifact, vaultAddress, tokenAddress, factoryAddress, tokenName, tokenSymbol, preview]
  );

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title="Custom vault UI"
      className={className ?? "h-[720px] w-full rounded-lg border border-border bg-background"}
    />
  );
}
