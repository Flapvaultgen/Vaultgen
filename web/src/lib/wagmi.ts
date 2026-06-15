import { http, createConfig } from "wagmi";
import { bsc, bscTestnet } from "wagmi/chains";
import { metaMask } from "wagmi/connectors";

export const wagmiConfig = createConfig({
  chains: [bsc, bscTestnet],
  connectors: [metaMask()],
  transports: {
    [bsc.id]: http(),
    [bscTestnet.id]: http(),
  },
});

export const SUPPORTED_CHAINS = [bsc, bscTestnet] as const;
