// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {VaultBaseV2} from "./flap/VaultBaseV2.sol";
import {VaultFactoryBaseV2} from "./flap/VaultFactoryBaseV2.sol";
import {IVaultFactory, IVaultFactoryValidationV2} from "./flap/IVaultFactory.sol";
import {
    VaultUISchema,
    VaultMethodSchema,
    VaultDataSchema,
    FieldDescriptor,
    ApproveAction
} from "./flap/IVaultSchemasV1.sol";
import {IComposerTypes} from "./IComposerTypes.sol";

/// @title ComposerVault
/// @notice Configurable tax-revenue router built from a no-code block pipeline.
contract ComposerVault is VaultBaseV2, ReentrancyGuard, IComposerTypes {
    uint256 public constant MAX_BLOCKS = 12;
    uint256 public constant MAX_RECIPIENTS = 10;
    uint256 public constant MAX_CREATOR_FEE_BPS = 1000;

    address public taxToken;
    address public templateCreator;
    address public factory;

    string public templateName;
    uint16 public creatorFeeBps;
    bytes public blocksData;

    uint256 public treasuryBalance;
    uint256 public poolBudget;

    bool public poolEnabled;
    uint256 public maxPerClaim;
    uint256 public claimCooldown;

    uint256 public nextClaimTime;
    mapping(address => bool) public hasClaimed;

    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event CommunityClaimed(address indexed claimer, uint256 amount);
    event PipelineExecuted(uint256 amountIn, uint256 treasuryAdded, uint256 poolAdded);

    constructor(
        address _taxToken,
        address _templateCreator,
        address _factory,
        ComposerConfig memory _config
    ) {
        taxToken = _taxToken;
        templateCreator = _templateCreator;
        factory = _factory;
        templateName = _config.templateName;
        creatorFeeBps = _config.creatorFeeBps;
        blocksData = abi.encode(_config.blocks);
        _initPoolFromConfig(_config.blocks);
    }

    receive() external payable {
        if (msg.value == 0) return;

        uint256 remaining = msg.value;
        uint256 treasuryAdded;
        uint256 poolAdded;

        if (creatorFeeBps > 0) {
            uint256 fee = (remaining * creatorFeeBps) / 10_000;
            if (fee > 0) {
                _sendNative(templateCreator, fee);
                remaining -= fee;
            }
        }

        ComposerBlock[] memory blocks = abi.decode(blocksData, (ComposerBlock[]));

        for (uint256 i = 0; i < blocks.length; i++) {
            if (remaining == 0) break;
            ComposerBlock memory block_ = blocks[i];

            if (block_.blockType == BlockType.SPLIT) {
                SplitRecipient[] memory recipients = abi.decode(block_.data, (SplitRecipient[]));
                remaining = _executeSplit(remaining, recipients);
            } else if (block_.blockType == BlockType.SEND) {
                (address to, uint16 bps) = abi.decode(block_.data, (address, uint16));
                (uint256 sent, uint256 left) = _takeBps(remaining, bps);
                if (sent > 0) _sendNative(to, sent);
                remaining = left;
            } else if (block_.blockType == BlockType.TREASURY) {
                uint16 bps = abi.decode(block_.data, (uint16));
                (uint256 slice, uint256 left) = _takeBps(remaining, bps);
                treasuryBalance += slice;
                treasuryAdded += slice;
                remaining = left;
            } else if (block_.blockType == BlockType.CLAIM_POOL) {
                (uint16 bps,,) = abi.decode(block_.data, (uint16, uint256, uint256));
                (uint256 slice, uint256 left) = _takeBps(remaining, bps);
                poolBudget += slice;
                poolAdded += slice;
                remaining = left;
            }
        }

        if (remaining > 0) {
            treasuryBalance += remaining;
            treasuryAdded += remaining;
        }

        emit PipelineExecuted(msg.value, treasuryAdded, poolAdded);
    }

    function claim() external nonReentrant {
        require(poolEnabled, "Claim pool disabled");
        require(!hasClaimed[msg.sender], "Already claimed");
        require(block.timestamp >= nextClaimTime, "Cooldown active");
        require(poolBudget > 0, "Pool empty");

        uint256 reward = address(this).balance;
        if (reward > maxPerClaim) reward = maxPerClaim;
        if (reward > poolBudget) reward = poolBudget;
        require(reward > 0, "Nothing to claim");

        hasClaimed[msg.sender] = true;
        nextClaimTime = block.timestamp + claimCooldown;
        poolBudget -= reward;

        _sendNative(msg.sender, reward);
        emit CommunityClaimed(msg.sender, reward);
    }

    function withdrawTreasury() external nonReentrant {
        require(msg.sender == templateCreator || msg.sender == _getGuardian(), "Not authorized");
        uint256 amount = treasuryBalance;
        require(amount > 0, "No treasury");

        treasuryBalance = 0;
        _sendNative(msg.sender, amount);
        emit TreasuryWithdrawn(msg.sender, amount);
    }

    function getPoolInfo()
        external
        view
        returns (uint256 budget, uint256 nextClaim, bool enabled, uint256 perClaimCap)
    {
        return (poolBudget, nextClaimTime, poolEnabled, maxPerClaim);
    }

    function description() public view override returns (string memory) {
        return string.concat(
            "ComposerVault [",
            templateName,
            "]: treasury ",
            _fmtWei(treasuryBalance),
            " BNB, pool ",
            _fmtWei(poolBudget),
            " BNB"
        );
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "ComposerVault";
        schema.description =
            "Configurable tax router. Withdraw treasury, or claim from the community pool if enabled.";

        schema.methods = new VaultMethodSchema[](3);
        uint256 idx;

        schema.methods[idx].name = "getPoolInfo";
        schema.methods[idx].description = "Community pool budget and claim timing.";
        schema.methods[idx].outputs = new FieldDescriptor[](4);
        schema.methods[idx].outputs[0] = FieldDescriptor("budget", "uint256", "Pool budget (BNB)", 18);
        schema.methods[idx].outputs[1] = FieldDescriptor("nextClaim", "time", "Next claim time", 0);
        schema.methods[idx].outputs[2] = FieldDescriptor("enabled", "bool", "Pool enabled", 0);
        schema.methods[idx].outputs[3] = FieldDescriptor("perClaimCap", "uint256", "Max per claim (BNB)", 18);
        idx++;

        schema.methods[idx].name = "claim";
        schema.methods[idx].description = "Claim once from the community pool (if enabled).";
        schema.methods[idx].isWriteMethod = true;
        idx++;

        schema.methods[idx].name = "withdrawTreasury";
        schema.methods[idx].description = "Withdraw accumulated treasury (creator or Guardian).";
        schema.methods[idx].isWriteMethod = true;
    }

    function _initPoolFromConfig(ComposerBlock[] memory blocks) internal {
        for (uint256 i = 0; i < blocks.length; i++) {
            if (blocks[i].blockType == BlockType.CLAIM_POOL) {
                (, uint256 cap, uint256 cd) = abi.decode(blocks[i].data, (uint16, uint256, uint256));
                poolEnabled = true;
                maxPerClaim = cap;
                claimCooldown = cd;
                break;
            }
        }
    }

    function _executeSplit(uint256 amount, SplitRecipient[] memory recipients)
        internal
        returns (uint256 remaining)
    {
        require(recipients.length > 0 && recipients.length <= MAX_RECIPIENTS, "Bad split size");

        uint256 totalBps;
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i].recipient != address(0), "Zero recipient");
            totalBps += recipients[i].bps;
        }
        require(totalBps == 10_000, "Split must total 100%");

        remaining = 0;
        uint256 distributed;
        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 share = (amount * recipients[i].bps) / 10_000;
            if (share > 0) {
                _sendNative(recipients[i].recipient, share);
                distributed += share;
            }
        }
        if (amount > distributed) remaining = amount - distributed;
    }

    function _takeBps(uint256 amount, uint16 bps) internal pure returns (uint256 slice, uint256 remaining) {
        require(bps <= 10_000, "Bps overflow");
        slice = (amount * bps) / 10_000;
        remaining = amount - slice;
    }

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

/// @title ComposerVaultFactory
/// @notice Single meta-factory for all no-code Composer templates.
contract ComposerVaultFactory is VaultFactoryBaseV2, IComposerTypes {
    function newVault(
        address taxToken,
        address,
        address creator,
        bytes calldata vaultData
    ) external override returns (address vault) {
        require(msg.sender == _getVaultPortal(), "Only VaultPortal");

        ComposerConfig memory cfg = abi.decode(vaultData, (ComposerConfig));
        _validateConfig(cfg);

        ComposerVault v = new ComposerVault(taxToken, creator, address(this), cfg);
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
            return (false, "ComposerVault supports native BNB only.");
        }
        return (true, "");
    }

    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description =
            unicode"Origin Composer — AI-generated original tax pipeline. Configure via Origin Vault AI Studio.";
        schema.fields = new FieldDescriptor[](1);
        schema.fields[0] = FieldDescriptor("configBytes", "bytes", "Encoded ComposerConfig from Origin AI Studio", 0);
        schema.isArray = false;
    }

    function _validateConfig(ComposerConfig memory cfg) internal pure {
        require(bytes(cfg.templateName).length > 0, "Name required");
        require(cfg.creatorFeeBps <= 1000, "Creator fee too high");
        require(cfg.blocks.length <= 12, "Too many blocks");

        for (uint256 i = 0; i < cfg.blocks.length; i++) {
            ComposerBlock memory block_ = cfg.blocks[i];
            if (block_.blockType == BlockType.SPLIT) {
                SplitRecipient[] memory recipients = abi.decode(block_.data, (SplitRecipient[]));
                require(recipients.length > 0 && recipients.length <= 10, "Bad split");
                uint256 total;
                for (uint256 j = 0; j < recipients.length; j++) {
                    require(recipients[j].recipient != address(0), "Zero recipient");
                    total += recipients[j].bps;
                }
                require(total == 10_000, "Split must total 100%");
            } else if (block_.blockType == BlockType.SEND) {
                (, uint16 bps) = abi.decode(block_.data, (address, uint16));
                require(bps > 0 && bps <= 10_000, "Bad send bps");
            } else if (block_.blockType == BlockType.TREASURY) {
                uint16 bps = abi.decode(block_.data, (uint16));
                require(bps > 0 && bps <= 10_000, "Bad treasury bps");
            } else if (block_.blockType == BlockType.CLAIM_POOL) {
                (uint16 bps, uint256 cap,) = abi.decode(block_.data, (uint16, uint256, uint256));
                require(bps > 0 && bps <= 10_000, "Bad pool bps");
                require(cap > 0, "Claim cap required");
            }
        }
    }
}
