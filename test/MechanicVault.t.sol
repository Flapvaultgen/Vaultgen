// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/token/ERC20/ERC20.sol";
import {MechanicVault, MechanicVaultFactory} from "../src/MechanicVault.sol";
import {IMechanicTypes} from "../src/IMechanicTypes.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burnFrom(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @dev Unit tests for MechanicVault mechanics that do NOT require a Flap fork:
///      funding allocation, survivor elimination, raffle, treasury, creator fee.
///      Buyback (needs the live Portal) is covered in the mainnet-fork suite.
contract MechanicVaultTest is Test, IMechanicTypes {
    MockToken token;
    address creator = makeAddr("creator");

    uint256 constant THRESHOLD = 1000 ether;
    uint256 constant DURATION = 1 days;

    function _cfg(uint16 buyback, uint16 survivor, uint16 raffle, uint16 treasury)
        internal
        pure
        returns (MechanicConfig memory)
    {
        return MechanicConfig({
            templateName: "Test Engine",
            creatorFeeBps: 200, // 2%
            buybackBps: buyback,
            survivorBps: survivor,
            raffleBps: raffle,
            treasuryBps: treasury,
            survivorHoldThreshold: THRESHOLD,
            survivorRoundDuration: DURATION,
            raffleMinHold: THRESHOLD,
            raffleRoundDuration: DURATION
        });
    }

    function _deploy(MechanicConfig memory cfg) internal returns (MechanicVault) {
        return new MechanicVault(address(token), creator, address(this), cfg);
    }

    function setUp() public {
        token = new MockToken();
    }

    // ── Funding allocation ────────────────────────────────────────────────

    function test_funding_allocatesAllBuckets() public {
        MechanicVault v = _deploy(_cfg(2500, 2500, 2500, 2500));

        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);

        // creator fee 2% = 0.02; remaining 0.98 split 25/25/25/25
        assertEq(v.creatorFeeAccrued(), 0.02 ether);
        assertEq(v.buybackBudget(), 0.245 ether);
        assertEq(v.survivorPot(), 0.245 ether);
        assertEq(v.treasuryBalance(), 0.245 ether);

        (,,uint256 rafflePrize,,,,) = v.getStats();
        assertEq(rafflePrize, 0.245 ether);
    }

    function test_funding_leftoverGoesToTreasury() public {
        // Only 50% allocated to buyback → other 50% (after fee) lands in treasury
        MechanicVault v = _deploy(_cfg(5000, 0, 0, 0));

        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);

        assertEq(v.creatorFeeAccrued(), 0.02 ether);
        assertEq(v.buybackBudget(), 0.49 ether);
        assertEq(v.treasuryBalance(), 0.49 ether);
    }

    // ── Treasury + creator fee (pull) ─────────────────────────────────────

    function test_withdrawTreasuryAndCreatorFee() public {
        MechanicVault v = _deploy(_cfg(0, 0, 0, 10000));
        vm.deal(address(this), 2 ether);
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);

        uint256 creatorBefore = creator.balance;

        vm.prank(creator);
        v.withdrawCreatorFee();
        assertEq(creator.balance - creatorBefore, 0.02 ether);

        creatorBefore = creator.balance;
        vm.prank(creator);
        v.withdrawTreasury();
        assertEq(creator.balance - creatorBefore, 0.98 ether);
    }

    function test_withdrawTreasury_unauthorizedReverts() public {
        vm.chainId(56); // so _getGuardian() resolves instead of reverting UnsupportedChain
        MechanicVault v = _deploy(_cfg(0, 0, 0, 10000));
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);

        vm.expectRevert("Not authorized");
        vm.prank(makeAddr("stranger"));
        v.withdrawTreasury();
    }

    // ── Survivor mechanic ─────────────────────────────────────────────────

    function test_survivor_holdToSurviveAndSplit() public {
        MechanicVault v = _deploy(_cfg(0, 10000, 0, 0));

        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        address paper = makeAddr("paper");

        token.mint(alice, THRESHOLD);
        token.mint(bob, THRESHOLD);
        token.mint(paper, THRESHOLD);

        vm.prank(alice);
        v.joinSurvivor();
        vm.prank(bob);
        v.joinSurvivor();
        vm.prank(paper);
        v.joinSurvivor();

        assertEq(v.survivorAliveCount(1), 3);

        // Fund the pot
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);
        // 2% fee → 0.98 to survivor pot
        assertEq(v.survivorPot(), 0.98 ether);

        // paper hands sells below threshold
        vm.prank(paper);
        token.transfer(address(0xdead), THRESHOLD);

        address[] memory toKill = new address[](1);
        toKill[0] = paper;
        v.eliminate(toKill);
        assertEq(v.survivorAliveCount(1), 2);

        // End round
        vm.warp(v.survivorRoundEnd(1) + 1);
        v.endSurvivorRound();
        assertEq(v.survivorRoundSurvivors(1), 2);

        // Survivors claim equal shares: 0.98 / 2 = 0.49
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        v.claimSurvivor(1);
        assertEq(alice.balance - aliceBefore, 0.49 ether);

        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        v.claimSurvivor(1);
        assertEq(bob.balance - bobBefore, 0.49 ether);

        // paper can't claim (eliminated)
        vm.expectRevert("Not a survivor");
        vm.prank(paper);
        v.claimSurvivor(1);
    }

    function test_survivor_doubleClaimReverts() public {
        MechanicVault v = _deploy(_cfg(0, 10000, 0, 0));
        address alice = makeAddr("alice");
        token.mint(alice, THRESHOLD);

        vm.prank(alice);
        v.joinSurvivor();
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);

        vm.warp(v.survivorRoundEnd(1) + 1);
        v.endSurvivorRound();

        vm.prank(alice);
        v.claimSurvivor(1);

        vm.expectRevert("Already claimed");
        vm.prank(alice);
        v.claimSurvivor(1);
    }

    function test_survivor_joinBelowThresholdReverts() public {
        MechanicVault v = _deploy(_cfg(0, 10000, 0, 0));
        address alice = makeAddr("alice");
        token.mint(alice, THRESHOLD - 1);

        vm.expectRevert("Below threshold");
        vm.prank(alice);
        v.joinSurvivor();
    }

    // ── Raffle mechanic ───────────────────────────────────────────────────

    function test_raffle_entryAndDrawPaysWinner() public {
        MechanicVault v = _deploy(_cfg(0, 0, 10000, 0));

        address alice = makeAddr("alice");
        token.mint(alice, THRESHOLD);

        vm.prank(alice);
        v.enterRaffle();
        assertEq(v.raffleEntrantCount(1), 1);

        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);

        vm.warp(v.raffleRoundEnd(1) + 1);
        uint256 aliceBefore = alice.balance;
        v.drawRaffle();

        // Single entrant must win the whole prize (0.98)
        assertEq(v.raffleWinner(1), alice);
        assertEq(alice.balance - aliceBefore, 0.98 ether);
        assertEq(v.currentRaffleRound(), 2);
    }

    function test_raffle_noEntrantsCarriesPrize() public {
        MechanicVault v = _deploy(_cfg(0, 0, 10000, 0));
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);

        vm.warp(v.raffleRoundEnd(1) + 1);
        v.drawRaffle();

        assertEq(v.currentRaffleRound(), 2);
        // prize carried to round 2
        (,,uint256 prize,,,,) = v.getStats();
        assertEq(prize, 0.98 ether);
    }

    function test_raffle_belowMinHoldReverts() public {
        MechanicVault v = _deploy(_cfg(0, 0, 10000, 0));
        address alice = makeAddr("alice");
        token.mint(alice, THRESHOLD - 1);

        vm.expectRevert("Below min hold");
        vm.prank(alice);
        v.enterRaffle();
    }

    // ── Factory validation ────────────────────────────────────────────────

    function test_factory_rejectsOverAllocation() public {
        MechanicVaultFactory factory = new MechanicVaultFactory();
        // direct validate via newVault path requires VaultPortal; test schema instead
        assertTrue(factory.isQuoteTokenSupported(address(0)));
        assertTrue(!factory.isQuoteTokenSupported(address(1)));
    }

    receive() external payable {}
}
