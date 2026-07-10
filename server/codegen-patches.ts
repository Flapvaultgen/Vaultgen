/**
 * Deterministic (non-LLM) source patches applied to generated Solidity
 * before compile/scan. Phase 4 constraint: patches may enforce safety
 * constraints (caps, guards, reentrancy, disclosure) but must NEVER invent
 * product mechanics — those violations are left to the scanner + LLM repair
 * loop.
 */
import { extractVaultUISchemaBody, findFunctionBody } from "./solidity-parse.js";

function replaceFunctionBody(source: string, fnName: string, newBody: string): string {
  const re = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)[^{]*\\{`, "g");
  const m = re.exec(source);
  if (!m) return source;
  const start = m.index + m[0].length;
  let i = start;
  let depth = 1;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return source.slice(0, start) + newBody + source.slice(i - 1);
}

/**
 * Phase 4: the former patchReceiveBuybackBuckets deterministic patch was REMOVED.
 * It invented a product mechanic (50/50 buyback/jackpot split, buybackBudget,
 * weeklyJackpot, executeBuyback) that the user's MechanicSpec never asked for.
 * Unsafe logic inside receive() (Rule 005) now surfaces as scanner findings
 * (receive-no-external-call / receive-no-transfer / receive-no-loop) and is
 * repaired by the LLM with rule-derived guidance — deterministic mutation must
 * never author mechanics.
 */

/** Cap lottery entrants at 255 in enter(), not only at draw time. */
function patchEntrantCap(code: string): string {
  if (!/function\s+enter\s*\(/.test(code) || !/entrants\.push/.test(code)) return code;
  if (/MAX_ENTRANTS|entrants\.length\s*<\s*255|entrants\.length\s*<\s*type\s*\(\s*uint8\s*\)\.max/.test(code)) {
    return code;
  }

  let out = code;
  if (!/MAX_ENTRANTS/.test(out)) {
    const anchor = out.match(/address\[\]\s+(?:public\s+)?entrants\s*;/);
    if (anchor) {
      out = out.replace(anchor[0], `${anchor[0]}\n    uint256 public constant MAX_ENTRANTS = 255;`);
    }
  }

  const enterBody = findFunctionBody(out, "enter");
  if (enterBody && !/MAX_ENTRANTS|\.length\s*<\s*255/.test(enterBody)) {
    out = replaceFunctionBody(
      out,
      "enter",
      `require(entrants.length < MAX_ENTRANTS, unicode"Entrant cap / 参与者已满");\n        ${enterBody.trimStart()}`
    );
  }
  return out;
}

/** Add nonReentrant to enter() when mutating entrant arrays. */
function patchEnterNonReentrant(code: string): string {
  if (!/function\s+enter\s*\(/.test(code) || !/entrants\.push|hasEntered/.test(code)) return code;
  if (/function\s+enter\s*\([^)]*\)\s*external\s+nonReentrant/.test(code)) return code;
  return code.replace(/function\s+enter\s*\(\s*\)\s*external(?!\s+nonReentrant)/, "function enter() external nonReentrant");
}

/** Ensure AI lottery vaults disclose Flap AI provider selection in schema description. */
function patchAiLotteryDisclosure(code: string): string {
  if (!/FlapAIConsumerBase/.test(code) || !/function\s+requestDraw\s*\(/.test(code)) return code;
  const schemaBody = extractVaultUISchemaBody(code);
  if (!schemaBody) return code;
  if (/AI.{0,30}provider|AI.{0,20}oracle|AI.{0,20}selected|Flap AI/i.test(schemaBody)) return code;
  return code.replace(
    /(schema\.description\s*=\s*unicode"[^"]*)(")/,
    `$1; winner selected by Flap AI provider (not on-chain VRF)$2`
  );
}

export function isForgeCompileSuccess(out: string): boolean {
  return /Compiler run successful/i.test(out);
}

/** Deterministic fixes for patterns the AI often misses after many retries.
 * Phase 4 constraint: patches may enforce safety constraints (caps, guards,
 * reentrancy, disclosure) but must NEVER invent product mechanics (buckets,
 * splits, reward flows). Rule 005 receive() violations are left to the
 * scanner + LLM repair loop. */
export function applyCommonCodegenPatches(code: string): string {
  let out = code;

  out = patchEntrantCap(out);
  out = patchEnterNonReentrant(out);
  out = patchAiLotteryDisclosure(out);

  if (/FlapAIConsumerBase/.test(out) && /lastDrawFee/.test(out)) {
    const fulfillBody = findFunctionBody(out, "_fulfillReasoning");
    if (fulfillBody && !/lastDrawFee\s*=\s*0/.test(fulfillBody)) {
      out = replaceFunctionBody(out, "_fulfillReasoning", `${fulfillBody.trimEnd()}\n        lastDrawFee = 0;\n    `);
    }
  }

  for (const fnName of ["requestDraw", "requestElimination"] as const) {
    const body = findFunctionBody(out, fnName);
    if (!body || !/uint8\s*\(\s*(?:n|entrants\.length|drawSnapshot\.length)/.test(body)) continue;
    if (/<=\s*255|<=\s*type\s*\(\s*uint8\s*\)\.max|MAX_ENTRANTS/.test(body)) continue;
    const guard = body.includes("drawSnapshot.length")
      ? 'require(drawSnapshot.length > 0 && drawSnapshot.length <= type(uint8).max, unicode"Invalid entrant count / 无效参与者数量");\n        '
      : 'require(n > 0 && n <= type(uint8).max, unicode"Invalid entrant count / 无效参与者数量");\n        ';
    out = replaceFunctionBody(out, fnName, `${guard}${body.trimStart()}`);
  }

  return out;
}
