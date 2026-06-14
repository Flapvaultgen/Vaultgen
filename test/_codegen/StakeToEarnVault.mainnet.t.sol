// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

// forge test --match-path test/_codegen/StakeToEarnVault.mainnet.t.sol -vvv --fork-url https://bsc-dataseed.bnbchain.org

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

import {FlapBSCFixture} from "../FlapBSCFixture.sol";
import {CodegenVaultFactory} from "../../src/CodegenVaultFactory.sol";
import {IVaultPortalTypes} from "../../src/flap/IVaultPortal.sol";
import {IFlapTaxTokenV3} from "../../src/flap/IFlapTaxTokenV3.sol";
import {ITaxProcessor} from "../../src/flap/ITaxProcessor.sol";

contract StakeToEarnVaultMainnetTest is FlapBSCFixture {
    CodegenVaultFactory public factory;
    address public vault;
    address public token;
    address public taxProcessorAddr;

    address public user1 = address(0x7777777777777777777777777777777777771001);
    address public creator = address(0x7777777777777777777777777777777777771004);

    function setUp() public {
        _forkBSCMainnet();

        vm.deal(creator, 100 ether);
        vm.deal(user1, 20 ether);

        vm.startPrank(creator);
        factory = new CodegenVaultFactory();
        vm.label(address(factory), "StakeToEarnVaultFactory");
        vm.stopPrank();

        bytes memory creationCode = vm.readFileBinary(string.concat("test/_codegen/", "StakeToEarnVault.bin"));
        bytes memory vaultData = creationCode;

        IVaultPortalTypes.NewTokenV6WithVaultParams memory params =
            _buildV3TaxTokenParams("Stake To Earn", "STE", bytes32(0), address(factory), vaultData);

        params.buyTaxRate = 500;
        params.sellTaxRate = 500;
        params.mktBps = 10000;
        params.deflationBps = 0;
        params.dividendBps = 0;
        params.lpBps = 0;

        vm.startPrank(creator);
        token = vaultPortal.newTokenV6WithVault{value: params.quoteAmt, gas: MAX_OP_GAS}(params);
        vm.stopPrank();

        IVaultPortalTypes.VaultInfo memory info = vaultPortal.getVault(token);
        vault = info.vault;
        taxProcessorAddr = IFlapTaxTokenV3(token).taxProcessor();

        vm.label(token, "StakeToEarn:Token");
        vm.label(vault, "StakeToEarn:Vault");
        vm.label(taxProcessorAddr, "StakeToEarn:TaxProcessor");

        console2.log("Token:        %s", token);
        console2.log("Vault:        %s", vault);
        console2.log("TaxProcessor: %s", taxProcessorAddr);
    }

    function test_deployVault() public {
        assertTrue(vault != address(0), "Vault should be deployed");
        console2.log("[PASS] Vault deployed at: %s", vault);
    }

    function test_buyOnBCAndDispatch() public {
        uint256 buyAmount = 5 ether;

        uint256 vaultBalanceBefore = address(vault).balance;

        console2.log("=== Buying %s BNB on bonding curve ===", buyAmount / 1 ether);

        vm.startPrank(user1);
        uint256 tokensReceived = _buyOnBC(token, buyAmount);
        vm.stopPrank();
        console2.log("Tokens received: %s", tokensReceived);

        _dispatchTax(token);
        console2.log("Dispatched tax");

        uint256 vaultBalanceAfter = address(vault).balance;
        console2.log("Vault balance before dispatch: %s wei", vaultBalanceBefore);
        console2.log("Vault balance after dispatch:  %s wei", vaultBalanceAfter);
        assertGt(vaultBalanceAfter, vaultBalanceBefore, "Vault should have received BNB after dispatch");

        console2.log("[PASS] Buy on BC + dispatch: vault received %s wei", vaultBalanceAfter - vaultBalanceBefore);
    }

    function test_stakeAndUnstake() public {
        uint256 stakeAmount = 1000 * 1e18;

        vm.startPrank(user1);
        IERC20(token).approve(vault, stakeAmount);
        (bool success,) = vault.call(abi.encodeWithSignature("stake(uint256)", stakeAmount));
        require(success, "Stake failed");

        (success,) = vault.call(abi.encodeWithSignature("unstake(uint256)", stakeAmount));
        require(success, "Unstake failed");
        vm.stopPrank();

        console2.log("[PASS] Stake and unstake executed successfully");
    }
}