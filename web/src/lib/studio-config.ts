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

/** Explicit deploy-time override only (config.json / VITE_FACTORY_ADDRESS) — never localStorage. */
export function getConfiguredFactoryAddress(config: StudioConfig): `0x${string}` | null {
  const fromConfig = (config.factoryAddress ?? import.meta.env.VITE_FACTORY_ADDRESS ?? "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(fromConfig) ? (fromConfig as `0x${string}`) : null;
}

/** This browser's locally cached factory address only — never the config override. */
export function getCachedFactoryAddress(): `0x${string}` | null {
  if (typeof localStorage === "undefined") return null;
  const fromLs = (localStorage.getItem("flapVaultGen.codegenFactory.bscTestnet") ?? "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(fromLs) ? (fromLs as `0x${string}`) : null;
}

/**
 * @deprecated Collapses config override and local cache into one priority order with no way
 * to slot the database in between them. Use getConfiguredFactoryAddress (highest priority) and
 * getCachedFactoryAddress (lowest priority, same-browser-only fallback) directly instead, with
 * the database's persisted factory address checked in between.
 */
export function getCodegenFactoryAddress(config: StudioConfig): `0x${string}` | null {
  return getConfiguredFactoryAddress(config) ?? getCachedFactoryAddress();
}

export function saveCodegenFactoryAddress(address: `0x${string}`, artifactFingerprint: string): void {
  localStorage.setItem("flapVaultGen.codegenFactory.bscTestnet", address);
  localStorage.setItem("flapVaultGen.codegenFactory.artifactFp", artifactFingerprint);
}

export function getStoredFactoryArtifactFingerprint(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem("flapVaultGen.codegenFactory.artifactFp");
}

export function clearCodegenFactoryAddress(): void {
  localStorage.removeItem("flapVaultGen.codegenFactory.bscTestnet");
  localStorage.removeItem("flapVaultGen.codegenFactory.artifactFp");
}

export function saveVaultBytecode(contractName: string, bytecode: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(`flapVaultGen.vaultBytecode.${contractName}`, bytecode);
}

export function loadVaultBytecode(contractName: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(`flapVaultGen.vaultBytecode.${contractName}`);
}

export type LaunchedTokenRecord = {
  tokenAddress: string;
  vaultAddress: string;
  factoryAddress: string;
  txHash: string;
  name: string;
  symbol: string;
  launchedAt: string;
};

/** Keyed by contract name + launcher wallet: this browser may test several vaults/wallets. */
function launchedTokenKey(contractName: string, launcherAddress: string): string {
  return `flapVaultGen.launchedToken.${contractName}.${launcherAddress.toLowerCase()}`;
}

export function saveLaunchedToken(contractName: string, launcherAddress: string, record: LaunchedTokenRecord): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(launchedTokenKey(contractName, launcherAddress), JSON.stringify(record));
}

export function loadLaunchedToken(contractName: string, launcherAddress: string): LaunchedTokenRecord | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(launchedTokenKey(contractName, launcherAddress));
    return raw ? (JSON.parse(raw) as LaunchedTokenRecord) : null;
  } catch {
    return null;
  }
}

export function factoryArtifactFingerprint(creationCode: string): string {
  return `${(creationCode.length - 2) / 2}:${creationCode.slice(-14)}`;
}

/** @deprecated sandbox path — use getCodegenFactoryAddress for Flap launch */
export function getSandboxDeployerAddress(config: StudioConfig): `0x${string}` | null {
  const raw = (config.sandboxDeployer ?? import.meta.env.VITE_SANDBOX_DEPLOYER ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
  return raw as `0x${string}`;
}

export function explorerAddressUrl(explorerBase: string | undefined, address: string): string {
  const base = (explorerBase ?? "https://testnet.bscscan.com").replace(/\/$/, "");
  return `${base}/address/${address}`;
}

export function flapNewLaunchUrl(base: string | undefined): string {
  const root = (base ?? "https://testnet.flap.sh").replace(/\/$/, "");
  return root.includes("/launch") ? root.split("?")[0]! : `${root}/launch`;
}

/** @deprecated Prefer flapNewLaunchUrl — vaultfactory= restores Flap's last launch session. */
export function flapLaunchUrl(base: string | undefined, factoryAddress: string): string {
  const root = (base ?? "https://testnet.flap.sh").replace(/\/$/, "");
  const launch = root.includes("/launch") ? root : `${root}/launch`;
  if (!factoryAddress) return launch;
  const sep = launch.includes("?") ? "&" : "?";
  return `${launch}${sep}vaultfactory=${factoryAddress}`;
}

export function flapTaxTokenUrl(base: string | undefined, token: string): string {
  const root = (base ?? "https://testnet.flap.sh").replace(/\/$/, "");
  return `${root}/tax/${token}`;
}

export function explorerTxUrl(explorerBase: string | undefined, hash: string): string {
  const base = (explorerBase ?? "https://testnet.bscscan.com").replace(/\/$/, "");
  return `${base}/tx/${hash}`;
}

export function chainLabel(chainId: number): string {
  if (chainId === 97) return "BSC testnet";
  if (chainId === 56) return "BSC mainnet";
  return `Chain ${chainId}`;
}
