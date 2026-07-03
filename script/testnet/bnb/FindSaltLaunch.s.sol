// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;
import {Script, console2} from "forge-std/Script.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";

contract FindSaltLaunch is Script {
    address constant TOKEN_IMPL = 0xE6Ff967a887084c16D0fD71548CF709542cc1557;
    address constant CLONE_FACTORY = 0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9;
    address constant USED1 = 0x5e8406Fa9135f3e8Da4be7085dD6AcBDBbf17777;
    address constant USED2 = 0xCaD16E8C2812a479244D1fB6100c354A2Da17777;
    address constant USED3 = 0x6499166491d181341a142bA3DDA90659fefc7777;

    function run() external view {
        bytes32 salt = keccak256(abi.encodePacked(uint256(1)));
        for (uint256 i = 0; i < 20_000_000; i++) {
            address predicted = ClonesUpgradeable.predictDeterministicAddress(TOKEN_IMPL, salt, CLONE_FACTORY);
            if (uint160(predicted) & 0xFFFF == 0x7777 && predicted != USED1 && predicted != USED2 && predicted != USED3) {
                console2.logBytes32(salt);
                console2.log("Predicted:", predicted);
                return;
            }
            salt = bytes32(uint256(salt) + 1);
        }
    }
}
