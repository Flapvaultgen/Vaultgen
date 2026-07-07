import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, ImageOff, Loader2 } from "lucide-react";
import { useAccount } from "wagmi";
import SiteHeader from "./components/SiteHeader";
import { getChatConfig } from "./lib/chat-api";
import { chainLabel } from "./lib/studio-config";
import { navigate } from "./lib/router";
import { listLaunchedTokens, type LaunchedTokenRecord } from "./lib/tokens-api";
import { useI18n } from "./lib/i18n/context";
import type { Dictionary } from "./lib/i18n/types";

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function TokenAvatar({ token }: { token: LaunchedTokenRecord }) {
  const imageDataUrl = typeof token.metadata?.imageDataUrl === "string" ? token.metadata.imageDataUrl : null;
  if (imageDataUrl) {
    return (
      <img
        src={imageDataUrl}
        alt={`${token.tokenSymbol} icon`}
        className="size-12 shrink-0 rounded-full border border-border/60 object-cover"
      />
    );
  }
  const initial = token.tokenSymbol?.[0]?.toUpperCase() ?? "?";
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-full border border-border/60 bg-gradient-to-br from-primary/25 to-primary/5 font-display text-lg font-semibold text-primary">
      {initial || <ImageOff className="size-4 text-muted-foreground" />}
    </div>
  );
}

function TokenListRow({ token, dict }: { token: LaunchedTokenRecord; dict: Dictionary }) {
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/tokens/${token.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") navigate(`/tokens/${token.id}`);
      }}
      className="group cursor-pointer rounded-xl border border-border bg-secondary/20 p-4 transition-colors hover:border-primary/40 hover:bg-secondary/30"
    >
      <div className="flex items-center gap-3">
        <TokenAvatar token={token} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-medium text-foreground">{token.tokenName}</h2>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">({token.tokenSymbol})</span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{chainLabel(token.chainId)}</span>
            <span>· {new Date(token.createdAt).toLocaleDateString()}</span>
          </p>
          {(token.tokenAddress || token.vaultAddress) && (
            <p className="mt-1 truncate font-mono text-[0.65rem] text-muted-foreground">
              {token.tokenAddress ? shortAddress(token.tokenAddress) : dict.tokensPage.noTokenAddress}
              {token.vaultAddress ? ` · ${dict.tokensPage.vaultPrefix} ${shortAddress(token.vaultAddress)}` : ""}
            </p>
          )}
        </div>

        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </div>
    </article>
  );
}

export default function TokensPage() {
  const { address } = useAccount();
  const { dict } = useI18n();

  const [storage, setStorage] = useState<"supabase" | "memory" | "unknown">("unknown");
  const [tokens, setTokens] = useState<LaunchedTokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [chatCfg, rows] = await Promise.all([
        getChatConfig().catch(() => ({ supabaseConfigured: false, storage: "memory" as const })),
        listLaunchedTokens(address ? { walletAddress: address } : undefined),
      ]);
      setStorage(chatCfg.storage);
      // The public tokens page is for finished launches only — registered-but-not-yet-launched
      // or failed attempts aren't ready to show off and would just confuse visitors.
      setTokens(rows.filter((row) => row.status === "launched"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tokens.");
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="container max-w-3xl px-4 py-8 pt-[calc(3.5rem+1rem)] sm:px-6 lg:px-8">
        <div className="space-y-1">
          <h1 className="font-display text-xl font-bold tracking-tight">{dict.tokensPage.title}</h1>
          <p className="text-sm text-muted-foreground">{dict.tokensPage.subtitle}</p>
        </div>

        {storage === "memory" && (
          <p className="mt-4 inline-flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {dict.tokensPage.memoryWarning}
          </p>
        )}

        {loading && (
          <p className="mt-8 inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {dict.tokensPage.loading}
          </p>
        )}

        {error && !loading && <p className="mt-8 text-destructive">{error}</p>}

        {!loading && !error && tokens.length === 0 && (
          <p className="mt-8 text-muted-foreground">
            {address ? dict.tokensPage.emptyWithWallet : dict.tokensPage.emptyNoWallet}
          </p>
        )}

        <div className="mt-6 space-y-4">
          {tokens.map((token) => (
            <TokenListRow key={token.id} token={token} dict={dict} />
          ))}
        </div>
      </main>
    </div>
  );
}
