/**
 * Minimal history-based routing — the app deliberately has no router
 * dependency; views are chosen from window.location.pathname.
 */
import { useEffect, useState } from "react";

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function replaceUrl(path: string): void {
  window.history.replaceState({}, "", path);
}

export function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

/** /chat/:chatId */
export function matchChatRoute(path: string): { chatId: string } | null {
  const m = path.match(/^\/chat\/([A-Za-z0-9-]+)\/?$/);
  return m ? { chatId: m[1]! } : null;
}

/** /chats — landing page that opens the most recent chat, or an empty state */
export function matchChatsRoute(path: string): boolean {
  return /^\/chats\/?$/.test(path);
}

/** /docs */
export function matchDocsRoute(path: string): boolean {
  return /^\/docs\/?$/.test(path);
}

/** /tokens or /tokens/:id */
export function matchTokensRoute(path: string): boolean {
  return /^\/tokens\/?$/.test(path);
}

export function matchTokenRoute(path: string): { id: string } | null {
  const m = path.match(/^\/tokens\/([A-Za-z0-9-]+)\/?$/);
  return m ? { id: m[1]! } : null;
}

export function chatPath(chatId: string, runId?: string): string {
  return runId ? `/chat/${chatId}?run=${runId}` : `/chat/${chatId}`;
}
