// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console2} from "forge-std/Script.sol";
import {VaultDataSchema, FieldDescriptor} from "src/flap/IVaultSchemasV1.sol";

interface ISchemaFactory {
    function vaultDataSchema() external view returns (VaultDataSchema memory);
}

contract DumpVaultSchemas is Script {
    function run() external view {
        address[28] memory factories = [
            0xFb7ccc4Fd09Da5b7016A18d51e227Af4ABE53f44,
            0xfab75Dc774cB9B38b91749B8833360B46a52345F,
            0xB64655dab7156c29B63C70fb3ED7f071e2658D19,
            0xC3e4EE8f3c616D16297fAfcB9daab122D31eFA9E,
            0xA248eaCb6831a98e5fd5bb71886C6132625AFb36,
            0x4ac94f87863012C4F133ef748b7cC5b75CAFE801,
            0x47A216040Dc9e0AfE2e6fc5dcC44f7bBD1B60d25,
            0x8b80BFaAdf48aa906ef9A44949D49b27bAab7621,
            0xCf83c4577D4c2E2A6BA48C0926046938802B74E6,
            0x59F3b82Ea3aA3BCE6156CA61c0A6613C0A632452,
            0xd01A9D0f99Bd3539468a10db788F5701A805EA4D,
            0x44d8b03236995086fABb5CbfCd5D25445D6B74e2,
            0xf68eE35A4fDe7a7C3e4baf01Dac019B4A90Fa1db,
            0x9F5bF8EB9c4cA7179E60d0B529F4910B9A7eE0Ee,
            0xf3056DAa77db106f25ba8c32EE78E5d40777fbaf,
            0xFCe2509d232FB62dc15c9Bf2faDE69653e480a25,
            0xd83f73bA45C1a9FaA519d0792AfBbc8Bc2e6BA75,
            0xe4d06eCe2063B04C38AFE4b61DacA61954Cd3EfE,
            0xd5A0cB751c3F762c5d41d72EfD8ac989dD810bd5,
            0x30AcfA75fcbDF797eA0893fE449CA2A578B28913,
            0xeE37aC5885A70C5e527d47aEc9AfB2f6b7b83F1F,
            0x40EE3bB4873606b84bBeD3fb3750DC35c6d78434,
            0x1a039A8288547D290B9B246A72803bC4D214899a,
            0x1483c37Ce8Cd59a014e4867234e54973914cE039,
            0x470f75e938Ace4e3A467F6841B7FDaA7b2205d8e,
            0x20b10a49A6e4767BabD56484b6317C34e1F9c5cB,
            0x17108D8152189B3dD27cD2C54b645F022517f223,
            0x74B37E02A947E57707DAe7819fca37494b4E4E64
        ];

        for (uint256 i = 0; i < factories.length; i++) {
            _dump(factories[i]);
        }
    }

    function _dump(address factory) internal view {
        console2.log("FACTORY", factory);
        try ISchemaFactory(factory).vaultDataSchema() returns (VaultDataSchema memory s) {
            console2.log("HAS_SCHEMA", true);
            console2.log("isArray", s.isArray);
            console2.log("fields", s.fields.length);
            console2.logString(s.description);
            for (uint256 i = 0; i < s.fields.length; i++) {
                console2.log("FIELD", i);
                console2.logString(s.fields[i].name);
                console2.logString(s.fields[i].fieldType);
            }
        } catch {
            console2.log("HAS_SCHEMA", false);
        }
    }
}
