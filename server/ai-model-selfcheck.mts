import { DEFAULT_MODEL, resolveCheapModel, resolveEscalationModel, resolveAiModel } from "./ai-model.js";
import { extractJsonPayload } from "./ai-client.js";

let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`OK ${name}`);
  else {
    console.error(`FAIL ${name}`);
    failures++;
  }
}

check("DEFAULT_MODEL is claude-sonnet-5", DEFAULT_MODEL === "claude-sonnet-5");
check("resolveAiModel uses env override", resolveAiModel({ AI_MODEL: "claude-opus-4" }) === "claude-opus-4");
check("resolveAiModel falls back to default", resolveAiModel({}) === "claude-sonnet-5");
check("escalation model null when env missing", resolveEscalationModel({}) === null);
check("escalation model env-driven", resolveEscalationModel({ AI_ESCALATION_MODEL: "big-x" }) === "big-x");
check("cheap model falls back to default", resolveCheapModel({ AI_MODEL: "m" }) === "m");
check("cheap model env-driven", resolveCheapModel({ AI_CHEAP_MODEL: "small-x" }) === "small-x");

check("json extractor passes raw JSON through", extractJsonPayload('{"a":1}') === '{"a":1}');
check("json extractor unwraps ```json fences", JSON.parse(extractJsonPayload('```json\n{"a":1}\n```')).a === 1);
check("json extractor unwraps bare ``` fences", JSON.parse(extractJsonPayload('```\n{"a":2}\n```')).a === 2);
check(
  "json extractor tolerates surrounding prose",
  JSON.parse(extractJsonPayload('Here is the result:\n{"a":3}\nHope this helps!')).a === 3
);

if (failures > 0) process.exit(1);
console.log("\nai-model + ai-client selfchecks passed.");
