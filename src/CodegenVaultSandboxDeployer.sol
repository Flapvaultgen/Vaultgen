// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {SandboxTaxToken} from "./SandboxTaxToken.sol";

/// @title CodegenVaultSandboxDeployer
/// @notice Permissionless testnet helper — deploys AI-generated vault bytecode without a token launch.
/// @dev Mirrors CodegenVaultFactory initCode wiring:
///        initCode = creationBytecode ++ abi.encode(taxToken, creator, address(this))
///      Use this for studio sandbox deploys. Production launches still go through CodegenVaultFactory + VaultPortal.
contract CodegenVaultSandboxDeployer {
    uint256 public constant MAX_INIT_CODE = 49_152;

    event SandboxVaultDeployed(
        address indexed vault, address indexed creator, address indexed taxToken, uint256 initCodeSize
    );

    error EmptyInitCode();
    error InitCodeTooLarge(uint256 size);
    error DeployFailed();

    /// @notice Deploy generated vault creation bytecode to testnet for sandbox testing.
    /// @param creationCode Compiled creation bytecode from Flap Vault Gen (constructor args NOT included).
    /// @param taxToken Pass address(0) to auto-deploy SandboxTaxToken (1M STAX minted to msg.sender).
    /// @return vault Deployed vault address.
    /// @return tokenOut Tax token wired into the vault constructor.
    function deployVault(bytes calldata creationCode, address taxToken)
        external
        returns (address vault, address tokenOut)
    {
        if (creationCode.length == 0) revert EmptyInitCode();
        if (creationCode.length > MAX_INIT_CODE) revert InitCodeTooLarge(creationCode.length);

        tokenOut = taxToken;
        if (tokenOut == address(0)) {
            tokenOut = address(new SandboxTaxToken(msg.sender));
        }

        bytes memory initCode =
            abi.encodePacked(creationCode, abi.encode(tokenOut, msg.sender, address(this)));

        assembly {
            vault := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (vault == address(0)) revert DeployFailed();

        emit SandboxVaultDeployed(vault, msg.sender, tokenOut, creationCode.length);
    }
}
