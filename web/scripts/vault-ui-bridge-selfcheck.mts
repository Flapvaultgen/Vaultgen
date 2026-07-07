/**
 * Selfcheck for the sandboxed custom-vault-UI bridge (web side):
 * artifact parsing, request detection, write-target policy, preview zero
 * synthesis, srcdoc shell construction and manifest placeholder filling.
 *
 * Run: npm run test:vault-ui-bridge  (tsx scripts/vault-ui-bridge-selfcheck.mts)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MANIFEST_FACTORY_PLACEHOLDER,
  MANIFEST_TOKEN_PLACEHOLDER,
  VAULT_UI_BRIDGE_MARKER,
  buildVaultUiSrcDoc,
  checkWriteTarget,
  fillManifestPlaceholders,
  isVaultUiBridgeRequest,
  parseVaultUiArtifact,
  synthesizeZeroResult,
  type VaultUiArtifact,
} from "../src/lib/vault-ui-bridge";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const VAULT = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";

const ARTIFACT: VaultUiArtifact = {
  format: "flap-vault-component@1",
  files: {
    componentTsx: `"use client";\nexport default function C() { return null; }`,
    vaultAbiTs: "export const vaultAbi = [] as const;",
    i18nJson: JSON.stringify({ en: { hi: "Hi" }, zh: { hi: "你好" } }),
    manifestJson: JSON.stringify({
      artifactId: "vaultui_test_X",
      match: { bindings: [{ chainId: 97, factoryAddress: MANIFEST_FACTORY_PLACEHOLDER, tokenAddresses: [MANIFEST_TOKEN_PLACEHOLDER] }] },
    }),
  },
  compiled: {
    componentJs: `"use strict";\nmodule.exports = { default: function C() { return null; } };\n// </script> guard test`,
    vaultAbiJs: `"use strict";\nmodule.exports = { vaultAbi: [] };`,
  },
  model: "test-model",
  bytes: 123,
};

// ── parseVaultUiArtifact ─────────────────────────────────────────────────────
console.log("parseVaultUiArtifact");
{
  check("round-trips through JSON string", parseVaultUiArtifact(JSON.stringify(ARTIFACT)) !== null);
  check("accepts already-parsed object", parseVaultUiArtifact(ARTIFACT) !== null);
  check("rejects legacy html artifact", parseVaultUiArtifact("<!DOCTYPE html><html></html>") === null);
  check("rejects wrong format tag", parseVaultUiArtifact(JSON.stringify({ ...ARTIFACT, format: "html@1" })) === null);
  check("rejects missing compiled js", parseVaultUiArtifact(JSON.stringify({ ...ARTIFACT, compiled: undefined })) === null);
  check("rejects null/garbage", parseVaultUiArtifact(null) === null && parseVaultUiArtifact("{}") === null);
}

// ── isVaultUiBridgeRequest ───────────────────────────────────────────────────
console.log("isVaultUiBridgeRequest");
{
  check("accepts read request", isVaultUiBridgeRequest({ [VAULT_UI_BRIDGE_MARKER]: 1, id: 1, kind: "read", payload: {} }));
  check("accepts ready request", isVaultUiBridgeRequest({ [VAULT_UI_BRIDGE_MARKER]: 1, id: 2, kind: "ready" }));
  check("rejects wallet push shape", !isVaultUiBridgeRequest({ [VAULT_UI_BRIDGE_MARKER]: 1, kind: "wallet", wallet: {} }));
  check("rejects unmarked data", !isVaultUiBridgeRequest({ id: 1, kind: "read" }));
  check("rejects missing id", !isVaultUiBridgeRequest({ [VAULT_UI_BRIDGE_MARKER]: 1, kind: "read" }));
  check("rejects primitives", !isVaultUiBridgeRequest("read") && !isVaultUiBridgeRequest(null));
}

// ── checkWriteTarget ─────────────────────────────────────────────────────────
console.log("checkWriteTarget");
{
  const ctx = { vaultAddress: VAULT, tokenAddress: TOKEN };
  check("allows vault target", checkWriteTarget({ address: VAULT, functionName: "claim" }, ctx) === null);
  check("allows vault target case-insensitively", checkWriteTarget({ address: VAULT.toUpperCase().replace("0X", "0x"), functionName: "claim" }, ctx) === null);
  check("allows token target", checkWriteTarget({ address: TOKEN, functionName: "transfer" }, ctx) === null);
  check("defaults to vault when no address", checkWriteTarget({ functionName: "claim" }, ctx) === null);
  check("blocks arbitrary target", checkWriteTarget({ address: OTHER, functionName: "transfer" }, ctx) !== null);
  check("allows approve(vault) on any erc20", checkWriteTarget({ address: OTHER, functionName: "approve", args: [VAULT, 1n] }, ctx) === null);
  check("blocks approve(other) on foreign erc20", checkWriteTarget({ address: OTHER, functionName: "approve", args: [OTHER, 1n] }, ctx) !== null);
  check("blocks invalid address", checkWriteTarget({ address: "0x123", functionName: "claim" }, ctx) !== null);
  check("blocks with no vault context", checkWriteTarget({ functionName: "claim" }, { vaultAddress: null, tokenAddress: null }) !== null);
}

// ── synthesizeZeroResult ─────────────────────────────────────────────────────
console.log("synthesizeZeroResult");
{
  const abi = [
    { type: "function", name: "potBalance", outputs: [{ type: "uint256" }] },
    { type: "function", name: "winner", outputs: [{ type: "address" }] },
    { type: "function", name: "stats", outputs: [{ type: "uint256" }, { type: "bool" }, { type: "string" }] },
    { type: "function", name: "entries", outputs: [{ type: "address[]" }] },
    { type: "function", name: "doThing", outputs: [] },
  ];
  check("single uint → 0n", synthesizeZeroResult(abi, "potBalance") === 0n);
  check("address → zero address", synthesizeZeroResult(abi, "winner") === "0x0000000000000000000000000000000000000000");
  const stats = synthesizeZeroResult(abi, "stats") as unknown[];
  check("tuple → array of typed zeros", Array.isArray(stats) && stats[0] === 0n && stats[1] === false && stats[2] === "");
  check("array output → []", Array.isArray(synthesizeZeroResult(abi, "entries")) && (synthesizeZeroResult(abi, "entries") as unknown[]).length === 0);
  check("void output → undefined", synthesizeZeroResult(abi, "doThing") === undefined);
  check("unknown function → 0n-ish default", synthesizeZeroResult(abi, "nope") !== null);
}

// ── buildVaultUiSrcDoc ───────────────────────────────────────────────────────
console.log("buildVaultUiSrcDoc");
{
  const srcDoc = buildVaultUiSrcDoc(ARTIFACT, {
    context: {
      chainId: 97,
      vaultAddress: VAULT,
      tokenAddress: TOKEN,
      factoryAddress: null,
      tokenName: "Test",
      tokenSymbol: "TST",
      host: { marketPhase: "internal-market" },
    },
    preview: false,
    runtimeUrl: "https://example.local/vault-runtime.js",
  });
  check("sets init global", srcDoc.includes("window.__VAULT_UI_INIT__"));
  check("loads runtime bundle", srcDoc.includes(`src="https://example.local/vault-runtime.js"`));
  check("has root mount", srcDoc.includes(`<div id="root"></div>`));
  check("escapes </script> inside payload", !/guard test[\s\S]*<\/script>[\s\S]*guard/.test(srcDoc) && srcDoc.includes("\\u003c"));
  check("carries compiled js not tsx", srcDoc.includes("componentJs") && !srcDoc.includes("componentTsx"));
  const initMatch = srcDoc.match(/window\.__VAULT_UI_INIT__ = (.*);<\/script>/);
  let init: Record<string, unknown> | null = null;
  try {
    init = initMatch ? (JSON.parse(initMatch[1]!) as Record<string, unknown>) : null;
  } catch {
    init = null;
  }
  check("init payload is valid JSON", init !== null);
  check("init has parsed i18n", !!init && typeof (init.i18n as Record<string, unknown>)?.en === "object");
  check("init context has vault", !!init && (init.context as Record<string, unknown>)?.vaultAddress === VAULT);
  check("preview flag carried", !!init && init.preview === false);
}

// ── fillManifestPlaceholders ─────────────────────────────────────────────────
console.log("fillManifestPlaceholders");
{
  const filled = fillManifestPlaceholders(ARTIFACT.files.manifestJson, { factoryAddress: VAULT, tokenAddress: TOKEN });
  check("factory placeholder replaced", filled.includes(VAULT) && !filled.includes(MANIFEST_FACTORY_PLACEHOLDER));
  check("token placeholder replaced", filled.includes(TOKEN) && !filled.includes(MANIFEST_TOKEN_PLACEHOLDER));
  const partial = fillManifestPlaceholders(ARTIFACT.files.manifestJson, {});
  check("placeholders kept when unknown", partial.includes(MANIFEST_FACTORY_PLACEHOLDER) && partial.includes(MANIFEST_TOKEN_PLACEHOLDER));
}

// ── static wiring ────────────────────────────────────────────────────────────
console.log("static wiring");
{
  const customUi = readFileSync(path.join(here, "../src/components/VaultCustomUI.tsx"), "utf8");
  const sandboxMatch = customUi.match(/sandbox="([^"]+)"/);
  check("iframe sandbox is allow-scripts only", sandboxMatch?.[1] === "allow-scripts", sandboxMatch?.[1]);
  check("parent enforces write policy", customUi.includes("checkWriteTarget"));
  check("parent pushes wallet state", customUi.includes(`kind: "wallet"`));
  check("parent verifies message source", customUi.includes("e.source !== iframeRef.current?.contentWindow"));

  const runtimeMain = readFileSync(path.join(here, "../src/vault-runtime/main.tsx"), "utf8");
  check("runtime restricts module registry", runtimeMain.includes("STATIC_MODULES") && runtimeMain.includes("is not available in the vault UI sandbox"));
  check("runtime renders under error boundary", runtimeMain.includes("ErrorBoundary"));

  const pkg = JSON.parse(readFileSync(path.join(here, "../package.json"), "utf8")) as { scripts: Record<string, string> };
  check("dev builds runtime bundle", pkg.scripts.dev.includes("build:vault-runtime"));
  check("dev:all builds runtime bundle", pkg.scripts["dev:all"]!.includes("build:vault-runtime"));
  check("build builds runtime bundle", pkg.scripts.build.includes("build:vault-runtime"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll vault-ui-bridge selfchecks passed.");
