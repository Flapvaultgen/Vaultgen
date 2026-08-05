/**
 * Prompt language detection — English vs Simplified Chinese for free-text AI
 * replies (plan card, scope summary). The model is not asked to guess; we
 * count Han vs Latin and inject OUTPUT LANGUAGE.
 *
 * Run: npx tsx prompt-language-selfcheck.mts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectPromptLanguage, outputLanguageDirective } from "./prompt-language.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`OK ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Detector ─────────────────────────────────────────────────────────────────

check("pure English → en", detectPromptLanguage("I want holders to tip creators with trading fees") === "en");
check(
  "pure Chinese → zh",
  detectPromptLanguage("我想让持币人用交易手续费给创作者打赏，每天可以打一次") === "zh"
);
check(
  "English with BNB/claim jargon → en",
  detectPromptLanguage("Holders claim BNB rewards from the tipBucket once a day") === "en"
);
check(
  "Chinese with English tech words → zh",
  detectPromptLanguage("持币人每天可以从 tipBucket 领取 BNB 奖励，用 claimTips 领取") === "zh"
);
check(
  "one Chinese word in English → en",
  detectPromptLanguage("I want a vault like 金库 for charity voting every week") === "en"
);
check("empty / punctuation → en", detectPromptLanguage("   !!!   ") === "en");
check(
  "the tip-jar prompt that drifted to Chinese → en",
  detectPromptLanguage(
    "I want people who hold the token to tip creators with the trading-fee money. Like once a day you can send a small tip to someone, and that person can cash it out later. I don't want the project owner grabbing those tips."
  ) === "en"
);

const enDir = outputLanguageDirective("en");
const zhDir = outputLanguageDirective("zh");
check("EN directive names English and forbids Chinese", /English/.test(enDir) && /Do NOT write those fields in Chinese/.test(enDir));
check("ZH directive names Simplified Chinese and forbids English", /Simplified Chinese/.test(zhDir) && /Do NOT write those fields in English/.test(zhDir));

// ── Wired into planner + scope classifier ────────────────────────────────────

const plannerSrc = await readFile(path.join(SERVER_DIR, "mechanic-spec.ts"), "utf8");
const scopeSrc = await readFile(path.join(SERVER_DIR, "vault-scope.ts"), "utf8");

check("planner imports detectPromptLanguage", /detectPromptLanguage/.test(plannerSrc));
check("planner injects outputLanguageDirective into system prompt", /outputLanguageDirective\(outputLang\)/.test(plannerSrc));
check(
  "planner repeats the directive on the user message",
  /User's vault idea:/.test(plannerSrc) && /outputLanguageDirective\(outputLang\)/.test(plannerSrc)
);
check("planner no longer asks the model to guess the language", !/should mirror the user's language/.test(plannerSrc));

check("scope classifier imports detectPromptLanguage", /detectPromptLanguage/.test(scopeSrc));
check("scope classifier injects outputLanguageDirective", /outputLanguageDirective\(outputLang\)/.test(scopeSrc));
check(
  "scope classifier no longer asks the model to guess the language",
  !/when the user's prompt is primarily Chinese/.test(scopeSrc)
);

console.log(failures === 0 ? "\nAll prompt-language selfchecks passed." : `\n${failures} prompt-language selfcheck(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
