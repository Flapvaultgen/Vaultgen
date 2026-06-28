/**
 * Detects half-implemented vault mechanics — compiles + passes generic scanners
 * but user-facing actions (register, claim, milestone) are dead or disconnected.
 */

import type { VaultPlan } from "./vault-plan.js";

export type MechanicFinding = { rule: string; detail: string };

type FnChunk = { name: string; body: string; header: string };

const SKIP_UI_METHODS = new Set([
  "description",
  "vaultUISchema",
  "receive",
  "constructor",
  "emergencyWithdrawNative",
  "emergencyWithdrawToken",
  "lastRequestId",
]);

const SKIP_UI_PREFIXES = ["_onFlapAI", "_fulfillReasoning"];

function extractFunctionChunks(source: string): FnChunk[] {
  const chunks: FnChunk[] = [];
  const re = /function\s+(\w+)\s*\([^)]*\)[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const name = m[1]!;
    const start = m.index + m[0].length;
    let i = start;
    let depth = 1;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    chunks.push({ name, header: m[0], body: source.slice(start, i - 1) });
  }
  return chunks;
}

function extractVaultUISchemaBody(source: string): string | null {
  const m = source.match(/function\s+vaultUISchema\s*\([^)]*\)[^{]*\{/);
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return source.slice(start, i - 1);
}

function schemaListsMethod(schemaBody: string, fnName: string): boolean {
  return new RegExp(`\\.name\\s*=\\s*"${fnName}"`).test(schemaBody);
}

/** Pull-claim mappings (claimableRewards, claimablePrize, …) must be credited somewhere. */
function scanClaimMappingsNeverCredited(source: string): MechanicFinding[] {
  const findings: MechanicFinding[] = [];
  const mappingNames = new Set<string>();
  for (const m of source.matchAll(
    /mapping\s*\(\s*address\s*=>\s*uint256\s*\)\s+(?:public\s+)?(claimable\w+)/g
  )) {
    mappingNames.add(m[1]!);
  }

  for (const mapName of mappingNames) {
    const claimFns = extractFunctionChunks(source).filter(
      (f) =>
        /claim/i.test(f.name) &&
        new RegExp(`${mapName}\\s*\\[\\s*msg\\.sender\\s*\\]`).test(f.body) &&
        /=\s*0\s*;/.test(f.body)
    );
    if (claimFns.length === 0) continue;

    const creditRe = new RegExp(`${mapName}\\s*\\[[^\\]]+\\]\\s*\\+=`, "g");
    const hasCredit = creditRe.test(source);
    if (!hasCredit) {
      findings.push({
        rule: "claim-mapping-never-credited",
        detail: `${mapName} is read in claim function(s) but never increased (no ${mapName}[user] += amount anywhere). Either credit rewards in a distribute/advance function or remove the dead claim path.`,
      });
    }
  }
  return findings;
}

/** Registration flags/arrays must be consumed by payout or distribution logic. */
function scanRegistrationNeverConsumed(source: string): MechanicFinding[] {
  const findings: MechanicFinding[] = [];
  const registerFns = extractFunctionChunks(source).filter((f) => /register/i.test(f.name) && /external|public/.test(f.header));
  if (registerFns.length === 0) return findings;

  const setsInterest =
    /registeredInterest\s*\[|hasRegistered\s*\[|registered\s*\[/.test(source) &&
    registerFns.some((f) => /= true/.test(f.body) || /\.push\s*\(\s*msg\.sender/.test(f.body));

  if (!setsInterest) return findings;

  const hasRegistrantArray = /Registrants|registrants|interestList|registeredUsers/.test(source);
  const arrayPushed = registerFns.some((f) => /\.push\s*\(\s*msg\.sender/.test(f.body)) || hasRegistrantArray;

  const consumedInAdvance = extractFunctionChunks(source).some(
    (f) =>
      (/advance|distribute|settle|payout|milestone/i.test(f.name) || f.name === "claimReward") &&
      (/registeredInterest\s*\[|hasRegistered\s*\[|Registrants|registrants/.test(f.body) ||
        (arrayPushed && /\.length/.test(f.body) && /for\s*\(/.test(f.body)))
  );

  const creditsOnAdvance = extractFunctionChunks(source).some(
    (f) =>
      /advance|distribute|milestone/i.test(f.name) &&
      (/claimable\w+\s*\[[^\]]+\]\s*\+=|_sendNative\s*\(/.test(f.body))
  );

  if (!consumedInAdvance && !creditsOnAdvance) {
    findings.push({
      rule: "register-never-consumed",
      detail:
        "register*() sets registration state but no advance/distribute/claim function reads registrants or credits rewards. Either implement reward distribution on milestone advance or remove register/claim as dead UI.",
    });
  }

  return findings;
}

/** User-callable external write methods must appear in vaultUISchema. */
function scanWriteMethodsMissingFromSchema(source: string): MechanicFinding[] {
  const schemaBody = extractVaultUISchemaBody(source);
  if (!schemaBody) return [];

  const findings: MechanicFinding[] = [];
  for (const fn of extractFunctionChunks(source)) {
    if (!/external|public/.test(fn.header)) continue;
    if (/view|pure/.test(fn.header)) continue;
    if (SKIP_UI_METHODS.has(fn.name)) continue;
    if (SKIP_UI_PREFIXES.some((p) => fn.name.startsWith(p))) continue;
    if (/onlyGuardian|onlyManager/.test(fn.header) && !/register|claim|stake|enter|unstake/i.test(fn.name)) {
      continue;
    }
    if (!schemaListsMethod(schemaBody, fn.name)) {
      findings.push({
        rule: "write-method-not-in-uischema",
        detail: `User-facing write function ${fn.name}() is missing from vaultUISchema.methods — Flap UI cannot expose it.`,
      });
    }
  }
  return findings;
}

/** milestoneIndex + fixed target array must bounds-check before indexing. */
function scanMilestoneIndexUnbounded(source: string): MechanicFinding[] {
  if (!/milestoneIndex/.test(source) || !/milestoneTargets|milestoneTarget/.test(source)) return [];

  const usesIndex = /milestoneTargets\s*\[\s*milestoneIndex\s*\]|milestoneTarget\s*\(\s*\)/.test(source);
  if (!usesIndex) return [];

  const hasBounds =
    /milestoneIndex\s*<\s*milestoneTargets\.length/.test(source) ||
    /milestoneIndex\s*<\s*\w+\.length/.test(source) ||
    /require\s*\([^)]*milestoneIndex[^)]*<\s*milestoneTargets/.test(source);

  if (!hasBounds) {
    return [
      {
        rule: "milestone-index-unbounded",
        detail:
          "milestoneIndex indexes milestoneTargets[] but never checks milestoneIndex < milestoneTargets.length — final advance will revert or read out of bounds.",
      },
    ];
  }
  return [];
}

/** Pool zeroed on advance while claim/register exist but nothing credited. */
function scanPoolErasedWithoutPayout(source: string): MechanicFinding[] {
  const hasClaim = /function\s+claim\w*\s*\(/.test(source);
  const hasRegister = /function\s+register\w*\s*\(/.test(source);
  if (!hasClaim && !hasRegister) return [];

  const advanceFns = extractFunctionChunks(source).filter((f) => /advance|milestone/i.test(f.name));
  for (const fn of advanceFns) {
    if (!/(milestonePool|rewardPool)\s*=\s*0/.test(fn.body)) continue;
    const creditsInFn = /claimable\w+\s*\[[^\]]+\]\s*\+=|_sendNative\s*\(/.test(fn.body);
    const creditsGlobally = /claimable\w+\s*\[[^\]]+\]\s*\+=/.test(source);
    if (!creditsInFn && !creditsGlobally && (hasClaim || hasRegister)) {
      return [
        {
          rule: "pool-erased-no-payout",
          detail: `${fn.name}() zeros milestonePool/rewardPool but never credits claimableRewards or pays registrants — registration/claim path is incomplete.`,
        },
      ];
    }
  }
  return [];
}

/** Both register and claim exist but no connection between them. */
function scanHalfImplementedRewardVault(source: string): MechanicFinding[] {
  const hasRegister = /function\s+register\w*\s*\([^)]*\)\s*external/.test(source);
  const hasClaim = /function\s+claim(?:Reward|Prize)?\s*\([^)]*\)\s*external/.test(source);
  if (!hasRegister || !hasClaim) return [];

  const hasCredit = /claimable\w+\s*\[[^\]]+\]\s*\+=/.test(source);

  if (!hasCredit) {
    return [
      {
        rule: "half-implemented-reward-vault",
        detail:
          "Vault exposes register*() and claim*() but no function ever credits claimable balances — pick pure milestone burn (remove register/claim) OR implement full reward distribution.",
      },
    ];
  }
  return [];
}

export function isNovelMechanicPrompt(prompt: string): boolean {
  return (
    /milestone|register\s*interest|registration|threshold|advance|epoch|tier|badge|referral|vote|gauge|campaign|quest|reward\s*pool/i.test(
      prompt
    ) ||
    (/\bregister\b/i.test(prompt) && /\bclaim\b/i.test(prompt))
  );
}

export function scanMechanicCompleteness(
  source: string,
  userPrompt = "",
  vaultPlan?: VaultPlan
): MechanicFinding[] {
  const findings: MechanicFinding[] = [];
  const runAll =
    isNovelMechanicPrompt(userPrompt) ||
    /registerInterest|milestoneIndex|claimableRewards|milestonePool/.test(source);

  findings.push(...scanClaimMappingsNeverCredited(source));
  findings.push(...scanWriteMethodsMissingFromSchema(source));

  if (runAll || /function\s+register\w*\s*\(/.test(source)) {
    findings.push(
      ...scanRegistrationNeverConsumed(source),
      ...scanMilestoneIndexUnbounded(source),
      ...scanPoolErasedWithoutPayout(source),
      ...scanHalfImplementedRewardVault(source)
    );
  }

  const schemaBody = extractVaultUISchemaBody(source);
  if (schemaBody && vaultPlan?.mechanicDesign?.requiredSchemaMethods?.length) {
    for (const method of vaultPlan.mechanicDesign.requiredSchemaMethods) {
      if (!schemaListsMethod(schemaBody, method)) {
        findings.push({
          rule: "design-schema-method-missing",
          detail: `Mechanic design requires vaultUISchema method "${method}" but it is missing.`,
        });
      }
    }
  }

  return findings;
}
