/**
 * Central, environment-driven model routing. No other module may hardcode a
 * model name — everything resolves through these helpers so deployments can
 * pick cost-appropriate models purely via env:
 *
 *   OPENAI_MODEL            — default model for planning/codegen/critic/repair
 *   OPENAI_ESCALATION_MODEL — optional stronger model for a final repair
 *                             attempt (no escalation when unset)
 *   OPENAI_CHEAP_MODEL      — optional cheap model for classifier-style calls
 *                             (falls back to the default model when unset)
 */
export const DEFAULT_OPENAI_MODEL = "gpt-5.4";

export function resolveOpenAiModel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPENAI_MODEL?.trim();
  return fromEnv || DEFAULT_OPENAI_MODEL;
}

/** Optional expensive escalation model — null (no escalation) unless configured. */
export function resolveEscalationModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.OPENAI_ESCALATION_MODEL?.trim();
  return fromEnv || null;
}

/** Optional cheap classifier model — falls back to the default model when unset. */
export function resolveCheapModel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPENAI_CHEAP_MODEL?.trim();
  return fromEnv || resolveOpenAiModel(env);
}
