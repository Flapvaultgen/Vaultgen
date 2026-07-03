// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

// forge test --match-path test/_codegen/ReferralRewardsVault.mainnet.t.sol -vvv --fork-url https://bsc-dataseed.bnbchain.org

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";

import {FlapBSCFixture} from "../FlapBSCFixture.sol";
import {VanityHelper} from "../lib/VanityHelper.sol";

import {CodegenVaultFactory} from "../../src/CodegenVaultFactory.sol";
import {IVaultPortalTypes} from "../../src/flap/IVaultPortal.sol";
import {IPortalTypes} from "../../src/flap/IPortal.sol";
import {IFlapTaxTokenV3} from "../../src/flap/IFlapTaxTokenV3.sol";
import {ITaxProcessor} from "../../src/flap/ITaxProcessor.sol";
import {VaultUISchema, VaultMethodSchema, FieldDescriptor} from "../../src/flap/IVaultSchemasV1.sol";

// ============================================================
//  Minimal interface mirroring the ReferralRewardsVault ABI.
//  The concrete vault is deployed by CodegenVaultFactory from raw
//  creation bytecode (test/_codegen/ReferralRewardsVault.bin), so
//  we interact with it purely through this interface rather than
//  importing a concrete contract type.
// ============================================================
interface IReferralRewardsVault {
    // ---- Holder actions ----
    function setReferrer(address referrer) external;
    function claimReferralReward() external;

    // ---- Manager action ----
    function creditReferralRewards(address[] calldata users, uint256[] calldata amounts) external;

    // ---- Guardian actions ----
    function setPaused(bool paused) external;
    function guardianRescueUnreservedPool(address to) external;
    function emergencyWithdrawNative(address to) external;
    function emergencyWithdrawToken(address token, address to) external;

    // ---- Views ----
    function getReferrer(address user) external view returns (address);
    function getClaimable(address user) external view returns (uint256);
    function getPoolBalance() external view returns (uint256);
    function referrerOf(address user) external view returns (address);
    function claimableRewards(address user) external view returns (uint256);
    function referralRewardsPoolAvailable() external view returns (uint256);
    function totalReserved() external view returns (uint256);
    function isPaused() external view returns (bool);
    function manager() external view returns (address);
    function guardian() external view returns (address);
    function taxToken() external view returns (address);
    function description() external view returns (string memory);
    function vaultUISchema() external view returns (VaultUISchema memory);
}

// ============================================================
//  ReferralRewardsVault Mainnet Fork Tests
// ============================================================

/// @title ReferralRewardsVaultMainnetTest
/// @notice Mainnet-fork integration tests for the ReferralRewardsVault codegen vault,
///         deployed through CodegenVaultFactory + Flap VaultPortal.
///
/// @dev Covers Flap Rules 001 (vault rules), 002 (factory rules), 003 (fairness),
///      004 (UI-friendliness), 005 (receive() gas limit), 006 (integration tests),
///      009 (emergency controls), applied to the ReferralRewardsVault MechanicSpec:
///      one-time referrer registration, manager-batched per-user reward crediting,
///      and pull-based per-user claiming from a shared referralRewardsPool.
contract ReferralRewardsVaultMainnetTest is FlapBSCFixture {
    // ──────────────────────────────────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────────────────────────────────

    CodegenVaultFactory public factory;
    IReferralRewardsVault public vault;
    address public token;
    address public taxProcessorAddr;

    address public managerAddr;
    address public guardianAddr;

    // 0x7777-prefixed addresses avoid collisions with real funded/system accounts on fork.
    address public creator = address(0x7777777777777777777777777777777777771004);
    address public alice = address(0x7777777777777777777777777777777777771001);
    address public bob = address(0x7777777777777777777777777777777777771002);
    address public randomUser = address(0x7777777777777777777777777777777777771003);
    address public protocol = address(0x7777777777777777777777777777777777773001);

    function setUp() public {
        _forkBSCMainnet();

        vm.deal(creator, 100 ether);
        vm.deal(alice, 20 ether);
        vm.deal(bob, 20 ether);
        vm.deal(randomUser, 20 ether);
        vm.deal(protocol, 50 ether);

        // Deploy CodegenVaultFactory
        vm.startPrank(creator);
        factory = new CodegenVaultFactory();
        vm.label(address(factory), "ReferralRewardsVault:CodegenVaultFactory");
        vm.stopPrank();

        // Load the ReferralRewardsVault creation bytecode (compiled codegen artifact)
        bytes memory creationCode = vm.readFileBinary(string.concat("test/_codegen/", "ReferralRewardsVault.bin"));

        bytes32 salt = _findVanitySalt(VanityType.VANITY_7777, TOKEN_IMPL_TAXED_V3, PORTAL);

        // vaultData IS the creation bytecode for a CodegenVaultFactory deployment
        IVaultPortalTypes.NewTokenV6WithVaultParams memory params =
            _buildV3TaxTokenParams("Referral Rewards Coin", "REFC", salt, address(factory), creationCode);

        params.buyTaxRate = 500; // 5%
        params.sellTaxRate = 500; // 5%
        params.mktBps = 10000; // 100% of tax remainder -> vault
        params.deflationBps = 0;
        params.dividendBps = 0;
        params.lpBps = 0;

        vm.startPrank(creator);
        token = vaultPortal.newTokenV6WithVault{value: params.quoteAmt, gas: MAX_OP_GAS}(params);
        vm.stopPrank();

        IVaultPortalTypes.VaultInfo memory info = vaultPortal.getVault(token);
        vault = IReferralRewardsVault(payable(info.vault));
        taxProcessorAddr = IFlapTaxTokenV3(token).taxProcessor();

        managerAddr = vault.manager();
        guardianAddr = vault.guardian();
        vm.deal(guardianAddr, 10 ether);

        vm.label(token, "ReferralRewardsVault:Token");
        vm.label(address(vault), "ReferralRewardsVault:Vault");
        vm.label(taxProcessorAddr, "ReferralRewardsVault:TaxProcessor");

        console2.log("Token:    %s", token);
        console2.log("Vault:    %s", address(vault));
        console2.log("Manager:  %s", managerAddr);
        console2.log("Guardian: %s", guardianAddr);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Internal helpers
    // ──────────────────────────────────────────────────────────────────────────

    /// @dev Simulates protocol tax intake landing on the vault's receive().
    function _fundPool(uint256 amount) internal {
        vm.startPrank(protocol);
        uint256 gasBefore = gasleft();
        (bool ok,) = payable(address(vault)).call{value: amount}("");
        uint256 gasUsed = gasBefore - gasleft();
        vm.stopPrank();
        assertTrue(ok, "receive() must not revert on a normal deposit");
        assertLt(gasUsed, 1_000_000, "receive() must stay under 1,000,000 gas");
    }

    function _streq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 1 / Rule 002,006 — factory deploys vault with base-compatible ctor
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 002, 006
    function test_factoryDeploysVaultAndWiresTaxProcessor() public view {
        assertTrue(address(vault) != address(0), "vault must be deployed");
        address marketAddr = ITaxProcessor(taxProcessorAddr).marketAddress();
        assertEq(marketAddr, address(vault), "TaxProcessor.marketAddress() should be the vault");
        assertEq(vault.taxToken(), token, "vault.taxToken() should equal launched token");
        console2.log("[PASS] factory deploy + taxProcessor wiring verified");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 2 / Rule 001,005,006 — tax BNB dispatch reaches receive()
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 005, 006
    function test_taxDispatchReachesReceiveWithoutRevert() public {
        uint256 before = address(vault).balance;
        uint256 poolBefore = vault.referralRewardsPoolAvailable();

        vm.startPrank(alice);
        _buyOnBC(token, 5 ether);
        vm.stopPrank();

        _dispatchTax(token);

        uint256 afterBal = address(vault).balance;
        uint256 poolAfter = vault.referralRewardsPoolAvailable();

        assertGt(afterBal, before, "vault should receive BNB after dispatch");
        assertGt(poolAfter, poolBefore, "pool available must increase on tax intake");
        console2.log("[PASS] bonding curve buy + dispatch delivered %s wei", afterBal - before);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 3 / Rule 004,006 — vaultUISchema() methods exist
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 004, 006
    function test_vaultUISchemaMethodsExist() public view {
        VaultUISchema memory schema = vault.vaultUISchema();
        assertTrue(bytes(schema.vaultType).length > 0, "schema.vaultType must be set");
        assertGt(schema.methods.length, 0, "schema must list methods");

        bool sawSetReferrer;
        bool sawClaim;
        bool sawCredit;
        bool sawSetPaused;
        bool sawRescue;

        for (uint256 i = 0; i < schema.methods.length; i++) {
            VaultMethodSchema memory m = schema.methods[i];
            assertTrue(bytes(m.name).length > 0, "each schema method needs a name");

            if (_streq(m.name, "setReferrer")) {
                sawSetReferrer = true;
                assertTrue(m.isWriteMethod, "setReferrer should be a write method");
            } else if (_streq(m.name, "claimReferralReward")) {
                sawClaim = true;
                assertTrue(m.isWriteMethod, "claimReferralReward should be a write method");
            } else if (_streq(m.name, "creditReferralRewards")) {
                sawCredit = true;
                assertTrue(m.isWriteMethod, "creditReferralRewards should be a write method");
            } else if (_streq(m.name, "setPaused")) {
                sawSetPaused = true;
            } else if (_streq(m.name, "guardianRescueUnreservedPool")) {
                sawRescue = true;
            } else if (_streq(m.name, "getReferrer")) {
                vault.getReferrer(alice); // resolves to a real function
            } else if (_streq(m.name, "getClaimable")) {
                vault.getClaimable(alice);
            } else if (_streq(m.name, "getPoolBalance")) {
                vault.getPoolBalance();
            } else if (_streq(m.name, "referralRewardsPoolAvailable")) {
                vault.referralRewardsPoolAvailable();
            } else if (_streq(m.name, "totalReserved")) {
                vault.totalReserved();
            } else if (_streq(m.name, "isPaused")) {
                vault.isPaused();
            } else if (_streq(m.name, "manager")) {
                vault.manager();
            } else if (_streq(m.name, "guardian")) {
                vault.guardian();
            }
        }

        assertTrue(sawSetReferrer, "schema must expose setReferrer");
        assertTrue(sawClaim, "schema must expose claimReferralReward");
        assertTrue(sawCredit, "schema must expose creditReferralRewards");
        assertTrue(sawSetPaused, "schema must expose setPaused (guardian control)");
        assertTrue(sawRescue, "schema must expose guardianRescueUnreservedPool");

        console2.log("[PASS] vaultUISchema exposes %s methods, all resolvable", schema.methods.length);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 4 / Rule 001,004,006 — manager-gated actions revert for non-manager
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 004, 006
    function test_managerGatedActionsRevertForNonManager() public {
        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;

        vm.startPrank(randomUser);
        vm.expectRevert(bytes(unicode"Manager only / 仅限管理员"));
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        console2.log("[PASS] non-manager creditReferralRewards reverted as expected");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 5 / Rule 009,006 — emergency withdrawals are guardian-only
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 009, 006
    function test_emergencyWithdrawalsGuardianOnly() public {
        vm.startPrank(randomUser);
        vm.expectRevert();
        vault.emergencyWithdrawNative(randomUser);
        vm.stopPrank();

        vm.startPrank(randomUser);
        vm.expectRevert();
        vault.emergencyWithdrawToken(token, randomUser);
        vm.stopPrank();

        vm.startPrank(randomUser);
        vm.expectRevert();
        vault.guardianRescueUnreservedPool(randomUser);
        vm.stopPrank();

        console2.log("[PASS] emergency + rescue functions are guardian-gated");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 6,23 / Rule 001,004,006 — holder can setReferrer (once)
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 004, 006
    function test_holderCanSetReferrerOnce() public {
        vm.startPrank(alice);
        vault.setReferrer(bob);
        vm.stopPrank();

        assertEq(vault.getReferrer(alice), bob, "referrerOf[alice] should be bob");
        assertEq(vault.referrerOf(alice), bob, "public mapping should also reflect referrer");

        // second call must revert (already set, never changed)
        vm.startPrank(alice);
        vm.expectRevert(bytes(unicode"Referrer already set / 推荐人已设置"));
        vault.setReferrer(randomUser);
        vm.stopPrank();

        assertEq(vault.getReferrer(alice), bob, "referrer must remain unchanged after failed re-set");
        console2.log("[PASS] setReferrer is one-time and immutable thereafter");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 7,24 / Rule 004,006 — setReferrer rejects invalid input
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 004, 006
    function test_setReferrerRejectsSelfAndZero() public {
        vm.startPrank(alice);
        vm.expectRevert(bytes(unicode"Cannot refer yourself / 不能推荐自己"));
        vault.setReferrer(alice);
        vm.stopPrank();

        vm.startPrank(bob);
        vm.expectRevert(bytes(unicode"Invalid referrer / 无效推荐人"));
        vault.setReferrer(address(0));
        vm.stopPrank();

        assertEq(vault.getReferrer(alice), address(0), "alice referrer must remain unset");
        assertEq(vault.getReferrer(bob), address(0), "bob referrer must remain unset");
        console2.log("[PASS] setReferrer rejects self-referral and zero address");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 8,28 / Rule 001,004,006 — holder can claimReferralReward
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 004, 006
    function test_holderCanClaimReferralReward() public {
        _fundPool(2 ether);

        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0.5 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        assertEq(vault.getClaimable(alice), 0.5 ether, "alice should have 0.5 ether claimable");

        uint256 balBefore = alice.balance;
        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();
        uint256 balAfter = alice.balance;

        assertEq(balAfter - balBefore, 0.5 ether, "alice must receive exactly her claimable amount");
        assertEq(vault.getClaimable(alice), 0, "claimable balance must be zeroed after claim");
        console2.log("[PASS] holder claimed exact credited BNB reward");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 9,28 / Rule 004,006 — claimReferralReward rejects invalid claims
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 004, 006
    function test_claimReferralRewardRejectsWhenNothingClaimable() public {
        vm.startPrank(randomUser);
        vm.expectRevert(bytes(unicode"Nothing to claim / 无可领取金额"));
        vault.claimReferralReward();
        vm.stopPrank();
        console2.log("[PASS] claim reverts with zero claimable balance");
    }

    function test_doubleClaimReverts() public {
        _fundPool(1 ether);

        address[] memory users = new address[](1);
        users[0] = bob;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0.2 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        vm.startPrank(bob);
        vault.claimReferralReward();
        vm.stopPrank();

        vm.startPrank(bob);
        vm.expectRevert(bytes(unicode"Nothing to claim / 无可领取金额"));
        vault.claimReferralReward();
        vm.stopPrank();

        console2.log("[PASS] double-claim reverts after balance is zeroed");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 10,25 / Rule 001,003,006 — manager executes creditReferralRewards
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 003, 006
    function test_managerCreditsWithinPoolBalance() public {
        _fundPool(3 ether);
        uint256 poolBefore = vault.referralRewardsPoolAvailable();

        address[] memory users = new address[](2);
        users[0] = alice;
        users[1] = bob;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1 ether;
        amounts[1] = 0.5 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        assertEq(vault.getClaimable(alice), 1 ether, "alice claimable mismatch");
        assertEq(vault.getClaimable(bob), 0.5 ether, "bob claimable mismatch");
        assertEq(
            vault.referralRewardsPoolAvailable(),
            poolBefore - 1.5 ether,
            "pool available must decrease by exact sum"
        );
        console2.log("[PASS] manager credited both users, pool decremented by exact sum");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 11 / Rule 001,005,006 — tax dispatch credits referralRewardsPool
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 005, 006
    function test_taxDispatchCreditsReferralRewardsPoolBucket() public {
        uint256 poolBefore = vault.referralRewardsPoolAvailable();
        uint256 balBefore = address(vault).balance;

        _fundPool(1.25 ether);

        assertEq(
            vault.referralRewardsPoolAvailable(), poolBefore + 1.25 ether, "pool available must track exact deposit"
        );
        assertLe(
            vault.referralRewardsPoolAvailable() + vault.totalReserved(),
            address(vault).balance,
            "sum(buckets) must not exceed contract balance"
        );
        assertGt(address(vault).balance, balBefore, "contract balance must have increased");
        console2.log("[PASS] tax intake credited referralRewardsPoolAvailable exactly");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 12,26 / Rule 001,003,006 — bucket spending never exceeds credited
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 003, 006
    function test_managerOverCreditRevertsWithNoStateChange() public {
        _fundPool(1 ether);
        uint256 poolBefore = vault.referralRewardsPoolAvailable();

        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = poolBefore + 1; // exceeds available

        vm.startPrank(managerAddr);
        vm.expectRevert(bytes(unicode"Insufficient pool balance / 池余额不足"));
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        assertEq(vault.referralRewardsPoolAvailable(), poolBefore, "pool must be untouched after revert");
        assertEq(vault.getClaimable(alice), 0, "no claimable should be granted after revert");
        console2.log("[PASS] over-credit beyond pool reverts with no state change");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 13 / Rule 001,003,006 — payout credited from pool before claim
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 003, 006
    function test_payoutCreditedBeforeClaimIsPossible() public {
        _fundPool(2 ether);

        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0.7 ether;

        // Before crediting, claim must fail
        vm.startPrank(alice);
        vm.expectRevert(bytes(unicode"Nothing to claim / 无可领取金额"));
        vault.claimReferralReward();
        vm.stopPrank();

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        assertEq(vault.getClaimable(alice), 0.7 ether, "credit must be reflected in state before claim");

        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();

        console2.log("[PASS] state credited before claim is possible; claim succeeds afterward");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 14 / Rule 001,003,006 — cannot drain unrelated buckets / no double-claim
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 003, 006
    function test_claimCannotDoubleClaimOrTouchOtherBuckets() public {
        _fundPool(2 ether);
        uint256 poolBeforeCredit = vault.referralRewardsPoolAvailable();

        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0.4 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        uint256 poolAfterCredit = vault.referralRewardsPoolAvailable();

        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();

        // Pool available (a separate bucket from claimable) must remain unaffected by the claim itself
        assertEq(
            vault.referralRewardsPoolAvailable(),
            poolAfterCredit,
            "claiming must not further touch referralRewardsPoolAvailable"
        );
        assertEq(poolBeforeCredit - poolAfterCredit, 0.4 ether, "credit debited pool by exact amount");

        vm.startPrank(alice);
        vm.expectRevert(bytes(unicode"Nothing to claim / 无可领取金额"));
        vault.claimReferralReward();
        vm.stopPrank();

        console2.log("[PASS] no double-claim; unrelated bucket accounting untouched");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journeys 15,16,17,20 / Rule 001,003,006 — per-user isolation between Alice & Bob
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 003, 006
    function test_aliceAndBobEachClaimOwnRewardIndependently() public {
        _fundPool(3 ether);

        address[] memory users = new address[](2);
        users[0] = alice;
        users[1] = bob;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1 ether;
        amounts[1] = 0.3 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        uint256 aliceBefore = alice.balance;
        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();
        uint256 aliceAfter = alice.balance;

        // Alice's claim must not have touched Bob's reserved balance
        assertEq(vault.getClaimable(bob), 0.3 ether, "Bob's claimable must be untouched by Alice's claim");
        assertEq(aliceAfter - aliceBefore, 1 ether, "Alice receives exactly her own amount");

        uint256 bobBefore = bob.balance;
        vm.startPrank(bob);
        vault.claimReferralReward();
        vm.stopPrank();
        uint256 bobAfter = bob.balance;

        assertEq(bobAfter - bobBefore, 0.3 ether, "Bob receives exactly his own amount");
        assertEq(vault.getClaimable(alice), 0, "Alice claimable stays zero");
        assertEq(vault.getClaimable(bob), 0, "Bob claimable now zero after his own claim");

        console2.log("[PASS] Alice and Bob each claimed exactly their own reserved amounts");
    }

    /// Rules 001, 003, 006
    function test_bobCannotClaimAliceReward() public {
        _fundPool(2 ether);

        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0.8 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        // Bob has no claimable — his claim call pays nothing / reverts
        vm.startPrank(bob);
        vm.expectRevert(bytes(unicode"Nothing to claim / 无可领取金额"));
        vault.claimReferralReward();
        vm.stopPrank();

        // Alice's entitlement is preserved regardless of Bob's attempt
        assertEq(vault.getClaimable(alice), 0.8 ether, "Alice's claimable must remain intact");

        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();

        // Alice repeat-claim reverts
        vm.startPrank(alice);
        vm.expectRevert(bytes(unicode"Nothing to claim / 无可领取金额"));
        vault.claimReferralReward();
        vm.stopPrank();

        console2.log("[PASS] Bob cannot claim Alice's reward; Alice cannot double-claim");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 18 / Rule 001,006 — crediting reserves per-user amounts, not shared
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 006
    function test_creditingSecondUserDoesNotLetFirstSweepEverything() public {
        _fundPool(2 ether);

        address[] memory usersA = new address[](1);
        usersA[0] = alice;
        uint256[] memory amountsA = new uint256[](1);
        amountsA[0] = 0.6 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(usersA, amountsA);
        vm.stopPrank();

        address[] memory usersB = new address[](1);
        usersB[0] = bob;
        uint256[] memory amountsB = new uint256[](1);
        amountsB[0] = 0.4 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(usersB, amountsB);
        vm.stopPrank();

        assertEq(vault.getClaimable(alice), 0.6 ether, "Alice's earlier credit must be untouched by later credit");
        assertEq(vault.getClaimable(bob), 0.4 ether, "Bob's credit reserved independently");

        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();

        // Alice claiming must not have swept Bob's reserved amount
        assertEq(vault.getClaimable(bob), 0.4 ether, "Bob's reserved amount must survive Alice's claim");
        console2.log("[PASS] second credit does not let first claimant sweep everything");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 19 / Rule 001,004,006 — off-chain review disclosure
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 004, 006
    function test_offChainReviewIsDisclosed() public view {
        string memory desc = vault.description();
        assertTrue(bytes(desc).length > 0, "description() must be non-empty");
        // The MechanicSpec explicitly discloses that referral volume/tier data is
        // computed off-chain by the manager and cannot be verified on-chain.
        bool disclosesOffChain = _contains(desc, unicode"off-chain")
            || _contains(desc, unicode"off-chain referral computation")
            || _contains(desc, unicode"cannot be verified on-chain");
        assertTrue(disclosesOffChain, "description() must disclose off-chain computation review");
        console2.log("[PASS] off-chain review process disclosed in description()");
    }

    function _contains(string memory what, string memory needle) internal pure returns (bool) {
        bytes memory w = bytes(what);
        bytes memory n = bytes(needle);
        if (n.length == 0 || w.length < n.length) return false;
        for (uint256 i = 0; i <= w.length - n.length; i++) {
            bool matchFound = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (w[i + j] != n[j]) {
                    matchFound = false;
                    break;
                }
            }
            if (matchFound) return true;
        }
        return false;
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 20 / Rule 001,003,006 — claim pays per-user mapping, never raw pool
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 003, 006
    function test_claimPaysOwnEntryNeverRawPoolValue() public {
        _fundPool(5 ether);

        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0.9 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        uint256 poolAvailable = vault.referralRewardsPoolAvailable();
        assertGt(poolAvailable, 0.9 ether, "pool still holds funds beyond alice's credited entry");

        uint256 before = alice.balance;
        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();
        uint256 received = alice.balance - before;

        assertEq(received, 0.9 ether, "Alice must receive exactly her own claimableRewards entry");
        assertTrue(received != poolAvailable, "claim amount must not equal the raw pool balance");
        console2.log("[PASS] claim paid exactly the per-user mapping value, not the raw pool");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 21 / Rule 009,006 — emergency path exists and is disclosed
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 009, 006
    function test_emergencyPathExistsAndDisclosed() public {
        string memory desc = vault.description();
        assertTrue(_contains(desc, unicode"Rule 009") || _contains(desc, "guardian"), "must disclose guardian role");

        _fundPool(1 ether);

        vm.startPrank(guardianAddr);
        vault.setPaused(true);
        vm.stopPrank();

        assertTrue(vault.isPaused(), "vault should report paused");

        // Manager cannot credit while paused
        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0.1 ether;

        vm.startPrank(managerAddr);
        vm.expectRevert(bytes(unicode"Vault paused / 金库已暂停"));
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        // Unpause and restore normal function
        vm.startPrank(guardianAddr);
        vault.setPaused(false);
        vm.stopPrank();
        assertFalse(vault.isPaused(), "vault should be unpaused again");

        console2.log("[PASS] emergency pause path exists, is guardian-gated, and disclosed");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 29 / Rule 001,003,006,009 — guardian pause blocks manager + claims work
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 001, 003, 006, 009
    function test_guardianPauseBlocksNewCreditingButClaimsStillWork() public {
        _fundPool(2 ether);

        // Credit alice before pausing so she has a pre-existing claimable balance.
        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0.5 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        vm.startPrank(guardianAddr);
        vault.setPaused(true);
        vm.stopPrank();

        // New crediting blocked while paused
        address[] memory users2 = new address[](1);
        users2[0] = bob;
        uint256[] memory amounts2 = new uint256[](1);
        amounts2[0] = 0.2 ether;

        vm.startPrank(managerAddr);
        vm.expectRevert(bytes(unicode"Vault paused / 金库已暂停"));
        vault.creditReferralRewards(users2, amounts2);
        vm.stopPrank();

        // Existing claim (already reserved before pause) must still succeed per spec design
        uint256 before = alice.balance;
        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();
        assertEq(alice.balance - before, 0.5 ether, "reserved claims remain payable while paused");

        // View functions remain callable while paused
        vault.isPaused();
        vault.getPoolBalance();
        vault.manager();
        vault.guardian();

        vm.startPrank(guardianAddr);
        vault.setPaused(false);
        vm.stopPrank();

        console2.log("[PASS] pause blocks new crediting; reserved claims and views remain functional");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 30 / Rule 003,006,009 — guardian rescue only touches unreserved funds
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 003, 006, 009
    function test_guardianRescueOnlyTouchesUnreservedPool() public {
        _fundPool(3 ether);

        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        uint256 reservedBefore = vault.totalReserved();
        uint256 availableBefore = vault.referralRewardsPoolAvailable();
        uint256 vaultBalBefore = address(vault).balance;

        assertGe(vaultBalBefore, reservedBefore, "vault balance must fully back reserved claimables before rescue");

        vm.startPrank(guardianAddr);
        vault.guardianRescueUnreservedPool(randomUser);
        vm.stopPrank();

        assertEq(vault.referralRewardsPoolAvailable(), 0, "unreserved pool must be fully drained");
        assertEq(vault.totalReserved(), reservedBefore, "reserved amounts must be untouched by rescue");

        uint256 vaultBalAfter = address(vault).balance;
        assertEq(vaultBalBefore - vaultBalAfter, availableBefore, "only unreserved pool BNB should leave the vault");
        assertGe(vaultBalAfter, vault.totalReserved(), "remaining balance must still fully back claimable rewards");

        // Alice can still claim her reserved amount after the rescue
        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();

        console2.log("[PASS] guardian rescue only withdrew unreserved pool; reserved claims remained backed");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journeys 31–35 — core invariants (single-call style checks)
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 003, 006 — invariant: balance >= sum(claimableRewards)
    function test_invariant_balanceCoversAllClaimables() public {
        _fundPool(4 ether);

        address[] memory users = new address[](2);
        users[0] = alice;
        users[1] = bob;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1.2 ether;
        amounts[1] = 0.8 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        assertGe(
            address(vault).balance,
            vault.claimableRewards(alice) + vault.claimableRewards(bob),
            "contract balance must cover the sum of all claimable rewards"
        );
        console2.log("[PASS] balance-covers-claimables invariant holds");
    }

    /// Rules 006 — invariant: referrerOf set at most once
    function test_invariant_referrerImmutableAfterFirstSet() public {
        vm.startPrank(alice);
        vault.setReferrer(bob);
        vm.stopPrank();

        address before = vault.getReferrer(alice);

        vm.startPrank(alice);
        vm.expectRevert(bytes(unicode"Referrer already set / 推荐人已设置"));
        vault.setReferrer(randomUser);
        vm.stopPrank();

        assertEq(vault.getReferrer(alice), before, "referrer must never change once set");
        console2.log("[PASS] referrer-immutability invariant holds");
    }

    /// Rules 001, 003, 006 — invariant: pool debits equal claimable credits
    function test_invariant_poolDebitsEqualClaimableCredits() public {
        _fundPool(2 ether);
        uint256 poolBefore = vault.referralRewardsPoolAvailable();

        address[] memory users = new address[](2);
        users[0] = alice;
        users[1] = bob;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 0.3 ether;
        amounts[1] = 0.4 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        uint256 poolAfter = vault.referralRewardsPoolAvailable();
        uint256 creditedSum = vault.getClaimable(alice) + vault.getClaimable(bob);

        assertEq(poolBefore - poolAfter, creditedSum, "pool debit must equal total claimable credit");
        console2.log("[PASS] pool-debit-equals-credit invariant holds");
    }

    /// Rules 003, 006 — invariant: claim never pays more than caller's own balance
    function test_invariant_claimNeverExceedsOwnBalance() public {
        _fundPool(1 ether);

        address[] memory users = new address[](1);
        users[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0.35 ether;

        vm.startPrank(managerAddr);
        vault.creditReferralRewards(users, amounts);
        vm.stopPrank();

        uint256 expected = vault.getClaimable(alice);
        uint256 before = alice.balance;

        vm.startPrank(alice);
        vault.claimReferralReward();
        vm.stopPrank();

        uint256 received = alice.balance - before;
        assertEq(received, expected, "claim must pay exactly the caller's own claimable balance, never more");
        console2.log("[PASS] claim-never-exceeds-own-balance invariant holds");
    }

    /// Rules 006 — invariant: receive() never reverts / stays under gas cap
    function test_invariant_receiveNeverRevertsUnderGasCap() public {
        _fundPool(0.001 ether);
        _fundPool(1 ether);
        _fundPool(0); // zero-value deposit must also not revert
        console2.log("[PASS] receive() never reverted across multiple deposit sizes, incl. zero-value");
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Journey 36 / Rule 004,006 — extra methods beyond spec smoke-tested
    // ──────────────────────────────────────────────────────────────────────────

    /// Rules 004, 006
    function test_extraMethodsSmokeCovered() public {
        // setPaused / isPaused (guardian-only, disclosed as Rule 009 pause control)
        vm.startPrank(guardianAddr);
        vault.setPaused(true);
        vm.stopPrank();
        assertTrue(vault.isPaused(), "setPaused(true) should be reflected by isPaused()");
        vm.startPrank(guardianAddr);
        vault.setPaused(false);
        vm.stopPrank();
        assertFalse(vault.isPaused(), "setPaused(false) should be reflected by isPaused()");

        // guardianRescueUnreservedPool smoke (non-zero pool)
        _fundPool(0.1 ether);
        vm.startPrank(guardianAddr);
        vault.guardianRescueUnreservedPool(randomUser);
        vm.stopPrank();
        assertEq(vault.referralRewardsPoolAvailable(), 0, "rescue should drain unreserved pool");

        // manager() / guardian() views
        assertEq(vault.manager(), managerAddr, "manager() view smoke");
        assertEq(vault.guardian(), guardianAddr, "guardian() view smoke");

        console2.log("[PASS] all extra methods beyond the core spec were smoke-tested");
    }
}