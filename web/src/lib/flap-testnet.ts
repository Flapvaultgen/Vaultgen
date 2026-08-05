/**
 * Backward-compatible re-exports. Prefer `flap-networks.ts` for new code.
 */
export { FLAP_BSC_TESTNET, FLAP_BSC_MAINNET, DEFAULT_LAUNCH_NETWORK } from "./flap-networks";

/** Matches FlapBSCFixture defaults for V3 tax tokens. */
export const FLAP_LAUNCH_DEFAULTS = {
  dexThresh: 1, // DexThreshType.FOUR_FIFTHS
  migratorType: 1, // MigratorType.V2_MIGRATOR
  dexId: 0, // DEXId.DEX0
  lpFeeProfile: 0, // V3LPFeeProfile.LP_FEE_PROFILE_STANDARD
  tokenVersion: 6, // TokenVersion.TOKEN_TAXED_V3
  taxDuration: BigInt(100 * 365 * 86400),
  antiFarmerDuration: BigInt(86400),
  mktBps: 10_000,
  deflationBps: 0,
  dividendBps: 0,
  lpBps: 0,
  minimumShareBalance: 0n,
  quoteAmt: 0n,
  maxOpGas: 10_000_000n,
} as const;
