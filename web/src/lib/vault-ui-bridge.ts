/**
 * Host side of the sandboxed custom-vault-UI runtime.
 *
 * The AI artifact is a Flap vault-component-template source package
 * (Component.tsx + VaultABI.ts + i18n.json + manifest.json) compiled to CJS on
 * the server. We render it inside `<iframe sandbox="allow-scripts">` — a
 * unique origin with no wallet, no RPC, no storage and no parent-DOM access.
 * The iframe loads our prebuilt runtime bundle (/vault-runtime.js: React +
 * a Flap SDK/UI shim, built by scripts/build-vault-runtime.mts), which
 * evaluates the compiled component and routes ALL chain access through the
 * postMessage protocol defined here:
 *
 *   - "read"        → publicClient.readContract with the artifact's own ABI
 *   - "write"       → wagmi writeContract via the user's wallet (target-restricted)
 *   - "switchChain" → prompt the wallet to switch to the vault chain
 *   - "ready"       → iframe booted; host replies with a wallet-state push
 *
 * postMessage uses structured clone, so bigints cross the boundary natively.
 *
 * This module is DOM-free at import time (no React/wagmi) so node selfchecks
 * can cover the protocol; the React side lives in components/VaultCustomUI.tsx
 * and the in-iframe side in src/vault-runtime/.
 */

export const VAULT_UI_BRIDGE_MARKER = "__flapVaultUi";

/** Mirrors server/ui-gen.ts VaultUiArtifact. */
export type VaultUiArtifact = {
  format: "flap-vault-component@1";
  files: {
    componentTsx: string;
    vaultAbiTs: string;
    i18nJson: string;
    manifestJson: string;
  };
  compiled: { componentJs: string; vaultAbiJs: string };
  model: string;
  bytes: number;
};

/** Parses a persisted artifact JSON string; null for legacy/foreign payloads. */
export function parseVaultUiArtifact(raw: unknown): VaultUiArtifact | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const artifact = value as VaultUiArtifact;
  if (artifact.format !== "flap-vault-component@1") return null;
  if (!artifact.files?.componentTsx || !artifact.compiled?.componentJs || typeof artifact.compiled.vaultAbiJs !== "string") return null;
  return artifact;
}

// ── postMessage protocol ─────────────────────────────────────────────────────

export type VaultUiCallPayload = {
  address?: string;
  abi?: unknown[];
  functionName?: string;
  args?: unknown[];
  value?: bigint;
};

export type VaultUiBridgeRequest = {
  [VAULT_UI_BRIDGE_MARKER]: 1;
  id: number;
  kind: "read" | "write" | "switchChain" | "ready";
  payload?: VaultUiCallPayload;
};

export type VaultUiBridgeResponse = {
  [VAULT_UI_BRIDGE_MARKER]: 1;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type VaultUiWalletState = { address: string | null; chainId: number | null };

export type VaultUiWalletPush = {
  [VAULT_UI_BRIDGE_MARKER]: 1;
  kind: "wallet";
  wallet: VaultUiWalletState;
};

export function isVaultUiBridgeRequest(data: unknown): data is VaultUiBridgeRequest {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d[VAULT_UI_BRIDGE_MARKER] === 1 && typeof d.kind === "string" && d.kind !== "wallet" && typeof d.id === "number";
}

// ── Write-target policy ──────────────────────────────────────────────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Writes from AI code are restricted to the vault and its token, plus ERC-20
 * `approve` calls whose spender is the vault. Returns an error message, or
 * null when the call is allowed.
 */
export function checkWriteTarget(
  payload: VaultUiCallPayload,
  ctx: { vaultAddress: string | null; tokenAddress: string | null }
): string | null {
  const target = payload.address ?? ctx.vaultAddress ?? "";
  if (!ADDRESS_RE.test(target)) return "Invalid write target address.";
  const targetLc = target.toLowerCase();
  const vaultLc = ctx.vaultAddress?.toLowerCase() ?? null;
  if (vaultLc && targetLc === vaultLc) return null;
  if (ctx.tokenAddress && targetLc === ctx.tokenAddress.toLowerCase()) return null;
  if (
    vaultLc &&
    payload.functionName === "approve" &&
    Array.isArray(payload.args) &&
    typeof payload.args[0] === "string" &&
    payload.args[0].toLowerCase() === vaultLc
  ) {
    return null; // approving the vault as spender on any ERC-20 is safe
  }
  return "Writes are restricted to this vault, its token, and approve(vault, …).";
}

// ── Preview-mode zero synthesis ──────────────────────────────────────────────

type AbiParam = { type?: string; components?: AbiParam[] };

function zeroForType(param: AbiParam): unknown {
  const type = param.type ?? "uint256";
  if (type.endsWith("]")) return [];
  if (type === "tuple") return (param.components ?? []).map(zeroForType);
  if (type === "bool") return false;
  if (type === "address") return "0x0000000000000000000000000000000000000000";
  if (type === "string") return "";
  if (type.startsWith("bytes")) return "0x";
  return 0n; // uint*/int*
}

/**
 * Fabricates a plausible zero-value result for a read in preview mode (no
 * vault deployed yet), shaped by the function's declared outputs so the
 * component renders realistically.
 */
export function synthesizeZeroResult(abi: unknown[] | undefined, functionName: string | undefined): unknown {
  const fn = (Array.isArray(abi) ? abi : []).find(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      (e as Record<string, unknown>).type === "function" &&
      (e as Record<string, unknown>).name === functionName
  ) as { outputs?: AbiParam[] } | undefined;
  const outputs = fn?.outputs ?? [];
  if (outputs.length === 0) return undefined;
  if (outputs.length === 1) return zeroForType(outputs[0]!);
  return outputs.map(zeroForType);
}

// ── iframe document (srcdoc) ─────────────────────────────────────────────────

export type VaultUiRuntimeContext = {
  chainId: number;
  vaultAddress: string | null;
  tokenAddress: string | null;
  factoryAddress: string | null;
  tokenName: string | null;
  tokenSymbol: string | null;
  host: { marketPhase: "internal-market" | "dex-listed" | "unknown" };
};

/** The global the runtime bundle reads at boot (window.__VAULT_UI_INIT__). */
export type VaultUiRuntimeInit = {
  context: VaultUiRuntimeContext;
  preview: boolean;
  locale: "en" | "zh";
  i18n: Record<string, Record<string, string>>;
  componentJs: string;
  vaultAbiJs: string;
};

/** Makes a JSON payload safe to inline inside a <script> block. */
function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Builds the sandboxed iframe document: an empty shell that sets the init
 * global and loads our runtime bundle (classic scripts, so order is
 * guaranteed). None of the AI's code appears as markup — it only ever runs as
 * compiled CJS evaluated by the runtime.
 */
export function buildVaultUiSrcDoc(
  artifact: VaultUiArtifact,
  opts: { context: VaultUiRuntimeContext; preview: boolean; locale?: "en" | "zh"; runtimeUrl: string }
): string {
  let i18n: Record<string, Record<string, string>> = {};
  try {
    i18n = JSON.parse(artifact.files.i18nJson) as Record<string, Record<string, string>>;
  } catch {
    // tolerate a broken dictionary — the shim falls back to raw keys
  }
  const init: VaultUiRuntimeInit = {
    context: opts.context,
    preview: opts.preview,
    locale: opts.locale ?? "en",
    i18n,
    componentJs: artifact.compiled.componentJs,
    vaultAbiJs: artifact.compiled.vaultAbiJs,
  };
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
<div id="root"></div>
<script>window.__VAULT_UI_INIT__ = ${inlineScriptJson(init)};</script>
<script src="${opts.runtimeUrl}"></script>
</body>
</html>`;
}

// ── Download (Flap Artifact Workbench package) ───────────────────────────────

export const MANIFEST_FACTORY_PLACEHOLDER = "{{FACTORY_ADDRESS}}";
export const MANIFEST_TOKEN_PLACEHOLDER = "{{TOKEN_ADDRESS}}";

/** Replaces manifest address placeholders once the real deployment is known. */
export function fillManifestPlaceholders(
  manifestJson: string,
  addresses: { factoryAddress?: string | null; tokenAddress?: string | null }
): string {
  let out = manifestJson;
  if (addresses.factoryAddress) out = out.split(MANIFEST_FACTORY_PLACEHOLDER).join(addresses.factoryAddress);
  if (addresses.tokenAddress) out = out.split(MANIFEST_TOKEN_PLACEHOLDER).join(addresses.tokenAddress);
  return out;
}

/**
 * Downloads the 4-file source package as a zip — the exact files to drop into
 * a clone of Flap's vault-component template and submit to their Artifact
 * Workbench (their vault:check / vault:package pipeline runs on these).
 */
export async function downloadVaultUiPackage(
  artifact: VaultUiArtifact,
  contractName: string,
  addresses: { factoryAddress?: string | null; tokenAddress?: string | null } = {}
): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("Component.tsx", artifact.files.componentTsx);
  zip.file("VaultABI.ts", artifact.files.vaultAbiTs);
  zip.file("i18n.json", artifact.files.i18nJson);
  zip.file("manifest.json", fillManifestPlaceholders(artifact.files.manifestJson, addresses));
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${contractName || "vault"}-flap-ui.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
