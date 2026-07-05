/**
 * Selfcheck for the custom vault UI generation pass (Flap component-package
 * format): sectioned-output parsing, Flap Workbench blocking-rule validation,
 * i18n dictionary validation, manifest generation, the esbuild compile step,
 * and static wiring into codegen.ts / run-manager.ts.
 *
 * Run: npm run test:ui-gen  (tsx server/ui-gen-selfcheck.mts)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FLAP_SDK_SURFACE_DOC,
  MANIFEST_FACTORY_PLACEHOLDER,
  MANIFEST_TOKEN_PLACEHOLDER,
  buildVaultUiManifest,
  buildVaultUiPrompt,
  compileVaultUiComponent,
  parseVaultUiSections,
  validateVaultUiComponent,
  validateVaultUiI18n,
} from "./ui-gen.js";
import type { MechanicSpec } from "./mechanic-spec.js";

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

const GOOD_COMPONENT = `"use client";
import { useEffect, useState } from "react";
import { useFlapSdk, formatTokenAmount, handleTxError, type VaultComponentProps } from "@/src/sdk";
import { Card, CardContent, TxButton, type TxButtonState } from "@/src/ui";
import { Trophy } from "lucide-react";
import { vaultAbi } from "./VaultABI";

export default function Component(_props: VaultComponentProps) {
  const sdk = useFlapSdk();
  const [pot, setPot] = useState<bigint>(0n);
  const [state, setState] = useState<TxButtonState>("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      sdk.readContract<bigint>({ abi: vaultAbi, functionName: "potBalance" })
        .then((v) => { if (alive) setPot(v); })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 12000);
    return () => { alive = false; clearInterval(timer); };
  }, [sdk]);
  const claim = async () => {
    setState("pending");
    try {
      await sdk.writeContract({ abi: vaultAbi, functionName: "claim" });
      setState("success");
    } catch (err) {
      setError(handleTxError(err));
      setState("error");
    }
  };
  return (
    <div className="pot-root">
      <style>{".pot-root { padding: 16px; }"}</style>
      <Card><CardContent>
        <Trophy size={16} />
        <span>{sdk.i18n.t("pot.title")}: {formatTokenAmount(pot, 18)}</span>
        <TxButton state={state} onClick={claim}>{sdk.i18n.t("pot.claim")}</TxButton>
        {error ? <span>{error}</span> : null}
      </CardContent></Card>
    </div>
  );
}
`;

const GOOD_ABI = `export const vaultAbi = [
  { type: "function", name: "potBalance", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
`;

const GOOD_I18N = JSON.stringify({
  en: { "pot.title": "Prize pot", "pot.claim": "Claim" },
  zh: { "pot.title": "奖池", "pot.claim": "领取" },
});

// ── parseVaultUiSections ─────────────────────────────────────────────────────
console.log("parseVaultUiSections");
{
  const raw = `===FILE:Component.tsx===\n${GOOD_COMPONENT}\n===FILE:VaultABI.ts===\n${GOOD_ABI}\n===FILE:i18n.json===\n${GOOD_I18N}\n===END===\n`;
  const parsed = parseVaultUiSections(raw);
  check("parses all three sections", !!parsed);
  check("component content intact", !!parsed && parsed.componentTsx.includes("export default function Component"));
  check("abi content intact", !!parsed && parsed.vaultAbiTs.includes("potBalance"));
  check("i18n content intact", !!parsed && parsed.i18nJson.includes("pot.title"));
  check("missing section returns null", parseVaultUiSections(`===FILE:Component.tsx===\nfoo\n===END===`) === null);
  check("plain text returns null", parseVaultUiSections("hello world") === null);
}

// ── validateVaultUiComponent ─────────────────────────────────────────────────
console.log("validateVaultUiComponent");
{
  check("good package passes", validateVaultUiComponent(GOOD_COMPONENT, GOOD_ABI).length === 0, validateVaultUiComponent(GOOD_COMPONENT, GOOD_ABI).join("; "));

  const cases: [string, string][] = [
    ["missing use client", GOOD_COMPONENT.replace(`"use client";\n`, "")],
    ["disallowed import", GOOD_COMPONENT.replace(`from "lucide-react"`, `from "axios"`)],
    ["fetch", GOOD_COMPONENT.replace("const claim", `const x = fetch("/x"); const claim`)],
    ["window.ethereum", GOOD_COMPONENT.replace("const claim", "const w = window.ethereum; const claim")],
    ["postMessage", GOOD_COMPONENT.replace("const claim", `const p = () => postMessage({}, "*"); const claim`)],
    ["localStorage", GOOD_COMPONENT.replace("const claim", `const s = localStorage.getItem("k"); const claim`)],
    ["external url", GOOD_COMPONENT.replace("const claim", `const u = "https://evil.example/"; const claim`)],
    ["eval", GOOD_COMPONENT.replace("const claim", `const e = eval("1"); const claim`)],
    ["iframe", GOOD_COMPONENT.replace("<Trophy size={16} />", `<iframe src="x" />`)],
    ["dangerouslySetInnerHTML", GOOD_COMPONENT.replace("<Trophy size={16} />", `<div dangerouslySetInnerHTML={{ __html: "x" }} />`)],
    ["window.parent", GOOD_COMPONENT.replace("const claim", "const wp = window.parent; const claim")],
    ["dynamic import", GOOD_COMPONENT.replace("const claim", `const m = import("x"); const claim`)],
  ];
  for (const [name, bad] of cases) {
    check(`blocks ${name}`, validateVaultUiComponent(bad, GOOD_ABI).length > 0);
  }

  check("blocks ABI with imports", validateVaultUiComponent(GOOD_COMPONENT, `import { x } from "y";\n${GOOD_ABI}`).length > 0);
  check("blocks ABI without vaultAbi export", validateVaultUiComponent(GOOD_COMPONENT, "export const foo = [];").length > 0);
  check(
    "allows svg xmlns namespace",
    validateVaultUiComponent(GOOD_COMPONENT.replace("<Trophy size={16} />", `<svg xmlns="http://www.w3.org/2000/svg" />`), GOOD_ABI).length === 0
  );
}

// ── validateVaultUiI18n ──────────────────────────────────────────────────────
console.log("validateVaultUiI18n");
{
  check("good i18n passes", validateVaultUiI18n(GOOD_I18N).length === 0);
  check("invalid json fails", validateVaultUiI18n("{oops").length > 0);
  check("missing zh fails", validateVaultUiI18n(JSON.stringify({ en: { a: "x" } })).length > 0);
  check("key mismatch fails", validateVaultUiI18n(JSON.stringify({ en: { a: "x" }, zh: { b: "y" } })).length > 0);
  check("non-string value fails", validateVaultUiI18n(JSON.stringify({ en: { a: 1 }, zh: { a: "y" } })).length > 0);
}

// ── buildVaultUiManifest ─────────────────────────────────────────────────────
console.log("buildVaultUiManifest");
{
  const manifest = JSON.parse(buildVaultUiManifest("WeeklyBurnLotteryVault")) as {
    artifactId: string;
    name: string;
    match: { bindings: { chainId: number; factoryAddress: string; tokenAddresses: string[] }[] };
    i18n: string[];
  };
  check("artifactId kebab-cased", manifest.artifactId.startsWith("vaultui_weekly-burn-lottery-vault_"));
  check("binding chain is BSC testnet", manifest.match.bindings[0]?.chainId === 97);
  check("factory placeholder present", manifest.match.bindings[0]?.factoryAddress === MANIFEST_FACTORY_PLACEHOLDER);
  check("token placeholder present", manifest.match.bindings[0]?.tokenAddresses[0] === MANIFEST_TOKEN_PLACEHOLDER);
  check("declares en+zh", manifest.i18n.join(",") === "en,zh");
  const second = JSON.parse(buildVaultUiManifest("WeeklyBurnLotteryVault")) as { artifactId: string };
  check("artifactId unique per call", second.artifactId !== manifest.artifactId);
}

// ── compileVaultUiComponent ──────────────────────────────────────────────────
console.log("compileVaultUiComponent");
{
  const compiled = await compileVaultUiComponent(GOOD_COMPONENT, GOOD_ABI);
  check("component compiles to CJS", compiled.componentJs.includes("module.exports") || compiled.componentJs.includes("exports"));
  check("jsx-runtime require emitted", /require\(["']react\/jsx-runtime["']\)/.test(compiled.componentJs));
  check("sdk require preserved", /require\(["']@\/src\/sdk["']\)/.test(compiled.componentJs));
  check("abi compiles", compiled.vaultAbiJs.includes("vaultAbi"));
  let threw = false;
  try {
    await compileVaultUiComponent(`"use client";\nexport default function X() { return <div>; }`, GOOD_ABI);
  } catch {
    threw = true;
  }
  check("syntax error throws", threw);
}

// ── prompt content ───────────────────────────────────────────────────────────
console.log("buildVaultUiPrompt");
{
  const spec = {
    productSummary: "Weekly lottery",
    buckets: [],
    userActions: [],
    managerActions: [],
    payoutRules: [],
    lifecycle: null,
    fairnessModel: "vrf",
  } as unknown as MechanicSpec;
  const prompt = buildVaultUiPrompt("PotVault", spec);
  check("documents sdk surface", prompt.includes("useFlapSdk") && prompt.includes(FLAP_SDK_SURFACE_DOC.slice(0, 60)));
  check("requires section markers", prompt.includes("===FILE:Component.tsx===") && prompt.includes("===END==="));
  check("requires use client", prompt.includes('"use client"'));
  check("requires i18n en+zh", prompt.includes('{"en": {...}, "zh": {...}}'));
  check("lists forbidden APIs", prompt.includes("window.ethereum") && prompt.includes("postMessage"));
  check("mentions mechanic summary", prompt.includes("Weekly lottery"));
}

// ── static wiring ────────────────────────────────────────────────────────────
console.log("static wiring");
{
  const codegen = readFileSync(path.join(here, "codegen.ts"), "utf8");
  check("codegen imports generateVaultUi", codegen.includes(`from "./ui-gen.js"`));
  check("codegen gates UI pass on full pass", /ok && safety\.level !== "fail" && integrationTestsPassed/.test(codegen));
  check("codegen emits ui_gen phase", codegen.includes(`phase: "ui_gen"`));

  const runManager = readFileSync(path.join(here, "run-manager.ts"), "utf8");
  check("run-manager persists vault_ui artifact as JSON", runManager.includes(`artifactType: "vault_ui"`) && runManager.includes(".vault-ui.json"));
  check("run-manager strips package from persisted result", runManager.includes("uiArtifact: _uiArtifact"));

  const webSdk = readFileSync(path.join(here, "../web/src/vault-runtime/sdk.ts"), "utf8");
  for (const name of [
    "useFlapSdk",
    "erc20Abi",
    "ZERO_ADDRESS",
    "isValidAddress",
    "formatTokenAmount",
    "parseTokenAmount",
    "formatPercentBps",
    "handleTxError",
    "readTaxVaultHostContext",
    "isActionAvailableForPhase",
  ]) {
    check(`runtime shim implements ${name}`, new RegExp(`export (function|const|type)? ?${name}`).test(webSdk) || webSdk.includes(`export function ${name}`) || webSdk.includes(`export const ${name}`));
  }
  const webUi = readFileSync(path.join(here, "../web/src/vault-runtime/ui.tsx"), "utf8");
  for (const name of ["Button", "Card", "CardHeader", "CardTitle", "CardDescription", "CardContent", "Input", "Alert", "StatusBadge", "DetailTile", "TxButton", "AddressLink", "Spinner"]) {
    check(`runtime kit implements ${name}`, webUi.includes(`export function ${name}`));
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll ui-gen selfchecks passed.");
