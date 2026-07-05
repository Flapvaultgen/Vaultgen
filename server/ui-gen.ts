/**
 * Custom vault UI generation — Flap Artifact Workbench format.
 *
 * After a vault passes every gate (compile + safety + fork tests), one extra
 * LLM pass writes a bespoke UI for that specific mechanic in the EXACT format
 * Flap's official component template expects (flap-sh/flap-vault-component-
 * template): a strict source package of
 *
 *   Component.tsx   — controlled React component on the Flap SDK surface
 *   VaultABI.ts     — minimal vault ABI fragments
 *   i18n.json       — en + zh locale dictionaries
 *   manifest.json   — deployment binding (built deterministically by us)
 *
 * The same artifact serves two paths:
 *  - OUR site renders it immediately: the server compiles Component.tsx with
 *    esbuild and the web app runs it inside a sandboxed iframe on top of a
 *    small runtime shim implementing the SDK subset below (all chain access
 *    bridged through the host page — AI code never touches the wallet).
 *  - The user downloads the 4 source files, drops them into a clone of Flap's
 *    template, runs their vault:check / vault:e2e / vault:package pipeline
 *    and submits the zip to the Flap Artifact Workbench. After Flap review +
 *    binding, flap.sh serves the same UI.
 *
 * The pass is ADVISORY: any failure (LLM error, validation, compile) returns
 * null and the pipeline result stays exactly as it was — never a block.
 */
import { transform } from "esbuild";
import { randomBytes } from "node:crypto";
import type { AiChatClient } from "./ai-client.js";
import type { MechanicSpec } from "./mechanic-spec.js";

export type VaultUiFiles = {
  /** Component.tsx — the AI-authored React component (Flap template format). */
  componentTsx: string;
  /** VaultABI.ts — minimal vault ABI fragments used by the component. */
  vaultAbiTs: string;
  /** i18n.json — { en: {...}, zh: {...} } locale dictionaries. */
  i18nJson: string;
  /** manifest.json — deployment binding, built by us (address placeholders filled at download time). */
  manifestJson: string;
};

export type VaultUiArtifact = {
  format: "flap-vault-component@1";
  files: VaultUiFiles;
  /** esbuild-compiled CJS for the sandboxed in-browser runtime on our site. */
  compiled: { componentJs: string; vaultAbiJs: string };
  model: string;
  bytes: number;
};

/** Hard cap on total source size so a runaway generation can't bloat events/DB rows. */
export const VAULT_UI_MAX_BYTES = 400_000;

const UI_GEN_MAX_OUTPUT_TOKENS = 32_000;

/** Placeholders we bake into manifest.json — replaced with real addresses at download/render time. */
export const MANIFEST_FACTORY_PLACEHOLDER = "{{FACTORY_ADDRESS}}";
export const MANIFEST_TOKEN_PLACEHOLDER = "{{TOKEN_ADDRESS}}";

/**
 * The SDK surface contract — the ONLY imports the generated component may use.
 * MUST stay in sync with the runtime shim (web/src/vault-runtime/) on our
 * side, and stays a compatible subset of Flap's real `@/src/sdk` / `@/src/ui`
 * template surfaces so the same source passes their vault:check.
 * Kept as a named export so selfchecks can assert prompt/shim agreement.
 */
export const FLAP_SDK_SURFACE_DOC = `Imports allowed (NOTHING else — any other import is rejected):
  import { ... } from "react";                    // hooks only (useState, useEffect, useMemo, useCallback, useRef)
  import { ... } from "@/src/sdk";
  import { ... } from "@/src/ui";
  import { IconName } from "lucide-react";        // any Lucide icon, used as <IconName size={16} />
  import { vaultAbi } from "./VaultABI";

From "@/src/sdk":
  useFlapSdk(): {
    context: {
      chainId: number;
      vaultAddress: Address;                       // the vault this UI is bound to
      tokenAddress: Address | null;                // the tax token (null before launch)
      factoryAddress: Address | null;
      tokenName: string | null;
      tokenSymbol: string | null;
      host: unknown;                               // pass to readTaxVaultHostContext()
    };
    i18n: { t(key: string): string; locale: "en" | "zh" };   // keys come from your i18n.json
    wallet: {
      address: Address | null;
      isConnected: boolean;
      isWrongNetwork: boolean;
      switchChain(): Promise<void>;
    };
    readContract<T = unknown>(args: { address?: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<T>;
      // address defaults to context.vaultAddress. Multiple return values arrive as a tuple ARRAY
      // (readonly [a: bigint, b: bigint]), not an object. BigInt values arrive as real bigints.
    writeContract(args: { address?: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }): Promise<{ txHash: string }>;
      // Sends via the user's wallet and waits for the receipt. Rejects with Error(message) on
      // failure. Writes are restricted to the vault, the token, and ERC-20 approve(vault, ...).
  }
  erc20Abi                                          // standard ERC-20 ABI (balanceOf/allowance/approve/decimals/symbol)
  ZERO_ADDRESS
  isValidAddress(s: string): boolean
  formatTokenAmount(value: bigint, decimals: number, maxFraction?: number): string
  parseTokenAmount(text: string, decimals: number): bigint       // throws on invalid input
  formatPercentBps(bps: bigint | number): string                  // 250 -> "2.5%"
  handleTxError(err: unknown): string                             // short human-readable message
  readTaxVaultHostContext(host: unknown): { marketPhase: "internal-market" | "dex-listed" | "unknown" }
  isActionAvailableForPhase(stage: "internal-market" | "dex-listed" | "both", phase: string): boolean
  type Address, type VaultComponentProps

From "@/src/ui" (dark-themed kit — use these, do not re-implement basics):
  <Button variant?="primary"|"secondary"|"ghost"|"danger" size?="sm"|"md"|"lg" disabled onClick>
  <Card> <CardHeader> <CardTitle> <CardDescription> <CardContent>
  <Input value onChange placeholder type? disabled? />
  <Alert variant?="info"|"warning"|"error"|"success">
  <StatusBadge tone?="success"|"warning"|"danger"|"info"|"neutral">
  <DetailTile label={string} value={ReactNode} hint?={string} />
  <TxButton state={TxButtonState} disabled? onClick>   // state: "idle"|"pending"|"success"|"error"
  <AddressLink address={Address} />
  <Spinner size?={number} />
  type TxButtonState`;

/** Output section markers the model must emit (JSON-in-JSON escaping of big TSX is too fragile). */
const FILE_MARKER = /^===FILE:(Component\.tsx|VaultABI\.ts|i18n\.json)===$/;

export function buildVaultUiPrompt(contractName: string, spec: MechanicSpec): string {
  return `You are a senior product designer + React engineer generating the OFFICIAL custom Flap Vault UI
component for ${contractName}. This is the bespoke, launch-day product page token holders see (like flap.sh's
custom vault UIs: strong visual identity, live numbers, one-click actions) — NOT a generic admin panel.
The output must be a valid Flap vault-component-template source package: it will be submitted to the Flap
Artifact Workbench, so it must survive their strict static checks.

THE MECHANIC (design the whole page around this):
${JSON.stringify(
    {
      productSummary: spec.productSummary,
      buckets: spec.buckets,
      userActions: spec.userActions,
      managerActions: spec.managerActions,
      payoutRules: spec.payoutRules,
      lifecycle: spec.lifecycle,
      fairnessModel: spec.fairnessModel,
    },
    null,
    1
  )}

The full Solidity source follows in the user message. Its external/public methods (and the vaultUISchema()
implementation inside it) are your complete API surface — derive VaultABI.ts from the methods you actually
call, and never invent methods that are not in the contract.

SDK SURFACE (the whole outside world — nothing else exists):
${FLAP_SDK_SURFACE_DOC}

HARD RULES — the package is rejected if any is broken:
1. Output EXACTLY three sections, each starting with its marker line, then ===END===:
===FILE:Component.tsx===
===FILE:VaultABI.ts===
===FILE:i18n.json===
===END===
   No markdown fences, no commentary outside the sections.
2. Component.tsx: "use client" first line; ONE default-exported React function component taking
   (_props: VaultComponentProps); imports ONLY from the allowed list above; relative import ONLY ./VaultABI.
3. FORBIDDEN anywhere in Component.tsx / VaultABI.ts (Flap Workbench blocking rules): fetch, XMLHttpRequest,
   WebSocket, EventSource, sendBeacon, new Image, eval, new Function, dynamic import(), require(),
   window.ethereum, window.parent, window.top, postMessage, localStorage, sessionStorage, indexedDB,
   document.cookie, document.write, <iframe>, dangerouslySetInnerHTML, any http:// or https:// URL,
   any navigation (location=, window.open). All chain access goes through the sdk. All visuals come from
   CSS + lucide-react icons + inline SVG.
4. VaultABI.ts: exactly \`export const vaultAbi = [...] as const;\` — minimal ABI fragments for the methods
   the component calls (correct types, stateMutability, named outputs). No imports.
5. i18n.json: {"en": {...}, "zh": {...}} — flat string dictionaries, SAME key set in both languages. Every
   user-visible string in the component goes through i18n.t("key") — no hardcoded English labels in JSX.
6. Styling: a single <style>{\`...\`}</style> block at the top of the returned JSX, all selectors prefixed
   with a component-unique class (e.g. .kvlt-). Dark theme, bold gradient/glow identity THEMED TO THE
   MECHANIC, smooth number transitions, responsive mobile-first layout. Use the @/src/ui kit for buttons/
   cards/inputs/badges — style around them, don't rebuild them.

WHAT THE PAGE MUST DO:
- Hero: token/vault identity, a punchy tagline (via i18n), a strong visual motif for the mechanic.
- Live stats: read the key vault views on mount and refresh every ~12s (setInterval + cleanup); render big
  formatted numbers (formatTokenAmount with the right decimals; BNB values are 18 decimals).
- Time values: live countdowns ticking every second (keep a "now" state), never raw unix numbers.
- "You" panel: when wallet.isConnected, show the user's own status/claimable amounts from per-address views;
  otherwise a friendly connect prompt. If wallet.isWrongNetwork, show a switch-network action (keep actions
  visible but disabled — never hide them).
- Actions: one clear card per user-facing write method — labeled inputs (parseTokenAmount for amounts),
  TxButton with pending/success/error states, the txHash short-form on success, handleTxError(err) message
  inline on failure. If a write moves the user's ERC-20 tokens into the vault, check allowance first via
  erc20Abi and send approve(vault, amount) before the main write. Gate actions with
  isActionAvailableForPhase("both", readTaxVaultHostContext(context.host).marketPhase) unless the mechanic
  truly requires a DEX listing. Keep manager/admin methods in a collapsed/secondary "Manager" section.
- Read failures: show a compact inline error state, keep polling — never a blank page.

Make it feel designed for THIS mechanic: theme, copy, icons and layout should tell its story. Return only the
three marked sections and ===END===.`;
}

// ── Validation (mirror of Flap Workbench blocking rules) ─────────────────────

const IMPORT_RE = /^\s*import\s+(?:type\s+)?[\s\S]*?from\s+["']([^"']+)["'];?\s*$/gm;
const ALLOWED_IMPORTS = new Set(["react", "@/src/sdk", "@/src/ui", "lucide-react", "./VaultABI"]);

const COMPONENT_FORBIDDEN: { re: RegExp; message: string }[] = [
  { re: /\bfetch\s*\(/, message: "fetch() — network access is not allowed" },
  { re: /\bXMLHttpRequest\b/, message: "XMLHttpRequest is not allowed" },
  { re: /\bWebSocket\b/, message: "WebSocket is not allowed" },
  { re: /\bEventSource\b/, message: "EventSource is not allowed" },
  { re: /\bsendBeacon\b/, message: "sendBeacon is not allowed" },
  { re: /new\s+Image\s*\(/, message: "new Image() is not allowed" },
  { re: /\beval\s*\(/, message: "eval() is not allowed" },
  { re: /new\s+Function\s*\(/, message: "new Function() is not allowed" },
  { re: /\bimport\s*\(/, message: "dynamic import() is not allowed" },
  { re: /\brequire\s*\(/, message: "require() is not allowed" },
  { re: /\bwindow\s*\.\s*ethereum\b/, message: "window.ethereum — chain access goes through the sdk" },
  { re: /\bwindow\s*\.\s*(top|parent)\b/, message: "window.parent/window.top is not allowed" },
  { re: /\bpostMessage\s*\(/, message: "postMessage is not allowed" },
  { re: /\b(localStorage|sessionStorage|indexedDB)\b/, message: "browser storage is not allowed" },
  { re: /\bdocument\s*\.\s*cookie\b/, message: "document.cookie is not allowed" },
  { re: /\bdocument\s*\.\s*write(ln)?\b/, message: "document.write is not allowed" },
  { re: /<iframe/i, message: "iframes are not allowed" },
  { re: /dangerouslySetInnerHTML/, message: "dangerouslySetInnerHTML is not allowed" },
  { re: /\bwindow\s*\.\s*open\s*\(/, message: "window.open is not allowed" },
  { re: /\blocation\s*\.\s*(href|assign|replace)\b/, message: "navigation is not allowed" },
  { re: /https?:\/\//i, message: "external URL — the component must be fully self-contained" },
];

/** Inline SVG namespace attrs are the one legitimate `http://` use — strip before scanning. */
function stripSafeNamespaces(src: string): string {
  return src.replace(/https?:\/\/www\.w3\.org\/[^"'\s)<>]*/gi, "");
}

/** Deterministic containment check for the generated component sources. Empty = safe. */
export function validateVaultUiComponent(componentTsx: string, vaultAbiTs: string): string[] {
  const violations: string[] = [];

  if (!/^\s*["']use client["'];?/.test(componentTsx)) {
    violations.push('Component.tsx must start with "use client"');
  }
  if (!/export\s+default\s+function/.test(componentTsx)) {
    violations.push("Component.tsx must default-export a function component");
  }
  for (const match of componentTsx.matchAll(IMPORT_RE)) {
    if (!ALLOWED_IMPORTS.has(match[1]!)) {
      violations.push(`Component.tsx imports from "${match[1]}" — only ${[...ALLOWED_IMPORTS].join(", ")} are allowed`);
    }
  }

  if (!/export\s+const\s+vaultAbi\s*=/.test(vaultAbiTs)) {
    violations.push("VaultABI.ts must export `const vaultAbi`");
  }
  if (/^\s*import\s/m.test(vaultAbiTs)) {
    violations.push("VaultABI.ts must not import anything");
  }

  for (const [label, src] of [
    ["Component.tsx", componentTsx],
    ["VaultABI.ts", vaultAbiTs],
  ] as const) {
    const scannable = stripSafeNamespaces(src);
    for (const { re, message } of COMPONENT_FORBIDDEN) {
      if (re.test(scannable)) violations.push(`${label}: ${message}`);
    }
  }
  return violations;
}

/** Validates the i18n dictionaries: en + zh present, flat string values, identical key sets. */
export function validateVaultUiI18n(i18nJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(i18nJson);
  } catch {
    return ["i18n.json is not valid JSON"];
  }
  const obj = parsed as Record<string, unknown>;
  const violations: string[] = [];
  for (const locale of ["en", "zh"]) {
    const dict = obj[locale];
    if (!dict || typeof dict !== "object" || Array.isArray(dict)) {
      violations.push(`i18n.json is missing the "${locale}" dictionary`);
      continue;
    }
    for (const [k, v] of Object.entries(dict)) {
      if (typeof v !== "string") violations.push(`i18n.json ${locale}.${k} must be a string`);
    }
  }
  if (violations.length === 0) {
    const en = Object.keys(obj.en as object).sort();
    const zh = Object.keys(obj.zh as object).sort();
    if (en.join("\n") !== zh.join("\n")) {
      const missing = [
        ...en.filter((k) => !zh.includes(k)).map((k) => `zh missing "${k}"`),
        ...zh.filter((k) => !en.includes(k)).map((k) => `en missing "${k}"`),
      ];
      violations.push(`i18n.json en/zh key sets differ: ${missing.slice(0, 6).join(", ")}`);
    }
  }
  return violations;
}

// ── Parsing the model's sectioned output ─────────────────────────────────────

export function parseVaultUiSections(raw: string): { componentTsx: string; vaultAbiTs: string; i18nJson: string } | null {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) sections[current] = buffer.join("\n").trim();
    buffer = [];
  };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const marker = trimmed.match(FILE_MARKER);
    if (marker) {
      flush();
      current = marker[1]!;
      continue;
    }
    if (trimmed === "===END===") {
      flush();
      current = null;
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  const componentTsx = sections["Component.tsx"];
  const vaultAbiTs = sections["VaultABI.ts"];
  const i18nJson = sections["i18n.json"];
  if (!componentTsx || !vaultAbiTs || !i18nJson) return null;
  return { componentTsx, vaultAbiTs, i18nJson };
}

// ── Manifest (built by us, deterministic — never by the model) ──────────────

function ulidLike(): string {
  return randomBytes(16).toString("hex").toUpperCase().slice(0, 26);
}

export function buildVaultUiManifest(contractName: string): string {
  const kebab = contractName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return JSON.stringify(
    {
      artifactId: `vaultui_${kebab}_${ulidLike()}`,
      name: `${contractName} Vault UI`,
      match: {
        bindings: [
          {
            chainId: 97,
            factoryAddress: MANIFEST_FACTORY_PLACEHOLDER,
            tokenAddresses: [MANIFEST_TOKEN_PLACEHOLDER],
          },
        ],
      },
      i18n: ["en", "zh"],
    },
    null,
    2
  );
}

// ── esbuild compile for our in-browser sandbox runtime ───────────────────────

/**
 * Compiles the component + ABI module to CJS for the iframe runtime, which
 * provides `require` for react / react/jsx-runtime / @/src/sdk / @/src/ui /
 * lucide-react / ./VaultABI. Throws with esbuild's message on syntax errors.
 */
export async function compileVaultUiComponent(componentTsx: string, vaultAbiTs: string): Promise<{ componentJs: string; vaultAbiJs: string }> {
  const [component, abi] = await Promise.all([
    transform(componentTsx, { loader: "tsx", format: "cjs", jsx: "automatic", target: "es2020", minify: false }),
    transform(vaultAbiTs, { loader: "ts", format: "cjs", target: "es2020", minify: false }),
  ]);
  return { componentJs: component.code, vaultAbiJs: abi.code };
}

// ── Generation ────────────────────────────────────────────────────────────────

/**
 * Generates the custom UI package. Never throws; returns null when the pass
 * fails (LLM error, or a package that fails validation/compile twice).
 */
export async function generateVaultUi(opts: {
  client: AiChatClient;
  model: string;
  contractName: string;
  source: string;
  spec: MechanicSpec;
}): Promise<VaultUiArtifact | null> {
  const { client, model, contractName, source, spec } = opts;
  const systemPrompt = buildVaultUiPrompt(contractName, spec);

  try {
    let feedback: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // Streamed + accumulated: large outputs exceed the Anthropic SDK's
      // 10-minute non-streaming ceiling at this max_tokens.
      const stream = await client.chat.completions.create({
        model,
        temperature: 0.4,
        max_tokens: UI_GEN_MAX_OUTPUT_TOKENS,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content:
              `Solidity source for ${contractName}:\n\n${source.slice(0, 60_000)}` +
              (feedback ? `\n\nYour previous package was REJECTED. Fix these problems and return the full corrected package (all three sections):\n${feedback}` : ""),
          },
        ],
      });
      let raw = "";
      for await (const chunk of stream) {
        raw += chunk.choices[0]?.delta?.content ?? "";
      }
      if (!raw) return null;

      const sections = parseVaultUiSections(raw);
      if (!sections) {
        feedback = "- Output was not in the required ===FILE:...=== / ===END=== section format.";
        continue;
      }

      const violations = [
        ...validateVaultUiComponent(sections.componentTsx, sections.vaultAbiTs),
        ...validateVaultUiI18n(sections.i18nJson),
      ];
      const totalBytes = Buffer.byteLength(sections.componentTsx + sections.vaultAbiTs + sections.i18nJson, "utf8");
      if (totalBytes > VAULT_UI_MAX_BYTES) violations.push(`package exceeds ${VAULT_UI_MAX_BYTES} bytes`);

      if (violations.length > 0) {
        feedback = violations.map((v) => `- ${v}`).join("\n");
        continue;
      }

      let compiled: { componentJs: string; vaultAbiJs: string };
      try {
        compiled = await compileVaultUiComponent(sections.componentTsx, sections.vaultAbiTs);
      } catch (err) {
        feedback = `- Component failed to compile: ${err instanceof Error ? err.message.split("\n").slice(0, 6).join("\n") : String(err)}`;
        continue;
      }

      return {
        format: "flap-vault-component@1",
        files: {
          componentTsx: sections.componentTsx,
          vaultAbiTs: sections.vaultAbiTs,
          i18nJson: sections.i18nJson,
          manifestJson: buildVaultUiManifest(contractName),
        },
        compiled,
        model,
        bytes: totalBytes,
      };
    }
    return null;
  } catch (err) {
    console.error(`[ui-gen] custom UI generation failed for ${contractName}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
