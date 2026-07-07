import { http, createConfig } from "wagmi";
import { bsc, bscTestnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import type { EIP1193Provider } from "viem";

type EthereumProvider = EIP1193Provider & Record<string, unknown>;

declare global {
  interface Window {
    ethereum?: EthereumProvider & { providers?: EthereumProvider[] };
  }
}

const COMPETITOR_WALLET_FLAGS = [
  "isApexWallet",
  "isAvalanche",
  "isBitKeep",
  "isBlockWallet",
  "isKuCoinWallet",
  "isMathWallet",
  "isOkxWallet",
  "isOKExWallet",
  "isOneInchIOSWallet",
  "isOneInchAndroidWallet",
  "isOpera",
  "isPhantom",
  "isPortal",
  "isRabby",
  "isTokenPocket",
  "isTokenary",
  "isUniswapWallet",
  "isZerion",
] as const;

/** Same heuristics as wagmi's injected targetMap.metaMask — avoids Rabby/OKX false positives. */
export function findMetaMaskProvider(): EthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;

  const isMetaMaskOnly = (provider: EthereumProvider): boolean => {
    if (!provider.isMetaMask) return false;
    // Brave masquerades as MetaMask
    if (provider.isBraveWallet && !provider._events && !provider._state) return false;
    for (const flag of COMPETITOR_WALLET_FLAGS) {
      if (provider[flag]) return false;
    }
    return true;
  };

  const { ethereum } = window;
  if (!ethereum) return undefined;

  if (ethereum.providers?.length) {
    const fromList = ethereum.providers.find(isMetaMaskOnly);
    if (fromList) return fromList;
  }

  if (isMetaMaskOnly(ethereum)) return ethereum;
  return undefined;
}

export const wagmiConfig = createConfig({
  chains: [bsc, bscTestnet],
  multiInjectedProviderDiscovery: true,
  connectors: [
    injected({
      target() {
        const provider = findMetaMaskProvider();
        if (!provider) return undefined;
        return {
          id: "metaMask",
          name: "MetaMask",
          provider,
        };
      },
      shimDisconnect: true,
      unstable_shimAsyncInject: 2_000,
    }),
  ],
  transports: {
    [bsc.id]: http(),
    [bscTestnet.id]: http(),
  },
});

export const SUPPORTED_CHAINS = [bsc, bscTestnet] as const;

export function hasMetaMaskProvider(): boolean {
  return findMetaMaskProvider() !== undefined;
}

/** Prefer explicit MetaMask connector, then EIP-6963 `io.metamask` from wallet discovery. */
export function pickMetaMaskConnector<T extends { id: string; name: string }>(
  connectors: readonly T[]
): T | undefined {
  return (
    connectors.find((c) => c.id === "metaMask") ??
    connectors.find((c) => c.id === "io.metamask") ??
    connectors.find((c) => c.name === "MetaMask")
  );
}
