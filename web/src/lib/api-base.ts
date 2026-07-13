/** Backend base URL. Dev: Vite proxies /api. Prod: VITE_API_URL or /config.json apiUrl. */
function normalizeApiBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Same-origin /api only when no explicit API URL was set at build time. */
function defaultApiBase(): string {
  const fromEnv = normalizeApiBase((import.meta.env.VITE_API_URL as string | undefined) ?? "");
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined" && /\.vercel\.app$/i.test(window.location.hostname)) {
    return "";
  }
  return "";
}

let apiBase = defaultApiBase();

export function getApiBase(): string {
  return apiBase;
}

/** Load apiUrl from /config.json when env was not set at build time. Call once on app mount. */
export async function initApiBase(): Promise<string> {
  if (apiBase) return apiBase;
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) {
      const cfg = (await res.json()) as { apiUrl?: string };
      apiBase = normalizeApiBase(cfg.apiUrl ?? "");
    }
  } catch {
    /* offline */
  }
  return apiBase;
}

export function apiUrl(path: string): string {
  const base = apiBase;
  const p = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}
