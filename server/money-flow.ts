/**
 * Deterministic money-flow (ledger) extraction for generated vaults.
 *
 * Why this exists: the economic critic used to be handed the whole contract and
 * a checklist of known bad shapes ("first claimer drains the pool", …). A vault
 * can satisfy every item on that list and still be insolvent, because the bug
 * is in the arithmetic across functions rather than in any single line. Reading
 * a contract and asking "does the money add up?" requires enumerating every
 * write to every money variable — mechanical work a regex pass does perfectly
 * and a model does unreliably.
 *
 * So this module builds the table (which variables hold or owe money, and what
 * every function does to them) and the pipeline uses it twice:
 *   1. scanLedgerSolvency() — a deterministic blocking finding for the one
 *      unsound shape the table makes provable: a per-user liability credited
 *      without either debiting its bucket or incrementing an aggregate the
 *      free-balance math subtracts.
 *   2. formatMoneyFlowTable() — the same table goes into the critic prompt as
 *      evidence, turning "spot the bug" into "verify this arithmetic".
 *
 * Like solidity-parse.ts this is regex + brace-depth, not a real parser: good
 * enough for the narrow shapes AI-generated vaults produce.
 */

import { extractFunctionChunks } from "./solidity-parse.js";
import type { MechanicFinding } from "./mechanic-completeness.js";

/**
 * bucket    — native BNB the vault holds, credited by receive() (tax income).
 * liability — per-user amounts the vault owes (a claimable/pending mapping).
 * counter   — every other uint256 scalar (reservations, totals, indices).
 */
export type LedgerRole = "bucket" | "liability" | "counter";

export type LedgerVariable = {
  name: string;
  role: LedgerRole;
  shape: "scalar" | "mapping";
};

/** `credit` = `+=`, `debit` = `-=`, `zero` = `= 0`, `assign` = any other `=`. */
export type LedgerWriteKind = "credit" | "debit" | "zero" | "assign";

export type LedgerWrite = {
  /** Function name, or "receive" / "constructor". */
  fn: string;
  variable: string;
  kind: LedgerWriteKind;
  /** Right-hand side of the write, trimmed — null for `zero`. */
  amount: string | null;
};

/** A place where a bucket's *free* balance is computed to authorize something. */
export type FreeBalanceExpr = {
  fn: string;
  bucket: string;
  /** Variables subtracted from (or compared against) the bucket. */
  subtracted: string[];
  text: string;
};

export type MoneyFlowTable = {
  variables: LedgerVariable[];
  writes: LedgerWrite[];
  freeBalance: FreeBalanceExpr[];
};

// ── Source slicing ───────────────────────────────────────────────────────────

/**
 * Text at brace depth 1 — i.e. contract-level declarations only. Struct fields
 * (depth 2) and function locals (depth 2+) must not be mistaken for state.
 */
function declarationRegion(source: string): string {
  let depth = 0;
  let out = "";
  for (const c of source) {
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      continue;
    }
    if (depth === 1) out += c;
  }
  return out;
}

/** `receive() external payable { … }` body, or "" when absent. */
function receiveBody(source: string): string {
  const m = source.match(/receive\s*\(\s*\)[^{]*\{/);
  if (!m || m.index === undefined) return "";
  let i = m.index + m[0].length;
  const start = i;
  let depth = 1;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  return source.slice(start, i - 1);
}

type CodeUnit = { fn: string; body: string; header: string };

function codeUnits(source: string): CodeUnit[] {
  const units: CodeUnit[] = extractFunctionChunks(source).map((f) => ({
    fn: f.name,
    body: f.body,
    header: f.header,
  }));
  const rcv = receiveBody(source);
  if (rcv) units.push({ fn: "receive", body: rcv, header: "receive() external payable" });
  return units;
}

// ── Variable discovery ───────────────────────────────────────────────────────

function scalarNames(declarations: string): string[] {
  const names: string[] = [];
  for (const m of declarations.matchAll(
    /uint256\s+((?:public|private|internal|constant|immutable|override)\s+)*(\w+)\s*(?:=[^;]*)?;/g
  )) {
    // Constants and immutables are configuration, never balances.
    if (/constant|immutable/.test(m[1] ?? "")) continue;
    names.push(m[2]!);
  }
  return names;
}

/**
 * Mappings whose innermost value type is uint256, single- or multi-key. The
 * `\)+` matters: a nested `mapping(uint256 => mapping(address => uint256))`
 * closes two parens before the variable name.
 */
function uintMappingNames(declarations: string): string[] {
  const names: string[] = [];
  for (const m of declarations.matchAll(
    /mapping\s*\([^;]*?=>\s*uint256\s*\)+\s*((?:public|private|internal)\s+)?(\w+)\s*;/g
  )) {
    names.push(m[2]!);
  }
  return names;
}

// ── Write discovery ─────────────────────────────────────────────────────────

/** Matches `name +=`, `name[..] +=`, … capturing the RHS up to the `;`. */
function writeMatches(body: string, name: string, shape: "scalar" | "mapping"): LedgerWrite[] {
  const target = shape === "mapping" ? `${name}\\s*(?:\\[[^\\]]*\\]\\s*)+` : `${name}\\s*`;
  const out: Omit<LedgerWrite, "fn">[] = [];
  for (const m of body.matchAll(new RegExp(`\\b${target}\\+=\\s*([^;]+);`, "g"))) {
    out.push({ variable: name, kind: "credit", amount: m[1]!.trim() });
  }
  for (const m of body.matchAll(new RegExp(`\\b${target}-=\\s*([^;]+);`, "g"))) {
    out.push({ variable: name, kind: "debit", amount: m[1]!.trim() });
  }
  // Plain `=` only: the char before must not make it ==, +=, >=, … and the char
  // after must not make it ==.
  for (const m of body.matchAll(new RegExp(`\\b${target}(?<![=!<>+\\-*/%])=(?!=)\\s*([^;]+);`, "g"))) {
    const rhs = m[1]!.trim();
    out.push({ variable: name, kind: rhs === "0" ? "zero" : "assign", amount: rhs === "0" ? null : rhs });
  }
  return out as LedgerWrite[];
}

// ── Free-balance math ────────────────────────────────────────────────────────

function freeBalanceExprs(units: CodeUnit[], buckets: string[]): FreeBalanceExpr[] {
  const found: FreeBalanceExpr[] = [];
  for (const unit of units) {
    for (const bucket of buckets) {
      // `bucket - a - b`  (an availability computation)
      for (const m of unit.body.matchAll(new RegExp(`\\b${bucket}\\s*((?:-\\s*[A-Za-z_]\\w*\\s*)+)`, "g"))) {
        const subtracted = [...m[1]!.matchAll(/[A-Za-z_]\w*/g)].map((x) => x[0]);
        found.push({ fn: unit.fn, bucket, subtracted, text: `${bucket} ${m[1]!.trim()}`.replace(/\s+/g, " ") });
      }
      // `require(bucket >= x)`  (a solvency check before promising something)
      for (const m of unit.body.matchAll(new RegExp(`\\b${bucket}\\s*>=\\s*([^,;)]+)`, "g"))) {
        found.push({
          fn: unit.fn,
          bucket,
          subtracted: [...m[1]!.matchAll(/[A-Za-z_]\w*/g)].map((x) => x[0]),
          text: `${bucket} >= ${m[1]!.trim()}`.replace(/\s+/g, " "),
        });
      }
    }
  }
  return found;
}

// ── Table ────────────────────────────────────────────────────────────────────

export function buildMoneyFlowTable(source: string): MoneyFlowTable {
  const declarations = declarationRegion(source);
  const units = codeUnits(source);
  const rcv = units.find((u) => u.fn === "receive")?.body ?? "";

  const scalars = scalarNames(declarations);
  const mappings = uintMappingNames(declarations);

  // A bucket is a scalar that receive() credits AND that something later spends.
  // The second half matters: a reward *index* (accRewardPerShare) is also bumped
  // in receive() but is never debited, and calling it a balance would put a lie
  // in the critic's evidence.
  const spentSomewhere = (name: string): boolean =>
    units.some((u) =>
      writeMatches(u.body, name, "scalar").some((w) => w.kind === "debit" || w.kind === "zero")
    );
  const buckets = new Set(
    scalars.filter((n) => new RegExp(`\\b${n}\\s*\\+=`).test(rcv) && spentSomewhere(n))
  );

  // A liability is a uint256 mapping that is credited somewhere and paid out by
  // a function that clears it and moves native value.
  const liabilities = new Set(
    mappings.filter((n) => {
      const credited = units.some((u) => writeMatches(u.body, n, "mapping").some((w) => w.kind === "credit"));
      const paidOut = units.some(
        (u) =>
          writeMatches(u.body, n, "mapping").some((w) => w.kind === "zero" || w.kind === "debit") &&
          /_sendNative\s*\(|safeTransfer\s*\(|\.call\{value/.test(u.body)
      );
      return credited && paidOut;
    })
  );

  const variables: LedgerVariable[] = [
    ...scalars.map((name) => ({
      name,
      shape: "scalar" as const,
      role: (buckets.has(name) ? "bucket" : "counter") as LedgerRole,
    })),
    ...mappings
      .filter((name) => liabilities.has(name))
      .map((name) => ({ name, shape: "mapping" as const, role: "liability" as LedgerRole })),
  ];

  const writes: LedgerWrite[] = [];
  for (const unit of units) {
    for (const v of variables) {
      for (const w of writeMatches(unit.body, v.name, v.shape)) writes.push({ ...w, fn: unit.fn });
    }
  }

  return { variables, writes, freeBalance: freeBalanceExprs(units, [...buckets]) };
}

/**
 * True when the vault holds tax BNB in a bucket AND owes per-user amounts out of
 * it — the shape where solvency is a real question rather than a formality. Used
 * to decide when the critic is worth the stronger model.
 */
export function hasNontrivialLedger(table: MoneyFlowTable): boolean {
  return (
    table.variables.some((v) => v.role === "bucket") && table.variables.some((v) => v.role === "liability")
  );
}

// ── Deterministic solvency finding ───────────────────────────────────────────

const LEDGER_RULE = "bucket-liability-not-tracked";

/**
 * The one unsoundness the table makes provable: a function credits a per-user
 * liability without either debiting the bucket that funds it or incrementing an
 * aggregate the free-balance math can subtract. The owed amount then sits in the
 * bucket while counting as free, so the same BNB can be promised twice and the
 * users who claim last cannot be paid.
 */
export function scanLedgerSolvency(table: MoneyFlowTable): MechanicFinding[] {
  const role = (name: string): LedgerRole | undefined => table.variables.find((v) => v.name === name)?.role;
  const buckets = table.variables.filter((v) => v.role === "bucket").map((v) => v.name);
  const liabilities = table.variables.filter((v) => v.role === "liability").map((v) => v.name);
  if (buckets.length === 0 || liabilities.length === 0) return [];

  const findings: MechanicFinding[] = [];
  for (const liability of liabilities) {
    const creditFns = [
      ...new Set(table.writes.filter((w) => w.variable === liability && w.kind === "credit").map((w) => w.fn)),
    ];
    for (const fn of creditFns) {
      const own = table.writes.filter((w) => w.fn === fn);
      // Either accepted way to keep the bucket's free balance honest.
      const debitsBucket = own.some((w) => role(w.variable) === "bucket" && (w.kind === "debit" || w.kind === "zero"));
      const tracksAggregate = own.some((w) => role(w.variable) === "counter" && w.kind === "credit");
      if (debitsBucket || tracksAggregate) continue;

      // Crediting a liability without debiting the bucket is only unsound when
      // something else treats the bucket as having free funds. Two signals for
      // that, and at least one is required — otherwise this would fire on every
      // legitimate index-based staking vault, which credits pending rewards and
      // debits the bucket only at claim time.
      //
      // A `require(bucket >= localAmount)` guard does NOT count: it is a
      // defensive check, not an allocation. Allocation math subtracts a STATE
      // variable, which is the vault deciding how much it can still promise.
      const stateNames = new Set(table.variables.map((v) => v.name));
      const releasedCounters = [
        ...new Set(own.filter((w) => role(w.variable) === "counter" && w.kind === "debit").map((w) => w.variable)),
      ];
      const allocationMath = table.freeBalance.filter(
        (e) => e.fn !== fn && !e.subtracted.includes(liability) && e.subtracted.some((s) => stateNames.has(s))
      );
      if (releasedCounters.length === 0 && allocationMath.length === 0) continue;
      const bucket = buckets[0]!;

      const mathNote =
        allocationMath.length > 0
          ? ` ${allocationMath[0]!.fn}() then treats \`${allocationMath[0]!.text}\` as free, which does not subtract what ${liability} still owes.`
          : "";
      const releaseNote =
        releasedCounters.length > 0
          ? ` ${fn}() also releases ${releasedCounters.join(", ")}, so the amount stops counting as reserved at the exact moment it becomes owed.`
          : "";

      findings.push({
        rule: LEDGER_RULE,
        level: "block",
        detail:
          `${fn}() credits ${liability}[...] (money now owed to a user) without debiting ${bucket} ` +
          `or incrementing an aggregate outstanding-liability counter.${releaseNote}${mathNote} ` +
          `The same BNB can therefore be promised to two different users, and whoever claims last reverts. ` +
          `Fix it either way: (a) debit the bucket when you credit the user — \`${bucket} -= amount; ${liability}[user] += amount;\` ` +
          `— or (b) keep an aggregate (e.g. \`uint256 public totalOwedToUsers\`), increment it here, and subtract it from ` +
          `${bucket} in EVERY free-balance computation. Also expose the aggregate as a view so users can verify solvency.`,
      });
    }
  }
  return findings;
}

// ── Prompt rendering ─────────────────────────────────────────────────────────

const WRITE_SYMBOL: Record<LedgerWriteKind, string> = {
  credit: "+=",
  debit: "-=",
  zero: "= 0",
  assign: "=",
};

/**
 * The table as evidence for the critic. Ordered by function so a reader can
 * follow one call at a time, which is how the arithmetic actually has to be
 * checked.
 */
export function formatMoneyFlowTable(table: MoneyFlowTable): string {
  if (table.variables.length === 0) return "LEDGER: no native buckets or per-user liability mappings found.";

  const byRole = (role: LedgerRole): string =>
    table.variables
      .filter((v) => v.role === role)
      .map((v) => (v.shape === "mapping" ? `${v.name}[...]` : v.name))
      .join(", ") || "(none)";

  const fns = [...new Set(table.writes.map((w) => w.fn))];
  const writeLines = fns.map((fn) => {
    const own = table.writes
      .filter((w) => w.fn === fn)
      .map((w) => {
        const target = table.variables.find((v) => v.name === w.variable)?.shape === "mapping" ? `${w.variable}[...]` : w.variable;
        return `${target} ${WRITE_SYMBOL[w.kind]}${w.amount ? ` ${w.amount.slice(0, 40)}` : ""}`;
      })
      .join(" | ");
    return `  ${fn}: ${own}`;
  });

  const mathLines =
    table.freeBalance.length > 0
      ? table.freeBalance.map((e) => `  ${e.fn}: ${e.text}   [subtracts: ${e.subtracted.join(", ") || "nothing"}]`)
      : ["  (none found)"];

  return `LEDGER (extracted deterministically from the source — verify AGAINST it, do not re-derive it):
native buckets funded by receive(): ${byRole("bucket")}
per-user liabilities (claimable mappings): ${byRole("liability")}
other uint256 counters: ${byRole("counter")}

writes, by function:
${writeLines.join("\n")}

free-balance / solvency expressions:
${mathLines.join("\n")}`;
}
