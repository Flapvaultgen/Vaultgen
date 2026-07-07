/** BSC testnet Flap protocol addresses (from testnet.flap.sh chain config). */
export const FLAP_BSC_TESTNET = {
  chainId: 97,
  portal: "0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9" as const,
  vaultPortal: "0x027e3704fC5C16522e9393d04C60A3ac5c0d775f" as const,
  tokenImplTaxedV3: "0xE6Ff967a887084c16D0fD71548CF709542cc1557" as const,
} as const;

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
