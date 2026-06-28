// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {ERC20} from "@openzeppelin/token/ERC20/ERC20.sol";

/// @notice Minimal ERC20 for sandbox vault testing (holder checks, enter(), stake(), etc.).
contract SandboxTaxToken is ERC20 {
    constructor(address holder) ERC20("Sandbox Tax Token", "STAX") {
        _mint(holder, 1_000_000 * 1e18);
    }
}
