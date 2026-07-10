/**
 * Central, environment-driven model routing. No other module may hardcode a
 * model name — everything resolves through these helpers so deployments can
 * pick cost-appropriate models purely via env:
 *
 *   OPENAI_MODEL            — primary model for planning/codegen/critic/repair
 *                             (env var name kept for backward compat; uses Anthropic)
 *   OPENAI_ESCALATION_MODEL — optional stronger model for a final repair attempt
 *   OPENAI_CHEAP_MODEL      — optional cheap model for advisory/classifier calls
 */
export const DEFAULT_MODEL = "claude-sonnet-5";

export function resolveOpenAiModel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPENAI_MODEL?.trim();
  return fromEnv || DEFAULT_MODEL;
}

/** Optional expensive escalation model — null (no escalation) unless configured. */
export function resolveEscalationModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.OPENAI_ESCALATION_MODEL?.trim();
  return fromEnv || null;
}

/** Optional cheap classifier model — falls back to the primary model when unset. */
export function resolveCheapModel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPENAI_CHEAP_MODEL?.trim();
  return fromEnv || resolveOpenAiModel(env);
}
