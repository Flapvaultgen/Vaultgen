// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @title IMechanicTypes
/// @notice Shared types for the MechanicVault engine — a single meta-factory that
///         runs REAL on-chain mechanics funded by tax BNB:
///           - Buyback & burn (interacts with the Flap bonding curve / DEX)
///           - Survivor (hold-to-survive elimination, verifiable on-chain)
///           - Raffle (holder lottery with periodic draws)
///           - Treasury + creator fee (pull-based)
///
/// @dev Encoded as `vaultData` when launching via VaultPortal.
interface IMechanicTypes {
    /// @notice Engine configuration. All *Bps are taken from each tax deposit
    ///         AFTER the creator fee. buyback+survivor+raffle+treasury must be <= 10_000.
    ///         Any leftover (10_000 - sum) also accrues to treasury.
    struct MechanicConfig {
        string templateName;
        uint16 creatorFeeBps; // 0..1000 (0-10%), taken first from every deposit
        uint16 buybackBps; // → buyback budget (buy token from Portal + burn/lock)
        uint16 survivorBps; // → survivor pot (split among survivors each round)
        uint16 raffleBps; // → raffle prize (paid to a random eligible holder)
        uint16 treasuryBps; // → treasury (creator-withdrawable)
        // Survivor params (ignored if survivorBps == 0)
        uint256 survivorHoldThreshold; // min token balance to survive an elimination
        uint256 survivorRoundDuration; // seconds per survivor round
        // Raffle params (ignored if raffleBps == 0)
        uint256 raffleMinHold; // min token balance to enter the raffle
        uint256 raffleRoundDuration; // seconds per raffle round
    }
}
