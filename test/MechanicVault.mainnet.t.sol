// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

// forge test --match-path test/MechanicVault.mainnet.t.sol -vvv \
//     --fork-url https://bsc-dataseed.bnbchain.org

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {MechanicVault, MechanicVaultFactory} from "../src/MechanicVault.sol";
import {IMechanicTypes} from "../src/IMechanicTypes.sol";
import {FlapBSCFixture} from "./FlapBSCFixture.sol";
import {IVaultPortal, IVaultPortalTypes} from "../src/flap/IVaultPortal.sol";
import {IFlapTaxTokenV3} from "../src/flap/IFlapTaxTokenV3.sol";
import {ITaxProcessor} from "../src/flap/ITaxProcessor.sol";

/// @title MechanicVaultMainnetTest
/// @notice Proves the REAL bonding-curve interaction: tax BNB funds a buyback budget,
///         and executeBuyback() actually buys the token back from the Flap Portal and
///         burns it. Also verifies launch wiring and treasury accrual.
contract MechanicVaultMainnetTest is FlapBSCFixture, IMechanicTypes {
    MechanicVaultFactory public factory;
    MechanicVault public vault;
    address public token;
    address public taxProcessorAddr;

    address public creator = address(0x7777777777777777777777777777777777773001);
    address public user1 = address(0x7777777777777777777777777777777777773002);

    function setUp() public {
        _forkBSCMainnet();
        vm.deal(creator, 60 ether);
        vm.deal(user1, 30 ether);

        vm.startPrank(creator);
        factory = new MechanicVaultFactory();
        vm.stopPrank();

        // 60% buyback, 40% treasury
        MechanicConfig memory cfg = MechanicConfig({
            templateName: "Buyback Engine",
            creatorFeeBps: 200,
            buybackBps: 6000,
            survivorBps: 0,
            raffleBps: 0,
            treasuryBps: 4000,
            survivorHoldThreshold: 0,
            survivorRoundDuration: 0,
            raffleMinHold: 0,
            raffleRoundDuration: 0
        });
        bytes memory vaultData = abi.encode(cfg);

        bytes32 salt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);
        IVaultPortalTypes.NewTokenV6WithVaultParams memory params =
            _buildV3TaxTokenParams("Mechanic Test", "MECH", salt, address(factory), vaultData);

        vm.startPrank(creator);
        token = vaultPortal.newTokenV6WithVault{value: params.quoteAmt, gas: MAX_OP_GAS}(params);
        vm.stopPrank();

        IVaultPortalTypes.VaultInfo memory info = vaultPortal.getVault(token);
        vault = MechanicVault(payable(info.vault));
        taxProcessorAddr = IFlapTaxTokenV3(token).taxProcessor();

        vm.label(token, "Mechanic:Token");
        vm.label(address(vault), "Mechanic:Vault");
    }

    function test_launchWiring() public view {
        IVaultPortalTypes.VaultInfo memory info = vaultPortal.getVault(token);
        assertEq(info.vault, address(vault));
        assertEq(info.vaultFactory, address(factory));
        assertEq(vault.taxToken(), token);
        assertEq(ITaxProcessor(taxProcessorAddr).marketAddress(), address(vault));
    }

    function test_taxFundsBuybackAndTreasury() public {
        vm.startPrank(user1);
        _buyOnBC(token, 6 ether);
        vm.stopPrank();
        _dispatchTax(token);

        assertGt(vault.buybackBudget(), 0, "buyback budget should accrue");
        assertGt(vault.treasuryBalance(), 0, "treasury should accrue");
        assertGt(vault.creatorFeeAccrued(), 0, "creator fee should accrue");

        console2.log("buyback budget: %s", vault.buybackBudget());
        console2.log("treasury:       %s", vault.treasuryBalance());
    }

    function test_executeBuyback_buysAndBurnsRealTokens() public {
        // Fund the buyback budget
        vm.startPrank(user1);
        _buyOnBC(token, 8 ether);
        vm.stopPrank();
        _dispatchTax(token);

        uint256 budget = vault.buybackBudget();
        require(budget > 0, "need buyback budget");

        uint256 burnedBefore = IERC20(token).balanceOf(vault.BURN_ADDRESS());

        // Creator triggers the buyback (slippage floor 0 for the test)
        vm.startPrank(creator);
        vault.executeBuyback(0);
        vm.stopPrank();

        assertEq(vault.buybackBudget(), 0, "budget consumed");
        assertEq(vault.totalBoughtBack(), budget, "totalBoughtBack tracks BNB spent");

        uint256 burnedAfter = IERC20(token).balanceOf(vault.BURN_ADDRESS());
        uint256 lockedInVault = IERC20(token).balanceOf(address(vault));

        // Either burned to the black hole or locked in the vault — both remove supply.
        assertGt(burnedAfter - burnedBefore + lockedInVault, 0, "tokens removed from circulation");

        console2.log("BNB spent on buyback: %s", budget);
        console2.log("tokens burned:        %s", burnedAfter - burnedBefore);
        console2.log("tokens locked:        %s", lockedInVault);
    }

    function test_executeBuyback_onlyCreatorOrGuardian() public {
        vm.startPrank(user1);
        _buyOnBC(token, 5 ether);
        vm.stopPrank();
        _dispatchTax(token);

        vm.expectRevert("Not authorized");
        vm.prank(user1);
        vault.executeBuyback(0);
    }

    function test_creatorWithdrawsTreasury() public {
        vm.startPrank(user1);
        _buyOnBC(token, 5 ether);
        vm.stopPrank();
        _dispatchTax(token);

        uint256 treasury = vault.treasuryBalance();
        require(treasury > 0, "need treasury");

        uint256 before = creator.balance;
        vm.startPrank(creator);
        vault.withdrawTreasury{gas: MAX_OP_GAS}();
        vm.stopPrank();

        assertEq(vault.treasuryBalance(), 0);
        assertEq(creator.balance - before, treasury);
    }

    receive() external payable {}
}
