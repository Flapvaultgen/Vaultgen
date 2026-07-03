// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {VaultFactoryBaseV2} from "./flap/VaultFactoryBaseV2.sol";
import {IVaultFactoryValidationV2} from "./flap/IVaultFactory.sol";
import {VaultDataSchema, FieldDescriptor} from "./flap/IVaultSchemasV1.sol";
import {BytecodeStorage} from "./BytecodeStorage.sol";

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
    event VaultRegistered(address indexed launcher, string vaultDescription, uint256 creationCodeSize);

    error EmptyInitCode();
    error InitCodeTooLarge(uint256 size);
    error DeployFailed();
    error NotRegistered();

    /// @dev Launcher wallet → vault creation bytecode (stored via BytecodeStorage — see that
    ///      file for why plain SSTORE won't fit under public RPCs' ~16.7M gas send cap) +
    ///      human description (shown on Flap schema load).
    mapping(address => address[]) private _registeredCreationCodePointers;
    mapping(address => string) private _registeredDescription;

    /// @notice Register vault bytecode before launching on flap.sh (empty vaultData schema on Flap).
    function registerVault(bytes calldata creationCode, string calldata vaultDescription) external {
        if (creationCode.length == 0) revert EmptyInitCode();
        if (creationCode.length > MAX_INIT_CODE) revert InitCodeTooLarge(creationCode.length);
        delete _registeredCreationCodePointers[msg.sender];
        _registeredCreationCodePointers[msg.sender] = BytecodeStorage.write(creationCode);
        _registeredDescription[msg.sender] = vaultDescription;
        emit VaultRegistered(msg.sender, vaultDescription, creationCode.length);
    }

    function registeredVaultDescription(address launcher) external view returns (string memory) {
        return _registeredDescription[launcher];
    }

    function hasRegisteredBytecode(address launcher) external view returns (bool) {
        return _registeredCreationCodePointers[launcher].length > 0;
    }

    function newVault(address taxToken, address, address creator, bytes calldata vaultData)
        external
        override
        returns (address vault)
    {
        require(msg.sender == _getVaultPortal(), "Only VaultPortal");

        bytes memory creationCode;
        if (vaultData.length > 0) {
            creationCode = _parseCreationCode(vaultData);
        } else {
            address[] memory pointers = _registeredCreationCodePointers[creator];
            if (pointers.length == 0) revert NotRegistered();
            creationCode = BytecodeStorage.read(pointers);
            delete _registeredCreationCodePointers[creator];
            delete _registeredDescription[creator];
        }

        if (creationCode.length == 0) revert EmptyInitCode();
        if (creationCode.length > MAX_INIT_CODE) revert InitCodeTooLarge(creationCode.length);

        // initCode = creationBytecode ++ abi.encode(taxToken, creator, address(this))
        bytes memory initCode = abi.encodePacked(creationCode, abi.encode(taxToken, creator, address(this)));
        bytes32 salt = keccak256(abi.encodePacked(taxToken, creator));

        assembly {
            vault := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (vault == address(0)) revert DeployFailed();

        emit CodegenVaultDeployed(taxToken, creator, vault, creationCode.length);
    }

    /// @dev Flap UI ABI-encodes the single `creationCode` schema field as `abi.encode(bytes)`.
    ///      Raw creation bytecode is still accepted for direct portal/tests.
    function _parseCreationCode(bytes calldata vaultData) internal pure returns (bytes memory creationCode) {
        if (vaultData.length == 0) return vaultData;

        if (_looksAbiEncodedBytes(vaultData)) {
            return abi.decode(vaultData, (bytes));
        }

        return vaultData;
    }

    function _looksAbiEncodedBytes(bytes calldata data) internal pure returns (bool) {
        if (data.length < 64) return false;

        uint256 offset;
        uint256 len;
        assembly {
            offset := calldataload(data.offset)
            len := calldataload(add(data.offset, 32))
        }

        if (offset != 32 || len == 0) return false;

        uint256 padded = ((len + 31) / 32) * 32;
        return data.length == 64 + padded;
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

    function vaultDataSchema() public view override returns (VaultDataSchema memory schema) {
        string memory desc = _registeredDescription[msg.sender];
        if (bytes(desc).length > 0) {
            schema.description = desc;
        } else {
            schema.description =
                unicode"Custom tax vault — register your vault on-chain first, then launch with token name and tax only. UNAUDITED: testnet.";
        }
        schema.fields = new FieldDescriptor[](0);
        schema.isArray = false;
    }
}
