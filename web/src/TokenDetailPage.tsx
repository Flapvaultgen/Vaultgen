import { useEffect, useMemo, useState } from "react";
import { formatEther } from "viem";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Wallet,
} from "lucide-react";
import SiteHeader from "./components/SiteHeader";
import VaultUIPanel from "./components/VaultUIPanel";
import VaultCustomUI from "./components/VaultCustomUI";
import { downloadVaultUiPackage, parseVaultUiArtifact } from "./lib/vault-ui-bridge";
import { flapTestnetPublicClient } from "./lib/flap-factory";
import { Button } from "./components/ui/button";
import {
  chainLabel,
  explorerAddressUrl,
  explorerTxUrl,
  flapTaxTokenUrl,
  loadStudioConfig,
  type StudioConfig,
} from "./lib/studio-config";
import { navigate } from "./lib/router";
import { getLaunchedToken, launchedTokenStatusPresentation, type LaunchedTokenRecord } from "./lib/tokens-api";
import { cn } from "./lib/utils";
import { useI18n } from "./lib/i18n/context";

/** Formats a wei amount as a compact BNB figure, e.g. "0.4213 BNB". */
function formatBnb(wei: bigint | null, maxFraction = 4): string {
  if (wei === null) return "—";
  const value = Number(formatEther(wei));
  return `${value.toLocaleString(undefined, { maximumFractionDigits: maxFraction })} BNB`;
}

type Props = {
  tokenId: string;
};

function formatTax(bps: number | null): string {
  if (bps === null || bps === undefined) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** A truncated, click-to-copy address with an explorer link — friendlier than a raw 42-char hex dump. */
function AddressLink({
  address,
  explorerBase,
  variant = "link",
}: {
  address: string | null;
  explorerBase: string | undefined;
  /** "link" underlines like other links; "plain" is for use inside dense technical rows. */
  variant?: "link" | "plain";
}) {
  const [copied, setCopied] = useState(false);
  const { dict } = useI18n();
  if (!address) return <p className="text-xs text-amber-300">{dict.tokenDetailPage.notAvailableYet}</p>;

  const copy = () => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      <a
        href={explorerAddressUrl(explorerBase, address)}
        target="_blank"
        rel="noreferrer"
        title={address}
        className={variant === "link" ? "text-primary hover:underline" : "text-foreground hover:text-primary"}
      >
        {shortAddress(address)}
      </a>
      <button
        type="button"
        onClick={copy}
        title={dict.tokenDetailPage.copyAddress}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  );
}

export default function TokenDetailPage({ tokenId }: Props) {
  const { dict } = useI18n();
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [token, setToken] = useState<LaunchedTokenRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vaultUiTab, setVaultUiTab] = useState<"custom" | "standard">("custom");
  const [vaultBalanceWei, setVaultBalanceWei] = useState<bigint | null>(null);
  const [vaultBalanceError, setVaultBalanceError] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([loadStudioConfig(), getLaunchedToken(tokenId)])
      .then(([cfg, row]) => {
        if (cancelled) return;
        setConfig(cfg);
        setToken(row);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : dict.tokenDetailPage.loadError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tokenId]);

  // Live native balance of the vault contract — this is the BNB the tax vault
  // has actually raised/collected on-chain, independent of what the app
  // recorded at launch time. Polled so it stays current while the page is open.
  useEffect(() => {
    const vaultAddress = token?.vaultAddress;
    if (!vaultAddress) return;
    let cancelled = false;
    const poll = () => {
      flapTestnetPublicClient
        .getBalance({ address: vaultAddress as `0x${string}` })
        .then((wei) => {
          if (!cancelled) {
            setVaultBalanceWei(wei);
            setVaultBalanceError(false);
          }
        })
        .catch(() => {
          if (!cancelled) setVaultBalanceError(true);
        });
    };
    poll();
    const timer = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token?.vaultAddress]);

  const flapBase = config?.flapTestnet ?? "https://testnet.flap.sh";
  const metaStr = (key: string): string | null => {
    const v = token?.metadata?.[key];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const contractName = typeof token?.metadata?.contractName === "string" ? token.metadata.contractName : null;
  const description = metaStr("description");
  const website = metaStr("website");
  const twitter = metaStr("twitter");
  const telegram = metaStr("telegram");
  const hasAboutInfo = Boolean(description || website || twitter || telegram);
  const uiArtifact = useMemo(() => parseVaultUiArtifact(token?.metadata?.uiArtifact ?? null), [token]);

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="container max-w-4xl px-4 py-8 pt-[calc(3.5rem+1rem)] sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => navigate("/tokens")}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> {dict.tokenDetailPage.backToTokens}
        </button>

        {loading && (
          <p className="mt-8 inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {dict.tokenDetailPage.loading}
          </p>
        )}

        {error && !loading && (
          <p className="mt-8 inline-flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-4 shrink-0" /> {error}
          </p>
        )}

        {token && !loading && !error && (
          <div className="mt-4 space-y-6">
            <div className="flex items-center gap-3">
              {(() => {
                const imageDataUrl =
                  typeof token.metadata?.imageDataUrl === "string" ? token.metadata.imageDataUrl : null;
                return imageDataUrl ? (
                  <img
                    src={imageDataUrl}
                    alt={`${token.tokenSymbol} icon`}
                    className="size-14 shrink-0 rounded-full border border-border/60 object-cover"
                  />
                ) : (
                  <div className="flex size-14 shrink-0 items-center justify-center rounded-full border border-border/60 bg-gradient-to-br from-primary/25 to-primary/5 font-display text-xl font-semibold text-primary">
                    {token.tokenSymbol?.[0]?.toUpperCase() ?? "?"}
                  </div>
                );
              })()}
              <div>
                <h1 className="font-display text-2xl font-bold tracking-tight">
                  {token.tokenName}{" "}
                  <span className="font-mono text-base text-muted-foreground">({token.tokenSymbol})</span>
                </h1>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {chainLabel(token.chainId)} ·{" "}
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 font-medium",
                      launchedTokenStatusPresentation(token.status, dict).className
                    )}
                  >
                    {launchedTokenStatusPresentation(token.status, dict).label}
                  </span>{" "}
                  · {new Date(token.createdAt).toLocaleString()}
                </p>
              </div>
            </div>

            {/* Key stats — the numbers people actually come to this page for. */}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3.5">
                <p className="inline-flex items-center gap-1.5 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                  <Wallet className="size-3" /> {dict.tokenDetailPage.bnbRaised}
                </p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                  {token.vaultAddress ? (
                    vaultBalanceError ? (
                      <span className="text-sm font-normal text-muted-foreground">{dict.tokenDetailPage.unableToLoad}</span>
                    ) : vaultBalanceWei === null ? (
                      <span className="text-sm font-normal text-muted-foreground">{dict.tokenDetailPage.loadingShort}</span>
                    ) : (
                      formatBnb(vaultBalanceWei)
                    )
                  ) : (
                    "—"
                  )}
                </p>
                <p className="mt-0.5 text-[0.65rem] text-muted-foreground">
                  {token.vaultAddress ? dict.tokenDetailPage.bnbRaisedLiveNote : dict.tokenDetailPage.bnbRaisedNotLaunched}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/20 p-3.5">
                <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{dict.tokenDetailPage.buyTax}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{formatTax(token.buyTaxBps)}</p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/20 p-3.5">
                <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{dict.tokenDetailPage.sellTax}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{formatTax(token.sellTaxBps)}</p>
              </div>
            </div>

            {/* Addresses + external links */}
            <div className="rounded-lg border border-border bg-secondary/20 p-4">
              <div className="grid gap-3 text-xs sm:grid-cols-2">
                <div>
                  <p className="text-muted-foreground">{dict.tokenDetailPage.tokenContract}</p>
                  <AddressLink address={token.tokenAddress} explorerBase={config?.bscTestnetExplorer} />
                </div>
                <div>
                  <p className="text-muted-foreground">{dict.tokenDetailPage.vaultContract}</p>
                  <AddressLink address={token.vaultAddress} explorerBase={config?.bscTestnetExplorer} />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-3 border-t border-border/60 pt-4 text-xs">
                {token.launchUrl && (
                  <a
                    href={token.launchUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {dict.tokenDetailPage.viewOnFlap} <ExternalLink className="size-3" />
                  </a>
                )}
                {token.tokenAddress && (
                  <a
                    href={flapTaxTokenUrl(flapBase, token.tokenAddress)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {dict.tokenDetailPage.flapTaxPage} <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            </div>

            {token.vaultAddress && (
              <section>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-display text-sm font-semibold tracking-tight text-foreground">
                    {dict.tokenDetailPage.vaultInformation}
                  </h2>
                  {uiArtifact && (
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant={vaultUiTab === "custom" ? "secondary" : "ghost"}
                        className="h-7 px-2.5 text-xs"
                        onClick={() => setVaultUiTab("custom")}
                      >
                        {dict.tokenDetailPage.customUiTab}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={vaultUiTab === "standard" ? "secondary" : "ghost"}
                        className="h-7 px-2.5 text-xs"
                        onClick={() => setVaultUiTab("standard")}
                      >
                        {dict.tokenDetailPage.standardPanelTab}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2.5 text-xs"
                        onClick={() =>
                          void downloadVaultUiPackage(uiArtifact!, contractName ?? token.tokenSymbol, {
                            factoryAddress: token.factoryAddress,
                            tokenAddress: token.tokenAddress,
                          })
                        }
                        title={dict.tokenDetailPage.developerFilesTitle}
                      >
                        <Download className="size-3" /> {dict.tokenDetailPage.developerFiles}
                      </Button>
                    </div>
                  )}
                </div>
                {uiArtifact && vaultUiTab === "custom" ? (
                  <>
                    <p className="mb-2 text-xs text-muted-foreground">{dict.tokenDetailPage.customUiNote}</p>
                    <VaultCustomUI
                      artifact={uiArtifact}
                      vaultAddress={token.vaultAddress as `0x${string}`}
                      tokenAddress={(token.tokenAddress ?? null) as `0x${string}` | null}
                      factoryAddress={(token.factoryAddress ?? null) as `0x${string}` | null}
                      tokenName={token.tokenName}
                      tokenSymbol={token.tokenSymbol}
                    />
                  </>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-muted-foreground">{dict.tokenDetailPage.standardUiNote}</p>
                    <VaultUIPanel
                      vaultAddress={token.vaultAddress as `0x${string}`}
                      explorerBase={config?.bscTestnetExplorer}
                    />
                  </>
                )}
              </section>
            )}

            {hasAboutInfo && (
              <section>
                <h2 className="mb-2 font-display text-sm font-semibold tracking-tight text-foreground">
                  {dict.tokenDetailPage.about}
                </h2>
                <div className="rounded-lg border border-border bg-secondary/20 p-4 text-xs">
                  {description && <p className="text-foreground">{description}</p>}
                  <div className={cn("flex flex-wrap gap-3", description && "mt-2")}>
                    {website && (
                      <a href={website} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        {dict.tokenDetailPage.website}
                      </a>
                    )}
                    {twitter && (
                      <a
                        href={twitter.startsWith("http") ? twitter : `https://x.com/${twitter.replace(/^@/, "")}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {dict.tokenDetailPage.twitter}
                      </a>
                    )}
                    {telegram && (
                      <a
                        href={telegram.startsWith("http") ? telegram : `https://t.me/${telegram.replace(/^@/, "")}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {dict.tokenDetailPage.telegram}
                      </a>
                    )}
                  </div>
                </div>
              </section>
            )}

            {/* Technical details — collapsed by default so the page stays approachable;
                everything here is still just the on-chain addresses and tx hashes for
                anyone who wants to verify things themselves. */}
            <section>
              <button
                type="button"
                onClick={() => setShowTechnical((v) => !v)}
                className="flex w-full items-center justify-between rounded-lg border border-border bg-secondary/20 px-4 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {dict.tokenDetailPage.technicalDetails}
                {showTechnical ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              </button>
              {showTechnical && (
                <div className="mt-2 rounded-lg border border-border bg-secondary/20 p-4 text-xs">
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">{dict.tokenDetailPage.launchTransaction}</dt>
                      <dd>
                        {token.launchTxHash ? (
                          <a
                            href={explorerTxUrl(config?.bscTestnetExplorer, token.launchTxHash)}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-primary hover:underline"
                          >
                            {shortAddress(token.launchTxHash)}
                          </a>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{dict.tokenDetailPage.registrationTransaction}</dt>
                      <dd>
                        {token.registerTxHash ? (
                          <a
                            href={explorerTxUrl(config?.bscTestnetExplorer, token.registerTxHash)}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-primary hover:underline"
                          >
                            {shortAddress(token.registerTxHash)}
                          </a>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{dict.tokenDetailPage.launchedByWallet}</dt>
                      <dd>
                        <AddressLink address={token.walletAddress} explorerBase={config?.bscTestnetExplorer} variant="plain" />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{dict.tokenDetailPage.factoryContract}</dt>
                      <dd>
                        <AddressLink address={token.factoryAddress} explorerBase={config?.bscTestnetExplorer} variant="plain" />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{dict.tokenDetailPage.flapPortalContract}</dt>
                      <dd>
                        <AddressLink
                          address={token.launchContractAddress}
                          explorerBase={config?.bscTestnetExplorer}
                          variant="plain"
                        />
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 border-t border-border/60 pt-3 text-muted-foreground">
                    {dict.tokenDetailPage.routingNote.replace("{name}", contractName ? ` (${contractName})` : "")}
                  </p>
                </div>
              )}
            </section>

            <Button type="button" variant="outline" size="sm" onClick={() => navigate("/tokens")} className="gap-1.5">
              <ArrowLeft className="size-3.5" /> {dict.tokenDetailPage.backToAllTokens}
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
