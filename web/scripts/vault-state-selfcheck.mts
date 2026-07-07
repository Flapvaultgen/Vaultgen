/**
 * Deterministic selfcheck for mergeVaultState (web/src/lib/chat-api.ts) — the
 * function that folds every "launch_status" artifact for a chat into the
 * current factory/register/launch picture. This is what makes the launch
 * flow database-backed instead of localStorage-backed: it must fold events
 * in chronological order and never lose an earlier field a later event
 * didn't touch.
 *
 * Run: npm run test:vault-state  (from web/)
 */
import { mergeVaultState, type VaultStateArtifact } from "../src/lib/vault-state";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function artifact(
  createdAt: string,
  metadata: Record<string, unknown>,
  artifactType = "launch_status"
): VaultStateArtifact {
  return { artifactType, metadata, createdAt };
}

// Empty input yields an all-null snapshot, never throws.
const empty = mergeVaultState([]);
check("empty artifact list yields null factory address", empty.factoryAddress === null);
check("empty artifact list yields null launched record", empty.launched === null);

// A single factory_deployed event populates factory fields only.
const afterFactory = mergeVaultState([
  artifact("2026-01-01T00:00:00Z", {
    status: "factory_deployed",
    factoryAddress: "0xFACTORY000000000000000000000000000000AA",
    factoryArtifactFingerprint: "fp-v1",
  }),
]);
check("factory_deployed sets factoryAddress", afterFactory.factoryAddress === "0xFACTORY000000000000000000000000000000AA");
check("factory_deployed sets fingerprint", afterFactory.factoryArtifactFingerprint === "fp-v1");
check("factory_deployed alone leaves creationBytecode null", afterFactory.creationBytecode === null);

// A later "registered" event adds bytecode + registration without erasing
// the earlier factory fields (out-of-order artifacts must still fold by
// createdAt, not array order).
const events = [
  artifact("2026-01-02T00:00:00Z", {
    status: "registered",
    wallet: "0xWALLET0000000000000000000000000000000BB",
    registerTxHash: "0xTX1",
    registeredPayloadFingerprint: "pk-1",
    creationBytecode: "0xdeadbeef",
  }),
  artifact("2026-01-01T00:00:00Z", {
    status: "factory_deployed",
    factoryAddress: "0xFACTORY000000000000000000000000000000AA",
    factoryArtifactFingerprint: "fp-v1",
  }),
];
const merged = mergeVaultState(events); // deliberately out of chronological order
check("out-of-order events still fold by createdAt: factory retained", merged.factoryAddress === "0xFACTORY000000000000000000000000000000AA");
check("out-of-order events still fold by createdAt: bytecode from later event", merged.creationBytecode === "0xdeadbeef");
check("registered event sets registeredTxHash", merged.registeredTxHash === "0xTX1");
check("registered event sets registeredPayloadFingerprint", merged.registeredPayloadFingerprint === "pk-1");
check("registered event sets registeredWallet", merged.registeredWallet === "0xWALLET0000000000000000000000000000000BB");
check("no launched event yet", merged.launched === null);

// A subsequent "launched" event adds the launched-token record.
const withLaunch = mergeVaultState([
  ...events,
  artifact("2026-01-03T00:00:00Z", {
    status: "launched",
    tokenAddress: "0xTOKEN00000000000000000000000000000000CC",
    vaultAddress: "0xVAULT00000000000000000000000000000000DD",
    factoryAddress: "0xFACTORY000000000000000000000000000000AA",
    txHash: "0xTX2",
    name: "MyVault",
    symbol: "MYV",
    launchedAt: "2026-01-03T00:00:00Z",
  }),
]);
check("launched event populates launched record", withLaunch.launched?.tokenAddress === "0xTOKEN00000000000000000000000000000000CC");
check("launched record keeps prior factory/bytecode fields", withLaunch.creationBytecode === "0xdeadbeef");

// Non-launch_status artifacts (e.g. solidity source) are ignored entirely.
const withNoise = mergeVaultState([
  artifact("2026-01-01T00:00:00Z", { status: "factory_deployed", factoryAddress: "0xAA" }, "solidity"),
]);
check("non-launch_status artifacts are ignored", withNoise.factoryAddress === null);

// Malformed metadata (missing required fields for "launched") is skipped
// rather than producing a half-populated launched record.
const malformed = mergeVaultState([
  artifact("2026-01-01T00:00:00Z", { status: "launched", tokenAddress: "0xAA" /* missing vaultAddress/txHash */ }),
]);
check("malformed launched event does not populate a partial record", malformed.launched === null);

// "Clear saved" (factory_cleared) must win over an earlier factory_deployed
// event — this is the fix for the bug where a stale local cache kept
// resurrecting a factory address the user explicitly cleared.
const afterClear = mergeVaultState([
  artifact("2026-01-01T00:00:00Z", {
    status: "factory_deployed",
    factoryAddress: "0xFACTORY000000000000000000000000000000AA",
    factoryArtifactFingerprint: "fp-v1",
  }),
  artifact("2026-01-02T00:00:00Z", { status: "factory_cleared" }),
]);
check("factory_cleared resets factoryAddress to null", afterClear.factoryAddress === null);
check("factory_cleared resets factoryArtifactFingerprint to null", afterClear.factoryArtifactFingerprint === null);

// A later re-deploy after clearing must still take effect (clear isn't sticky forever).
const afterClearThenRedeploy = mergeVaultState([
  artifact("2026-01-01T00:00:00Z", {
    status: "factory_deployed",
    factoryAddress: "0xOLD00000000000000000000000000000000000A",
    factoryArtifactFingerprint: "fp-old",
  }),
  artifact("2026-01-02T00:00:00Z", { status: "factory_cleared" }),
  artifact("2026-01-03T00:00:00Z", {
    status: "factory_deployed",
    factoryAddress: "0xNEW00000000000000000000000000000000000B",
    factoryArtifactFingerprint: "fp-new",
  }),
]);
check(
  "a redeploy after clearing is not blocked by the earlier clear",
  afterClearThenRedeploy.factoryAddress === "0xNEW00000000000000000000000000000000000B"
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll vault-state selfchecks passed");
