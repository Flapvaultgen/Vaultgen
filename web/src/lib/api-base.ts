/** Backend base URL. Dev: Vite proxies /api. Prod: VITE_API_URL or /config.json apiUrl. */
let apiBase = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

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
      apiBase = (cfg.apiUrl ?? "").replace(/\/$/, "");
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
