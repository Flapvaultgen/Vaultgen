// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console2} from "forge-std/Script.sol";
import {VaultDataSchema} from "src/flap/IVaultSchemasV1.sol";

interface ISchemaFactory {
    function vaultDataSchema() external view returns (VaultDataSchema memory);
}

/// forge script script/tools/DumpAllVaults.s.sol:DumpAllVaults --rpc-url https://bsc-dataseed.bnbchain.org
contract DumpAllVaults is Script {
    struct Entry {
        string label;
        address factory;
    }

    function run() external view {
        Entry[] memory list = _entries();
        for (uint256 i = 0; i < list.length; i++) {
            _dump(list[i].label, list[i].factory);
        }
    }

    function _entries() internal pure returns (Entry[] memory list) {
        list = new Entry[](30);
        uint256 i;
        list[i++] = Entry("gift_FlapXVault", 0xFb7ccc4Fd09Da5b7016A18d51e227Af4ABE53f44);
        list[i++] = Entry("split", 0xfab75Dc774cB9B38b91749B8833360B46a52345F);
        list[i++] = Entry("snowball_buyback_burn", 0xB64655dab7156c29B63C70fb3ED7f071e2658D19);
        list[i++] = Entry("community_approved_buyback", 0xC3e4EE8f3c616D16297fAfcB9daab122D31eFA9E);
        list[i++] = Entry("fixed_interval_buyback", 0xA248eaCb6831a98e5fd5bb71886C6132625AFb36);
        list[i++] = Entry("scheduled_buyback", 0x4ac94f87863012C4F133ef748b7cC5b75CAFE801);
        list[i++] = Entry("burn_dividend", 0x47A216040Dc9e0AfE2e6fc5dcC44f7bBD1B60d25);
        list[i++] = Entry("burn_nft_v2", 0x8b80BFaAdf48aa906ef9A44949D49b27bAab7621);
        list[i++] = Entry("silent", 0xCf83c4577D4c2E2A6BA48C0926046938802B74E6);
        list[i++] = Entry("lp_staking_dividend", 0x59F3b82Ea3aA3BCE6156CA61c0A6613C0A632452);
        list[i++] = Entry("lp_principal_hybrid", 0xd01A9D0f99Bd3539468a10db788F5701A805EA4D);
        list[i++] = Entry("lp_flexible_lock", 0x44d8b03236995086fABb5CbfCd5D25445D6B74e2);
        list[i++] = Entry("token_staking_dividend", 0xf68eE35A4fDe7a7C3e4baf01Dac019B4A90Fa1db);
        list[i++] = Entry("rank_burn_dividend", 0x9F5bF8EB9c4cA7179E60d0B529F4910B9A7eE0Ee);
        list[i++] = Entry("staking_lucky_draw", 0xf3056DAa77db106f25ba8c32EE78E5d40777fbaf);
        list[i++] = Entry("buffett", 0xFCe2509d232FB62dc15c9Bf2faDE69653e480a25);
        list[i++] = Entry("external_erc20_reward", 0xd83f73bA45C1a9FaA519d0792AfBbc8Bc2e6BA75);
        list[i++] = Entry("dream", 0xe4d06eCe2063B04C38AFE4b61DacA61954Cd3EfE);
        list[i++] = Entry("niwojie", 0xd5A0cB751c3F762c5d41d72EfD8ac989dD810bd5);
        list[i++] = Entry("flap_lending_v2", 0x30AcfA75fcbDF797eA0893fE449CA2A578B28913);
        list[i++] = Entry("flapixel", 0xeE37aC5885A70C5e527d47aEc9AfB2f6b7b83F1F);
        list[i++] = Entry("bonding_curve_vault", 0x40EE3bB4873606b84bBeD3fb3750DC35c6d78434);
        list[i++] = Entry("tax_token_floor", 0x1a039A8288547D290B9B246A72803bC4D214899a);
        list[i++] = Entry("survivor", 0x1483c37Ce8Cd59a014e4867234e54973914cE039);
        list[i++] = Entry("nsts_vault", 0x470f75e938Ace4e3A467F6841B7FDaA7b2205d8e);
        list[i++] = Entry("short_meme_v2", 0x20b10a49A6e4767BabD56484b6317C34e1F9c5cB);
        list[i++] = Entry("diamond_pulse", 0x17108D8152189B3dD27cD2C54b645F022517f223);
        list[i++] = Entry("diamond_pulse_legacy", 0x7332830272c6E33d06AdDf607F9D949Fe5aBCB12);
        list[i++] = Entry("block_collision_lottery", 0x74B37E02A947E57707DAe7819fca37494b4E4E64);
        list[i++] = Entry("ai_smart_buyback", 0x7c8781B21FB004308a5a2bB7F9cB1E2e6Bd1fC7E);
    }

    function _dump(string memory label, address factory) internal view {
        console2.log("====");
        console2.logString(label);
        console2.log("factory", factory);
        uint256 size;
        assembly {
            size := extcodesize(factory)
        }
        console2.log("codeSize", size);
        if (size == 0) {
            console2.log("EMPTY_ADDRESS");
            return;
        }
        try ISchemaFactory(factory).vaultDataSchema() returns (VaultDataSchema memory s) {
            console2.log("hasSchema", uint256(1));
            console2.log("isArray", s.isArray);
            console2.log("fieldCount", s.fields.length);
            console2.logString(s.description);
            for (uint256 j = 0; j < s.fields.length; j++) {
                console2.log("---field", j);
                console2.logString(s.fields[j].name);
                console2.logString(s.fields[j].fieldType);
                console2.logString(s.fields[j].description);
                console2.log("decimals", s.fields[j].decimals);
            }
        } catch {
            console2.log("hasSchema", uint256(0));
        }
    }
}
