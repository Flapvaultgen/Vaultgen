// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {MechanicVaultFactory} from "src/MechanicVault.sol";

/// @title DeployMechanicFactoryMainnet
/// @dev forge script script/mainnet/bnb/DeployMechanicFactory.s.sol:DeployMechanicFactoryMainnet \
///      --rpc-url https://bsc-dataseed.bnbchain.org --broadcast --verify
contract DeployMechanicFactoryMainnet is Script {
    function run() external {
        vm.startBroadcast();
        MechanicVaultFactory factory = new MechanicVaultFactory();
        console.log("MechanicVaultFactory deployed at:", address(factory));
        vm.stopBroadcast();
    }
}
