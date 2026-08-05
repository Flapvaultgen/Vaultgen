import { useState } from "react";
import { Menu, X } from "lucide-react";
import MetaMaskConnect from "./MetaMaskConnect";
import { navigate } from "../lib/router";
import { useI18n } from "../lib/i18n/context";

const X_PROFILE_URL = "https://x.com/flapvaultgen";

/** Small EN / 中文 pill toggle — persists to localStorage via I18nProvider. */
function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("common.langToggleAria")}
      className="flex items-center rounded-full border border-border bg-transparent p-0.5 text-[0.65rem] font-medium"
    >
      {(["en", "zh"] as const).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          className={
            lang === code
              ? "whitespace-nowrap rounded-full bg-secondary px-2 py-0.5 text-foreground"
              : "whitespace-nowrap rounded-full px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          {code === "en" ? "EN" : "中文"}
        </button>
      ))}
    </div>
  );
}

/** Plain text nav link — no icon, no button chrome (reference-site header). */
function NavLink({ label, to, onDone }: { label: string; to: string; onDone?: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (to === "/") goHome();
        else navigate(to);
        onDone?.();
      }}
      className="text-[0.8rem] text-muted-foreground transition-colors hover:text-foreground"
    >
      {label}
    </button>
  );
}

/** Official X (Twitter) mark — next to the language switcher. */
function XLogoLink({ ariaLabel }: { ariaLabel: string }) {
  return (
    <a
      href={X_PROFILE_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={ariaLabel}
      className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 fill-current">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    </a>
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
  const [mobileOpen, setMobileOpen] = useState(false);

  const links = [
    { label: t("common.nav.home"), to: "/" },
    { label: t("common.nav.tokens"), to: "/tokens" },
    { label: t("common.nav.chats"), to: "/chats" },
    { label: t("common.nav.docs"), to: "/docs" },
  ];

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-background/70 backdrop-blur-xl">
      <div className="container flex h-14 max-w-[1200px] items-center gap-4 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={goHome}
          className="flex shrink-0 items-center gap-2 text-left transition-opacity hover:opacity-80"
        >
          <span className="size-3.5 rounded-[3px] bg-primary" aria-hidden />
          <span className="text-[0.9rem] font-semibold tracking-[-0.02em] text-foreground">
            {t("common.appName")}
          </span>
        </button>

        {/* Center nav, like the reference sites — links sit between the mark
            and the account controls rather than crowding the right edge. */}
        <nav className="hidden flex-1 items-center justify-center gap-6 md:flex">
          {links.map((l) => (
            <NavLink key={l.to} label={l.label} to={l.to} />
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <LanguageToggle />
          <XLogoLink ariaLabel={t("common.nav.xAria")} />
          <MetaMaskConnect />
          {/* The four links don't fit next to the wallet button on a phone, so
              below md they move into a dropdown instead of disappearing. */}
          <button
            type="button"
            aria-label={t("common.nav.menuAria")}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
            className="flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:text-foreground md:hidden"
          >
            {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav className="flex flex-col gap-1 border-t border-border bg-background px-4 py-3 sm:px-6 md:hidden">
          {links.map((l) => (
            <div key={l.to} className="py-1.5 text-left">
              <NavLink label={l.label} to={l.to} onDone={() => setMobileOpen(false)} />
            </div>
          ))}
        </nav>
      )}
    </header>
  );
}
