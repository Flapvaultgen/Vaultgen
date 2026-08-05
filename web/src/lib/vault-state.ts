/**
 * Pure fold of "launch_status" chat artifacts into the current factory /
 * register / launch picture for a vault. No fetch/window/import.meta.env
 * imports here so deterministic selfchecks can run this in plain Node,
 * mirroring register-validation.ts.
 *
 * This — not localStorage — is the database source of truth: reopening a
 * chat on any device/browser recovers the same factory address, registered
 * creation bytecode, register tx, and launched token by replaying every
 * launch_status event ever saved for it.
 *
 * Events are scoped by chainId (97 testnet / 56 mainnet). Legacy events
 * without chainId are treated as BSC testnet (97).
 */

/** Structural subset of GeneratedArtifact (avoids importing chat-api's browser-only module). */
export type VaultStateArtifact = {
  artifactType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type PersistedLaunchedToken = {
  tokenAddress: string;
  vaultAddress: string;
  factoryAddress: string;
  txHash: string;
  name: string;
  symbol: string;
  launchedAt: string;
  chainId: number;
};

export type PersistedVaultState = {
  factoryAddress: string | null;
  factoryArtifactFingerprint: string | null;
  creationBytecode: string | null;
  registeredWallet: string | null;
  registeredTxHash: string | null;
  registeredPayloadFingerprint: string | null;
  /** Chain this snapshot was folded for (null when empty / no chain filter). */
  chainId: number | null;
  launched: PersistedLaunchedToken | null;
};

const EMPTY_VAULT_STATE: PersistedVaultState = {
  factoryAddress: null,
  factoryArtifactFingerprint: null,
  creationBytecode: null,
  registeredWallet: null,
  registeredTxHash: null,
  registeredPayloadFingerprint: null,
  chainId: null,
  launched: null,
};

/** Legacy launch_status rows omit chainId — those were always BSC testnet. */
export function eventChainId(metadata: Record<string, unknown>): number {
  const raw = metadata.chainId;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return 97;
}

/**
 * Folds every launch_status artifact (oldest → newest) into the current vault state.
 * When `chainId` is set, only events for that chain are applied so a testnet
 * launch never masquerades as a mainnet one (and vice versa).
 */
export function mergeVaultState<T extends VaultStateArtifact>(
  artifacts: T[],
  chainId?: number | null
): PersistedVaultState {
  const events = artifacts
    .filter((a) => a.artifactType === "launch_status")
    .filter((a) => (chainId === undefined || chainId === null ? true : eventChainId(a.metadata) === chainId))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const acc: PersistedVaultState = {
    ...EMPTY_VAULT_STATE,
    chainId: chainId === undefined || chainId === null ? null : chainId,
  };
  for (const a of events) {
    const m = a.metadata;
    const eventChain = eventChainId(m);
    if (m.status === "factory_cleared") {
      // Explicit "forget this factory" event (the "Clear saved" button) — must
      // win over any earlier factory_deployed event, which is why this is
      // handled first and `continue`s rather than falling through to the
      // generic factoryAddress merge below.
      acc.factoryAddress = null;
      acc.factoryArtifactFingerprint = null;
      continue;
    }
    if (typeof m.factoryAddress === "string") acc.factoryAddress = m.factoryAddress;
    if (typeof m.factoryArtifactFingerprint === "string") acc.factoryArtifactFingerprint = m.factoryArtifactFingerprint;
    if (typeof m.creationBytecode === "string") acc.creationBytecode = m.creationBytecode;
    if (m.status === "registered") {
      if (typeof m.wallet === "string") acc.registeredWallet = m.wallet;
      if (typeof m.registerTxHash === "string") acc.registeredTxHash = m.registerTxHash;
      if (typeof m.registeredPayloadFingerprint === "string") {
        acc.registeredPayloadFingerprint = m.registeredPayloadFingerprint;
      }
    }
    if (
      m.status === "launched" &&
      typeof m.tokenAddress === "string" &&
      typeof m.vaultAddress === "string" &&
      typeof m.txHash === "string"
    ) {
      acc.launched = {
        tokenAddress: m.tokenAddress,
        vaultAddress: m.vaultAddress,
        factoryAddress: typeof m.factoryAddress === "string" ? m.factoryAddress : "",
        txHash: m.txHash,
        name: typeof m.name === "string" ? m.name : "",
        symbol: typeof m.symbol === "string" ? m.symbol : "",
        launchedAt: typeof m.launchedAt === "string" ? m.launchedAt : a.createdAt,
        chainId: eventChain,
      };
    }
  }
  return acc;
}
