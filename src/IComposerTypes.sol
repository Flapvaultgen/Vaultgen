// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @title IComposerTypes
/// @notice Shared types for the Vault Composer meta-factory.
/// @dev    Encoded as vaultData when launching via VaultPortal.
interface IComposerTypes {
    enum BlockType {
        SPLIT,
        SEND,
        TREASURY,
        CLAIM_POOL
    }

    struct SplitRecipient {
        address recipient;
        uint16 bps;
    }

    struct ComposerBlock {
        BlockType blockType;
        bytes data;
    }

    struct ComposerConfig {
        string templateName;
        uint16 creatorFeeBps;
        ComposerBlock[] blocks;
    }
}
