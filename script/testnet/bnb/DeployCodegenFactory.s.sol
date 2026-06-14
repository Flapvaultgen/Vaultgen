// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {CodegenVaultFactory} from "src/CodegenVaultFactory.sol";

/// @title DeployCodegenFactory (BNB testnet)
/// @dev forge script script/testnet/bnb/DeployCodegenFactory.s.sol:DeployCodegenFactory \
///      --rpc-url https://bsc-testnet-dataseed.bnbchain.org --broadcast --verify
///
///      Deploys the CodegenVaultFactory, which deploys AI-generated vault bytecode at
///      launch. Generated code is UNAUDITED — testnet only until each vault is audited.
contract DeployCodegenFactory is Script {
    function run() external {
        vm.startBroadcast();
        CodegenVaultFactory factory = new CodegenVaultFactory();
        console.log("CodegenVaultFactory (testnet) deployed at:", address(factory));
        vm.stopBroadcast();
    }
}
