/**
 * Central AI client — Anthropic native path only.
 *
 * All server calls use the Anthropic Messages API directly via @anthropic-ai/sdk.
 * Prompt caching is enabled on every call (system-prompt breakpoint always set;
 * conversation-prefix breakpoint opt-in via `cache_conversation`), so retry
 * loops re-read the large stable prefix at ~0.1x input price.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY   — your Anthropic API key (sk-ant-…)
 *   AI_MODEL            — primary model, e.g. claude-sonnet-5
 *   AI_CHEAP_MODEL      — optional cheap model for advisory calls
 *   AI_ESCALATION_MODEL — optional stronger model for final repair escalation
 *
 * Every call records token usage into an AsyncLocalStorage-scoped accumulator
 * (see runWithAiUsage), so the pipeline can report per-run totals and an
 * estimated cost.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";

// ── Per-run token usage & cost tracking ──────────────────────────────────────

export type AiUsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from the Anthropic prompt cache (billed ~0.1x input price). */
  cacheReadInputTokens: number;
  /** Tokens written to the Anthropic prompt cache (billed ~1.25x input price). */
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

/** Run `fn` with all AI calls accumulating token usage into `totals`. */
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
 * cache writes (5-minute tier) at 1.25x input. Matched by model-id substring.
 */
const MODEL_PRICES_PER_MTOK: [RegExp, { input: number; output: number }][] = [
  [/haiku/i, { input: 1, output: 5 }],
  [/sonnet/i, { input: 3, output: 15 }],
  [/opus/i, { input: 5, output: 25 }],
];

export function estimateCallCostUsd(model: string, usage: AiCallUsage): number | null {
  const price = MODEL_PRICES_PER_MTOK.find(([re]) => re.test(model))?.[1];
  if (!price) return null;
  const perTok = { input: price.input / 1_000_000, output: price.output / 1_000_000 };
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

// ── Provider-neutral chat interface ──────────────────────────────────────────

export type AiChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiCompletionParams = {
  model: string;
  messages: AiChatMessage[];
  temperature?: number;
  response_format?: { type: "json_object" };
  /** Output cap — maps to max_tokens on Anthropic. */
  max_tokens?: number;
  stream?: boolean;
  /**
   * Opt-in: cache the conversation prefix (last-message breakpoint).
   * Set ONLY for multi-turn retry loops where the next call re-reads the
   * same prefix — one-shot calls would pay the 1.25x cache-write premium
   * with zero future reads. The system prompt is always cached regardless.
   */
  cache_conversation?: boolean;
};

export type AiCompletion = { choices: { message?: { content?: string | null } }[] };
export type AiCompletionChunk = {
  choices: {
    delta?: { content?: string | null };
    /** Set on the final chunk: "max_tokens" means the output was truncated at the cap. */
    finish_reason?: string | null;
  }[];
};

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

// ── JSON extraction helper ────────────────────────────────────────────────────

/**
 * Extract a JSON payload from a model reply. Without OpenAI's json_object
 * mode, models may wrap JSON in ```json fences or add prose. Candidates are
 * parse-validated so inner code fences inside JSON strings can't truncate.
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

// ── Anthropic request builder ─────────────────────────────────────────────────

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
 *   1. Last system block — the large stable prompt, cached on every call.
 *   2. (only when cache_conversation) last message block — caches the growing
 *      conversation prefix for retry loops. One-shot calls skip this.
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

// ── Transient-error retry ─────────────────────────────────────────────────────

/** Anthropic error "type" values worth retrying — all are provider-side capacity/hiccups, never our fault. */
const RETRYABLE_ERROR_TYPES = new Set(["overloaded_error", "api_error", "internal_server_error", "rate_limit_error"]);
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_TRANSIENT_RETRIES = 4;
const RETRY_BACKOFF_MS = [2_000, 5_000, 12_000, 25_000];

function anthropicErrorType(err: unknown): string | undefined {
  const e = err as { error?: { type?: string; error?: { type?: string } }; type?: string } | null;
  return e?.error?.error?.type ?? e?.error?.type ?? (typeof e?.type === "string" ? e.type : undefined);
}

function anthropicHttpStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

/** True for capacity/rate-limit/5xx errors that are safe to retry with backoff. */
function isRetryableAnthropicError(err: unknown): boolean {
  const type = anthropicErrorType(err);
  const status = anthropicHttpStatus(err);
  return (type ? RETRYABLE_ERROR_TYPES.has(type) : false) || (status ? RETRYABLE_HTTP_STATUS.has(status) : false);
}

/** Friendly, provider-neutral message — call sites (and the chat UI) show this instead of a raw SDK dump. */
export function describeAiError(err: unknown): string {
  const type = anthropicErrorType(err);
  if (type === "overloaded_error") return "Anthropic's API is temporarily overloaded — please retry in a moment.";
  if (type === "rate_limit_error") return "Rate limited by the AI provider — please wait a moment and retry.";
  if (type === "api_error" || type === "internal_server_error") return "The AI provider had a temporary error — please retry.";
  return err instanceof Error ? err.message : "Codegen failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Client factory ────────────────────────────────────────────────────────────

export function createAiClient(apiKey: string): AiChatClient {
  const anthropic = new Anthropic({ apiKey });

  /**
   * Large max_tokens values make the Anthropic SDK refuse non-streaming
   * calls ("Streaming is required for operations that may take longer than
   * 10 minutes"). Non-streaming calls run over the stream transport and are
   * aggregated back into a single completion so call sites keep the simple API.
   */
  async function createNonStream(params: AiCompletionParams): Promise<AiCompletion> {
    let text = "";
    for await (const chunk of streamChunks(params)) {
      text += chunk.choices[0]?.delta?.content ?? "";
    }
    return { choices: [{ message: { content: text } }] };
  }

  /**
   * One attempt at the full stream — split out so streamChunks can retry it.
   * Throws on any error; the caller decides whether it is safe to retry.
   */
  async function* attemptStream(params: AiCompletionParams): AsyncGenerator<AiCompletionChunk> {
    const req = buildAnthropicRequest(params);
    const stream = await anthropic.messages.create({ ...req, stream: true });
    const usage: AiCallUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
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
          if (event.delta.stop_reason === "max_tokens") {
            yield { choices: [{ delta: {}, finish_reason: "max_tokens" }] };
          }
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { choices: [{ delta: { content: event.delta.text } }] };
        }
      }
    } finally {
      recordAiUsage(params.model, usage, totals);
    }
  }

  /**
   * Retries a transient provider error (overload, rate limit, 5xx) with
   * backoff — but ONLY while zero content has been yielded yet. Once the
   * model has started streaming text, a silent retry would duplicate or
   * corrupt the partial output the caller has already emitted downstream
   * (e.g. streamed code_delta events to the chat UI), so a mid-stream error
   * always propagates as-is.
   */
  async function* streamChunks(params: AiCompletionParams): AsyncGenerator<AiCompletionChunk> {
    let attempt = 0;
    for (;;) {
      let yieldedAny = false;
      try {
        for await (const chunk of attemptStream(params)) {
          yieldedAny = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (yieldedAny || attempt >= MAX_TRANSIENT_RETRIES || !isRetryableAnthropicError(err)) throw err;
        const waitMs = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
        console.warn(
          `[ai-client] transient error (${anthropicErrorType(err) ?? "unknown"}), retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES})`
        );
        await sleep(waitMs);
        attempt++;
      }
    }
  }

  const create = (async (params: AiCompletionParams) => {
    if (params.stream) return streamChunks(params);
    return createNonStream(params);
  }) as AiChatClient["chat"]["completions"]["create"];

  return { chat: { completions: { create } } };
}
