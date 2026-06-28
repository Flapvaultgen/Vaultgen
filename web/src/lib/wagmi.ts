import { http, createConfig } from "wagmi";
import { bsc, bscTestnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const wagmiConfig = createConfig({
  chains: [bsc, bscTestnet],
  connectors: [
    injected({
      target: "metaMask",
      shimDisconnect: true,
    }),
  ],
  transports: {
    [bsc.id]: http(),
    [bscTestnet.id]: http(),
  },
});

export const SUPPORTED_CHAINS = [bsc, bscTestnet] as const;

export function hasMetaMaskProvider(): boolean {
  if (typeof window === "undefined") return false;
  const eth = (window as Window & { ethereum?: { isMetaMask?: boolean } }).ethereum;
  return Boolean(eth?.isMetaMask);
}
