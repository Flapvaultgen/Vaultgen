/**
 * Detects half-implemented vault mechanics — compiles + passes generic scanners
 * but user-facing actions are dead or disconnected.
 *
 * Phase 4: all checks fire from SOURCE STRUCTURE and the MechanicSpec-derived
 * design (vaultPlan.mechanicDesign) — never from prompt keywords or VaultKind.
 * Free-form action names (voteForCharity, submitQuestProof, allocateToCause,
 * settleEpoch, redeemBadge, …) are handled by dataflow, not by name lists.
 */

import type { VaultPlan } from "./vault-plan.js";
import type { MechanicSpec } from "./mechanic-spec.js";

export type MechanicFinding = { rule: string; detail: string; level?: "block" | "warn" };

type FnChunk = { name: string; body: string; header: string };

const SKIP_UI_METHODS = new Set([
  "description",
  "vaultUISchema",
  "receive",
  "constructor",
  "emergencyWithdrawNative",
  "emergencyWithdrawToken",
  "lastRequestId",
  // Rule 008 trigger-service callback is protocol plumbing, not user UI.
  "trigger",
]);

const SKIP_UI_PREFIXES = ["_onFlapAI", "_fulfillReasoning"];

/** Primary mechanism triggers must stay visible in Flap UI even when onlyManager. */
function isMechanismTrigger(fnName: string): boolean {
  return (
    /^(request|execute|advance|trigger|run|perform|start)/i.test(fnName) ||
    /Draw|Burn|Milestone|Buyback|Epoch|Round|Settle|Distribute|Payout/i.test(fnName)
  );
}

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

/**
 * Any user-credit mapping consumed by a claim-shaped function must have a crediting
 * path — detected by DATAFLOW (read mapping[msg.sender], zero it, send value), not
 * by method names. claimReward, redeemBadge, collectPayout, … all match.
 */
function scanClaimMappingsNeverCredited(source: string): MechanicFinding[] {
  const findings: MechanicFinding[] = [];
  const mappingNames = new Set<string>();
  for (const m of source.matchAll(
    /mapping\s*\(\s*address\s*=>\s*uint256\s*\)\s+(?:public\s+|private\s+|internal\s+)?(\w+)/g
  )) {
    mappingNames.add(m[1]!);
  }

  for (const mapName of mappingNames) {
    // Claim-shaped consumer: external/public non-view fn that reads the caller's
    // entry, zeroes it, and pays out — regardless of the function's name.
    const claimShaped = extractFunctionChunks(source).filter(
      (f) =>
        /external|public/.test(f.header) &&
        !/\bview\b|\bpure\b/.test(f.header) &&
        new RegExp(`${mapName}\\s*\\[\\s*msg\\.sender\\s*\\]`).test(f.body) &&
        new RegExp(`${mapName}\\s*\\[\\s*msg\\.sender\\s*\\]\\s*=\\s*0\\s*;`).test(f.body) &&
        (/_sendNative\s*\(|safeTransfer\s*\(|\.call\{value/.test(f.body) ||
          /claim|redeem|collect|withdraw|harvest/i.test(f.name))
    );
    if (claimShaped.length === 0) continue;

    const credited =
      new RegExp(`${mapName}\\s*\\[[^\\]]+\\]\\s*\\+=`).test(source) ||
      // A non-zero, non-comparison assignment anywhere also counts as a crediting path.
      new RegExp(`${mapName}\\s*\\[[^\\]]+\\]\\s*=\\s*(?!=|0\\s*;)`).test(
        source.replace(new RegExp(`${mapName}\\s*\\[\\s*msg\\.sender\\s*\\]\\s*=\\s*0\\s*;`, "g"), "")
      );
    if (!credited) {
      findings.push({
        rule: "claim-mapping-never-credited",
        detail: `${mapName} is zeroed and paid out in ${claimShaped.map((f) => `${f.name}()`).join(", ")} but never increased (no ${mapName}[user] += amount anywhere). Either credit it in a settlement/distribution function or remove the dead claim path (Rule 001).`,
      });
    }
  }
  return findings;
}

/**
 * Participation state written by open user actions (push msg.sender / flag msg.sender /
 * record a msg.sender-keyed value) must be consumed by some OTHER function —
 * settlement, distribution, payout, or view. Fires from dataflow, so free-form
 * names (voteForCharity, submitQuestProof, registerReferrer, commitScore) all work.
 */
function scanParticipationNeverConsumed(source: string): MechanicFinding[] {
  const findings: MechanicFinding[] = [];
  const fns = extractFunctionChunks(source);

  const recorders = fns.filter(
    (f) =>
      /external|public/.test(f.header) &&
      !/\bview\b|\bpure\b/.test(f.header) &&
      !/onlyManager|onlyGuardian/.test(f.header) &&
      !SKIP_UI_METHODS.has(f.name) &&
      !SKIP_UI_PREFIXES.some((p) => f.name.startsWith(p))
  );

  for (const fn of recorders) {
    const written = new Set<string>();
    for (const m of fn.body.matchAll(/(\w+)\.push\s*\(\s*msg\.sender\s*\)/g)) written.add(m[1]!);
    for (const m of fn.body.matchAll(/(\w+)\s*\[\s*msg\.sender\s*\]\s*(?:\[[^\]]+\]\s*)?=\s*(?!0\s*;)/g)) {
      written.add(m[1]!);
    }
    for (const m of fn.body.matchAll(/(\w+)\s*\[[^\]]*\]\s*\[\s*msg\.sender\s*\]\s*=\s*(?!0\s*;)/g)) {
      written.add(m[1]!);
    }
    if (written.size === 0) continue;

    const consumedSomewhere = [...written].some((name) => {
      const re = new RegExp(`\\b${name}\\b`);
      return fns.some((other) => other.name !== fn.name && re.test(other.body));
    });
    if (!consumedSomewhere) {
      findings.push({
        rule: "participation-never-consumed",
        detail: `${fn.name}() records participation state (${[...written].join(", ")}) but no other function ever reads it — no settlement, payout, or view consumes what users submit. Implement the lifecycle or remove the dead action (Rule 001).`,
      });
    }
  }
  return findings;
}

/**
 * Destructive bucket reset: a fund bucket (state var accumulated in receive())
 * set to 0 in an external function without first reading/distributing its value.
 * Fires from dataflow — no milestone/advance name gate.
 */
function scanBucketResetWithoutDistribution(source: string): MechanicFinding[] {
  const findings: MechanicFinding[] = [];
  const recvMatch = source.match(/receive\s*\(\s*\)\s*external\s+payable[^{]*\{([\s\S]*?)^\s*\}/m);
  const recvBody = recvMatch?.[1] ?? "";
  const buckets = new Set<string>();
  for (const m of recvBody.matchAll(/(\w+)\s*\+=/g)) buckets.add(m[1]!);
  if (buckets.size === 0) return findings;

  for (const fn of extractFunctionChunks(source)) {
    if (!/external|public/.test(fn.header)) continue;
    if (/\bview\b|\bpure\b/.test(fn.header)) continue;
    for (const bucket of buckets) {
      const zeroRe = new RegExp(`\\b${bucket}\\s*=\\s*0\\s*;`);
      const zeroIdx = fn.body.search(zeroRe);
      if (zeroIdx < 0) continue;
      const before = fn.body.slice(0, zeroIdx);
      // Value-use before the reset: captured into a local, used in arithmetic,
      // passed to a call — a boolean guard (bucket > 0) does not preserve funds.
      const valueUse = new RegExp(
        `(?:=\\s*|\\+=\\s*|-=\\s*|\\breturn\\s+|\\(\\s*|,\\s*)${bucket}\\b(?!\\s*(?:>|<|==|!=|>=|<=))`
      );
      if (!valueUse.test(before)) {
        findings.push({
          rule: "pool-erased-no-payout",
          detail: `${fn.name}() sets ${bucket} = 0 without first distributing, crediting, or capturing its value — funds accounted in receive() are silently erased. Read the bucket into a payout/credit path before zeroing it (Rule 001).`,
        });
      }
    }
  }
  return findings;
}

/** Oracle/trigger callbacks are protocol plumbing — they must not be exposed as user UI methods. */
function scanOracleCallbackInSchema(source: string): MechanicFinding[] {
  const schemaBody = extractVaultUISchemaBody(source);
  if (!schemaBody) return [];
  const findings: MechanicFinding[] = [];
  for (const m of schemaBody.matchAll(/\.name\s*=\s*"([^"]+)"/g)) {
    const name = m[1]!;
    if (/^_|^fulfillReasoning$|^onFlapAI|^_onFlapAI/.test(name) || name === "trigger") {
      findings.push({
        rule: "oracle-callback-in-uischema",
        detail: `vaultUISchema lists "${name}" — oracle/trigger callbacks are internal plumbing called by the Flap provider, never a user UI method. Remove it from the schema.`,
      });
    }
  }
  return findings;
}

// ── Phase 7: economic correctness (multi-user payout / liability) ──────────
// These checks are spec-aware: a MechanicSpec is the only source of truth for
// "is this genuinely winner-takes-all?". Structural detection alone cannot
// tell a lottery apart from a quest-reward vault that just forgot per-user
// accounting — so absence of an explicit MechanicSpec declaration is treated
// conservatively as "NOT winner-takes-all" (Phase 7 default rule).

const isOpenWrite = (f: FnChunk) => /external|public/.test(f.header) && !/\bview\b|\bpure\b/.test(f.header);
const isManagerGated = (f: FnChunk) => /onlyManager|onlyGuardian/.test(f.header);

/** Non-mapping state vars accumulated via += inside receive() — "shared pool" buckets. */
function detectSharedPoolBuckets(source: string): string[] {
  const recvMatch = source.match(/receive\s*\(\s*\)\s*external\s+payable[^{]*\{([\s\S]*?)^\s*\}/m);
  const recvBody = recvMatch?.[1] ?? "";
  const buckets = new Set<string>();
  for (const m of recvBody.matchAll(/(\w+)\s*\+=/g)) buckets.add(m[1]!);
  return [...buckets].filter(
    (name) => !new RegExp(`mapping\\s*\\([^)]*\\)\\s+(?:public\\s+|private\\s+|internal\\s+)?${name}\\b`).test(source)
  );
}

/** Address-keyed mappings (bool/uint256/etc.) — candidates for per-user eligibility or credit. */
function detectAddressKeyedMappings(source: string): string[] {
  return [...source.matchAll(/mapping\s*\(\s*address\s*=>\s*\w+\s*\)\s+(?:public\s+|private\s+|internal\s+)?(\w+)/g)].map(
    (m) => m[1]!
  );
}

function specDeclaresWinnerTakesAll(spec?: MechanicSpec): boolean {
  if (!spec) return false;
  return spec.payoutRules.some(
    (p) => p.winnerTakesAll === true || p.distributionMode === "winner_takes_all" || p.liabilityModel === "single_winner_pool"
  );
}

function specRequiresPerUserAccounting(spec?: MechanicSpec): boolean {
  if (!spec) return false;
  return spec.payoutRules.some((p) => p.perUserAccountingRequired === true);
}

function specDisclosesOffchainReview(spec?: MechanicSpec): boolean {
  if (!spec) return false;
  return (
    spec.trustAssumptions.some((t) => /off-?chain|event log|manual(?:ly)? review(?:ed)?/i.test(t)) ||
    spec.payoutRules.some((p) => p.liabilityModel === "event_only_offchain_review")
  );
}

/**
 * The bad QuestProofVault pattern: a claim-shaped function pays the ENTIRE
 * value of a shared (non-mapping) bucket to msg.sender and zeroes it, gated
 * only by a per-user eligibility mapping — so whichever eligible address
 * claims first takes everything and every other eligible user gets nothing.
 * Fires unless the MechanicSpec explicitly declares winner-takes-all /
 * single-winner-pool semantics for the mechanic (Rule 001/003).
 */
function scanSharedPoolFirstClaimerDrain(source: string, spec?: MechanicSpec): MechanicFinding[] {
  const buckets = detectSharedPoolBuckets(source);
  if (buckets.length === 0) return [];
  if (specDeclaresWinnerTakesAll(spec)) return [];

  const fns = extractFunctionChunks(source);
  const eligibilityMappings = detectAddressKeyedMappings(source);
  const findings: MechanicFinding[] = [];

  for (const fn of fns) {
    if (!isOpenWrite(fn)) continue;
    const claimShaped =
      /claim|redeem|collect|harvest/i.test(fn.name) ||
      /_sendNative\s*\(\s*msg\.sender\s*,|\.call\{value:[^}]*\}\s*\(\s*""\s*\)/.test(fn.body);
    if (!claimShaped) continue;

    for (const bucket of buckets) {
      const capturesFullBucket = new RegExp(
        `(?:\\w+\\s+\\w+\\s*=\\s*${bucket}\\s*;|_sendNative\\s*\\(\\s*msg\\.sender\\s*,\\s*${bucket}\\s*\\))`
      ).test(fn.body);
      const zeroesBucket = new RegExp(`\\b${bucket}\\s*=\\s*0\\s*;`).test(fn.body);
      if (!capturesFullBucket || !zeroesBucket) continue;

      const eligibilityGate = eligibilityMappings.find((m) => new RegExp(`${m}\\s*\\[\\s*msg\\.sender\\s*\\]`).test(fn.body));
      if (!eligibilityGate) continue;

      findings.push({
        rule: "first-claimer-can-drain-shared-pool",
        detail: `${fn.name}() pays the entire ${bucket} to msg.sender and zeroes it, gated only by ${eligibilityGate}[msg.sender]. If more than one address can become eligible, the first claimant takes the whole pool and every other eligible user permanently loses their reward. Reserve a per-user amount (e.g. claimableRewards[user]) when eligibility is granted instead of paying the whole bucket to whoever claims first — unless this mechanic is explicitly winner-takes-all in the MechanicSpec.`,
      });
      findings.push({
        rule: "claim-amount-from-global-bucket-without-winner-semantics",
        detail: `${fn.name}() sizes the payout from the shared ${bucket} bucket rather than a per-user claimable amount, and the MechanicSpec does not declare winner-takes-all/single-winner-pool semantics for this payout (Rule 003).`,
      });

      const approvalFn = fns.find(
        (f) =>
          f.name !== fn.name &&
          isManagerGated(f) &&
          /address\s+\w+/.test(f.header) &&
          new RegExp(`${eligibilityGate}\\s*\\[\\s*\\w+\\s*\\]\\s*=\\s*(?!0\\s*;|false\\s*;)`).test(f.body)
      );
      if (approvalFn) {
        const reservesLiability =
          new RegExp(`\\b${bucket}\\s*-=`).test(approvalFn.body) || /claimable\w*\s*\[[^\]]+\]\s*\+=/.test(approvalFn.body);
        if (!reservesLiability) {
          findings.push({
            rule: "approval-without-reserved-liability",
            detail: `${approvalFn.name}() grants eligibility (${eligibilityGate}[user] = ...) without reserving any amount from ${bucket} or crediting a per-user claimable mapping. Decide and reserve the reward amount when approving, e.g. \`${bucket} -= amount; claimableRewards[user] += amount;\`.`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Spec-driven fallback: the MechanicSpec declares that multiple users can
 * become independently eligible for a payout, but the contract has NO
 * per-user liability mapping anywhere — catches mechanics that don't even
 * reach the structural "claim-shaped function" pattern above (e.g. push
 * payouts, manual settlement) yet still lack per-user accounting.
 */
function scanMultiUserPayoutWithoutPerUserAccounting(source: string, spec?: MechanicSpec): MechanicFinding[] {
  if (!spec || !specRequiresPerUserAccounting(spec) || specDeclaresWinnerTakesAll(spec)) return [];
  const hasPerUserLiability = /mapping\s*\(\s*address\s*=>\s*uint256\s*\)/.test(source) && /\[[^\]\s]+\]\s*\+=/.test(source);
  if (hasPerUserLiability) return [];
  return [
    {
      rule: "multi-user-payout-without-per-user-accounting",
      detail:
        "The MechanicSpec declares a payout where multiple users can become independently eligible (perUserAccountingRequired), but the contract has no mapping(address => uint256) claimable/credited liability anywhere. Add a per-user claimable mapping that is credited (+=) before each claim (Rule 001).",
    },
  ];
}

/** Open, non-manager functions that ONLY emit an event — no state is actually written. */
function detectEventOnlySubmitters(source: string): FnChunk[] {
  return extractFunctionChunks(source).filter((f) => {
    if (!isOpenWrite(f) || isManagerGated(f)) return false;
    if (SKIP_UI_METHODS.has(f.name) || SKIP_UI_PREFIXES.some((p) => f.name.startsWith(p))) return false;
    const withoutEmit = f.body.replace(/emit\s+\w+\s*\([^;]*\)\s*;/g, "");
    return f.body.trim().length > 0 && !/=(?!=)|\+\+|--|\.push\s*\(|delete\s+/.test(withoutEmit);
  });
}

/**
 * A user submission that only emits an event (no on-chain state) is fine ONLY
 * if disclosed as off-chain/event-log review, or if a manager approval step
 * references stored submission state. Otherwise flag both as advisory
 * findings (Rule 004 — honest disclosure of the trust model), not launch
 * blockers, since an event-only design can be intentional.
 */
function scanEventOnlyUserActionTrust(source: string, spec?: MechanicSpec): MechanicFinding[] {
  const submitters = detectEventOnlySubmitters(source);
  if (submitters.length === 0) return [];
  if (specDisclosesOffchainReview(spec)) return [];

  const fns = extractFunctionChunks(source);
  const findings: MechanicFinding[] = [];
  for (const submitFn of submitters) {
    findings.push({
      level: "warn",
      rule: "event-only-user-action-without-trust-disclosure",
      detail: `${submitFn.name}() only emits an event and writes no on-chain state — any approval/review must happen off-chain from logs. Disclose this trust assumption in description()/vaultUISchema (or the MechanicSpec's trustAssumptions), or store the submitted data on-chain (e.g. a proof hash) so approval can reference it (Rule 004).`,
    });

    // submitFn is event-only by construction (detectEventOnlySubmitters requires
    // zero state writes), so there is nothing on-chain an approval step COULD
    // reference — any manager approval taking an address is unlinked by definition.
    const approvalFn = fns.find((f) => f !== submitFn && isManagerGated(f) && /address\s+\w+/.test(f.header));
    if (approvalFn) {
      findings.push({
        level: "warn",
        rule: "approval-not-linked-to-submitted-state",
        detail: `${approvalFn.name}() approves an address with no on-chain reference to what ${submitFn.name}() submitted — ${submitFn.name}() only emits an event and stores nothing to check against. Either store a hash/commitment on submission (e.g. latestProofHash[user] = keccak256(proof)) and check it in ${approvalFn.name}(), or disclose that approval is based on off-chain review (Rule 004).`,
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
      (/advance|distribute|settle|payout|milestone|fulfill/i.test(f.name) || f.name === "claimReward") &&
      (/registeredInterest\s*\[|hasRegistered\s*\[|Registrants|registrants|drawSnapshot/.test(f.body) ||
        (arrayPushed && /\.length/.test(f.body) && /for\s*\(/.test(f.body)))
  );

  const creditsOnAdvance = extractFunctionChunks(source).some(
    (f) =>
      /advance|distribute|milestone|fulfill/i.test(f.name) &&
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
    const userFacing =
      /register|claim|stake|enter|unstake/i.test(fn.name) || isMechanismTrigger(fn.name);
    if (/onlyGuardian|onlyManager/.test(fn.header) && !userFacing) {
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

/** Schema references a method name that has no matching function in the contract. */
function scanSchemaMethodsNotImplemented(source: string): MechanicFinding[] {
  const schemaBody = extractVaultUISchemaBody(source);
  if (!schemaBody) return [];

  const findings: MechanicFinding[] = [];
  // Extract method names from schema: .name = "funcName"
  const schemaMethodNames = [...schemaBody.matchAll(/\.name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);

  const allFunctions = new Set(extractFunctionChunks(source).map((f) => f.name));
  // Also allow public state variables (they generate getter functions).
  // Matches both "uint256 public varName;" and "public uint256 varName;" orderings.
  const publicVars = [
    ...[...source.matchAll(/\bpublic\b\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]),
    ...[...source.matchAll(/\w+\s+public\s+(\w+)\s*;/g)].map((m) => m[1]),
  ];
  for (const v of publicVars) allFunctions.add(v);

  for (const name of schemaMethodNames) {
    if (!allFunctions.has(name)) {
      findings.push({
        rule: "schema-method-not-implemented",
        detail: `vaultUISchema lists method "${name}" but no function or public variable with that name exists — Flap UI will revert when calling it.`,
      });
    }
  }
  return findings;
}

/**
 * Time-gated vaults must expose a human-readable time-until view.
 * Detection is structural: named interval constants, epoch/next-run state, or a
 * `block.timestamp >= X + Y` window anywhere — not an "epoch"/"draw" keyword gate.
 * The countdown view is accepted by name OR by body shape (deadline - block.timestamp).
 */
function scanMissingTimeUntilView(source: string): MechanicFinding[] {
  const isTimeBased =
    /DRAW_INTERVAL|WEEK_DURATION|EPOCH_DURATION|drawInterval|weeklyDraw|nextDraw|nextEpoch|nextRunAt|epochStart|1\s*weeks|7\s*days|30\s*days/.test(
      source
    ) || /block\.timestamp\s*>=?\s*\w+\s*\+\s*\w+/.test(source);
  if (!isTimeBased) return [];

  const timeUntilFn = extractFunctionChunks(source).find(
    (f) =>
      /\bview\b|\bpure\b/.test(f.header) &&
      (/^(timeUntil|secondsUntil|timeRemaining|nextDrawIn|drawCooldown)/i.test(f.name) ||
        /until|remaining|countdown|cooldown/i.test(f.name) ||
        /-\s*block\.timestamp/.test(f.body))
  );
  if (!timeUntilFn) {
    return [
      {
        rule: "missing-time-until-view",
        detail:
          "Time-gated vault has no countdown view — Flap UI cannot show when the next scheduled action unlocks. Add a view returning seconds remaining, e.g.: function timeUntilNextExecution() public view returns (uint256) { return block.timestamp >= lastRunAt + INTERVAL ? 0 : lastRunAt + INTERVAL - block.timestamp; }",
      },
    ];
  }

  const schemaBody = extractVaultUISchemaBody(source);
  if (schemaBody && !schemaListsMethod(schemaBody, timeUntilFn.name)) {
    return [
      {
        rule: "time-until-not-in-uischema",
        detail: `${timeUntilFn.name}() exists but is missing from vaultUISchema.methods — Flap UI cannot show the countdown.`,
      },
    ];
  }
  return [];
}

/** AI refund handlers must restore the fee, not double the pool balance. */
function scanRefundDoublesBalance(source: string): MechanicFinding[] {
  const findings: MechanicFinding[] = [];
  for (const fn of extractFunctionChunks(source)) {
    if (!/refund|Refunded/i.test(fn.name)) continue;
    const selfAdd = fn.body.match(/(\w+)\s*\+=\s*\1\b/);
    if (selfAdd) {
      findings.push({
        rule: "refund-doubles-balance",
        detail: `${fn.name}() does ${selfAdd[1]} += ${selfAdd[1]} which doubles the balance — refund the original fee only (e.g. accumulatedTaxBNB += lastDrawFee).`,
      });
    }
  }
  return findings;
}

/** Status views must return stored outcomes, not array[0] (first registrant ≠ winner). */
function scanStatusViewUsesFirstArrayElement(source: string): MechanicFinding[] {
  for (const fn of extractFunctionChunks(source)) {
    if (!/view|pure/.test(fn.header)) continue;
    if (!/winner|leader|selected|current|active|result|outcome/i.test(fn.name)) continue;
    if (
      /\w+\s*\[\s*0\s*\]/.test(fn.body) &&
      /registeredUsers|registrants|entrants|participants|holders|entries|queue|list/i.test(fn.body)
    ) {
      return [
        {
          rule: "status-view-first-array-element",
          detail: `${fn.name}() returns array[0] instead of a stored outcome — persist the result in state when the mechanism settles (e.g. lastWinner) and return that field.`,
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

// ── Phase 8: lifecycle / assignment / stuck-state safety ────────────────────
// Generic resource-lifecycle analysis — NOT a BountyVault template. Any
// discrete resource (bounty, task, quest, contest entry, epoch slot, …) is
// detected structurally: a struct container indexed by id, an open "accept"
// path that attaches msg.sender to an id, deactivation paths, and exits.
// Spec-awareness: MechanicSpec.lifecycle is the only source of truth for
// intentional multi-assignee semantics; its absence is treated conservatively
// as single-assignee-or-undecided (never as permission for shared state).

type ResourceLifecycle = {
  resourceVar: string;
  structName: string;
  structBody: string;
  /** bool field like isActive/active/open on the struct. */
  activeField: string | null;
  /** enum-ish status/state field on the struct. */
  statusField: string | null;
  /** address field like assignee/worker/hunter on the struct. */
  assigneeField: string | null;
  isPublic: boolean;
  /** Regex source matching an access to this resource (direct or via storage alias) — built per function body. */
  accessRe: (body: string) => RegExp;
  acceptFns: FnChunk[];
  /** address-keyed state written with msg.sender inside accept functions. */
  assignmentStores: string[];
  submitFns: FnChunk[];
  /** state (mapping or struct field) written by submit functions. */
  submissionStores: string[];
  deactivateFns: FnChunk[];
  /** deactivating fns that also credit a per-user reward (completion-shaped). */
  completeFns: FnChunk[];
  /** manager deactivating fns that do NOT credit (cancel-shaped) or are named cancel/expire/revoke. */
  cancelFns: FnChunk[];
  /** open fns where the caller clears their own assignment. */
  abandonFns: FnChunk[];
};

function structFields(structBody: string): { type: string; name: string }[] {
  return [...structBody.matchAll(/^\s*([\w\[\]]+)\s+(\w+)\s*;/gm)].map((m) => ({ type: m[1]!, name: m[2]! }));
}

function resourceAccessRegex(resourceVar: string, body: string): RegExp {
  const aliases = [...body.matchAll(new RegExp(`\\w+\\s+storage\\s+(\\w+)\\s*=\\s*${resourceVar}\\s*\\[`, "g"))].map(
    (m) => m[1]!
  );
  const names = [`${resourceVar}\\s*\\[[^\\]]+\\]`, ...aliases.map((a) => `\\b${a}\\b`)];
  return new RegExp(`(?:${names.join("|")})`);
}

/** All address-keyed (possibly nested) stores written with msg.sender inside a fn body. */
function senderKeyedWrites(body: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(/(\w+)\s*\[\s*msg\.sender\s*\]\s*(?:\[[^\]]+\]\s*)?=\s*(?!=)/g)) names.add(m[1]!);
  for (const m of body.matchAll(/(\w+)\s*\[[^\]]+\]\s*\[\s*msg\.sender\s*\]\s*=\s*(?!=)/g)) names.add(m[1]!);
  for (const m of body.matchAll(/(\w+)\.push\s*\(\s*msg\.sender\s*\)/g)) names.add(m[1]!);
  return [...names];
}

/** Does this open fn clear the CALLER's own assignment/participation state? */
function clearsOwnAssignment(body: string): boolean {
  return (
    /delete\s+\w+\s*\[\s*msg\.sender\s*\]/.test(body) ||
    /delete\s+\w+\s*\[[^\]]+\]\s*\[\s*msg\.sender\s*\]/.test(body) ||
    /\w+\s*\[\s*msg\.sender\s*\]\s*=\s*(?:0|false)\s*;/.test(body) ||
    /\w+\s*\[[^\]]+\]\s*\[\s*msg\.sender\s*\]\s*=\s*(?:0|false)\s*;/.test(body)
  );
}

export function analyzeResourceLifecycles(source: string): ResourceLifecycle[] {
  const structs = new Map<string, string>();
  for (const m of source.matchAll(/struct\s+(\w+)\s*\{([\s\S]*?)\}/g)) structs.set(m[1]!, m[2]!);
  if (structs.size === 0) return [];

  const containers: { resourceVar: string; structName: string; isPublic: boolean }[] = [];
  for (const [structName] of structs) {
    for (const m of source.matchAll(
      new RegExp(`\\b${structName}\\s*\\[\\s*\\]\\s+(public\\s+|private\\s+|internal\\s+)?(\\w+)\\s*;`, "g")
    )) {
      containers.push({ resourceVar: m[2]!, structName, isPublic: (m[1] ?? "").trim() === "public" });
    }
    for (const m of source.matchAll(
      new RegExp(`mapping\\s*\\(\\s*uint\\d*\\s*=>\\s*${structName}\\s*\\)\\s+(public\\s+|private\\s+|internal\\s+)?(\\w+)\\s*;`, "g")
    )) {
      containers.push({ resourceVar: m[2]!, structName, isPublic: (m[1] ?? "").trim() === "public" });
    }
  }
  if (containers.length === 0) return [];

  const fns = extractFunctionChunks(source);
  const results: ResourceLifecycle[] = [];

  for (const { resourceVar, structName, isPublic } of containers) {
    const structBody = structs.get(structName)!;
    const fields = structFields(structBody);
    const activeField = fields.find((f) => f.type === "bool" && /active|open|live|available/i.test(f.name))?.name ?? null;
    const statusField =
      fields.find((f) => /status|state|phase/i.test(f.name) && f.type !== "bool" && f.type !== "string")?.name ?? null;
    const assigneeField =
      fields.find((f) => f.type === "address" && /assign|worker|hunter|claimant|taker|acceptor|solver/i.test(f.name))?.name ??
      null;
    const accessRe = (body: string) => resourceAccessRegex(resourceVar, body);

    // Accept-shaped: open non-manager write with a uint id param, touches the
    // resource, and attaches msg.sender (mapping write / push / assignee set).
    const acceptFns = fns.filter((f) => {
      if (!isOpenWrite(f) || isManagerGated(f)) return false;
      if (!/\buint\d*\s+\w+/.test(f.header)) return false;
      if (!accessRe(f.body).test(f.body)) return false;
      const attaches =
        senderKeyedWrites(f.body).length > 0 ||
        new RegExp(`${accessRe(f.body).source}\\s*\\.\\s*\\w+\\s*=\\s*msg\\.sender`).test(f.body);
      // Exclude claim/exit-shaped bodies (paying out or clearing own state).
      const paysOut = /_sendNative\s*\(\s*msg\.sender|\.call\{value/.test(f.body);
      return attaches && !paysOut && !clearsOwnAssignment(f.body);
    });

    const assignmentStores = [...new Set(acceptFns.flatMap((f) => senderKeyedWrites(f.body)))];

    // Submit-shaped: open non-manager write storing user work (bytes32/string param stored in state).
    const submitFns = fns.filter((f) => {
      if (!isOpenWrite(f) || isManagerGated(f)) return false;
      if (acceptFns.includes(f)) return false;
      if (!/\b(bytes32|string|bytes)\b/.test(f.header)) return false;
      return /=(?!=)/.test(f.body.replace(/emit\s+\w+\s*\([^;]*\)\s*;/g, "")) && accessRe(f.body).test(f.body);
    });
    const submissionStores = [
      ...new Set(
        submitFns.flatMap((f) => {
          const stores: string[] = [];
          for (const m of f.body.matchAll(/(\w+)\s*\[[^\]]*\]\s*(?:\[[^\]]+\]\s*)?=\s*(?!=)/g)) stores.push(m[1]!);
          for (const m of f.body.matchAll(/\.\s*(\w+)\s*=\s*(?!=|msg\.sender)/g)) stores.push(m[1]!);
          return stores;
        })
      ),
    ].filter((s) => s !== resourceVar);

    // Deactivation: sets active=false / assigns the status field / deletes the entry.
    const deactivateFns = fns.filter((f) => {
      if (/\bview\b|\bpure\b/.test(f.header)) return false;
      const acc = accessRe(f.body).source;
      return (
        (activeField && new RegExp(`${acc}\\s*\\.\\s*${activeField}\\s*=\\s*false`).test(f.body)) ||
        (statusField && new RegExp(`${acc}\\s*\\.\\s*${statusField}\\s*=`).test(f.body) && !acceptFns.includes(f) && !submitFns.includes(f)) ||
        new RegExp(`delete\\s+${resourceVar}\\s*\\[`).test(f.body)
      );
    });

    const creditsPerUser = (f: FnChunk) => /\w+\s*\[[^\]]+\]\s*\+=/.test(f.body);
    const completeFns = deactivateFns.filter((f) => creditsPerUser(f) || /complet|approv|finish|finali[sz]e|done|fulfill/i.test(f.name));
    const cancelFns = deactivateFns.filter(
      (f) => !completeFns.includes(f) && (isManagerGated(f) || /cancel|expire|revoke|remove|retract|close/i.test(f.name))
    );

    const abandonFns = fns.filter(
      (f) => isOpenWrite(f) && !isManagerGated(f) && clearsOwnAssignment(f.body) && !/claim|redeem|collect|harvest/i.test(f.name)
    );

    results.push({
      resourceVar,
      structName,
      structBody,
      activeField,
      statusField,
      assigneeField,
      isPublic,
      accessRe,
      acceptFns,
      assignmentStores,
      submitFns,
      submissionStores,
      deactivateFns,
      completeFns,
      cancelFns,
      abandonFns,
    });
  }

  return results;
}

function specDeclaresMultiAssignee(spec?: MechanicSpec): boolean {
  return spec?.lifecycle?.assignmentModel === "multi_assignee";
}

function specDeclaresSingleAssignee(spec?: MechanicSpec): boolean {
  return spec?.lifecycle?.assignmentModel === "single_assignee";
}

/** Does the accept path enforce exclusivity (second accept of the same resource reverts/records per-resource state)? */
function acceptEnforcesExclusivity(r: ResourceLifecycle, fn: FnChunk): boolean {
  const acc = r.accessRe(fn.body).source;
  // Writes a per-resource field on accept (assignee/status/active) AND gates on
  // per-resource state before doing so (require/if on the resource's fields).
  const writesResourceField = new RegExp(`${acc}\\s*\\.\\s*\\w+\\s*=`).test(fn.body);
  const gatesOnResourceField =
    new RegExp(`require\\s*\\([^;]*${acc}`).test(fn.body) || new RegExp(`if\\s*\\([^)]*${acc}[^)]*\\)\\s*(?:\\{[^}]*)?revert`).test(fn.body);
  const gatesOnAssignee =
    r.assigneeField !== null && new RegExp(`${acc}\\s*\\.\\s*${r.assigneeField}\\s*==\\s*address\\s*\\(\\s*0\\s*\\)`).test(fn.body);
  return writesResourceField && (gatesOnResourceField || gatesOnAssignee);
}

/** Does a deactivating fn clear/handle assignments beyond a single passed user? */
function deactivationClearsAssignments(r: ResourceLifecycle, fn: FnChunk): boolean {
  if (r.assignmentStores.length === 0) return true;
  return r.assignmentStores.some(
    (s) => new RegExp(`delete\\s+${s}\\s*\\[`).test(fn.body) || new RegExp(`${s}\\s*\\[[^\\]]+\\]\\s*(?:\\[[^\\]]+\\]\\s*)?=\\s*(?:0|false)\\s*;`).test(fn.body)
  );
}

/**
 * Lifecycle / assignment / stuck-state scanners (Phase 8). All findings fire
 * from source structure + MechanicSpec.lifecycle semantics — never from a
 * vault-kind or template match. Returns [] for mechanics without a discrete
 * assignable resource.
 */
export function scanLifecycleSafety(source: string, spec?: MechanicSpec): MechanicFinding[] {
  const resources = analyzeResourceLifecycles(source);
  const findings: MechanicFinding[] = [];
  const fns = extractFunctionChunks(source);

  for (const r of resources) {
    if (r.acceptFns.length === 0) continue; // no assignment lifecycle — nothing to check here
    const noun = r.structName.toLowerCase();
    const multiDeclared = specDeclaresMultiAssignee(spec);
    const hasAssignmentTracking = r.assignmentStores.length > 0 || r.assigneeField !== null;

    // ── single-resource-multiple-acceptance ──
    const nonExclusiveAccepts = r.acceptFns.filter((f) => !acceptEnforcesExclusivity(r, f));
    const multipleAcceptancePossible = nonExclusiveAccepts.length > 0;
    if (multipleAcceptancePossible && !multiDeclared) {
      findings.push({
        rule: "single-resource-multiple-acceptance",
        detail: `${nonExclusiveAccepts.map((f) => `${f.name}()`).join(", ")} lets any number of users accept the same ${noun}: it never sets/checks a per-${noun} assignee or status, so a second user can accept a ${noun} someone is already working on. Either enforce one assignee (set ${r.assigneeField ?? "an assignee field"} on accept and revert when taken) or declare an explicit multi-assignee model in the MechanicSpec with per-user completion state (Rule 001).`,
      });
    }
    if (multipleAcceptancePossible && multiDeclared && !hasAssignmentTracking) {
      findings.push({
        rule: "single-resource-multiple-acceptance",
        detail: `The MechanicSpec declares multi-assignee ${noun}s, but the contract does not track WHO accepted: without per-user assignment state, completion and exits cannot be per-user (Rule 001).`,
      });
    }

    // ── shared-resource-deactivated-while-users-assigned / stuck-state cluster ──
    const unclearingDeactivations = r.deactivateFns.filter((f) => !deactivationClearsAssignments(r, f));
    const hasAbandon = r.abandonFns.length > 0;

    if (multipleAcceptancePossible && !multiDeclared && unclearingDeactivations.length > 0 && hasAssignmentTracking) {
      findings.push({
        rule: "shared-resource-deactivated-while-users-assigned",
        detail: `${unclearingDeactivations.map((f) => `${f.name}()`).join(", ")} deactivates a ${noun} globally while several users may have accepted it (${r.assignmentStores.join(", ") || r.assigneeField}) — the assignment state of the other users is never cleared, so they stay attached to a dead ${noun} (Rule 001).`,
      });
    }

    if (hasAssignmentTracking && r.deactivateFns.length > 0 && !hasAbandon && unclearingDeactivations.length > 0) {
      findings.push({
        rule: "accepted-user-can-become-stuck",
        detail: `A user who accepted a ${noun} has NO exit: deactivation (${unclearingDeactivations.map((f) => `${f.name}()`).join(", ")}) does not clear their assignment, and there is no abandon function where the caller can clear their own state. A stuck user cannot claim, cannot complete, and may be blocked from accepting another ${noun}. Add an abandon path (assignee clears own assignment before approval) and clear assignments on cancellation (Rule 001).`,
      });

      const activeGatedAccepts = r.acceptFns.filter((f) => {
        const acc = r.accessRe(f.body).source;
        return (
          (r.activeField && new RegExp(`require\\s*\\([^;]*${acc}\\s*\\.\\s*${r.activeField}`).test(f.body)) ||
          (r.statusField && new RegExp(`require\\s*\\([^;]*${acc}\\s*\\.\\s*${r.statusField}`).test(f.body))
        );
      });
      if (activeGatedAccepts.length > 0) {
        findings.push({
          rule: "inactive-resource-blocks-user-state",
          detail: `${activeGatedAccepts.map((f) => `${f.name}()`).join(", ")} requires the ${noun} to be active, but a user can stay assigned to a deactivated ${noun} — every ${noun}-gated action then reverts for them permanently (Rule 001).`,
        });
      }
    }

    // ── no-abandon-or-cancel-path ──
    if (hasAssignmentTracking && !hasAbandon && r.cancelFns.length === 0) {
      findings.push({
        rule: "no-abandon-or-cancel-path",
        detail: `Users get attached to a ${noun} (${r.assignmentStores.join(", ") || r.assigneeField}) but there is no abandon function (user clears own assignment) and no cancel function (manager retires a ${noun} without crediting). If the work stalls or the manager disappears, assigned users are trapped. Add abandonment before approval and manager cancellation of open/expired ${noun}s (Rule 001).`,
      });
    }

    // ── manager-completion-without-assignee-check ──
    for (const f of r.completeFns) {
      if (!isManagerGated(f)) continue;
      const addrParam = f.header.match(/address\s+(\w+)/)?.[1];
      if (!addrParam) continue;
      const credits = new RegExp(`\\w+\\s*\\[\\s*${addrParam}\\s*\\]\\s*\\+=`).test(f.body);
      if (!credits) continue;
      const checksAssignment =
        r.assignmentStores.some((s) => new RegExp(`${s}\\s*\\[[^\\]]*${addrParam}[^\\]]*\\]|${s}\\s*\\[[^\\]]+\\]\\s*\\[\\s*${addrParam}\\s*\\]`).test(f.body)) ||
        (r.assigneeField !== null && new RegExp(`\\.\\s*${r.assigneeField}\\s*==\\s*${addrParam}|${addrParam}\\s*==\\s*[^;]*\\.\\s*${r.assigneeField}`).test(f.body));
      if (!checksAssignment) {
        findings.push({
          rule: "manager-completion-without-assignee-check",
          detail: `${f.name}() credits a reward to ${addrParam} without verifying that ${addrParam} is actually assigned to / accepted the ${noun} — the manager can pay any address for any ${noun}, and the real assignee can be skipped. Require ${r.assigneeField ? `the ${noun}'s ${r.assigneeField} to equal ${addrParam}` : `the assignment state of ${addrParam}`} before crediting (Rule 001/004).`,
        });
      }
    }

    // ── manager-finalization-without-submission ──
    if (spec?.lifecycle?.requiresSubmission === "yes" && r.completeFns.length > 0) {
      const referencesSubmission = (f: FnChunk) =>
        r.submissionStores.some((s) => new RegExp(`\\b${s}\\b`).test(f.body)) ||
        /proof|submission|submitted/i.test(f.body) ||
        (f.header.match(/bytes32\s+\w+|string\s+\w+/) !== null && /==|keccak256/.test(f.body));
      const unlinked = r.completeFns.filter((f) => isManagerGated(f) && !referencesSubmission(f));
      if (unlinked.length > 0) {
        findings.push({
          rule: "manager-finalization-without-submission",
          detail: `The MechanicSpec requires users to submit work before approval, but ${unlinked.map((f) => `${f.name}()`).join(", ")} finalizes a ${noun} without referencing ANY submitted state (no proof hash, no submission flag). The manager can approve work that was never submitted (Rule 004).`,
        });
      }
    }

    // ── manager-finalization-without-timeout ──
    const managerCompletes = r.completeFns.some((f) => isManagerGated(f));
    const specHasTimeout = Boolean(spec?.lifecycle?.timeoutOrExpiry);
    const sourceHasTimeout = /block\.timestamp/.test(
      [...r.acceptFns, ...r.deactivateFns, ...r.abandonFns, ...r.cancelFns].map((f) => f.body).join("\n")
    );
    if (managerCompletes && !hasAbandon && !specHasTimeout && !sourceHasTimeout) {
      findings.push({
        level: "warn",
        rule: "manager-finalization-without-timeout",
        detail: `Completion of a ${noun} depends entirely on the manager acting, and there is no deadline/expiry and no abandon path. If the manager never marks completion, assigned users wait forever. Add a deadline per ${noun} or let the assignee abandon (Rule 001/009 disclosure).`,
      });
    }

    // ── holder-wording-without-holder-check ──
    const descriptionFn = fns.find((f) => f.name === "description");
    const holderWording = /holder/i.test(descriptionFn?.body ?? "") || /holder/i.test(extractVaultUISchemaBody(source) ?? "");
    if (holderWording) {
      const anyUserGateChecksBalance = [...r.acceptFns, ...r.submitFns].some((f) => /balanceOf\s*\(\s*msg\.sender\s*\)/.test(f.body));
      if (!anyUserGateChecksBalance) {
        findings.push({
          level: "warn",
          rule: "holder-wording-without-holder-check",
          detail: `description()/vaultUISchema says "holders" but ${r.acceptFns.map((f) => `${f.name}()`).join(", ")} never checks the caller's token balance — any wallet (including bots) can participate. Enforce eligibility (e.g. require(IERC20(taxToken).balanceOf(msg.sender) > 0)) or change the wording (Rule 004 honesty).`,
        });
      }
    }

    // ── missing-user-status-view ──
    if (hasAssignmentTracking) {
      const assignmentPublic = r.assignmentStores.some((s) =>
        new RegExp(`mapping\\s*\\([^)]*\\)\\s+public\\s+${s}\\b|\\bpublic\\s+${s}\\b`).test(source)
      );
      const userStatusView = fns.some(
        (f) =>
          /\bview\b/.test(f.header) &&
          /address\s+\w+/.test(f.header) &&
          (r.assignmentStores.some((s) => new RegExp(`\\b${s}\\b`).test(f.body)) ||
            (r.assigneeField !== null && new RegExp(`\\.\\s*${r.assigneeField}\\b`).test(f.body)))
      );
      if (!assignmentPublic && !userStatusView) {
        findings.push({
          level: "warn",
          rule: "missing-user-status-view",
          detail: `Assignment state (${r.assignmentStores.join(", ") || r.assigneeField}) is tracked but there is no public getter or view(address) exposing it — a non-coder cannot see whether they are assigned or what to do next. Add e.g. getAccepted${r.structName}(address user) (Rule 004 schema completeness).`,
        });
      }
    }

    // ── resource-state-not-queryable ──
    const perIdView = fns.some((f) => /\bview\b/.test(f.header) && /\buint\d*\s+\w+/.test(f.header) && r.accessRe(f.body).test(f.body));
    if (!r.isPublic && !perIdView) {
      findings.push({
        level: "warn",
        rule: "resource-state-not-queryable",
        detail: `${r.resourceVar} is not public and there is no per-id view (e.g. get${r.structName}(uint256 id)) — the Flap UI cannot show the state of an individual ${noun}. Add a per-id getter and a count view (Rule 004).`,
      });
    }

    // ── hardcoded-economic-constant-without-spec ──
    for (const m of source.matchAll(/constant\s+(\w+)\s*=\s*[\d_.]+\s*(?:ether|e18|gwei)\b/g)) {
      const constName = m[1]!;
      const creditedWithConst = new RegExp(`\\w+\\s*\\[[^\\]]+\\]\\s*\\+=\\s*${constName}\\b`).test(source);
      if (!creditedWithConst) continue;
      const specSupportsFixed =
        spec?.payoutRules.some(
          (p) => p.distributionMode === "fixed_per_user" || /fixed|constant|same amount/i.test(p.claimAmountSource)
        ) ?? false;
      if (!specSupportsFixed) {
        findings.push({
          level: "warn",
          rule: "hardcoded-economic-constant-without-spec",
          detail: `Rewards are credited from the hardcoded constant ${constName} but the MechanicSpec never decided a fixed per-user amount — the user never chose this number, and the vault may promise BNB it does not have. Make the reward per-${noun} (set by the manager when posting) or record the fixed amount explicitly in the spec (Rule 003).`,
        });
      }
    }

    // ── unbounded-array-return-in-ui-schema ──
    for (const f of fns) {
      if (!/\bview\b/.test(f.header)) continue;
      const retMatch = f.header.match(/returns\s*\(\s*(\w+)\s*\[\s*\]\s+memory/);
      if (!retMatch) continue;
      const retStructBody = retMatch[1] === r.structName ? r.structBody : null;
      if (!retStructBody || !/\bstring\b/.test(retStructBody)) continue;
      const paginated = (f.header.match(/uint\d*\s+\w+/g)?.length ?? 0) >= 2;
      if (!paginated) {
        findings.push({
          level: "warn",
          rule: "unbounded-array-return-in-ui-schema",
          detail: `${f.name}() returns an unbounded ${r.structName}[] containing strings — gas cost grows without limit and the standard Flap panel renders it poorly. Expose a count view plus a per-id getter (or paginate with offset/limit) instead (Rule 004 UI schema).`,
        });
      }
    }

    // ── spec-gap findings (only meaningful when a spec is present) ──
    if (spec?.lifecycle && spec.lifecycle.assignmentModel === "unspecified") {
      findings.push({
        level: "warn",
        rule: "assignment-model-missing",
        detail: `The MechanicSpec never decided whether one or many users can accept the same ${noun} (assignmentModel is unspecified) — this is a safety-relevant design decision the user must make (or accept the conservative single-assignee default).`,
      });
    }
    if (spec?.lifecycle && spec.payoutRules.length > 0 && spec.payoutRules.every((p) => !p.claimAmountSource.trim())) {
      findings.push({
        level: "warn",
        rule: "reward-amount-not-specified",
        detail: `The MechanicSpec pays rewards but never decided where the reward AMOUNT comes from (claimAmountSource is empty on every payout rule) — decide per-${noun} manager-set amounts, a fixed amount, or a pool rule before launch (Rule 003).`,
      });
    }
  }

  return findings;
}

export function isNovelMechanicPrompt(prompt: string): boolean {
  return (
    /milestone|register\s*interest|registration|threshold|advance|epoch|tier|badge|referral|vote|gauge|campaign|quest|reward\s*pool/i.test(
      prompt
    ) ||
    (/\bregister\b/i.test(prompt) && /\bclaim\b/i.test(prompt))
  );
}

/**
 * UI methods inferred from the generated contract — not from prompt keywords.
 * Used when mechanicDesign.requiredSchemaMethods is empty (no API key / pre-codegen).
 */
export function inferRequiredSchemaMethods(_prompt: string, source = ""): string[] {
  if (!source) return [];

  const methods = new Set<string>();
  for (const fn of extractFunctionChunks(source)) {
    if (SKIP_UI_METHODS.has(fn.name)) continue;
    if (SKIP_UI_PREFIXES.some((p) => fn.name.startsWith(p))) continue;
    if (/internal|private/.test(fn.header)) continue;

    if (/view|pure/.test(fn.header)) {
      if (/^(timeUntil|secondsUntil|timeRemaining|nextDrawIn|drawCooldown)/i.test(fn.name)) {
        methods.add(fn.name);
      }
      continue;
    }

    if (!/external|public/.test(fn.header)) continue;

    const exposed =
      !/onlyGuardian|onlyManager/.test(fn.header) ||
      /register|claim|stake|enter|unstake/i.test(fn.name) ||
      isMechanismTrigger(fn.name);
    if (exposed) methods.add(fn.name);
  }

  return [...methods];
}

export function scanMechanicCompleteness(
  source: string,
  userPrompt = "",
  vaultPlan?: VaultPlan,
  mechanicSpec?: MechanicSpec
): MechanicFinding[] {
  const findings: MechanicFinding[] = [];

  // Phase 4: every completeness check runs unconditionally from source structure —
  // no prompt-keyword gate (milestone/register/epoch/…) and no VaultKind gate.
  void userPrompt;
  findings.push(...scanClaimMappingsNeverCredited(source));
  findings.push(...scanWriteMethodsMissingFromSchema(source));
  findings.push(...scanSchemaMethodsNotImplemented(source));
  findings.push(...scanMissingTimeUntilView(source));
  findings.push(...scanRefundDoublesBalance(source));
  findings.push(...scanStatusViewUsesFirstArrayElement(source));
  findings.push(...scanParticipationNeverConsumed(source));
  findings.push(...scanBucketResetWithoutDistribution(source));
  findings.push(...scanOracleCallbackInSchema(source));
  // Phase 7: economic correctness — spec-aware, so a missing/absent MechanicSpec
  // is treated conservatively (never assumes winner-takes-all).
  findings.push(...scanSharedPoolFirstClaimerDrain(source, mechanicSpec));
  findings.push(...scanMultiUserPayoutWithoutPerUserAccounting(source, mechanicSpec));
  findings.push(...scanEventOnlyUserActionTrust(source, mechanicSpec));
  // Phase 8: lifecycle / assignment / stuck-state safety — spec-aware; absence
  // of an explicit multi-assignee declaration is treated conservatively.
  findings.push(...scanLifecycleSafety(source, mechanicSpec));
  findings.push(
    ...scanRegistrationNeverConsumed(source),
    ...scanMilestoneIndexUnbounded(source),
    ...scanPoolErasedWithoutPayout(source),
    ...scanHalfImplementedRewardVault(source)
  );

  const schemaBody = extractVaultUISchemaBody(source);
  const requiredMethods = [
    ...(vaultPlan?.mechanicDesign?.requiredSchemaMethods ?? []),
    ...(vaultPlan?.mechanicDesign?.requiredSchemaMethods?.length
      ? []
      : inferRequiredSchemaMethods(userPrompt, source)),
  ];
  if (schemaBody && requiredMethods.length) {
    for (const method of requiredMethods) {
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
