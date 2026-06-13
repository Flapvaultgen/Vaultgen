// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {VaultFactoryBaseV2} from "./flap/VaultFactoryBaseV2.sol";
import {IVaultFactoryValidationV2} from "./flap/IVaultFactory.sol";
import {VaultDataSchema, FieldDescriptor} from "./flap/IVaultSchemasV1.sol";

/// @title CodegenVaultFactory
/// @notice Meta-factory for AI-generated ("codegen") vaults.
///
/// @dev  HOW IT WORKS
///       Each launch carries the *creation bytecode* of a bespoke vault contract in
///       `vaultData`. At launch time VaultPortal calls `newVault(...)`, and this factory
///       appends the standard constructor arguments `(taxToken, creator, address(this))`
///       to that bytecode and deploys it with CREATE2.
///
///       The generated vault MUST have the constructor signature:
///           constructor(address taxToken, address creator, address factory)
///       and MUST inherit Flap's VaultBaseV2 (so VaultPortal can interact with it).
///
///       ── SECURITY MODEL (read this) ─────────────────────────────────────────────
///       This factory deploys ARBITRARY user-supplied bytecode. The blast radius is
///       limited to the launching token's own vault (it cannot touch other vaults or the
///       protocol), but the code is UNAUDITED by definition. This factory is intended for
///       TESTNET and for flows where each generated vault is independently audited before a
///       mainnet launch. Do not treat a codegen vault as safe just because it deployed.
contract CodegenVaultFactory is VaultFactoryBaseV2 {
    /// @notice Max allowed creation-bytecode size (defensive cap; EIP-170 caps runtime at 24576).
    uint256 public constant MAX_INIT_CODE = 49_152;

    event CodegenVaultDeployed(address indexed taxToken, address indexed creator, address vault, uint256 initCodeSize);

    error EmptyInitCode();
    error InitCodeTooLarge(uint256 size);
    error DeployFailed();

    function newVault(address taxToken, address, address creator, bytes calldata vaultData)
        external
        override
        returns (address vault)
    {
        require(msg.sender == _getVaultPortal(), "Only VaultPortal");
        if (vaultData.length == 0) revert EmptyInitCode();
        if (vaultData.length > MAX_INIT_CODE) revert InitCodeTooLarge(vaultData.length);

        // initCode = creationBytecode ++ abi.encode(taxToken, creator, address(this))
        bytes memory initCode = abi.encodePacked(vaultData, abi.encode(taxToken, creator, address(this)));
        bytes32 salt = keccak256(abi.encodePacked(taxToken, creator));

        assembly {
            vault := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (vault == address(0)) revert DeployFailed();

        emit CodegenVaultDeployed(taxToken, creator, vault, vaultData.length);
    }

    function isQuoteTokenSupported(address quoteToken) external pure override returns (bool supported) {
        supported = quoteToken == address(0); // native BNB only
    }

    function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
        internal
        pure
        override
        returns (bool success, string memory reason)
    {
        if (data.quoteToken != address(0)) {
            return (false, "Codegen vaults support native BNB only.");
        }
        return (true, "");
    }

    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description =
            unicode"CodegenVaultFactory — deploys an AI-generated vault. vaultData is the contract creation bytecode produced by Origin Vault AI Studio. UNAUDITED generated code: testnet / audit-gated.";
        schema.fields = new FieldDescriptor[](1);
        schema.fields[0] = FieldDescriptor("creationCode", "bytes", "Compiled creation bytecode of the generated vault", 0);
        schema.isArray = false;
    }
}
