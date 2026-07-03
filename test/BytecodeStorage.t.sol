// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test, console} from "forge-std/Test.sol";
import {BytecodeStorage} from "../src/BytecodeStorage.sol";

/// @dev BytecodeStorage's functions are `internal`; this harness exposes them as external
///      calls so tests can measure real transaction-shaped gas usage.
contract BytecodeStorageHarness {
    address[] public lastPointers;

    function write(bytes calldata data) external returns (address[] memory pointers) {
        pointers = BytecodeStorage.write(data);
        lastPointers = pointers;
    }

    function read(address[] memory pointers) external view returns (bytes memory) {
        return BytecodeStorage.read(pointers);
    }

    function writeAndRead(bytes calldata data) external returns (bytes memory) {
        address[] memory pointers = BytecodeStorage.write(data);
        return BytecodeStorage.read(pointers);
    }
}

contract BytecodeStorageTest is Test {
    BytecodeStorageHarness harness;

    function setUp() public {
        harness = new BytecodeStorageHarness();
    }

    function _randomBytes(uint256 len, uint256 seed) internal pure returns (bytes memory data) {
        data = new bytes(len);
        bytes32 chunk;
        for (uint256 i = 0; i < len; i++) {
            if (i % 32 == 0) chunk = keccak256(abi.encode(seed, i));
            data[i] = chunk[i % 32];
        }
    }

    function test_roundTrip_singleChunkExactBoundary() public {
        // Exactly MAX_CHUNK_SIZE (24,575) — must fit in one pointer contract.
        bytes memory data = _randomBytes(24_575, 1);
        uint256 gasBefore = gasleft();
        address[] memory pointers = harness.write(data);
        console.log("BytecodeStorage.write gas for 24,575 bytes (1 chunk):", gasBefore - gasleft());
        assertEq(pointers.length, 1, "single chunk at the boundary");
        assertEq(harness.read(pointers), data, "round-trips exactly");
    }

    function test_roundTrip_justOverBoundaryNeedsTwoChunks() public {
        // One byte over the boundary — must split into two pointer contracts.
        bytes memory data = _randomBytes(24_576, 2);
        address[] memory pointers = harness.write(data);
        assertEq(pointers.length, 2, "splits into two chunks");
        assertEq(harness.read(pointers), data, "round-trips exactly across the split");
    }

    function test_roundTrip_realisticGeneratedVaultSize() public {
        // Matches the ~37KB creation bytecode size reported in production.
        bytes memory data = _randomBytes(37_141, 3);
        address[] memory pointers = harness.write(data);
        assertEq(pointers.length, 2, "37,141 bytes needs exactly two chunks");
        assertEq(harness.read(pointers), data, "round-trips exactly");
    }

    function test_roundTrip_maxInitCodeSize() public {
        // The factory's MAX_INIT_CODE (49,152) — worst case, needs three chunks.
        bytes memory data = _randomBytes(49_152, 4);
        address[] memory pointers = harness.write(data);
        assertEq(pointers.length, 3, "49,152 bytes needs three chunks");
        assertEq(harness.read(pointers), data, "round-trips exactly");
    }

    function test_roundTrip_tinyPayload() public {
        bytes memory data = _randomBytes(4, 5);
        address[] memory pointers = harness.write(data);
        assertEq(pointers.length, 1, "tiny payload still gets a pointer");
        assertEq(harness.read(pointers), data, "round-trips exactly");
    }

    /// @dev The whole point of this library: writing a large blob must fit comfortably under
    ///      the ~16.7M gas send cap enforced by public BSC RPC nodes, unlike plain SSTORE.
    function test_gasCost_realisticVaultUnderKnownRpcCap() public {
        bytes memory data = _randomBytes(37_141, 6);
        uint256 gasBefore = gasleft();
        harness.write(data);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("BytecodeStorage.write gas for 37,141 bytes:", gasUsed);
        assertLt(gasUsed, 16_777_216, "37KB write must stay under the known public-RPC gas cap");
    }

    function test_gasCost_maxSizeUnderKnownRpcCap() public {
        bytes memory data = _randomBytes(49_152, 7);
        uint256 gasBefore = gasleft();
        harness.write(data);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("BytecodeStorage.write gas for 49,152 bytes:", gasUsed);
        assertLt(gasUsed, 16_777_216, "max-size (49,152 byte) write must stay under the known public-RPC gas cap");
    }
}
