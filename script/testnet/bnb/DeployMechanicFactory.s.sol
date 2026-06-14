// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {MechanicVaultFactory} from "src/MechanicVault.sol";

/// @title DeployMechanicFactory
/// @dev forge script script/testnet/bnb/DeployMechanicFactory.s.sol:DeployMechanicFactory \
///      --rpc-url https://bsc-testnet-dataseed.bnbchain.org --broadcast --verify
contract DeployMechanicFactory is Script {
    function run() external {
        vm.startBroadcast();
        MechanicVaultFactory factory = new MechanicVaultFactory();
        console.log("MechanicVaultFactory deployed at:", address(factory));
        vm.stopBroadcast();
    }
}
