// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

// forge test --match-path test/ComposerVault.mainnet.t.sol -vvv \
//     --fork-url https://bsc-dataseed.bnbchain.org

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {ComposerVault, ComposerVaultFactory} from "../src/ComposerVault.sol";
import {IComposerTypes} from "../src/IComposerTypes.sol";
import {FlapBSCFixture} from "./FlapBSCFixture.sol";
import {VanityHelper} from "./lib/VanityHelper.sol";
import {IVaultPortal, IVaultPortalTypes} from "../src/flap/IVaultPortal.sol";
import {IPortalTypes} from "../src/flap/IPortal.sol";
import {IFlapTaxTokenV3} from "../src/flap/IFlapTaxTokenV3.sol";
import {ITaxProcessor} from "../src/flap/ITaxProcessor.sol";
import {VaultDataSchema} from "../src/flap/IVaultSchemasV1.sol";

/// @title ComposerVaultMainnetTest
/// @notice Mainnet-fork integration tests for ComposerVault + ComposerVaultFactory.
///
/// Covers Flap pre-audit required scenarios:
///   1. Factory deploys vault on newTokenV6WithVault()
///   2. TaxProcessor.marketAddress == vault
///   3. Buy on BC → dispatch → pipeline executes
///   4. Graduate to DEX → sell → dispatch
///   5. claim() happy path
///   6. claim() gating (double-claim, cooldown)
contract ComposerVaultMainnetTest is FlapBSCFixture, IComposerTypes {
    ComposerVaultFactory public factory;
    ComposerVault public vault;
    address public token;
    address public taxProcessorAddr;

    address public creator = address(0x7777777777777777777777777777777777772001);
    address public marketing = address(0x7777777777777777777777777777777777772002);
    address public dev = address(0x7777777777777777777777777777777777772003);
    address public user1 = address(0x7777777777777777777777777777777777772004);
    address public user2 = address(0x7777777777777777777777777777777777772005);

    uint256 constant CREATOR_FEE_BPS = 200; // 2%
    uint256 constant MAX_PER_CLAIM = 0.05 ether;
    uint256 constant CLAIM_COOLDOWN = 1 hours;

    function setUp() public {
        _forkBSCMainnet();
        vm.deal(creator, 50 ether);
        vm.deal(user1, 20 ether);
        vm.deal(user2, 20 ether);

        vm.startPrank(creator);
        factory = new ComposerVaultFactory();
        vm.label(address(factory), "ComposerVaultFactory");
        vm.stopPrank();

        bytes memory vaultData = _buildVaultData();

        bytes32 salt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);

        IVaultPortalTypes.NewTokenV6WithVaultParams memory params =
            _buildV3TaxTokenParams("Composer Test", "CMPS", salt, address(factory), vaultData);

        vm.startPrank(creator);
        token = vaultPortal.newTokenV6WithVault{value: params.quoteAmt, gas: MAX_OP_GAS}(params);
        vm.stopPrank();

        IVaultPortalTypes.VaultInfo memory info = vaultPortal.getVault(token);
        vault = ComposerVault(payable(info.vault));
        taxProcessorAddr = IFlapTaxTokenV3(token).taxProcessor();

        vm.label(token, "Composer:Token");
        vm.label(address(vault), "Composer:Vault");
        vm.label(taxProcessorAddr, "Composer:TaxProcessor");
    }

    function _buildVaultData() internal view returns (bytes memory) {
        ComposerBlock[] memory blocks = new ComposerBlock[](3);

        blocks[0] = ComposerBlock({
            blockType: BlockType.SEND,
            data: abi.encode(marketing, uint16(1000)) // 10% of remaining
        });

        blocks[1] = ComposerBlock({
            blockType: BlockType.TREASURY,
            data: abi.encode(uint16(2500)) // 25% of remaining after send
        });

        blocks[2] = ComposerBlock({
            blockType: BlockType.CLAIM_POOL,
            data: abi.encode(uint16(10_000), MAX_PER_CLAIM, CLAIM_COOLDOWN) // rest → pool
        });

        ComposerConfig memory cfg = ComposerConfig({
            templateName: "Integration Pipeline",
            creatorFeeBps: uint16(CREATOR_FEE_BPS),
            blocks: blocks
        });

        return abi.encode(cfg);
    }

    // ── 1. Factory deploys vault on launch ───────────────────────────────────

    function test_factoryDeploysVaultOnLaunch() public view {
        IVaultPortalTypes.VaultInfo memory info = vaultPortal.getVault(token);
        assertTrue(info.vault != address(0), "vault must be deployed");
        assertEq(info.vaultFactory, address(factory), "factory mismatch");
        assertEq(vault.templateName(), "Integration Pipeline");
        console2.log("[PASS] Vault deployed at %s", info.vault);
    }

    // ── 2. Vault wired as tax recipient ────────────────────────────────────

    function test_vaultWiredAsTaxRecipient() public view {
        assertEq(vault.taxToken(), token);
        assertEq(ITaxProcessor(taxProcessorAddr).marketAddress(), address(vault));
        console2.log("[PASS] TaxProcessor.marketAddress == vault");
    }

    // ── 3. Buy on BC → dispatch → pipeline runs ──────────────────────────────

    function test_buyOnBCAndDispatch() public {
        uint256 marketingBefore = marketing.balance;
        uint256 creatorBefore = creator.balance;

        vm.startPrank(user1);
        _buyOnBC(token, 5 ether);
        vm.stopPrank();

        _dispatchTax(token);

        assertGt(marketing.balance, marketingBefore, "marketing should receive SEND");
        assertGt(creator.balance, creatorBefore, "creator should receive fee");
        assertGt(vault.treasuryBalance(), 0, "treasury should accumulate");

        (uint256 poolBudget,, bool enabled,) = vault.getPoolInfo();
        assertTrue(enabled, "claim pool should be enabled");
        assertGt(poolBudget, 0, "claim pool should be funded");

        console2.log("[PASS] BC buy + dispatch: treasury=%s pool=%s", vault.treasuryBalance(), poolBudget);
    }

    // ── 4. Graduate → sell → dispatch post-DEX ───────────────────────────────

    function test_graduateAndDispatchPostDEX() public {
        vm.startPrank(user1);
        _buyOnBC(token, 5 ether);
        vm.stopPrank();
        _dispatchTax(token);

        vm.startPrank(user2);
        _buyOnBC(token, 15 ether);
        vm.stopPrank();

        IPortalTypes.TokenStateV8Safe memory state = portal.getTokenV8Safe(token);
        if (state.status != 4) {
            vm.deal(creator, 20 ether);
            vm.startPrank(creator);
            _buyOnBC(token, 10 ether);
            vm.stopPrank();
            state = portal.getTokenV8Safe(token);
        }
        assertEq(state.status, 4, "token should graduate to DEX");

        uint256 treasuryBefore = vault.treasuryBalance();
        uint256 user1Bal = IERC20(token).balanceOf(user1);
        require(user1Bal > 400_000 * 1e18, "need tokens to sell");

        vm.startPrank(user1);
        IERC20(token).transfer(token, 400_000 * 1e18);
        _sell(token, user1Bal - 400_000 * 1e18);
        vm.stopPrank();

        _dispatchTax(token);
        assertGt(vault.treasuryBalance(), treasuryBefore, "treasury should grow after DEX sell tax");

        console2.log("[PASS] DEX sell + dispatch succeeded");
    }

    // ── 5. claim() happy path ────────────────────────────────────────────────

    function test_claimFromPool() public {
        vm.startPrank(user1);
        _buyOnBC(token, 8 ether);
        vm.stopPrank();
        _dispatchTax(token);

        (uint256 poolBefore,,,) = vault.getPoolInfo();
        require(poolBefore > 0, "pool must be funded");

        uint256 user2Before = user2.balance;
        vm.startPrank(user2);
        vault.claim{gas: MAX_OP_GAS}();
        vm.stopPrank();

        assertGt(user2.balance, user2Before, "claimer should receive BNB");
        assertTrue(vault.hasClaimed(user2), "claimer marked");
        console2.log("[PASS] claim paid %s wei", user2.balance - user2Before);
    }

    // ── 6. claim() gating ────────────────────────────────────────────────────

    function test_cannotClaimTwice() public {
        vm.startPrank(user1);
        _buyOnBC(token, 8 ether);
        vm.stopPrank();
        _dispatchTax(token);

        vm.startPrank(user2);
        vault.claim{gas: MAX_OP_GAS}();
        vm.stopPrank();

        vm.expectRevert();
        vm.startPrank(user2);
        vault.claim{gas: MAX_OP_GAS}();
        vm.stopPrank();

        console2.log("[PASS] double claim rejected");
    }

    function test_cooldownBlocksSecondUser() public {
        vm.startPrank(user1);
        _buyOnBC(token, 10 ether);
        vm.stopPrank();
        _dispatchTax(token);

        vm.startPrank(user2);
        _buyOnBC(token, 5 ether);
        vm.stopPrank();
        _dispatchTax(token);

        vm.startPrank(user1);
        vault.claim{gas: MAX_OP_GAS}();
        vm.stopPrank();

        vm.expectRevert();
        vm.startPrank(user2);
        vault.claim{gas: MAX_OP_GAS}();
        vm.stopPrank();

        vm.warp(block.timestamp + CLAIM_COOLDOWN + 1);

        vm.startPrank(user2);
        vault.claim{gas: MAX_OP_GAS}();
        vm.stopPrank();

        assertTrue(vault.hasClaimed(user2));
        console2.log("[PASS] cooldown enforced then second user claimed");
    }

    // ── Additional: treasury withdraw ──────────────────────────────────────

    function test_creatorWithdrawsTreasury() public {
        vm.startPrank(user1);
        _buyOnBC(token, 5 ether);
        vm.stopPrank();
        _dispatchTax(token);

        uint256 treasury = vault.treasuryBalance();
        require(treasury > 0, "need treasury");

        uint256 creatorBefore = creator.balance;
        vm.startPrank(creator);
        vault.withdrawTreasury{gas: MAX_OP_GAS}();
        vm.stopPrank();

        assertEq(vault.treasuryBalance(), 0);
        assertEq(creator.balance - creatorBefore, treasury);
        console2.log("[PASS] treasury withdrawn");
    }

    function test_factorySchema() public view {
        VaultDataSchema memory schema = factory.vaultDataSchema();
        assertEq(schema.fields.length, 1);
        assertTrue(factory.isQuoteTokenSupported(address(0)));
        assertTrue(!factory.isQuoteTokenSupported(address(1)));
    }

    receive() external payable {}
}
