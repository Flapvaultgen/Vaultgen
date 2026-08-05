/**
 * Deterministic prompt-language detection for user-facing AI text.
 *
 * The planner / scope classifier used to be told "mirror the user's language"
 * and still drifted into Chinese on English prompts (bilingual system text
 * pulls the model that way). So we count Han vs Latin ourselves and put an
 * explicit OUTPUT LANGUAGE line in the prompt — the model is not asked to
 * guess.
 */

export type PromptLanguage = "en" | "zh";

/** True for CJK Unified Ideographs (the bulk of Simplified/Traditional Chinese prose). */
function isHan(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility Ideographs
  );
}

/**
 * Decide whether free-text AI replies should be English or Simplified Chinese.
 *
 * - No Han → English.
 * - No Latin letters but some Han → Chinese.
 * - Mixed → Chinese when Han is at least 20% of (Han + Latin), else English.
 *   A short English tip with one Chinese word stays English; a Chinese
 *   sentence that mentions "BNB" or "claim" stays Chinese.
 */
export function detectPromptLanguage(prompt: string): PromptLanguage {
  let han = 0;
  let latin = 0;
  for (const ch of prompt) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (isHan(code)) han++;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
  }
  if (han === 0) return "en";
  if (latin === 0) return "zh";
  return han / (han + latin) >= 0.2 ? "zh" : "en";
}

/** Hard instruction injected into planner / scope prompts after detection. */
export function outputLanguageDirective(lang: PromptLanguage): string {
  if (lang === "zh") {
    return (
      "OUTPUT LANGUAGE (detected from the user's prompt — do not override): Simplified Chinese.\n" +
      "Every free-text field a human reads MUST be written in Simplified Chinese. " +
      "Do NOT write those fields in English. Schema keys, enum tokens, role names, " +
      "and contractName stay in English as required by the JSON shape."
    );
  }
  return (
    "OUTPUT LANGUAGE (detected from the user's prompt — do not override): English.\n" +
    "Every free-text field a human reads MUST be written in English. " +
    "Do NOT write those fields in Chinese. Schema keys, enum tokens, role names, " +
    "and contractName stay in English as required by the JSON shape."
  );
}
