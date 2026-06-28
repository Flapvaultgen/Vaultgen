export type StudioConfig = {
  factoryAddress?: string;
  sandboxDeployer?: string;
  productName?: string;
  flapLaunch?: string;
  apiUrl?: string;
  bscTestnetExplorer?: string;
  bscTestnetFaucet?: string;
  flapTestnet?: string;
};

let cached: StudioConfig | null = null;

export async function loadStudioConfig(): Promise<StudioConfig> {
  if (cached) return cached;
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) {
      cached = (await res.json()) as StudioConfig;
      return cached;
    }
  } catch {
    /* ignore */
  }
  cached = {};
  return cached;
}

export function getSandboxDeployerAddress(config: StudioConfig): `0x${string}` | null {
  const raw = (config.sandboxDeployer ?? import.meta.env.VITE_SANDBOX_DEPLOYER ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
  return raw as `0x${string}`;
}

export function explorerAddressUrl(explorerBase: string | undefined, address: string): string {
  const base = (explorerBase ?? "https://testnet.bscscan.com").replace(/\/$/, "");
  return `${base}/address/${address}`;
}

export function explorerTxUrl(explorerBase: string | undefined, hash: string): string {
  const base = (explorerBase ?? "https://testnet.bscscan.com").replace(/\/$/, "");
  return `${base}/tx/${hash}`;
}
