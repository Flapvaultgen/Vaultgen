import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { en } from "./en";
import { zh } from "./zh";
import type { Dictionary, Lang } from "./types";

export type { Dictionary, Lang } from "./types";

const DICTS: Record<Lang, Dictionary> = { en, zh };
const STORAGE_KEY = "flapVaultGen.lang";

function readStoredLang(): Lang {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "zh" || stored === "en" ? stored : "en";
}

type I18nContextValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Full dictionary for the current language — use for nested/structured content (docs, tables, lists). */
  dict: Dictionary;
  /** Convenience getter for a single leaf string via dot-path, e.g. t("common.nav.home"). */
  t: (path: string) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang());

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private browsing / storage disabled — language just won't persist */
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = next === "zh" ? "zh-Hans" : "en";
    }
  }, []);

  const dict = DICTS[lang];

  const t = useCallback(
    (path: string): string => {
      const parts = path.split(".");
      let node: unknown = dict;
      for (const part of parts) {
        if (typeof node !== "object" || node === null) return path;
        node = (node as Record<string, unknown>)[part];
      }
      return typeof node === "string" ? node : path;
    },
    [dict]
  );

  const value = useMemo<I18nContextValue>(() => ({ lang, setLang, dict, t }), [lang, setLang, dict, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n() must be used within <I18nProvider>.");
  return ctx;
}
