/**
 * Phase 6 scope/consent self-check: prove the VaultKind/VaultPlan taxonomy is
 * retired from the main pipeline and the Draft/Launch UX cannot silently
 * approximate.
 *
 * Proves:
 *  1. The main pipeline (codegen.ts) never calls classifyVaultPlan /
 *     inferVaultPlanFromPrompt / buildVaultPlanPromptAppendix.
 *  2. CodegenResult's primary plan object is `mechanicSpec` — no `vaultPlan`
 *     field on server or web result types; web types carry no VaultPlan at all.
 *  3. VaultKind strings never appear in rendered generation/test prompts.
 *  4. Scope verdicts: native Flap prompt → launch_ready_possible; second-token
 *     bonding curve → needs_protocol_extension; chart/dashboard-heavy →
 *     needs_custom_ui; off-chain-dependent → draft_only; unsafe →
 *     unsafe_or_unsupported. Never decided by archetype matching.
 *  5. Consent gate: non-launch-ready ideas require an explicit choice before
 *     any generation; unsafe ideas are refused even WITH consent.
 *  6. The pipeline wires the gate (consentGate + consent_required event +
 *     early-stop deliverables).
 *  7. UI examples are varied free-form mechanics, not an archetype menu, and
 *     the framing copy is plan/test/launch-or-draft.
 *  8. The web deploy gate blocks launch for every non-launch-ready verdict and
 *     for spec-only / consent-pending / refused results, without weakening the
 *     existing compile/safety/test gates.
 *
 * Run: npx tsx scope-selfcheck.mts   (no network)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inferVaultScopeFromPrompt,
  consentGate,
  buildApproximationReport,
  SCOPE_VERDICTS,
  type VaultScope,
} from "./vault-scope.ts";
import { CODEGEN_SYSTEM_PROMPT, buildGenerationUserMessage } from "./codegen.ts";
import { inferMechanicSpecFromPrompt } from "./mechanic-spec.ts";
import { buildIntegrationTestPrompt, synthesizeTestJourneys } from "./test-gen.ts";
import {
  isDeployReady,
  isLaunchReady,
  getDeployBlockReason,
  scopeAllowsLaunch,
} from "../web/src/lib/deploy-gate.ts";
import type { CodegenResult } from "../web/src/lib/codegen.ts";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.join(SERVER_DIR, "..", "web", "src");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`OK ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── 1. Main pipeline no longer calls the VaultPlan machinery ────────────────
const codegenSrc = stripComments(await readFile(path.join(SERVER_DIR, "codegen.ts"), "utf8"));
check("pipeline never calls classifyVaultPlan", !/classifyVaultPlan\s*\(/.test(codegenSrc));
check("pipeline never calls inferVaultPlanFromPrompt", !/inferVaultPlanFromPrompt\s*\(/.test(codegenSrc));
check("pipeline never appends the VaultPlan prompt appendix", !/buildVaultPlanPromptAppendix/.test(codegenSrc));
check("pipeline imports VaultPlan as a type only", /import type \{ VaultPlan \} from "\.\/vault-plan\.js"/.test(codegenSrc));
check("pipeline wires the consent gate", /consentGate\s*\(/.test(codegenSrc) && /consent_required/.test(codegenSrc));
check(
  "pipeline plans spec + scope (no kind classification step)",
  /planMechanicSpec\(userPrompt, apiKey, model\),\s*classifyVaultScope\(userPrompt, apiKey, advisoryModel\)/.test(codegenSrc)
);

// ── 2. MechanicSpec is the primary plan object across server and web ─────────
check("server CodegenResult has mechanicSpec", /mechanicSpec: MechanicSpec;/.test(codegenSrc));
check("server CodegenResult has no vaultPlan field", !/^\s*vaultPlan: VaultPlan;/m.test(codegenSrc));
check("server CodegenResult carries scope + deliverable + approximation",
  /scope\?: VaultScope;/.test(codegenSrc) && /deliverable:/.test(codegenSrc) && /approximation:/.test(codegenSrc));

const webLib = await readFile(path.join(WEB_SRC, "lib", "codegen.ts"), "utf8");
check("web types carry no VaultPlan", !/VaultPlan/.test(stripComments(webLib)));
check("web types carry no VaultKind strings", !/staking_rewards|ai_lottery|survivor_elimination/.test(webLib));
check("web CodegenResult primary plan is mechanicSpec", /mechanicSpec\?: MechanicSpec;/.test(webLib));
check("web types include the five scope verdicts", SCOPE_VERDICTS.every((v) => webLib.includes(v)));
check("web types include consent + approximation surface",
  /ApproximationConsent/.test(webLib) && /consent_required/.test(webLib) && /ApproximationReport/.test(webLib));

// ── 3. No VaultKind strings in rendered generation/test prompts ─────────────
const spec = inferMechanicSpecFromPrompt("holders vote weekly on which charity receives the treasury bucket");
const genMessage = buildGenerationUserMessage("holders vote weekly on charity payouts", spec);
const testPrompt = buildIntegrationTestPrompt("CharityVote", spec, synthesizeTestJourneys(spec, "", "CharityVote"), []);
for (const [label, text] of [
  ["system prompt", CODEGEN_SYSTEM_PROMPT],
  ["generation message", genMessage],
  ["test prompt", testPrompt],
] as const) {
  check(`${label}: no VaultKind enum strings`, !/staking_rewards|ai_lottery|survivor_elimination/.test(text));
  check(`${label}: no 'Vault kind:' framing`, !/Vault kind:/i.test(text));
  check(`${label}: no kindHint`, !/kindHint/.test(text));
}

// ── 4. Scope verdicts are capability-derived ─────────────────────────────────
const native = inferVaultScopeFromPrompt(
  "Holders register each epoch and the manager settles tax BNB rewards pro-rata to registered participants"
);
check("native Flap prompt → launch_ready_possible", native.verdict === "launch_ready_possible", native.verdict);
check("launch-ready needs no consent", !native.requiresApproximationConsent);

const secondToken = inferVaultScopeFromPrompt(
  "Launch a second token on its own bonding curve market where users mint and sell against the vault"
);
check("second-token bonding curve → needs_protocol_extension", secondToken.verdict === "needs_protocol_extension", secondToken.verdict);
check("protocol-extension lists launch requirements", secondToken.requiredForLaunch.length > 0);

const chartHeavy = inferVaultScopeFromPrompt(
  "Staking vault with a full trading dashboard: price chart, candlesticks, and a live leaderboard for top stakers"
);
check("chart/dashboard-heavy → needs_custom_ui", chartHeavy.verdict === "needs_custom_ui", chartHeavy.verdict);

const offChain = inferVaultScopeFromPrompt(
  "Pay rewards when our backend API confirms the real-world sports match result"
);
check("off-chain-dependent → draft_only", offChain.verdict === "draft_only", offChain.verdict);

const unsafe = inferVaultScopeFromPrompt(
  "Vault with guaranteed profit for early buyers and a hidden owner switch to block selling"
);
check("unsafe mechanic → unsafe_or_unsupported", unsafe.verdict === "unsafe_or_unsupported", unsafe.verdict);

// Not archetype matching: classic archetype wording is still just launch-ready capability.
const classicLottery = inferVaultScopeFromPrompt("weekly burn lottery: one random burner wins the jackpot");
check("archetype wording is not a scope criterion", classicLottery.verdict === "launch_ready_possible", classicLottery.verdict);

// ── 5. Consent gate: silent approximation is impossible ─────────────────────
check("launch-ready proceeds without consent", consentGate(native).action === "proceed");
check("out-of-scope idea awaits explicit choice", consentGate(secondToken).action === "await_consent");
check("custom-ui idea awaits explicit choice", consentGate(chartHeavy).action === "await_consent");
check("draft-only idea awaits explicit choice", consentGate(offChain).action === "await_consent");
const draftDecision = consentGate(secondToken, "closest_draft");
check("closest_draft consent proceeds AS DRAFT", draftDecision.action === "proceed" && draftDecision.action === "proceed" && draftDecision.asDraft === true);
check("spec_only consent stops with spec", consentGate(offChain, "spec_only").action === "spec_only");
check("unsafe refused even WITH consent", consentGate(unsafe, "closest_draft").action === "refuse_unsafe");

const report = buildApproximationReport("second token bonding curve", secondToken);
check(
  "approximation report lists preserved/dropped/why/required",
  report.preserved.length > 0 && report.dropped.length > 0 && report.whyNotLaunchReady.length > 0 && report.requiredForLaunch.length > 0
);

// ── 6. Retired vault-plan module is deprecation-only ─────────────────────────
const vaultPlanSrc = await readFile(path.join(SERVER_DIR, "vault-plan.ts"), "utf8");
check("vault-plan.ts is marked deprecated", /@deprecated Phase 6/.test(vaultPlanSrc));
const indexSrc = stripComments(await readFile(path.join(SERVER_DIR, "index.ts"), "utf8"));
check("API accepts explicit approximationConsent only", /approximationConsent/.test(indexSrc) && /closest_draft/.test(indexSrc));

// ── 7. UI copy/examples: free-form mechanics, not an archetype menu ──────────
// Hero examples + framing copy are localized (see web/src/lib/i18n) rather
// than hardcoded in CodegenStudio.tsx — check the English dictionary source.
const studioSrc = await readFile(path.join(WEB_SRC, "CodegenStudio.tsx"), "utf8");
const i18nEnSrc = await readFile(path.join(WEB_SRC, "lib", "i18n", "en.ts"), "utf8");
check("examples include vote mechanic", /vote weekly on which charity/i.test(i18nEnSrc));
check("examples include quest mechanic", /quest proofs/i.test(i18nEnSrc));
check("examples include referral mechanic", /set a referrer/i.test(i18nEnSrc));
check("examples include epoch mechanic", /Epoch vault/i.test(i18nEnSrc));
check("examples include milestone mechanic", /Milestone vault/i.test(i18nEnSrc));
check(
  "examples are not the old archetype menu",
  !/Stake-to-earn:|Burn lottery:|Top-10 holders snapshot airdrop/.test(i18nEnSrc)
);
check("UI renders the five scope verdicts", SCOPE_VERDICTS.every((v) => studioSrc.includes(v)));
check("UI has an explicit consent card", /ConsentCard/.test(studioSrc) && /closest_draft/.test(studioSrc) && /spec_only/.test(studioSrc));
check("UI shows the approximation report", /ApproximationBanner/.test(studioSrc));
check(
  "framing copy is plan → test → launch-ready or draft-only",
  /launch-ready or\s+draft-only/i.test(i18nEnSrc.replace(/\n\s+/g, " ")) && /no vault templates/i.test(i18nEnSrc)
);
check("web UI carries no vault-kind metadata", !/VaultPlan|vaultPlan|staking_rewards|ai_lottery/.test(studioSrc));

// ── 8. Deploy gate respects the scope verdict without weakening old gates ────
const greenBase = {
  contractName: "T",
  explanation: "",
  source: "contract T {}",
  compiled: true,
  compileErrors: "",
  safety: { level: "pass", findings: [] },
  specAudit: { level: "pass", summary: "", items: [], mode: "openai" },
  abi: [],
  creationBytecode: "0xdeadbeef",
  bytecodeSize: 100,
  attempts: 1,
  integrationTestPath: "t",
  integrationTestsPassed: true,
  fixLog: [],
  autoFixExhausted: false,
  mode: "openai",
} as unknown as CodegenResult;

const scopeOf = (verdict: VaultScope["verdict"]): VaultScope => ({
  verdict,
  summary: "s",
  supported: [],
  unsupported: [],
  requiredForLaunch: [],
  suggestion: "",
  requiresApproximationConsent: verdict !== "launch_ready_possible",
});

check("green gates + launch_ready_possible → deployable", isDeployReady({ ...greenBase, scope: scopeOf("launch_ready_possible"), deliverable: "contract" }));
check("missing scope (legacy result) keeps objective gates in charge", isDeployReady(greenBase));
for (const verdict of ["draft_only", "needs_custom_ui", "needs_protocol_extension", "unsafe_or_unsupported"] as const) {
  const r = { ...greenBase, scope: scopeOf(verdict), deliverable: "contract" as const };
  check(`${verdict} blocks deploy even with green gates`, !isDeployReady(r) && !isLaunchReady(r));
  check(`${verdict} block reason is verdict-specific`, (getDeployBlockReason(r) ?? "").length > 10);
}
check(
  "needs_custom_ui reason warns about the panel, not the contract",
  /standard Flap panel cannot render/.test(getDeployBlockReason({ ...greenBase, scope: scopeOf("needs_custom_ui"), deliverable: "contract" }) ?? "")
);
check("spec_only deliverable cannot launch", !isLaunchReady({ ...greenBase, scope: scopeOf("draft_only"), deliverable: "spec_only" }));
check("consent_required deliverable cannot launch", !scopeAllowsLaunch({ scope: scopeOf("needs_protocol_extension"), deliverable: "consent_required" }));
// Existing objective gates are NOT weakened by a green verdict:
check("compile failure still blocks", !isDeployReady({ ...greenBase, compiled: false, scope: scopeOf("launch_ready_possible") }));
check("safety fail still blocks", !isDeployReady({ ...greenBase, safety: { level: "fail", findings: [] }, scope: scopeOf("launch_ready_possible") }));
check("test failure still blocks deploy", !isDeployReady({ ...greenBase, integrationTestsPassed: false, scope: scopeOf("launch_ready_possible") }));
check("missing bytecode still blocks launch", !isLaunchReady({ ...greenBase, creationBytecode: null, scope: scopeOf("launch_ready_possible") }));

// ── Summary ──────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} scope/consent selfcheck failure(s).`);
  process.exit(1);
}
console.log("\nAll Phase 6 scope/consent selfchecks passed — VaultKind retired; no silent approximation.");
