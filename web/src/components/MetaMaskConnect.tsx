import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";
import { SUPPORTED_CHAINS, hasMetaMaskProvider } from "../lib/wagmi";

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function MetaMaskConnect() {
  const { address, isConnected, isConnecting } = useAccount();
  const { connect, connectors, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const metaMaskConnector = connectors.find((c) => c.id === "metaMask" || c.name === "MetaMask");
  const activeChain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  const busy = isConnecting || isPending || isSwitching;
  const metaMaskInstalled = hasMetaMaskProvider();

  const onConnect = () => {
    if (!metaMaskInstalled) {
      window.open("https://metamask.io/download/", "_blank", "noopener,noreferrer");
      return;
    }
    if (metaMaskConnector) connect({ connector: metaMaskConnector });
  };

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  if (!isConnected) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onConnect}
        >
          {busy ? "Connecting…" : metaMaskInstalled ? "Connect MetaMask" : "Install MetaMask"}
        </Button>
        {connectError && (
          <p className="max-w-xs text-right text-xs text-destructive">
            {connectError.message.split("\n")[0]}
          </p>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
        <span className="size-2 rounded-full bg-success" />
        {truncateAddress(address!)}
        <Badge variant="outline" className="ml-1 hidden px-1.5 py-0 text-[0.65rem] sm:inline-flex">
          {activeChain?.name ?? `Chain ${chainId}`}
        </Badge>
        <ChevronDown className="size-3 opacity-60" />
      </Button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border border-border bg-card shadow-xl">
          <div className="border-b border-border px-3 py-2">
            <p className="truncate font-mono text-xs text-muted-foreground">{address}</p>
          </div>
          <div className="border-b border-border px-3 py-2">
            <p className="mb-1.5 text-xs text-muted-foreground">Network</p>
            <div className="flex flex-col gap-1">
              {SUPPORTED_CHAINS.map((chain) => (
                <button
                  key={chain.id}
                  type="button"
                  disabled={busy || chainId === chain.id}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/60 disabled:opacity-50",
                    chainId === chain.id && "bg-secondary/40 font-medium"
                  )}
                  onClick={() => switchChain({ chainId: chain.id })}
                >
                  {chain.name}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-destructive hover:bg-secondary/60"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
          >
            <LogOut className="size-3.5" />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
