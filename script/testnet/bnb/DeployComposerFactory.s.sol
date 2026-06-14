// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {ComposerVaultFactory} from "src/ComposerVault.sol";

/// @title DeployComposerFactory
/// @dev forge script script/testnet/bnb/DeployComposerFactory.s.sol:DeployComposerFactory \
///      --rpc-url https://bsc-testnet-dataseed.bnbchain.org --broadcast --verify
contract DeployComposerFactory is Script {
    function run() external {
        vm.startBroadcast();
        ComposerVaultFactory factory = new ComposerVaultFactory();
        console.log("ComposerVaultFactory deployed at:", address(factory));
        vm.stopBroadcast();
    }
}
