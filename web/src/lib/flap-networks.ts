/**
 * Flap protocol addresses per BSC network.
 * Sources: test/FlapBSCFixture.sol + docs.flap.sh deployed-contract-addresses.
 */
import { createPublicClient, http, type Address, type Chain } from "viem";
import { bsc, bscTestnet } from "viem/chains";

export type FlapLaunchNetworkId = 97 | 56;

export type FlapNetworkConfig = {
  chainId: FlapLaunchNetworkId;
  label: string;
  shortLabel: string;
  chain: Chain;
  portal: Address;
  vaultPortal: Address;
  tokenImplTaxedV3: Address;
  flapBase: string;
  explorerBase: string;
  /** localStorage key for this browser's CodegenVaultFactory on this chain */
  factoryStorageKey: string;
};

export const FLAP_BSC_TESTNET: FlapNetworkConfig = {
  chainId: 97,
  label: "BSC testnet",
  shortLabel: "Testnet",
  chain: bscTestnet,
  portal: "0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9",
  vaultPortal: "0x027e3704fC5C16522e9393d04C60A3ac5c0d775f",
  tokenImplTaxedV3: "0xE6Ff967a887084c16D0fD71548CF709542cc1557",
  flapBase: "https://testnet.flap.sh",
  explorerBase: "https://testnet.bscscan.com",
  factoryStorageKey: "flapVaultGen.codegenFactory.bscTestnet",
};

export const FLAP_BSC_MAINNET: FlapNetworkConfig = {
  chainId: 56,
  label: "BSC mainnet",
  shortLabel: "Mainnet",
  chain: bsc,
  portal: "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0",
  vaultPortal: "0x90497450f2a706f1951b5bdda52B4E5d16f34C06",
  tokenImplTaxedV3: "0x024f18294970B5c76c0691b87f138A0317156422",
  flapBase: "https://flap.sh",
  explorerBase: "https://bscscan.com",
  factoryStorageKey: "flapVaultGen.codegenFactory.bscMainnet",
};

export const SUPPORTED_LAUNCH_NETWORKS = [FLAP_BSC_TESTNET, FLAP_BSC_MAINNET] as const;
export const DEFAULT_LAUNCH_NETWORK = FLAP_BSC_TESTNET;

export function isFlapLaunchChainId(chainId: number): chainId is FlapLaunchNetworkId {
  return chainId === 97 || chainId === 56;
}

export function getFlapNetwork(chainId: number): FlapNetworkConfig {
  if (chainId === 56) return FLAP_BSC_MAINNET;
  if (chainId === 97) return FLAP_BSC_TESTNET;
  throw new Error(`Unsupported Flap launch chain ${chainId} — use BSC testnet (97) or mainnet (56).`);
}

export function flapPublicClient(chainId: FlapLaunchNetworkId) {
  const net = getFlapNetwork(chainId);
  return createPublicClient({
    chain: net.chain,
    transport: http(),
  });
}
