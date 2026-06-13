// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {VaultBaseV2} from "./flap/VaultBaseV2.sol";
import {VaultFactoryBaseV2} from "./flap/VaultFactoryBaseV2.sol";
import {IVaultFactory, IVaultFactoryValidationV2} from "./flap/IVaultFactory.sol";
import {IPortalTradeV2} from "./flap/IPortal.sol";
import {
    VaultUISchema,
    VaultMethodSchema,
    VaultDataSchema,
    FieldDescriptor,
    ApproveAction
} from "./flap/IVaultSchemasV1.sol";
import {IMechanicTypes} from "./IMechanicTypes.sol";

/// @title MechanicVault
/// @notice A tax-funded engine that runs REAL on-chain mechanics — not just BNB routing.
///
/// @dev DESIGN PRINCIPLES
///      - `receive()` is intentionally CHEAP: it performs pure accounting only
///        (no external calls), so tax dispatch can never be bricked and the 1M gas
///        receive() budget is respected with large margin.
///      - All heavy work (Portal swaps, payouts) happens in separate, explicitly
///        callable functions (keeper / pull pattern).
///      - All payouts are pull-based.
///
///      MECHANICS
///      1. BUYBACK & BURN — `executeBuyback()` spends the buyback budget buying the
///         tax token from the Flap Portal (bonding curve or DEX) and burns it.
///         This is a genuine bonding-curve interaction, creating real buy pressure.
///      2. SURVIVOR — hold-to-survive elimination. Participants `join`, anyone may
///         `eliminate` holders whose balance dropped below the survival threshold
///         (a verifiable on-chain condition), and survivors split the pot per round.
///      3. RAFFLE — eligible holders `enter`; after each round `drawRaffle()` pays a
///         pseudo-random entrant. Randomness is documented as non-secure; production
///         deployments should upgrade the draw to FlapTriggerService / an oracle.
///      4. TREASURY + CREATOR FEE — pull-based withdrawals.
contract MechanicVault is VaultBaseV2, ReentrancyGuard, IMechanicTypes {
    uint16 public constant MAX_CREATOR_FEE_BPS = 1000;
    address public constant BURN_ADDRESS = 0x00576E4Fb32296Cd973A0d413D0379609400DEad;

    // ── Immutable-ish config ──────────────────────────────────────────────
    address public taxToken;
    address public templateCreator;
    address public factory;

    string public templateName;
    uint16 public creatorFeeBps;
    uint16 public buybackBps;
    uint16 public survivorBps;
    uint16 public raffleBps;
    uint16 public treasuryBps;

    uint256 public survivorHoldThreshold;
    uint256 public survivorRoundDuration;
    uint256 public raffleMinHold;
    uint256 public raffleRoundDuration;

    uint256 public deployTime;

    // ── Accounting buckets ────────────────────────────────────────────────
    uint256 public creatorFeeAccrued;
    uint256 public treasuryBalance;
    uint256 public buybackBudget;

    uint256 public totalBoughtBack; // BNB spent on buyback
    uint256 public totalTokensBurned; // tokens removed from circulation

    // ── Survivor state ────────────────────────────────────────────────────
    uint256 public survivorPot; // accrues to the CURRENT round
    uint256 public currentSurvivorRound; // starts at 1
    mapping(uint256 => address[]) public survivorParticipants;
    mapping(uint256 => mapping(address => bool)) public survivorJoined;
    mapping(uint256 => mapping(address => bool)) public survivorAlive;
    mapping(uint256 => mapping(address => bool)) public survivorClaimed;
    mapping(uint256 => uint256) public survivorAliveCount;
    mapping(uint256 => uint256) public survivorRoundPot; // finalized pot for an ended round
    mapping(uint256 => uint256) public survivorRoundSurvivors; // finalized survivor count

    // ── Raffle state ──────────────────────────────────────────────────────
    uint256 public currentRaffleRound; // starts at 1
    mapping(uint256 => uint256) public rafflePrize; // prize accrued per round
    mapping(uint256 => address[]) public raffleEntrants;
    mapping(uint256 => mapping(address => bool)) public raffleEntered;
    mapping(uint256 => address) public raffleWinner;
    uint256 private raffleNonce;

    // ── Events ────────────────────────────────────────────────────────────
    event Funded(uint256 amount, uint256 toBuyback, uint256 toSurvivor, uint256 toRaffle, uint256 toTreasury);
    event BuybackExecuted(uint256 bnbSpent, uint256 tokensBought, uint256 tokensBurned);
    event SurvivorJoined(uint256 indexed round, address indexed player);
    event SurvivorEliminated(uint256 indexed round, address indexed player);
    event SurvivorRoundEnded(uint256 indexed round, uint256 pot, uint256 survivors);
    event SurvivorClaimed(uint256 indexed round, address indexed player, uint256 amount);
    event RaffleEntered(uint256 indexed round, address indexed player);
    event RaffleDrawn(uint256 indexed round, address indexed winner, uint256 prize);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event CreatorFeeWithdrawn(address indexed to, uint256 amount);

    constructor(address _taxToken, address _creator, address _factory, MechanicConfig memory cfg) {
        taxToken = _taxToken;
        templateCreator = _creator;
        factory = _factory;

        templateName = cfg.templateName;
        creatorFeeBps = cfg.creatorFeeBps;
        buybackBps = cfg.buybackBps;
        survivorBps = cfg.survivorBps;
        raffleBps = cfg.raffleBps;
        treasuryBps = cfg.treasuryBps;

        survivorHoldThreshold = cfg.survivorHoldThreshold;
        survivorRoundDuration = cfg.survivorRoundDuration;
        raffleMinHold = cfg.raffleMinHold;
        raffleRoundDuration = cfg.raffleRoundDuration;

        deployTime = block.timestamp;
        currentSurvivorRound = 1;
        currentRaffleRound = 1;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  FUNDING — cheap, pure accounting (no external calls)
    // ══════════════════════════════════════════════════════════════════════

    receive() external payable {
        uint256 amount = msg.value;
        if (amount == 0) return;

        uint256 remaining = amount;

        if (creatorFeeBps > 0) {
            uint256 fee = (amount * creatorFeeBps) / 10_000;
            creatorFeeAccrued += fee;
            remaining -= fee;
        }

        uint256 toBuyback = (remaining * buybackBps) / 10_000;
        uint256 toSurvivor = (remaining * survivorBps) / 10_000;
        uint256 toRaffle = (remaining * raffleBps) / 10_000;

        uint256 allocated = toBuyback + toSurvivor + toRaffle;
        uint256 toTreasury = remaining - allocated; // treasuryBps slice + any leftover

        if (toBuyback > 0) buybackBudget += toBuyback;
        if (toSurvivor > 0) survivorPot += toSurvivor;
        if (toRaffle > 0) rafflePrize[currentRaffleRound] += toRaffle;
        if (toTreasury > 0) treasuryBalance += toTreasury;

        emit Funded(amount, toBuyback, toSurvivor, toRaffle, toTreasury);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  BUYBACK & BURN — real bonding-curve / DEX interaction
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Spend the buyback budget buying the tax token from the Flap Portal,
    ///         then burn the proceeds. Sandwich-sensitive, so restricted to creator
    ///         or Guardian with a caller-supplied slippage floor.
    /// @param minTokensOut Minimum tokens to receive (slippage protection).
    function executeBuyback(uint256 minTokensOut) external nonReentrant {
        require(msg.sender == templateCreator || msg.sender == _getGuardian(), "Not authorized");
        uint256 budget = buybackBudget;
        require(budget > 0, "No buyback budget");

        buybackBudget = 0;

        IPortalTradeV2.ExactInputParams memory params = IPortalTradeV2.ExactInputParams({
            inputToken: address(0), // BNB in
            outputToken: taxToken, // tax token out
            inputAmount: budget,
            minOutputAmount: minTokensOut,
            permitData: ""
        });

        uint256 bought = IPortalTradeV2(_getPortal()).swapExactInput{value: budget}(params);
        totalBoughtBack += budget;

        uint256 burned = _burnTokens();
        emit BuybackExecuted(budget, bought, burned);
    }

    /// @dev Attempt to burn all tax tokens held by the vault. If the token blocks the
    ///      transfer to the burn address, the tokens stay locked in the vault — still
    ///      removed from circulation (buyback-and-lock fallback).
    function _burnTokens() internal returns (uint256 burned) {
        uint256 bal = IERC20(taxToken).balanceOf(address(this));
        if (bal == 0) return 0;
        try IERC20(taxToken).transfer(BURN_ADDRESS, bal) returns (bool ok) {
            if (ok) {
                totalTokensBurned += bal;
                return bal;
            }
        } catch {}
        return 0; // locked in vault
    }

    // ══════════════════════════════════════════════════════════════════════
    //  SURVIVOR — hold-to-survive elimination
    // ══════════════════════════════════════════════════════════════════════

    function survivorRoundEnd(uint256 round) public view returns (uint256) {
        return deployTime + (round * survivorRoundDuration);
    }

    /// @notice Join the current survivor round. Must hold >= threshold right now.
    function joinSurvivor() external {
        require(survivorBps > 0 && survivorRoundDuration > 0, "Survivor disabled");
        uint256 round = currentSurvivorRound;
        require(block.timestamp < survivorRoundEnd(round), "Round closed");
        require(!survivorJoined[round][msg.sender], "Already joined");
        require(IERC20(taxToken).balanceOf(msg.sender) >= survivorHoldThreshold, "Below threshold");

        survivorJoined[round][msg.sender] = true;
        survivorAlive[round][msg.sender] = true;
        survivorParticipants[round].push(msg.sender);
        survivorAliveCount[round] += 1;

        emit SurvivorJoined(round, msg.sender);
    }

    /// @notice Eliminate participants whose balance dropped below the threshold.
    ///         Permissionless for liveness — the condition is objective and on-chain.
    function eliminate(address[] calldata players) external {
        uint256 round = currentSurvivorRound;
        for (uint256 i = 0; i < players.length; i++) {
            address p = players[i];
            if (!survivorAlive[round][p]) continue;
            if (IERC20(taxToken).balanceOf(p) < survivorHoldThreshold) {
                survivorAlive[round][p] = false;
                survivorAliveCount[round] -= 1;
                emit SurvivorEliminated(round, p);
            }
        }
    }

    /// @notice Close the current survivor round and snapshot the pot for claiming.
    function endSurvivorRound() external {
        uint256 round = currentSurvivorRound;
        require(survivorBps > 0 && survivorRoundDuration > 0, "Survivor disabled");
        require(block.timestamp >= survivorRoundEnd(round), "Round not over");

        survivorRoundPot[round] = survivorPot;
        survivorRoundSurvivors[round] = survivorAliveCount[round];
        survivorPot = 0;
        currentSurvivorRound = round + 1;

        emit SurvivorRoundEnded(round, survivorRoundPot[round], survivorRoundSurvivors[round]);
    }

    /// @notice Claim an equal share of an ended round's pot. Must still hold >= threshold.
    function claimSurvivor(uint256 round) external nonReentrant {
        require(round < currentSurvivorRound, "Round not ended");
        require(survivorAlive[round][msg.sender], "Not a survivor");
        require(!survivorClaimed[round][msg.sender], "Already claimed");
        uint256 survivors = survivorRoundSurvivors[round];
        require(survivors > 0, "No survivors");
        require(IERC20(taxToken).balanceOf(msg.sender) >= survivorHoldThreshold, "No longer holding");

        survivorClaimed[round][msg.sender] = true;
        uint256 share = survivorRoundPot[round] / survivors;
        require(share > 0, "Nothing to claim");

        _sendNative(msg.sender, share);
        emit SurvivorClaimed(round, msg.sender, share);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  RAFFLE — holder lottery
    // ══════════════════════════════════════════════════════════════════════

    function raffleRoundEnd(uint256 round) public view returns (uint256) {
        return deployTime + (round * raffleRoundDuration);
    }

    /// @notice Enter the current raffle round. Must hold >= raffleMinHold.
    function enterRaffle() external {
        require(raffleBps > 0 && raffleRoundDuration > 0, "Raffle disabled");
        uint256 round = currentRaffleRound;
        require(block.timestamp < raffleRoundEnd(round), "Round closed");
        require(!raffleEntered[round][msg.sender], "Already entered");
        require(IERC20(taxToken).balanceOf(msg.sender) >= raffleMinHold, "Below min hold");

        raffleEntered[round][msg.sender] = true;
        raffleEntrants[round].push(msg.sender);

        emit RaffleEntered(round, msg.sender);
    }

    /// @notice Draw the current raffle round and pay the winner.
    /// @dev Randomness is NON-SECURE (block-derived). For production, upgrade the draw
    ///      to FlapTriggerService / a verifiable oracle. With no entrants the prize
    ///      carries over to the next round.
    function drawRaffle() external nonReentrant {
        require(raffleBps > 0 && raffleRoundDuration > 0, "Raffle disabled");
        uint256 round = currentRaffleRound;
        require(block.timestamp >= raffleRoundEnd(round), "Round not over");

        address[] storage entrants = raffleEntrants[round];
        uint256 prize = rafflePrize[round];

        if (entrants.length == 0) {
            // Carry prize to next round
            currentRaffleRound = round + 1;
            rafflePrize[round + 1] += prize;
            rafflePrize[round] = 0;
            emit RaffleDrawn(round, address(0), 0);
            return;
        }

        uint256 idx = _pseudoRandom(round, entrants.length) % entrants.length;
        address winner = entrants[idx];

        rafflePrize[round] = 0;
        raffleWinner[round] = winner;
        currentRaffleRound = round + 1;

        if (prize > 0) _sendNative(winner, prize);
        emit RaffleDrawn(round, winner, prize);
    }

    function _pseudoRandom(uint256 round, uint256 entropy) internal returns (uint256) {
        raffleNonce++;
        return uint256(
            keccak256(
                abi.encodePacked(blockhash(block.number - 1), block.timestamp, block.prevrandao, round, entropy, raffleNonce)
            )
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    //  TREASURY + CREATOR FEE — pull based
    // ══════════════════════════════════════════════════════════════════════

    function withdrawTreasury() external nonReentrant {
        require(msg.sender == templateCreator || msg.sender == _getGuardian(), "Not authorized");
        uint256 amount = treasuryBalance;
        require(amount > 0, "No treasury");
        treasuryBalance = 0;
        _sendNative(msg.sender, amount);
        emit TreasuryWithdrawn(msg.sender, amount);
    }

    function withdrawCreatorFee() external nonReentrant {
        require(msg.sender == templateCreator || msg.sender == _getGuardian(), "Not authorized");
        uint256 amount = creatorFeeAccrued;
        require(amount > 0, "No fee");
        creatorFeeAccrued = 0;
        _sendNative(templateCreator, amount);
        emit CreatorFeeWithdrawn(templateCreator, amount);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  VIEWS
    // ══════════════════════════════════════════════════════════════════════

    function getStats()
        external
        view
        returns (
            uint256 _buybackBudget,
            uint256 _survivorPot,
            uint256 _currentRafflePrize,
            uint256 _treasury,
            uint256 _creatorFee,
            uint256 _totalBoughtBack,
            uint256 _totalBurned
        )
    {
        return (
            buybackBudget,
            survivorPot,
            rafflePrize[currentRaffleRound],
            treasuryBalance,
            creatorFeeAccrued,
            totalBoughtBack,
            totalTokensBurned
        );
    }

    function survivorParticipantCount(uint256 round) external view returns (uint256) {
        return survivorParticipants[round].length;
    }

    function raffleEntrantCount(uint256 round) external view returns (uint256) {
        return raffleEntrants[round].length;
    }

    function description() public view override returns (string memory) {
        return string.concat(
            "MechanicVault [",
            templateName,
            "]: bought back ",
            _fmtWei(totalBoughtBack),
            " BNB, treasury ",
            _fmtWei(treasuryBalance),
            " BNB"
        );
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "MechanicVault";
        schema.description =
            "Tax-funded engine: buyback & burn, hold-to-survive elimination, holder raffle, and treasury.";

        schema.methods = new VaultMethodSchema[](7);
        uint256 idx;

        schema.methods[idx].name = "getStats";
        schema.methods[idx].description = "Current budgets and lifetime buyback/burn totals.";
        schema.methods[idx].outputs = new FieldDescriptor[](7);
        schema.methods[idx].outputs[0] = FieldDescriptor("buybackBudget", "uint256", "Pending buyback (BNB)", 18);
        schema.methods[idx].outputs[1] = FieldDescriptor("survivorPot", "uint256", "Survivor pot (BNB)", 18);
        schema.methods[idx].outputs[2] = FieldDescriptor("rafflePrize", "uint256", "Raffle prize (BNB)", 18);
        schema.methods[idx].outputs[3] = FieldDescriptor("treasury", "uint256", "Treasury (BNB)", 18);
        schema.methods[idx].outputs[4] = FieldDescriptor("creatorFee", "uint256", "Creator fee (BNB)", 18);
        schema.methods[idx].outputs[5] = FieldDescriptor("totalBoughtBack", "uint256", "Lifetime buyback (BNB)", 18);
        schema.methods[idx].outputs[6] = FieldDescriptor("totalBurned", "uint256", "Tokens burned", 18);
        idx++;

        schema.methods[idx].name = "executeBuyback";
        schema.methods[idx].description = "Buy the token from the bonding curve and burn it (creator/Guardian).";
        schema.methods[idx].inputs = new FieldDescriptor[](1);
        schema.methods[idx].inputs[0] = FieldDescriptor("minTokensOut", "uint256", "Min tokens (slippage)", 18);
        schema.methods[idx].isWriteMethod = true;
        idx++;

        schema.methods[idx].name = "joinSurvivor";
        schema.methods[idx].description = "Join the current survivor round (must hold the threshold).";
        schema.methods[idx].isWriteMethod = true;
        idx++;

        schema.methods[idx].name = "claimSurvivor";
        schema.methods[idx].description = "Claim your share of an ended survivor round.";
        schema.methods[idx].inputs = new FieldDescriptor[](1);
        schema.methods[idx].inputs[0] = FieldDescriptor("round", "uint256", "Survivor round", 0);
        schema.methods[idx].isWriteMethod = true;
        idx++;

        schema.methods[idx].name = "enterRaffle";
        schema.methods[idx].description = "Enter the current raffle round (must hold the minimum).";
        schema.methods[idx].isWriteMethod = true;
        idx++;

        schema.methods[idx].name = "drawRaffle";
        schema.methods[idx].description = "Draw the current raffle round and pay the winner.";
        schema.methods[idx].isWriteMethod = true;
        idx++;

        schema.methods[idx].name = "withdrawTreasury";
        schema.methods[idx].description = "Withdraw accumulated treasury (creator or Guardian).";
        schema.methods[idx].isWriteMethod = true;
    }

    // ── internal helpers ──────────────────────────────────────────────────

    function _sendNative(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "Transfer failed");
    }

    function _fmtWei(uint256 weiAmount) internal pure returns (string memory) {
        if (weiAmount == 0) return "0";
        uint256 whole = weiAmount / 1e18;
        uint256 frac = (weiAmount % 1e18) / 1e16;
        return string.concat(_u(whole), ".", _pad2(frac));
    }

    function _u(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _pad2(uint256 value) internal pure returns (string memory) {
        if (value < 10) return string.concat("0", _u(value));
        return _u(value);
    }
}

/// @title MechanicVaultFactory
/// @notice Single meta-factory for all MechanicVault templates. Each template is a
///         unique encoded `MechanicConfig` — one factory address serves every product.
contract MechanicVaultFactory is VaultFactoryBaseV2, IMechanicTypes {
    function newVault(address taxToken, address, address creator, bytes calldata vaultData)
        external
        override
        returns (address vault)
    {
        require(msg.sender == _getVaultPortal(), "Only VaultPortal");

        MechanicConfig memory cfg = abi.decode(vaultData, (MechanicConfig));
        _validateConfig(cfg);

        MechanicVault v = new MechanicVault(taxToken, creator, address(this), cfg);
        vault = address(v);
    }

    function isQuoteTokenSupported(address quoteToken) external pure override returns (bool supported) {
        supported = quoteToken == address(0);
    }

    function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
        internal
        pure
        override
        returns (bool success, string memory reason)
    {
        if (data.quoteToken != address(0)) {
            return (false, "MechanicVault supports native BNB only.");
        }
        return (true, "");
    }

    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description =
            unicode"MechanicVault — AI-generated original engine (buyback/burn, survivor, raffle, treasury). Configure via Origin Vault AI Studio.";
        schema.fields = new FieldDescriptor[](1);
        schema.fields[0] = FieldDescriptor("configBytes", "bytes", "Encoded MechanicConfig from Origin AI Studio", 0);
        schema.isArray = false;
    }

    function _validateConfig(MechanicConfig memory cfg) internal pure {
        require(bytes(cfg.templateName).length > 0, "Name required");
        require(cfg.creatorFeeBps <= MAX_CREATOR_FEE_BPS_LIB(), "Creator fee too high");

        uint256 sum =
            uint256(cfg.buybackBps) + uint256(cfg.survivorBps) + uint256(cfg.raffleBps) + uint256(cfg.treasuryBps);
        require(sum <= 10_000, "Allocation > 100%");
        require(sum > 0, "No allocation");

        if (cfg.survivorBps > 0) {
            require(cfg.survivorRoundDuration > 0, "Survivor needs duration");
            require(cfg.survivorHoldThreshold > 0, "Survivor needs threshold");
        }
        if (cfg.raffleBps > 0) {
            require(cfg.raffleRoundDuration > 0, "Raffle needs duration");
            require(cfg.raffleMinHold > 0, "Raffle needs min hold");
        }
    }

    function MAX_CREATOR_FEE_BPS_LIB() internal pure returns (uint16) {
        return 1000;
    }
}
