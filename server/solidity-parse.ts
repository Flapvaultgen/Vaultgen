/**
 * Lightweight regex + brace-depth Solidity source helpers shared by the
 * codegen scanners (codegen.ts) and the mechanic completeness scanner
 * (mechanic-completeness.ts). Deliberately not a real Solidity parser —
 * good enough for extracting function bodies and the vaultUISchema() body
 * out of AI-generated source for pattern-based safety checks.
 */

export type FnChunk = { name: string; body: string; header: string };

/** Extracts every top-level `function name(...) { ... }` chunk via brace-depth walking. */
export function extractFunctionChunks(source: string): FnChunk[] {
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

export function findFunctionBody(source: string, fnName: string): string | null {
  return extractFunctionChunks(source).find((f) => f.name === fnName)?.body ?? null;
}

/** Extracts the body of `function vaultUISchema(...) { ... }`, or null if not present. */
export function extractVaultUISchemaBody(source: string): string | null {
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
