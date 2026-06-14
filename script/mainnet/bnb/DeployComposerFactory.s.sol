// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {ComposerVaultFactory} from "src/ComposerVault.sol";

/// @title DeployComposerFactoryMainnet
/// @dev forge script script/mainnet/bnb/DeployComposerFactory.s.sol:DeployComposerFactoryMainnet \
///      --rpc-url https://bsc-dataseed.bnbchain.org --broadcast --verify
contract DeployComposerFactoryMainnet is Script {
    function run() external {
        vm.startBroadcast();
        ComposerVaultFactory factory = new ComposerVaultFactory();
        console.log("ComposerVaultFactory deployed at:", address(factory));
        vm.stopBroadcast();
    }
}
