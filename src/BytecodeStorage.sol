// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @title BytecodeStorage
/// @notice SSTORE2-style storage for large `bytes` blobs, chunked to respect EIP-170.
///
/// @dev  WHY THIS EXISTS
///       Storing bytes in a regular `mapping(address => bytes)` costs ~20,000 gas per
///       32-byte word (SSTORE on a cold slot) — a 37KB blob needs ~23M gas just for
///       storage, which exceeds the ~16.7M gas-per-transaction cap enforced by most
///       public BSC RPC nodes (`--rpc.gascap`), even though the chain's real block gas
///       limit (~100M on BSC testnet) has plenty of room. That cap is a widely-deployed
///       node-operator default, not something callers can route around by trying a
///       different public RPC — every major public BSC testnet endpoint enforces it.
///
///       Instead, each chunk is deployed as a tiny contract's RUNTIME code (the classic
///       "SSTORE2" trick: CODECOPY the chunk into memory at deploy time and RETURN it,
///       so `EXTCODECOPY` reads it back later). Code deposit costs ~200 gas/byte versus
///       SSTORE's ~625 gas/byte for a fresh slot — roughly a 3x reduction, comfortably
///       under the RPC cap for realistic generated-vault sizes (tens of KB).
///
///       EIP-170 caps any single deployed contract's runtime code at 24,576 bytes, so a
///       blob larger than that (minus our 1-byte STOP prefix) is split across multiple
///       pointer contracts and reassembled on read.
library BytecodeStorage {
    error EmptyChunk();
    error ChunkDeployFailed();
    error PointerNotFound();

    /// @dev EIP-170 max contract size (24,576) minus the 1-byte STOP prefix each pointer needs.
    uint256 internal constant MAX_CHUNK_SIZE = 24_575;

    /// @notice Splits `data` into `MAX_CHUNK_SIZE` pieces and deploys each as a pointer contract.
    function write(bytes calldata data) internal returns (address[] memory pointers) {
        uint256 len = data.length;
        uint256 chunkCount = (len + MAX_CHUNK_SIZE - 1) / MAX_CHUNK_SIZE;
        pointers = new address[](chunkCount);

        for (uint256 i = 0; i < chunkCount; i++) {
            uint256 start = i * MAX_CHUNK_SIZE;
            uint256 end = start + MAX_CHUNK_SIZE;
            if (end > len) end = len;
            pointers[i] = _writeChunk(data[start:end]);
        }
    }

    /// @notice Reads back every chunk (in order) and concatenates them into the original blob.
    function read(address[] memory pointers) internal view returns (bytes memory data) {
        uint256 total = 0;
        uint256[] memory sizes = new uint256[](pointers.length);
        for (uint256 i = 0; i < pointers.length; i++) {
            address pointer = pointers[i];
            if (pointer == address(0)) revert PointerNotFound();
            uint256 codeSize;
            assembly {
                codeSize := extcodesize(pointer)
            }
            if (codeSize == 0) revert PointerNotFound();
            uint256 chunkSize = codeSize - 1; // minus the STOP prefix
            sizes[i] = chunkSize;
            total += chunkSize;
        }

        data = new bytes(total);
        uint256 offset = 0;
        for (uint256 i = 0; i < pointers.length; i++) {
            address pointer = pointers[i];
            uint256 chunkSize = sizes[i];
            assembly {
                extcodecopy(pointer, add(add(data, 32), offset), 1, chunkSize)
            }
            offset += chunkSize;
        }
    }

    /// @dev Deploys `chunk` as a pointer contract's runtime code (classic SSTORE2 layout):
    ///      a 14-byte init-code preamble that CODECOPYs + RETURNs everything after itself,
    ///      with the chunk prefixed by a STOP opcode so the pointer can never be called into.
    function _writeChunk(bytes calldata chunk) private returns (address pointer) {
        if (chunk.length == 0) revert EmptyChunk();

        bytes memory runtimeCode = abi.encodePacked(bytes1(0x00), chunk);
        bytes memory creationCode = abi.encodePacked(
            hex"63",
            uint32(runtimeCode.length), // PUSH4 <runtime code length>
            hex"80600E6000396000F3", // DUP1; PUSH1 14; PUSH1 0; CODECOPY; PUSH1 0; RETURN
            runtimeCode
        );

        assembly {
            pointer := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        if (pointer == address(0)) revert ChunkDeployFailed();
    }
}
