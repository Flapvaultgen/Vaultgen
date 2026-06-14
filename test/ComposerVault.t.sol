// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {ComposerVault, ComposerVaultFactory} from "../src/ComposerVault.sol";
import {IComposerTypes} from "../src/IComposerTypes.sol";

contract ComposerVaultTest is Test, IComposerTypes {
    ComposerVaultFactory factory;
    address creator = makeAddr("creator");

    function setUp() public {
        factory = new ComposerVaultFactory();
    }

    function test_receive_splitAndTreasury() public {
        SplitRecipient[] memory recipients = new SplitRecipient[](2);
        recipients[0] = SplitRecipient({recipient: address(0xA11CE), bps: 6000});
        recipients[1] = SplitRecipient({recipient: address(0xB22CE), bps: 4000});

        ComposerBlock[] memory blocks = new ComposerBlock[](1);
        blocks[0] = ComposerBlock({blockType: BlockType.SPLIT, data: abi.encode(recipients)});

        ComposerConfig memory cfg =
            ComposerConfig({templateName: "Marketing Split", creatorFeeBps: 500, blocks: blocks});

        ComposerVault vault = new ComposerVault(
            address(0x0000000000000000000000000000000000000100), creator, address(factory), cfg
        );

        vm.deal(address(vault), 0);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);

        assertEq(address(0xA11CE).balance, 0.57 ether);
        assertEq(address(0xB22CE).balance, 0.38 ether);
        assertEq(creator.balance, 0.05 ether);
    }

    function test_claim_pool() public {
        ComposerBlock[] memory blocks = new ComposerBlock[](1);
        blocks[0] = ComposerBlock({
            blockType: BlockType.CLAIM_POOL,
            data: abi.encode(uint16(10_000), uint256(0.1 ether), uint256(0))
        });

        ComposerConfig memory cfg = ComposerConfig({templateName: "Rain", creatorFeeBps: 0, blocks: blocks});

        ComposerVault vault = new ComposerVault(
            address(0x0000000000000000000000000000000000000100), creator, address(factory), cfg
        );

        vm.deal(address(vault), 0);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);

        (uint256 budget,,,) = vault.getPoolInfo();
        assertEq(budget, 1 ether);

        address user = address(0x1111);
        vm.prank(user);
        vault.claim();
        assertEq(user.balance, 0.1 ether);
    }
}
