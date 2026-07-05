import { DEFAULT_OPENAI_MODEL, resolveCheapModel, resolveEscalationModel, resolveOpenAiModel } from "./openai-model.js";
import { adaptBodyForAnthropic, extractJsonPayload, isAnthropicGateway, resolveAiBaseUrl } from "./ai-client.js";

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`OK ${name}`);
  else {
    console.error(`FAIL ${name}`);
    failures++;
  }
}

check("DEFAULT_OPENAI_MODEL is gpt-5.4", DEFAULT_OPENAI_MODEL === "gpt-5.4");
check("resolveOpenAiModel uses env override", resolveOpenAiModel({ OPENAI_MODEL: "gpt-5.5" }) === "gpt-5.5");
check("resolveOpenAiModel falls back to default", resolveOpenAiModel({}) === "gpt-5.4");
check("escalation model null when env missing", resolveEscalationModel({}) === null);
check("escalation model env-driven", resolveEscalationModel({ OPENAI_ESCALATION_MODEL: "big-x" }) === "big-x");
check("cheap model falls back to default", resolveCheapModel({ OPENAI_MODEL: "m" }) === "m");
check("cheap model env-driven", resolveCheapModel({ OPENAI_CHEAP_MODEL: "small-x" }) === "small-x");

// ── Provider gateway routing (Anthropic via OpenAI-compatible endpoint) ──────
check("no base URL by default", resolveAiBaseUrl({}) === undefined);
check("base URL env-driven", resolveAiBaseUrl({ OPENAI_BASE_URL: "https://api.anthropic.com/v1/" }) === "https://api.anthropic.com/v1/");
check("anthropic gateway detected from base URL", isAnthropicGateway({ OPENAI_BASE_URL: "https://api.anthropic.com/v1/" }));
check("openai default is not an anthropic gateway", !isAnthropicGateway({}));

const adapted = adaptBodyForAnthropic({
  model: "claude-sonnet-5",
  temperature: 0.2,
  response_format: { type: "json_object" },
  messages: [],
  stream: true,
});
check("adapter strips temperature (rejected by anthropic)", !("temperature" in adapted));
check("adapter strips json_object response_format (rejected by anthropic)", !("response_format" in adapted));
check("adapter preserves model/messages/stream", adapted.model === "claude-sonnet-5" && "messages" in adapted && adapted.stream === true);

check("json extractor passes raw JSON through", extractJsonPayload('{"a":1}') === '{"a":1}');
check("json extractor unwraps ```json fences", JSON.parse(extractJsonPayload('```json\n{"a":1}\n```')).a === 1);
check("json extractor unwraps bare ``` fences", JSON.parse(extractJsonPayload('```\n{"a":2}\n```')).a === 2);
check(
  "json extractor tolerates surrounding prose",
  JSON.parse(extractJsonPayload('Here is the result:\n{"a":3}\nHope this helps!')).a === 3
);

if (failures > 0) process.exit(1);
console.log("\nopenai-model + ai-client selfchecks passed.");
