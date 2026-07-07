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
 */

/** Structural subset of GeneratedArtifact (avoids importing chat-api's browser-only module). */
export type VaultStateArtifact = {
  artifactType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type PersistedVaultState = {
  factoryAddress: string | null;
  factoryArtifactFingerprint: string | null;
  creationBytecode: string | null;
  registeredWallet: string | null;
  registeredTxHash: string | null;
  registeredPayloadFingerprint: string | null;
  launched: {
    tokenAddress: string;
    vaultAddress: string;
    factoryAddress: string;
    txHash: string;
    name: string;
    symbol: string;
    launchedAt: string;
  } | null;
};

const EMPTY_VAULT_STATE: PersistedVaultState = {
  factoryAddress: null,
  factoryArtifactFingerprint: null,
  creationBytecode: null,
  registeredWallet: null,
  registeredTxHash: null,
  registeredPayloadFingerprint: null,
  launched: null,
};

/** Folds every launch_status artifact (oldest → newest) into the current vault state. */
export function mergeVaultState<T extends VaultStateArtifact>(artifacts: T[]): PersistedVaultState {
  const events = artifacts
    .filter((a) => a.artifactType === "launch_status")
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const acc: PersistedVaultState = { ...EMPTY_VAULT_STATE };
  for (const a of events) {
    const m = a.metadata;
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
      };
    }
  }
  return acc;
}
