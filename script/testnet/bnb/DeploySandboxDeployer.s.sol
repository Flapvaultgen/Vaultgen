// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {CodegenVaultSandboxDeployer} from "src/CodegenVaultSandboxDeployer.sol";

/// @title DeploySandboxDeployer (BNB testnet)
/// @dev forge script script/testnet/bnb/DeploySandboxDeployer.s.sol:DeploySandboxDeployer \
///      --rpc-url https://bsc-testnet-dataseed.bnbchain.org --broadcast
///
///      Deploy once, then set sandboxDeployer in web/public/config.json (or VITE_SANDBOX_DEPLOYER).
contract DeploySandboxDeployer is Script {
    function run() external {
        vm.startBroadcast();
        CodegenVaultSandboxDeployer deployer = new CodegenVaultSandboxDeployer();
        console.log("CodegenVaultSandboxDeployer (testnet):", address(deployer));
        vm.stopBroadcast();
    }
}
