/**
 * Deterministic selfchecks for newTokenV6WithVault validation + error decoding.
 * Run: npm run test:launch  (from web/)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodeErrorResult, toFunctionSelector, toFunctionSignature } from "viem";
import {
  DEFAULT_LAUNCH_TAX_BPS,
  LAUNCH_CHAIN_ID,
  LAUNCH_FUNCTION_SIGNATURE,
  LAUNCH_PORTAL_ADDRESS,
  MAX_PORTAL_TAX_BPS,
  VAULT_PORTAL_LAUNCH_ABI,
  buildLaunchCallContext,
  checkLaunchPayload,
  decodeLaunchRevert,
} from "../src/lib/launch-validation";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));

// ── 1. ABI includes newTokenV6WithVault ──────────────────────────────────────

const portalSource = readFileSync(join(here, "../../src/flap/IVaultPortal.sol"), "utf8");
check(
  "Solidity IVaultPortal.newTokenV6WithVault present",
  /function newTokenV6WithVault\(/.test(portalSource)
);

const launchFn = VAULT_PORTAL_LAUNCH_ABI.find((e) => e.type === "function" && e.name === "newTokenV6WithVault");
check("frontend ABI includes newTokenV6WithVault", launchFn !== undefined);
check(
  "LAUNCH_FUNCTION_SIGNATURE matches ABI selector",
  launchFn !== undefined &&
    toFunctionSelector(toFunctionSignature(launchFn as never)) ===
      toFunctionSelector("newTokenV6WithVault((string,string,string,uint8,bytes32,uint8,address,uint256,bytes,bytes32,bytes,uint8,uint8,uint16,uint16,uint64,uint64,uint16,uint16,uint16,uint16,uint256,address,address,uint8,address,bytes))")
);
check("LAUNCH_PORTAL_ADDRESS is BSC testnet vault portal", LAUNCH_PORTAL_ADDRESS === "0x027e3704fC5C16522e9393d04C60A3ac5c0d775f");
check("LAUNCH_CHAIN_ID is 97", LAUNCH_CHAIN_ID === 97);

for (const errName of ["InvalidTaxRate", "VaultFactoryNotRegistered", "NotRegistered", "DeployFailed"]) {
  check(
    `portal/factory error ${errName} in ABI`,
    VAULT_PORTAL_LAUNCH_ABI.some((e) => e.type === "error" && e.name === errName)
  );
}

// ── 2. launch argument validation ─────────────────────────────────────────────

const wallet = "0xceC6b3c84d0158FCa7b3B326E0e8d7798bcb3e39";
const factory = "0xAeD234De7f3DAe27F51976D1125510b8b7F0E4e0";

check("missing wallet rejected", checkLaunchPayload({ factoryAddress: factory })?.code === "wallet");
check(
  "unregistered vault rejected in registered mode",
  checkLaunchPayload({
    walletAddress: wallet,
    chainId: LAUNCH_CHAIN_ID,
    factoryAddress: factory,
    tokenName: "Test",
    tokenSymbol: "TST",
    registeredOnChain: false,
    vaultDataMode: "registered",
  })?.code === "not_registered"
);
check(
  "missing token name rejected",
  checkLaunchPayload({
    walletAddress: wallet,
    chainId: LAUNCH_CHAIN_ID,
    factoryAddress: factory,
    tokenName: "",
    tokenSymbol: "TST",
    registeredOnChain: true,
  })?.code === "name"
);
check(
  "tax above portal max rejected",
  checkLaunchPayload({
    walletAddress: wallet,
    chainId: LAUNCH_CHAIN_ID,
    factoryAddress: factory,
    tokenName: "Test",
    tokenSymbol: "TST",
    buyTaxRateBps: MAX_PORTAL_TAX_BPS + 1,
    registeredOnChain: true,
  })?.code === "buy_tax"
);
check(
  "negative dev buy rejected",
  checkLaunchPayload({
    walletAddress: wallet,
    chainId: LAUNCH_CHAIN_ID,
    factoryAddress: factory,
    tokenName: "Test",
    tokenSymbol: "TST",
    registeredOnChain: true,
    devBuyWei: -1n,
  })?.code === "dev_buy"
);
check(
  "malformed meta CID rejected",
  checkLaunchPayload({
    walletAddress: wallet,
    chainId: LAUNCH_CHAIN_ID,
    factoryAddress: factory,
    tokenName: "Test",
    tokenSymbol: "TST",
    registeredOnChain: true,
    metaCid: "not-a-cid",
  })?.code === "meta"
);
check(
  "valid CIDv1 meta accepted",
  checkLaunchPayload({
    walletAddress: wallet,
    chainId: LAUNCH_CHAIN_ID,
    factoryAddress: factory,
    tokenName: "Test",
    tokenSymbol: "TST",
    registeredOnChain: true,
    metaCid: "bafkreieepx7lh6zcpqsneo2jdeqmcgxjg7facam34w5ezh4myajjauuc24",
    devBuyWei: 50_000_000_000_000_000n, // 0.05 BNB dev buy
  }) === null
);
check(
  "valid registered payload passes",
  checkLaunchPayload({
    walletAddress: wallet,
    chainId: LAUNCH_CHAIN_ID,
    factoryAddress: factory,
    tokenName: "CharityVote",
    tokenSymbol: "CVV",
    buyTaxRateBps: DEFAULT_LAUNCH_TAX_BPS,
    sellTaxRateBps: DEFAULT_LAUNCH_TAX_BPS,
    registeredOnChain: true,
    vaultDataMode: "registered",
  }) === null
);

// ── 3. blank revert produces useful diagnostics ─────────────────────────────

const ctx = buildLaunchCallContext({
  wallet,
  factoryAddress: factory,
  tokenName: "CharityVote",
  tokenSymbol: "CVV",
  registeredOnChain: true,
});
const blankErr = new Error(
  'The contract function "newTokenV6WithVault" reverted with the following signature:'
);
const decodedBlank = decodeLaunchRevert(blankErr, ctx);
check("blank signature message is not returned verbatim", !decodedBlank.reason.includes("following signature:"));
check("blank revert includes portal address", decodedBlank.reason.includes(LAUNCH_PORTAL_ADDRESS));
check("blank revert mentions vaultData / registration", decodedBlank.reason.toLowerCase().includes("registered"));

// ── 4. custom error decoder ───────────────────────────────────────────────────

const notRegisteredData = encodeErrorResult({
  abi: VAULT_PORTAL_LAUNCH_ABI,
  errorName: "NotRegistered",
  args: [],
});
const customErr = { message: "execution reverted", data: notRegisteredData };
const decodedCustom = decodeLaunchRevert(customErr, ctx);
check("NotRegistered decoded with actionable message", decodedCustom.errorName === "NotRegistered");
check("NotRegistered mentions register step", decodedCustom.reason.toLowerCase().includes("register"));

// ── 5. launch gates / SQL / frontend safety ───────────────────────────────────

const launchPanel = readFileSync(join(here, "../src/components/LaunchOnFlapPanel.tsx"), "utf8");
check("launch button gated on isRegistered", launchPanel.includes("isRegistered") && launchPanel.includes("canLaunch"));
check("launch uses registered vaultData mode", launchPanel.includes('vaultDataMode: "registered"'));
check("Launch debug section exists", launchPanel.includes("Launch debug"));
check("launch panel has metadata fields (image/description/socials)", launchPanel.includes("uploadTokenMeta") && launchPanel.includes("tokenWebsite") && launchPanel.includes("tokenTwitter"));
check("launch panel has dev buy field", launchPanel.includes("devBuyBnb"));

const flapMeta = readFileSync(join(here, "../src/lib/flap-meta.ts"), "utf8");
check("meta upload targets Flap's pinning API", flapMeta.includes("funcs.flap.sh/api/upload"));
check("meta upload sends required fields", ["website", "twitter", "telegram", "description", "creator"].every((f) => flapMeta.includes(f)));

const flapLaunch = readFileSync(join(here, "../src/lib/flap-launch.ts"), "utf8");
check("launch params carry meta CID", flapLaunch.includes("input.metaCid"));
check("launch params carry dev buy as quoteAmt", flapLaunch.includes("input.devBuyWei"));
check("msg.value follows dev buy", flapLaunch.includes("launchPayableValue(input.devBuyWei)"));

const sql = readFileSync(join(here, "../../supabase/schema.sql"), "utf8");
check("launched_tokens table in schema.sql", sql.includes("create table if not exists launched_tokens"));
for (const col of ["wallet_address", "token_address", "buy_tax_bps", "launch_tx_hash", "gmgn_url"]) {
  check(`launched_tokens column ${col}`, sql.includes(col));
}

const migration = readFileSync(
  join(here, "../../supabase/migrations/20260708120000_launched_tokens.sql"),
  "utf8"
);
check("launched_tokens migration file exists", migration.includes("launched_tokens"));

const tokensPage = readFileSync(join(here, "../src/TokensPage.tsx"), "utf8");
const enDict = readFileSync(join(here, "../src/lib/i18n/en.ts"), "utf8");
// Page title text is localized (web/src/lib/i18n) rather than hardcoded — check the page
// renders the dictionary key and the English dictionary still has the expected copy.
check(
  "/tokens page compiles source exists",
  tokensPage.includes("dict.tokensPage.title") && enDict.includes("Launched tokens")
);

const chatApi = readFileSync(join(here, "../src/lib/chat-api.ts"), "utf8");
check("service role key not in frontend chat-api", !chatApi.includes("SERVICE_ROLE"));

const openaiModel = readFileSync(join(here, "../../server/openai-model.ts"), "utf8");
check("model routing still in openai-model.ts", openaiModel.includes("resolveOpenAiModel"));

const chatRoutes = readFileSync(join(here, "../../server/chat-routes.ts"), "utf8");
check("chat routes delegate model to openai-model", chatRoutes.includes("resolveOpenAiModel"));

// ── summary ───────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll launch validation selfchecks passed.");
