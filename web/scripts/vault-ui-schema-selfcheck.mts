/**
 * Deterministic selfchecks for the vault UI self-description helpers
 * (web/src/lib/vault-ui-schema.ts). No chain access, no wallet.
 *
 * Run: npm run test:vault-ui  (from web/)
 */
import { toFunctionSignature } from "viem";
import {
  buildMethodAbi,
  findMsgValueField,
  formatScaledOutput,
  formatTimeValue,
  isMsgValueField,
  isTimeField,
  normalizeAbiType,
  parseScaledInput,
  partitionMethods,
  type FieldDescriptor,
  type VaultMethodSchema,
} from "../src/lib/vault-ui-schema";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const field = (name: string, fieldType: string, decimals = 0, description = ""): FieldDescriptor => ({
  name,
  fieldType,
  description,
  decimals,
});

// ── 1. buildMethodAbi matches the real, on-chain-verified SimpleTreasuryVault
//       schema read live from a deployed vault (BSC testnet tx
//       0x5b487be818f2ea4246dfbc9dc85a647fc141131800c4b3d01ee0bbc301c5bad3). ──

const treasuryView: VaultMethodSchema = {
  name: "treasury",
  description: "Current treasury balance",
  inputs: [],
  outputs: [field("balance", "uint256", 18, "Treasury balance in BNB")],
  approvals: [],
  isInputArray: false,
  isOutputArray: false,
  isWriteMethod: false,
};
check(
  "treasury() view ABI signature",
  toFunctionSignature(buildMethodAbi(treasuryView)[0] as never) === "treasury()"
);

const withdrawWrite: VaultMethodSchema = {
  name: "withdrawTreasury",
  description: "Withdraw from treasury",
  inputs: [field("to", "address"), field("amount", "uint256", 18)],
  outputs: [],
  approvals: [],
  isInputArray: false,
  isOutputArray: false,
  isWriteMethod: true,
};
check(
  "withdrawTreasury(address,uint256) write ABI signature (flat args, per IVaultSchemasV1.sol)",
  toFunctionSignature(buildMethodAbi(withdrawWrite)[0] as never) === "withdrawTreasury(address,uint256)"
);

// ── 2. "time" fields are ABI-encoded as uint256, "msg.value" is excluded ────

check("normalizeAbiType('time') -> uint256", normalizeAbiType("time") === "uint256");
check("normalizeAbiType('address') passthrough", normalizeAbiType("address") === "address");
check("isTimeField detects time fields", isTimeField(field("endsAt", "time")));
check("isMsgValueField detects msg.value fields", isMsgValueField(field("amount", "msg.value")));

const payableDeposit: VaultMethodSchema = {
  name: "deposit",
  description: "Deposit BNB",
  inputs: [field("amount", "msg.value", 18)],
  outputs: [],
  approvals: [],
  isInputArray: false,
  isOutputArray: false,
  isWriteMethod: true,
};
const depositAbi = buildMethodAbi(payableDeposit)[0];
check("msg.value field excluded from calldata inputs", depositAbi.inputs.length === 0);
check("findMsgValueField locates the msg.value input", findMsgValueField(payableDeposit)?.name === "amount");

const timeOutputMethod: VaultMethodSchema = {
  name: "epochEndTime",
  description: "",
  inputs: [],
  outputs: [field("endsAt", "time")],
  approvals: [],
  isInputArray: false,
  isOutputArray: false,
  isWriteMethod: false,
};
check(
  "'time' output ABI-encoded as uint256",
  (buildMethodAbi(timeOutputMethod)[0].outputs[0] as { type: string }).type === "uint256"
);

// ── 3. isInputArray / isOutputArray wrap fields in a single tuple[] param ───

const arrayWrite: VaultMethodSchema = {
  name: "proposeMany",
  description: "",
  inputs: [field("wallet", "address"), field("weight", "uint16")],
  outputs: [],
  approvals: [],
  isInputArray: true,
  isOutputArray: false,
  isWriteMethod: true,
};
const arrayAbi = buildMethodAbi(arrayWrite)[0];
check(
  "isInputArray produces a single tuple[] parameter",
  arrayAbi.inputs.length === 1 &&
    arrayAbi.inputs[0]!.type === "tuple[]" &&
    (arrayAbi.inputs[0] as { components: unknown[] }).components.length === 2
);

const arrayView: VaultMethodSchema = {
  name: "activeItems",
  description: "",
  inputs: [],
  outputs: [field("id", "uint256"), field("wallet", "address")],
  approvals: [],
  isInputArray: false,
  isOutputArray: true,
  isWriteMethod: false,
};
const arrayViewAbi = buildMethodAbi(arrayView)[0];
check(
  "isOutputArray produces a single tuple[] return",
  arrayViewAbi.outputs.length === 1 && arrayViewAbi.outputs[0]!.type === "tuple[]"
);

// ── 4. numeric scaling round-trips ──────────────────────────────────────────

check("parseScaledInput/formatScaledOutput round-trip (18 decimals)", (() => {
  const raw = parseScaledInput("1.5", 18);
  return raw === 1_500_000_000_000_000_000n && formatScaledOutput(raw, 18) === "1.5";
})());
check("parseScaledInput with 0 decimals requires whole numbers", (() => {
  try {
    parseScaledInput("1.5", 0);
    return false;
  } catch {
    return true;
  }
})());
check("parseScaledInput rejects empty input", (() => {
  try {
    parseScaledInput("", 18);
    return false;
  } catch {
    return true;
  }
})());

// ── 5. time formatting never throws and reports a direction ────────────────

check("formatTimeValue handles a future timestamp", (() => {
  const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
  return formatTimeValue(future).relative.startsWith("in ");
})());
check("formatTimeValue handles a past timestamp", (() => {
  const past = BigInt(Math.floor(Date.now() / 1000) - 3600);
  return formatTimeValue(past).relative.endsWith(" ago");
})());

// ── 6. partitionMethods groups by shape (matches the doc's rendering algo) ──

const partitioned = partitionMethods([treasuryView, withdrawWrite, timeOutputMethod]);
check(
  "partitionMethods: zero-input view -> statViews",
  partitioned.statViews.map((m) => m.name).sort().join(",") === "epochEndTime,treasury"
);
check("partitionMethods: write method -> writes", partitioned.writes.map((m) => m.name).join(",") === "withdrawTreasury");
check("partitionMethods: queryViews empty when no view method has inputs", partitioned.queryViews.length === 0);

const queryMethod: VaultMethodSchema = {
  name: "stakedBalance",
  description: "",
  inputs: [field("user", "address")],
  outputs: [field("balance", "uint256", 18)],
  approvals: [],
  isInputArray: false,
  isOutputArray: false,
  isWriteMethod: false,
};
check(
  "partitionMethods: view method with inputs -> queryViews",
  partitionMethods([queryMethod]).queryViews.map((m) => m.name).join(",") === "stakedBalance"
);

// ── summary ──────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll vault-ui-schema selfchecks passed.");
}
