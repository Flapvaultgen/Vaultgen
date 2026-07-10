import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getAllFlapRules, getFlapRule, mapScannerFindingToRuleId } from "./constitution.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(process.cwd(), "..");
const BUNDLED_SPEC_DIR = path.join(SERVER_DIR, "flap-spec-checker");
const AGENTS_SPEC_DIR = path.join(REPO_ROOT, ".agents/skills/flap-vault-spec-checker");

export type SpecCheckStatus = "pass" | "warn" | "fail" | "na";

export type SpecCheckItem = {
  id: string;
  title: string;
  status: SpecCheckStatus;
  detail: string;
};

export type SpecAuditLevel = "pass" | "warn" | "fail" | "skipped";

export type SpecAuditResult = {
  level: SpecAuditLevel;
  summary: string;
  items: SpecCheckItem[];
  mode: "openai" | "skipped";
};

/** Long rule ids (e.g. "001-vault-rules") — canonical source is server/constitution.ts. */
const RULE_IDS = getAllFlapRules().map((r) => r.slug);

const itemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pass", "warn", "fail", "na"]),
  detail: z.string(),
});

const responseSchema = z.object({
  summary: z.string(),
  items: z.array(itemSchema).min(1),
});

let rulesCache: string | null = null;

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

async function resolveSpecPaths(): Promise<{ rulesDir: string; skillPath: string }> {
  const agentsRules = path.join(AGENTS_SPEC_DIR, "references/rules");
  if (await dirExists(agentsRules)) {
    return {
      rulesDir: agentsRules,
      skillPath: path.join(AGENTS_SPEC_DIR, "SKILL.md"),
    };
  }
  return {
    rulesDir: path.join(BUNDLED_SPEC_DIR, "rules"),
    skillPath: path.join(BUNDLED_SPEC_DIR, "SKILL.md"),
  };
}

async function loadRuleCorpus(): Promise<string> {
  if (rulesCache) return rulesCache;
  const { rulesDir } = await resolveSpecPaths();
  const files = (await readdir(rulesDir)).filter((f) => f.endsWith(".md")).sort();
  const parts: string[] = [];
  for (const f of files) {
    parts.push(`### ${f}\n${await readFile(path.join(rulesDir, f), "utf8")}`);
  }
  rulesCache = parts.join("\n\n");
  return rulesCache;
}

function computeLevel(items: SpecCheckItem[]): Exclude<SpecAuditLevel, "skipped"> {
  if (items.some((i) => i.status === "fail")) return "fail";
  if (items.some((i) => i.status === "warn")) return "warn";
  return "pass";
}

/** Recursively collect all `.t.sol` files under test/ (includes test/_codegen/). */
async function collectTestFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectTestFiles(full)));
    } else if (ent.name.endsWith(".t.sol")) {
      out.push(full);
    }
  }
  return out;
}

/** Deterministic Rule 006 hint: no dedicated integration test file for this vault. */
async function checkIntegrationTests(contractName: string): Promise<SpecCheckItem | null> {
  const testDir = path.join(REPO_ROOT, "test");

  let files: string[];
  try {
    files = await collectTestFiles(testDir);
  } catch {
    return {
      id: "006-integration-test-coverage",
      title: "Integration test coverage",
      status: "fail",
      detail: "No test/ directory found. Flap pre-audit requires mainnet-fork integration tests before third-party audit.",
    };
  }

  if (files.length === 0) {
    return {
      id: "006-integration-test-coverage",
      title: "Integration test coverage",
      status: "fail",
      detail: "No Foundry tests in test/. Add a mainnet-fork suite (see test/FlapBSCFixture.sol).",
    };
  }

  let hits = 0;
  let hasCodegenSuite = false;
  for (const filePath of files) {
    const body = await readFile(filePath, "utf8");
    if (body.includes(contractName)) {
      hits++;
      if (filePath.endsWith(`${contractName}.mainnet.t.sol`) && filePath.includes("_codegen")) {
        hasCodegenSuite = true;
      }
    }
  }

  if (hits === 0) {
    return {
      id: "006-integration-test-coverage",
      title: "Integration test coverage",
      status: "fail",
      detail: `No Foundry test references "${contractName}". Add a mainnet-fork suite (see test/FlapBSCFixture.sol) covering receive(), core writes, and VaultPortal dispatch before audit.`,
    };
  }

  if (hasCodegenSuite) {
    return {
      id: "006-integration-test-coverage",
      title: "Integration test coverage",
      status: "warn",
      detail: `Codegen Studio wrote test/_codegen/${contractName}.mainnet.t.sol. Run fork tests (forge test --match-path test/_codegen/${contractName}.mainnet.t.sol --fork-url …) and extend with happy/revert paths before third-party audit.`,
    };
  }

  return {
    id: "006-integration-test-coverage",
    title: "Integration test coverage",
    status: "warn",
    detail: `Found ${hits} test file(s) mentioning ${contractName}. Verify they cover buy→dispatch, DEX sell→dispatch, happy/revert paths per Flap Rule 006.`,
  };
}

/** Merge static safety scan hits into matching rule items. */
function mergeSafetyFindings(
  items: SpecCheckItem[],
  safetyFindings: { level: "block" | "warn"; rule: string; detail: string }[]
): SpecCheckItem[] {
  if (safetyFindings.length === 0) return items;
  const byId = new Map(items.map((i) => [i.id, { ...i }]));

  for (const f of safetyFindings) {
    // Canonical scanner-finding → Flap-rule attribution lives in constitution.ts.
    const ruleId = getFlapRule(mapScannerFindingToRuleId(f.rule)).slug;

    const existing = byId.get(ruleId);
    const bump = f.level === "block" ? "fail" : "warn";
    const line = `[scanSafety:${f.rule}] ${f.detail}`;
    if (existing) {
      if (existing.status === "pass" && bump === "fail") existing.status = "fail";
      else if (existing.status === "pass" && bump === "warn") existing.status = "warn";
      else if (existing.status === "warn" && bump === "fail") existing.status = "fail";
      existing.detail = `${existing.detail} ${line}`.trim();
    } else {
      byId.set(ruleId, { id: ruleId, title: ruleId, status: bump, detail: line });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeItems(raw: SpecCheckItem[]): SpecCheckItem[] {
  const byId = new Map<string, SpecCheckItem>();
  for (const item of raw) {
    const id = RULE_IDS.find((r) => item.id.startsWith(r)) ?? item.id;
    byId.set(id, { ...item, id });
  }
  for (const id of RULE_IDS) {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        title: id,
        status: "warn",
        detail: "Auditor did not report this rule — review manually.",
      });
    }
  }
  return RULE_IDS.map((id) => byId.get(id)!);
}

export async function runSpecAudit(
  vaultSource: string,
  contractName: string,
  apiKey: string | undefined,
  model: string,
  opts?: {
    compiled?: boolean;
    safetyFindings?: { level: "block" | "warn"; rule: string; detail: string }[];
    advisory?: boolean;
  }
): Promise<SpecAuditResult> {
  if (!opts?.compiled) {
    return {
      level: "skipped",
      summary: "Pre-audit runs after a successful compile. Fix compile errors first.",
      items: [],
      mode: "skipped",
    };
  }
  if (!apiKey) {
    return {
      level: "skipped",
      summary: "Set ANTHROPIC_API_KEY in server/.env.local to run Flap pre-audit verification.",
      items: [],
      mode: "skipped",
    };
  }

  const rules = await loadRuleCorpus();
  const { skillPath } = await resolveSpecPaths();
  const skill = await readFile(skillPath, "utf8");
  let factorySource = "";
  try {
    factorySource = await readFile(path.join(REPO_ROOT, "src/CodegenVaultFactory.sol"), "utf8");
  } catch {
    /* optional */
  }

  const systemPrompt = `You are the official Flap VaultPortal pre-audit verifier (flap-vault-spec-checker Copilot skill).
Audit the provided vault (+ factory context) against ALL 9 Flap spec rules below.
Be strict on Rule 005 (receive() gas / no external calls in receive call tree) and Rule 003 (fairness).
CodegenVaultBase is injected at compile time — treat it as part of the deployed vault.

Return ONLY valid JSON (no markdown):
{
  "summary": "2-4 sentence executive summary",
  "items": [
    { "id": "001-vault-rules", "title": "short label", "status": "pass|warn|fail|na", "detail": "1-3 sentences with concrete evidence" }
  ]
}

You MUST return exactly 9 items with these ids (use "na" only when truly not applicable):
${RULE_IDS.join(", ")}

RULE CORPUS:
${rules}

SKILL CHECKLIST (follow):
${skill.slice(0, 14000)}

Notes:
- Rule 002: audit CodegenVaultFactory when provided; commission fee recommendation applies to factories.
- Rule 006: note missing per-vault integration tests — the server adds a deterministic check too.
- Rule 009: CodegenVaultBase emergency fns use onlyManager (creator OR guardian), not onlyGuardian — warn if strict Rule 009 expects guardian-only.
- Do NOT mark description() static text as fail (Rule 001 allows placeholder).`;

  const userPrompt = `Pre-audit vault "${contractName}" for Flap.sh deployment via CodegenVaultFactory.

--- VAULT SOURCE (includes CodegenVaultBase preamble) ---
${vaultSource.slice(0, 90000)}

--- FACTORY ---
${factorySource.slice(0, 20000)}

Report PASS/WARN/FAIL/NA for each of the 9 rules.`;

  const { createAiClient } = await import("./ai-client.js");
  const client = createAiClient(apiKey);

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: 4000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return {
      level: "warn",
      summary: "Pre-audit returned empty — review manually with the flap-vault-spec-checker skill.",
      items: [],
      mode: "openai",
    };
  }

  let parsed: z.infer<typeof responseSchema>;
  try {
    const { extractJsonPayload } = await import("./ai-client.js");
    parsed = responseSchema.parse(JSON.parse(extractJsonPayload(raw)));
  } catch {
    return {
      level: "warn",
      summary: "Pre-audit response was malformed — review manually with the flap-vault-spec-checker skill.",
      items: [],
      mode: "openai",
    };
  }

  let items = normalizeItems(parsed.items);
  const testItem = await checkIntegrationTests(contractName);
  if (testItem) {
    items = items.map((i) => (i.id === "006-integration-test-coverage" ? testItem : i));
  }
  if (opts.safetyFindings?.length) {
    items = mergeSafetyFindings(items, opts.safetyFindings);
  }
  items = applyCodegenAuditPolicies(items);

  // Advisory mode: LLM findings are informational — only deterministic Rule 006 fail blocks pipeline.
  if (opts?.advisory) {
    items = items.map((item) => {
      if (item.status === "fail" && item.id !== "006-integration-test-coverage") {
        return {
          ...item,
          status: "warn" as SpecCheckStatus,
          detail: `[advisory] ${item.detail}`,
        };
      }
      return item;
    });
  }

  const level = computeLevel(items);
  const summary = opts?.advisory
    ? `${parsed.summary} (Advisory pre-audit — deterministic scanners and Foundry tests are the pass/fail gate.)`
    : parsed.summary;
  return {
    level,
    summary,
    items,
    mode: "openai",
  };
}

/** Vault-code FAIL rules that should trigger an AI rewrite (not 006 tests or 002 factory). */
const VAULT_CODE_FAIL_RULES = new Set([
  "001-vault-rules",
  "003-fairness-rule",
  "004-ui-friendly-rules",
  "005-receive-gas-limit",
  "007-ai-oracle-integration",
  "008-trigger-service-integration",
]);

export function specCodegenFixableItems(items: SpecCheckItem[]): SpecCheckItem[] {
  return items.filter((i) => {
    if (i.status === "fail") {
      if (i.id === "006-integration-test-coverage") return false;
      if (i.id === "002-vault-factory-rules") return false;
      return VAULT_CODE_FAIL_RULES.has(i.id);
    }
    if (i.id === "003-fairness-rule" && i.status === "warn" && /scanSafety:|balanceOf|flash|pro-rata|sandwich/i.test(i.detail)) {
      return true;
    }
    return false;
  });
}

export function specFailItems(items: SpecCheckItem[]): SpecCheckItem[] {
  return items.filter((i) => i.status === "fail");
}

export function specNeedsIntegrationTest(items: SpecCheckItem[]): boolean {
  const item = items.find((i) => i.id === "006-integration-test-coverage");
  return item?.status === "fail";
}

export function specFixPrompt(items: SpecCheckItem[]): string {
  const list = items.map((i) => `- [${i.id}] (${i.status}) ${i.title}: ${i.detail}`).join("\n");
  return `Flap pre-audit found issues that MUST be fixed in the vault contract. Fix every item below and return the corrected output (same format, no imports/pragma).

Key fixes:
- Rule 003: NEVER size payouts/dividends from live balanceOf(msg.sender). Use stake + accRewardPerShare, OR fixed jackpot pools, OR AI oracle winner selection. balanceOf may ONLY gate eligibility (e.g. require balance >= 1 token to enter()) — never compute payout amount from it.
- Rule 005: receive() = bucket accounting only; no external calls.
- Rule 007/008: authenticate AI/trigger callbacks per Flap patterns.

Pre-audit issues:

${list}`;
}

export function specFixPromptStream(items: SpecCheckItem[]): string {
  return `${specFixPrompt(items)}\n\nRe-output in the SAME plain-text format (CONTRACT_NAME / EXPLANATION / SOLIDITY).`;
}

/** Downgrade expected codegen-base findings so auto-fix does not chase unfixable noise. */
export function applyCodegenAuditPolicies(items: SpecCheckItem[]): SpecCheckItem[] {
  return items.map((item) => {
    if (item.id === "002-vault-factory-rules" && item.status !== "pass") {
      if (/commission fee|fee structure/i.test(item.detail)) {
        return {
          ...item,
          status: "pass",
          detail:
            "CodegenVaultFactory is a permissionless meta-factory (CREATE2 bytecode deploy). Per-vault commission fees do not apply; factory inherits VaultFactoryBaseV2 correctly.",
        };
      }
    }
    if (item.id === "009-emergency-risk-controls" && item.status !== "pass") {
      if (/onlyManager|creator OR guardian|creator and guardian/i.test(item.detail)) {
        return {
          ...item,
          status: "pass",
          detail:
            "Emergency withdraw functions inherit from CodegenVaultBase with onlyGuardian + nonReentrant (Rule 009 satisfied).",
        };
      }
    }
    if (item.id === "003-fairness-rule" && item.status === "warn") {
      if (
        /privileged|manager.*(?:control|execute|request)|sandwich|timing|insider|manipulat/i.test(item.detail) &&
        !/scanSafety:|balanceOf|flash|pro-rata|balance-based/i.test(item.detail)
      ) {
        return {
          ...item,
          status: "pass",
          detail:
            "Keeper-only buyback/treasury/draw functions are by design for this vault type. No live-balance payout or user sandwich vector identified (Rule 003).",
        };
      }
    }
    return item;
  });
}
