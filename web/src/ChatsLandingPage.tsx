import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { MessageSquarePlus, Loader2 } from "lucide-react";
import SiteHeader from "./components/SiteHeader";
import { Button } from "./components/ui/button";
import { listVisibleChats } from "./lib/chat-api";
import { getCurrentUserId, subscribeCurrentUser } from "./lib/current-user";
import { chatPath, navigate, replaceUrl } from "./lib/router";
import { useI18n } from "./lib/i18n/context";

/**
 * `/chats` — not a real page of its own content-wise: it redirects to the
 * most recently updated chat visible to this browser/wallet, or shows a
 * friendly empty state when there isn't one yet. Always reachable by
 * clicking "Chats" in the header, connected or not (see SiteHeader).
 */
export default function ChatsLandingPage() {
  const { dict } = useI18n();
  const { isConnected: walletConnected } = useAccount();
  const [loading, setLoading] = useState(true);

  const load = useCallback((cancelledRef: { cancelled: boolean }) => {
    setLoading(true);
    void listVisibleChats(getCurrentUserId())
      .then((chats) => {
        if (cancelledRef.cancelled) return;
        if (chats.length > 0) {
          // Replace (not push) so the browser's back button doesn't bounce
          // between /chats and the chat it immediately redirected to.
          replaceUrl(chatPath(chats[0]!.id));
          navigate(chatPath(chats[0]!.id));
          return;
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelledRef.cancelled) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const ref = { cancelled: false };
    load(ref);
    return () => {
      ref.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // The wallet often finishes connecting (and current-user.ts resolves the
  // matching account) slightly AFTER this page has already mounted and run
  // its first (anonymous, empty) fetch — without this, the empty state would
  // stick until the user navigated away and back. Re-run the lookup the
  // moment a wallet connects/switches.
  useEffect(() => {
    const ref = { cancelled: false };
    const unsubscribe = subscribeCurrentUser(() => load(ref));
    return () => {
      ref.cancelled = true;
      unsubscribe();
    };
  }, [load]);

  if (loading) {
    return (
      <div className="min-h-screen">
        <SiteHeader />
        <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 pt-14">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{dict.chatsLandingPage.loading}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto flex max-w-md flex-col items-center px-4 pt-[calc(3.5rem+8rem)] text-center sm:px-6">
        <h1 className="font-display text-xl font-bold tracking-tight text-foreground">
          {dict.chatsLandingPage.emptyTitle}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {walletConnected ? dict.chatsLandingPage.emptyBodyConnected : dict.chatsLandingPage.emptyBodyDisconnected}
        </p>
        <Button className="mt-6 gap-1.5" onClick={() => navigate("/")}>
          <MessageSquarePlus className="size-4" />
          {dict.chatsLandingPage.startVault}
        </Button>
      </main>
    </div>
  );
}
