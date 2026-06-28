// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {CodegenVaultSandboxDeployer} from "../src/CodegenVaultSandboxDeployer.sol";
import {SandboxTaxToken} from "../src/SandboxTaxToken.sol";
import {VaultBaseV2} from "../src/flap/VaultBaseV2.sol";
import {VaultUISchema, VaultMethodSchema} from "../src/flap/IVaultSchemasV1.sol";

contract SampleSandboxVault is VaultBaseV2 {
    address public taxToken;
    address public creator;
    address public factory;
    uint256 public totalReceived;

    constructor(address _taxToken, address _creator, address _factory) {
        taxToken = _taxToken;
        creator = _creator;
        factory = _factory;
    }

    receive() external payable {
        totalReceived += msg.value;
    }

    function description() public view override returns (string memory) {
        return "Sample sandbox vault";
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "SampleSandboxVault";
        schema.description = "Sandbox test vault";
        schema.methods = new VaultMethodSchema[](0);
    }
}

contract CodegenVaultSandboxDeployerTest is Test {
    CodegenVaultSandboxDeployer deployer;
    address user = address(0xBEEF);

    function setUp() public {
        deployer = new CodegenVaultSandboxDeployer();
    }

    function test_deployWithMockToken() public {
        bytes memory creationCode = type(SampleSandboxVault).creationCode;
        vm.prank(user);
        (address vault, address token) = deployer.deployVault(creationCode, address(0));

        assertTrue(vault != address(0), "vault");
        assertTrue(token != address(0), "token");
        assertEq(SampleSandboxVault(payable(vault)).taxToken(), token);
        assertEq(SampleSandboxVault(payable(vault)).creator(), user);
        assertEq(SampleSandboxVault(payable(vault)).factory(), address(deployer));
        assertEq(SandboxTaxToken(token).balanceOf(user), 1_000_000 * 1e18);
    }

    function test_deployWithProvidedToken() public {
        address token = address(0xA11CE);
        bytes memory creationCode = type(SampleSandboxVault).creationCode;
        vm.prank(user);
        (address vault, address outToken) = deployer.deployVault(creationCode, token);
        assertEq(vault != address(0), true);
        assertEq(outToken, token);
        assertEq(SampleSandboxVault(payable(vault)).taxToken(), token);
    }

    function test_receiveFundsVault() public {
        bytes memory creationCode = type(SampleSandboxVault).creationCode;
        vm.prank(user);
        (address vault,) = deployer.deployVault(creationCode, address(0));

        vm.deal(address(this), 1 ether);
        (bool ok,) = payable(vault).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(SampleSandboxVault(payable(vault)).totalReceived(), 0.5 ether);
    }

    function test_emptyInitCodeReverts() public {
        vm.prank(user);
        vm.expectRevert(CodegenVaultSandboxDeployer.EmptyInitCode.selector);
        deployer.deployVault("", address(0));
    }
}
