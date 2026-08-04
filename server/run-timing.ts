/**
 * Per-run wall-clock timing for the codegen pipeline.
 *
 * A generation run is a loop of expensive phases (model call, forge build,
 * fork test), and the only way to know which one is making a run feel slow is
 * to measure them. Timings collect into an AsyncLocalStorage store — the same
 * pattern as the token-usage tracking in ai-client.ts — so any phase deep in
 * the pipeline can record itself without threading a timer through every call.
 *
 * The summary is logged to stdout (visible in the Railway deploy logs), never
 * shown to the user: it is operator data, not part of the product surface.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** One completed phase within one pass of the repair loop. */
export type PhaseTiming = {
  /** Repair-loop pass this phase belonged to (1 = the first draft). */
  pass: number;
  /** Short phase id, e.g. "llm", "compile", "testgen", "forktest". */
  phase: string;
  ms: number;
};

const timingStore = new AsyncLocalStorage<PhaseTiming[]>();

/** Run `fn` with every timed phase inside it recording into `timings`. */
export function withRunTimings<T>(timings: PhaseTiming[], fn: () => Promise<T>): Promise<T> {
  return timingStore.run(timings, fn);
}

/**
 * Times `fn` and records it against the current run. Records on failure too —
 * a phase that threw after 90 seconds still spent those 90 seconds.
 */
export async function timePhase<T>(phase: string, pass: () => number, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timingStore.getStore()?.push({ pass: pass(), phase, ms: Date.now() - started });
  }
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * Compact operator summary: one line per pass (so a slow pass stands out),
 * then one totals line ordered by time spent (so the dominant phase is first).
 */
export function formatRunTimings(timings: PhaseTiming[], totalMs: number): string[] {
  if (timings.length === 0) return [`[codegen-timing] total=${secs(totalMs)} (no phases recorded)`];

  const passes = [...new Set(timings.map((t) => t.pass))].sort((a, b) => a - b);
  const lines = passes.map((pass) => {
    const own = timings.filter((t) => t.pass === pass);
    const passMs = own.reduce((sum, t) => sum + t.ms, 0);
    const parts = own.map((t) => `${t.phase} ${secs(t.ms)}`).join(" · ");
    return `[codegen-timing] pass ${pass}: ${secs(passMs)} — ${parts}`;
  });

  const byPhase = new Map<string, { ms: number; calls: number }>();
  for (const t of timings) {
    const acc = byPhase.get(t.phase) ?? { ms: 0, calls: 0 };
    byPhase.set(t.phase, { ms: acc.ms + t.ms, calls: acc.calls + 1 });
  }
  const measured = [...byPhase.values()].reduce((sum, v) => sum + v.ms, 0);
  const totals = [...byPhase.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([phase, v]) => `${phase} ${secs(v.ms)}x${v.calls}`)
    .join(" · ");

  lines.push(
    `[codegen-timing] total=${secs(totalMs)} measured=${secs(measured)} passes=${passes.length} — ${totals}`
  );
  return lines;
}

/** Logs the summary for a finished run. Never throws. */
export function logRunTimings(timings: PhaseTiming[], totalMs: number): void {
  for (const line of formatRunTimings(timings, totalMs)) console.log(line);
}
