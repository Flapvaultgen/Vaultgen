import { BookOpen, Coins, History, Home } from "lucide-react";
import MetaMaskConnect from "./MetaMaskConnect";
import { Button } from "./ui/button";
import { navigate } from "../lib/router";
import { useI18n } from "../lib/i18n/context";


/** Small EN / 中文 pill toggle — persists to localStorage via I18nProvider. */
function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("common.langToggleAria")}
      className="flex items-center rounded-full border border-border/60 bg-secondary/40 p-0.5 text-[0.65rem] font-medium"
    >
      {(["en", "zh"] as const).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          className={
            lang === code
              ? "rounded-full bg-primary px-2 py-1 text-primary-foreground"
              : "rounded-full px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          {code === "en" ? "EN" : "中文"}
        </button>
      ))}
    </div>
  );
}

/**
 * Every nav item is a plain route (navigate() pushes history + fires
 * popstate) so it always works regardless of which page/state we're
 * currently rendering — no dependency on a parent-supplied callback that
 * might be a no-op on the current view (that was the bug: Docs/Chats used
 * to only work from the studio's home view).
 */
function goHome() {
  navigate("/");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export default function SiteHeader() {
  const { t } = useI18n();

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="container flex h-14 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={goHome}
          className="group flex items-center gap-2 text-left transition-opacity hover:opacity-90"
        >
          <span className="font-display text-sm font-bold uppercase tracking-[0.18em] text-foreground">
            {t("common.appName")}
          </span>
        </button>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={goHome} className="gap-1.5 text-muted-foreground">
            <Home className="size-3.5" />
            {t("common.nav.home")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/tokens")}
            className="gap-1.5 text-muted-foreground"
          >
            <Coins className="size-3.5" />
            {t("common.nav.tokens")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/chats")} className="gap-1.5 text-muted-foreground">
            <History className="size-3.5" />
            {t("common.nav.chats")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/docs")} className="gap-1.5 text-muted-foreground">
            <BookOpen className="size-3.5" />
            {t("common.nav.docs")}
          </Button>
          <LanguageToggle />
          <MetaMaskConnect />
        </div>
      </div>
    </header>
  );
}
