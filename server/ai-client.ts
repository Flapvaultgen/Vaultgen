/**
 * Central AI client factory — env-driven provider routing.
 *
 * The whole server speaks the OpenAI chat-completions format. Which provider
 * actually serves the requests is decided purely by env:
 *
 *   OPENAI_API_KEY   — API key (OpenAI sk-… or Anthropic sk-ant-…)
 *   OPENAI_BASE_URL  — optional gateway, e.g. https://api.anthropic.com/v1/
 *                      (unset → api.openai.com)
 *   OPENAI_MODEL     — model id on that gateway (e.g. claude-sonnet-5)
 *
 * Anthropic routing: the OpenAI-compatibility layer does NOT support prompt
 * caching, so when the base URL is an Anthropic gateway we call the native
 * Messages API (via @anthropic-ai/sdk) behind a chat-completions-shaped shim.
 * Cache breakpoints are placed on the static system prompt and the last
 * message, so retry loops re-read the (large) stable prefix at 0.1x price.
 *
 * Every call — both providers, stream and non-stream — records token usage
 * into an AsyncLocalStorage-scoped accumulator (see runWithAiUsage), so the
 * pipeline can report per-run token totals and an estimated cost.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

// ── Provider resolution ──────────────────────────────────────────────────────

export function resolveAiBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OPENAI_BASE_URL?.trim() || undefined;
}

export function isAnthropicGateway(env: NodeJS.ProcessEnv = process.env): boolean {
  return /anthropic/i.test(resolveAiBaseUrl(env) ?? "");
}

/**
 * The Anthropic SDK wants the API origin WITHOUT the /v1 suffix that the
 * OpenAI-compatible gateway URL carries (it appends /v1/messages itself).
 */
export function anthropicBaseUrlFrom(openAiStyleUrl: string | undefined): string | undefined {
  if (!openAiStyleUrl) return undefined;
  return openAiStyleUrl.replace(/\/v1\/?$/, "") || undefined;
}

/** Strips OpenAI-only params from a chat-completions body for Anthropic gateways. */
export function adaptBodyForAnthropic(body: Record<string, unknown>): Record<string, unknown> {
  const adapted = { ...body };
  delete adapted.temperature;
  if ((adapted.response_format as { type?: string } | undefined)?.type === "json_object") {
    delete adapted.response_format;
  }
  return adapted;
}

/**
 * Extract a JSON payload from a model reply. Without OpenAI's json_object
 * mode (unavailable on the Anthropic path), models may wrap JSON in ```json
 * fences or add prose around it. Candidates are parse-validated so an inner
 * code fence INSIDE a JSON string (e.g. a suggestedRepair snippet) can't
 * truncate the payload.
 */
export function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const candidates: string[] = [];
  const fencedGreedy = trimmed.match(/```(?:json)?\s*([\s\S]*)```/);
  if (fencedGreedy?.[1]) candidates.push(fencedGreedy[1].trim());
  const fencedLazy = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedLazy?.[1]) candidates.push(fencedLazy[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return candidates[0] ?? trimmed;
}

// ── Per-run token usage & cost tracking ──────────────────────────────────────

export type AiUsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from the provider prompt cache (billed ~0.1x input price). */
  cacheReadInputTokens: number;
  /** Tokens written to the provider prompt cache (billed ~1.25x input price). */
  cacheWriteInputTokens: number;
  /** Estimated spend in USD for calls whose model pricing is known; null when no priced call happened. */
  estCostUsd: number | null;
};

export function createAiUsageTotals(): AiUsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    estCostUsd: null,
  };
}

const usageStore = new AsyncLocalStorage<AiUsageTotals>();

/** Run `fn` with all AI calls (any module, any client instance) accumulating into `totals`. */
export function runWithAiUsage<T>(totals: AiUsageTotals, fn: () => Promise<T>): Promise<T> {
  return usageStore.run(totals, fn);
}

export type AiCallUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
};

/**
 * USD per million tokens: [input, output]. Cache reads bill at 0.1x input,
 * cache writes (5-minute tier) at 1.25x input. Matched by model-id substring;
 * unknown models simply don't contribute to estCostUsd.
 */
const MODEL_PRICES_PER_MTOK: [RegExp, { input: number; output: number }][] = [
  [/haiku/i, { input: 1, output: 5 }],
  [/sonnet/i, { input: 3, output: 15 }],
  [/opus/i, { input: 5, output: 25 }],
];

export function estimateCallCostUsd(model: string, usage: AiCallUsage): number | null {
  const price = MODEL_PRICES_PER_MTOK.find(([re]) => re.test(model))?.[1];
  if (!price) return null;
  const perTok = {
    input: price.input / 1_000_000,
    output: price.output / 1_000_000,
  };
  return (
    usage.inputTokens * perTok.input +
    usage.cacheReadInputTokens * perTok.input * 0.1 +
    usage.cacheWriteInputTokens * perTok.input * 1.25 +
    usage.outputTokens * perTok.output
  );
}

export function recordAiUsage(model: string, usage: AiCallUsage, totals?: AiUsageTotals): void {
  const target = totals ?? usageStore.getStore();
  if (!target) return;
  target.calls += 1;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadInputTokens += usage.cacheReadInputTokens;
  target.cacheWriteInputTokens += usage.cacheWriteInputTokens;
  const cost = estimateCallCostUsd(model, usage);
  if (cost !== null) target.estCostUsd = (target.estCostUsd ?? 0) + cost;
}

// ── Provider-neutral chat interface (what every call site actually uses) ─────

export type AiChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiCompletionParams = {
  model: string;
  messages: AiChatMessage[];
  temperature?: number;
  response_format?: { type: "json_object" };
  /** Output cap. Translated to max_completion_tokens on OpenAI, max_tokens on Anthropic. */
  max_tokens?: number;
  stream?: boolean;
  /**
   * Opt-in: also cache the conversation prefix (last-message breakpoint).
   * Set this ONLY for multi-turn retry loops where the next call re-reads the
   * same prefix — one-shot calls would pay the 1.25x cache-write premium with
   * zero future reads. The system prompt is always cached regardless.
   */
  cache_conversation?: boolean;
};

export type AiCompletion = { choices: { message?: { content?: string | null } }[] };
export type AiCompletionChunk = { choices: { delta?: { content?: string | null } }[] };

export type AiChatClient = {
  chat: {
    completions: {
      create(params: AiCompletionParams & { stream: true }): Promise<AsyncIterable<AiCompletionChunk>>;
      create(params: AiCompletionParams & { stream?: false }): Promise<AiCompletion>;
      create(params: AiCompletionParams): Promise<AiCompletion | AsyncIterable<AiCompletionChunk>>;
    };
  };
};

/** Fallback output cap when a call site doesn't specify one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

// ── Anthropic native path (prompt caching enabled) ───────────────────────────

type AnthropicTextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export type AnthropicRequestShape = {
  model: string;
  max_tokens: number;
  system?: AnthropicTextBlock[];
  messages: { role: "user" | "assistant"; content: AnthropicTextBlock[] }[];
};

/**
 * Convert chat-completions messages into a native Anthropic Messages request
 * with cache breakpoints:
 *   1. the last system block — the big static prompt, stable across retries
 *      and across parallel/sequential calls sharing that prompt. Always set.
 *   2. (only when cache_conversation) the last message block — caches the
 *      whole growing conversation prefix so the next retry re-reads it at
 *      0.1x. One-shot calls skip this: a write with no future read costs
 *      1.25x for nothing.
 * (Anthropic ignores breakpoints on prefixes below its min cacheable length,
 * so this is safe for tiny classifier calls too.)
 */
export function buildAnthropicRequest(params: AiCompletionParams): AnthropicRequestShape {
  const systemBlocks: AnthropicTextBlock[] = [];
  const messages: AnthropicRequestShape["messages"] = [];
  for (const m of params.messages) {
    if (m.role === "system") {
      systemBlocks.push({ type: "text", text: m.content });
    } else {
      messages.push({ role: m.role, content: [{ type: "text", text: m.content }] });
    }
  }
  if (systemBlocks.length > 0) {
    systemBlocks[systemBlocks.length - 1]!.cache_control = { type: "ephemeral" };
  }
  if (params.cache_conversation) {
    const lastMessage = messages[messages.length - 1];
    const lastBlock = lastMessage?.content[lastMessage.content.length - 1];
    if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
  }
  return {
    model: params.model,
    max_tokens: params.max_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages,
  };
}

export function usageFromAnthropic(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | null | undefined): AiCallUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteInputTokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

function createAnthropicChatClient(apiKey: string, env: NodeJS.ProcessEnv): AiChatClient {
  const anthropic = new Anthropic({
    apiKey,
    baseURL: anthropicBaseUrlFrom(resolveAiBaseUrl(env)),
  });

  /**
   * Large max_tokens values make the Anthropic SDK refuse non-streaming
   * calls outright ("Streaming is required for operations that may take
   * longer than 10 minutes"), even when the actual response is much
   * shorter. Rather than every call site having to know this threshold and
   * fall back to manual streaming, non-streaming calls always run over the
   * stream transport under the hood here and get aggregated back into a
   * single completion — callers keep the simple non-stream API.
   */
  async function createNonStream(params: AiCompletionParams): Promise<AiCompletion> {
    let text = "";
    for await (const chunk of streamChunks(params)) {
      text += chunk.choices[0]?.delta?.content ?? "";
    }
    return { choices: [{ message: { content: text } }] };
  }

  async function* streamChunks(params: AiCompletionParams): AsyncGenerator<AiCompletionChunk> {
    const req = buildAnthropicRequest(params);
    const stream = await anthropic.messages.create({ ...req, stream: true });
    const usage: AiCallUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
    // Bind usage to the run context NOW — generator bodies may resume outside it.
    const totals = usageStore.getStore();
    try {
      for await (const event of stream) {
        if (event.type === "message_start") {
          const u = usageFromAnthropic(event.message.usage);
          usage.inputTokens = u.inputTokens;
          usage.cacheReadInputTokens = u.cacheReadInputTokens;
          usage.cacheWriteInputTokens = u.cacheWriteInputTokens;
        } else if (event.type === "message_delta") {
          usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens;
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { choices: [{ delta: { content: event.delta.text } }] };
        }
      }
    } finally {
      recordAiUsage(params.model, usage, totals);
    }
  }

  const create = (async (params: AiCompletionParams) => {
    if (params.stream) return streamChunks(params);
    return createNonStream(params);
  }) as AiChatClient["chat"]["completions"]["create"];

  return { chat: { completions: { create } } };
}

// ── OpenAI path (usage recording wrapper) ────────────────────────────────────

function usageFromOpenAi(usage: OpenAI.CompletionUsage | null | undefined): AiCallUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadInputTokens: cached,
    cacheWriteInputTokens: 0,
  };
}

function createOpenAiChatClient(apiKey: string, env: NodeJS.ProcessEnv): AiChatClient {
  const openai = new OpenAI({ apiKey, baseURL: resolveAiBaseUrl(env) });

  async function* streamChunks(params: AiCompletionParams): AsyncGenerator<AiCompletionChunk> {
    const { max_tokens, ...rest } = params;
    const stream = await openai.chat.completions.create({
      ...rest,
      ...(max_tokens ? { max_completion_tokens: max_tokens } : {}),
      stream: true,
      stream_options: { include_usage: true },
    });
    const totals = usageStore.getStore();
    for await (const chunk of stream) {
      if (chunk.usage) recordAiUsage(params.model, usageFromOpenAi(chunk.usage), totals);
      yield chunk as AiCompletionChunk;
    }
  }

  const create = (async (params: AiCompletionParams) => {
    if (params.stream) return streamChunks(params);
    const { max_tokens, stream: _stream, ...rest } = params;
    const completion = await openai.chat.completions.create({
      ...rest,
      ...(max_tokens ? { max_completion_tokens: max_tokens } : {}),
      stream: false,
    });
    recordAiUsage(params.model, usageFromOpenAi(completion.usage));
    return completion as AiCompletion;
  }) as AiChatClient["chat"]["completions"]["create"];

  return { chat: { completions: { create } } };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createAiClient(apiKey: string, env: NodeJS.ProcessEnv = process.env): AiChatClient {
  return isAnthropicGateway(env)
    ? createAnthropicChatClient(apiKey, env)
    : createOpenAiChatClient(apiKey, env);
}
