// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {CodegenVaultFactory} from "../src/CodegenVaultFactory.sol";
import {VaultBaseV2} from "../src/flap/VaultBaseV2.sol";
import {VaultUISchema, VaultMethodSchema, FieldDescriptor} from "../src/flap/IVaultSchemasV1.sol";

/// @dev A representative "AI-generated" vault: cheap receive() accounting + pull withdrawal.
///      Constructor matches the codegen ABI: (taxToken, creator, factory).
contract SampleCodegenVault is VaultBaseV2 {
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

    function withdraw() external {
        require(msg.sender == creator || msg.sender == _getGuardian(), "Not authorized");
        (bool ok,) = payable(creator).call{value: address(this).balance}("");
        require(ok, "transfer failed");
    }

    function description() public view override returns (string memory) {
        return "Sample codegen vault";
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "SampleCodegenVault";
        schema.description = "Accumulates tax BNB; creator withdraws.";
        schema.methods = new VaultMethodSchema[](1);
        schema.methods[0].name = "withdraw";
        schema.methods[0].description = "Withdraw full balance (creator/Guardian).";
        schema.methods[0].isWriteMethod = true;
    }
}

contract CodegenVaultFactoryTest is Test {
    // BNB testnet addresses (from VaultFactoryBaseV2).
    address constant VAULT_PORTAL_TESTNET = 0x027e3704fC5C16522e9393d04C60A3ac5c0d775f;
    address constant GUARDIAN_TESTNET = 0x76Fa8C526f8Bc27ba6958B76DeEf92a0dbE46950;

    CodegenVaultFactory factory;
    address taxToken = address(0xA11CE);
    address creator = address(0xC0FFEE);

    function setUp() public {
        vm.chainId(97);
        factory = new CodegenVaultFactory();
    }

    function _deploy() internal returns (address vault) {
        bytes memory creationCode = type(SampleCodegenVault).creationCode;
        vm.prank(VAULT_PORTAL_TESTNET);
        vault = factory.newVault(taxToken, address(0), creator, creationCode);
    }

    function test_deploysGeneratedBytecode() public {
        address vault = _deploy();
        assertTrue(vault != address(0), "vault deployed");
        assertEq(SampleCodegenVault(payable(vault)).taxToken(), taxToken, "taxToken wired");
        assertEq(SampleCodegenVault(payable(vault)).creator(), creator, "creator wired");
        assertEq(SampleCodegenVault(payable(vault)).factory(), address(factory), "factory wired");
    }

    function test_receiveAndWithdraw() public {
        address vault = _deploy();

        vm.deal(address(this), 5 ether);
        (bool ok,) = payable(vault).call{value: 2 ether}("");
        assertTrue(ok, "funded");
        assertEq(SampleCodegenVault(payable(vault)).totalReceived(), 2 ether, "accounted");
        assertEq(vault.balance, 2 ether, "held");

        uint256 before = creator.balance;
        vm.prank(creator);
        SampleCodegenVault(payable(vault)).withdraw();
        assertEq(creator.balance - before, 2 ether, "creator withdrew");
    }

    function test_guardianCanWithdraw() public {
        address vault = _deploy();
        vm.deal(address(this), 1 ether);
        payable(vault).call{value: 1 ether}("");

        vm.prank(GUARDIAN_TESTNET);
        SampleCodegenVault(payable(vault)).withdraw(); // pays creator
        assertEq(vault.balance, 0, "drained");
    }

    function test_onlyVaultPortalCanCreate() public {
        bytes memory creationCode = type(SampleCodegenVault).creationCode;
        vm.expectRevert("Only VaultPortal");
        factory.newVault(taxToken, address(0), creator, creationCode);
    }

    function test_emptyInitCodeReverts() public {
        vm.prank(VAULT_PORTAL_TESTNET);
        vm.expectRevert(CodegenVaultFactory.EmptyInitCode.selector);
        factory.newVault(taxToken, address(0), creator, "");
    }

    function test_quoteTokenSupport() public view {
        assertTrue(factory.isQuoteTokenSupported(address(0)), "BNB supported");
        assertFalse(factory.isQuoteTokenSupported(address(0xBEEF)), "ERC20 not supported");
    }
}
