// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

// forge test --match-path test/_codegen/WeeklyBurnLottery.mainnet.t.sol -vvv --fork-url https://bsc-dataseed.bnbchain.org

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

import {FlapBSCFixture} from "../FlapBSCFixture.sol";
import {CodegenVaultFactory} from "../../src/CodegenVaultFactory.sol";
import {IVaultPortalTypes} from "../../src/flap/IVaultPortal.sol";
import {IFlapTaxTokenV3} from "../../src/flap/IFlapTaxTokenV3.sol";
import {ITaxProcessor} from "../../src/flap/ITaxProcessor.sol";

contract WeeklyBurnLotteryMainnetTest is FlapBSCFixture {
    // ──────────────────────────────────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────────────────────────────────

    CodegenVaultFactory public factory;
    address public vault;
    address public token;
    address public taxProcessorAddr;

    address public user1 = address(0x7777777777777777777777777777777777771001);
    address public creator = address(0x7777777777777777777777777777777777771004);

    // ──────────────────────────────────────────────────────────────────────────
    //  Set Up
    // ──────────────────────────────────────────────────────────────────────────

    function setUp() public {
        // 1. Fork BSC mainnet
        _forkBSCMainnet();

        // 2. Fund test accounts
        vm.deal(creator, 100 ether);
        vm.deal(user1, 20 ether);

        // 3. Deploy CodegenVaultFactory
        vm.startPrank(creator);
        factory = new CodegenVaultFactory();
        vm.label(address(factory), "CodegenVaultFactory");
        vm.stopPrank();

        // 4. Load creation bytecode for WeeklyBurnLottery
        bytes memory creationCode = vm.readFileBinary(string.concat("test/_codegen/", "WeeklyBurnLottery.bin"));

        // 5. Build scaffold params and customise
        IVaultPortalTypes.NewTokenV6WithVaultParams memory params =
            _buildV3TaxTokenParams("Weekly Burn Lottery", "WBL", bytes32(0), address(factory), creationCode);

        // Customise: 5% symmetric tax, all market revenue → vault
        params.buyTaxRate = 500; // 5%
        params.sellTaxRate = 500; // 5%
        params.mktBps = 10000; // 100% of tax remainder → vault (after protocol fee)
        params.deflationBps = 0;
        params.dividendBps = 0;
        params.lpBps = 0;

        // 6. Launch the token + vault in a single transaction through VaultPortal
        vm.startPrank(creator);
        token = vaultPortal.newTokenV6WithVault{value: params.quoteAmt, gas: MAX_OP_GAS}(params);
        vm.stopPrank();

        // 7. Resolve vault and taxProcessor addresses
        IVaultPortalTypes.VaultInfo memory info = vaultPortal.getVault(token);
        vault = info.vault;
        taxProcessorAddr = IFlapTaxTokenV3(token).taxProcessor();

        vm.label(token, "WeeklyBurnLottery:Token");
        vm.label(vault, "WeeklyBurnLottery:Vault");
        vm.label(taxProcessorAddr, "WeeklyBurnLottery:TaxProcessor");

        console2.log("Token:        %s", token);
        console2.log("Vault:        %s", vault);
        console2.log("TaxProcessor: %s", taxProcessorAddr);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Test 1: Deploy vault and verify configuration
    // ──────────────────────────────────────────────────────────────────────────

    function test_vaultDeployment() public {
        assertEq(IFlapTaxTokenV3(token).taxProcessor(), taxProcessorAddr, "TaxProcessor mismatch");
        assertEq(ITaxProcessor(taxProcessorAddr).marketAddress(), vault, "Market address should be the vault");

        console2.log("[PASS] Vault deployment and configuration verified");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Test 2: Buy on bonding curve → tax accumulates → dispatch → vault receives BNB
    // ──────────────────────────────────────────────────────────────────────────

    function test_buyOnBCAndDispatch() public {
        uint256 buyAmount = 5 ether;

        uint256 vaultBalanceBefore = address(vault).balance;

        console2.log("=== Buying %s BNB on bonding curve ===", buyAmount / 1 ether);

        vm.startPrank(user1);
        uint256 tokensReceived = _buyOnBC(token, buyAmount);
        vm.stopPrank();
        console2.log("Tokens received: %s", tokensReceived);

        // Dispatch: flush TaxProcessor balances → vault receives BNB
        _dispatchTax(token);
        console2.log("Dispatched tax");

        uint256 vaultBalanceAfter = address(vault).balance;
        console2.log("Vault balance before dispatch: %s wei", vaultBalanceBefore);
        console2.log("Vault balance after dispatch:  %s wei", vaultBalanceAfter);
        assertGt(vaultBalanceAfter, vaultBalanceBefore, "Vault should have received BNB after dispatch");

        console2.log("[PASS] Buy on BC + dispatch: vault received %s wei", vaultBalanceAfter - vaultBalanceBefore);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Test 3: Enter lottery, request draw, and execute buyback
    // ──────────────────────────────────────────────────────────────────────────

    function test_enterLotteryAndBuyback() public {
        // Enter the lottery
        vm.startPrank(user1);
        (bool success,) = vault.call(abi.encodeWithSignature("enter()"));
        require(success, "Failed to enter lottery");
        vm.stopPrank();

        console2.log("[PASS] User entered the lottery");

        // Request draw
        vm.startPrank(creator);
        (success,) = vault.call(abi.encodeWithSignature("requestDraw()"));
        require(success, "Failed to request draw");
        vm.stopPrank();

        console2.log("[PASS] Draw requested");

        // Execute buyback
        vm.startPrank(creator);
        (success,) = vault.call(abi.encodeWithSignature("executeBuyback(uint256)", 1));
        require(success, "Failed to execute buyback");
        vm.stopPrank();

        console2.log("[PASS] Buyback executed");
    }
}