/**
 * Pure helpers for the on-chain vault UI self-description protocol
 * (`VaultBaseV2.vaultUISchema()` / `src/flap/IVaultSchemasV1.sol`).
 *
 * Every codegen vault exposes `vaultUISchema()` returning a `VaultUISchema`
 * struct that fully describes its user-facing methods (name, description,
 * typed inputs/outputs, required ERC-20 approvals, view-vs-write). This lets
 * one generic renderer build a full interaction page for ANY vault type
 * without vault-specific frontend code — exactly like flap.sh does for
 * FlapXVault / SplitVault / SnowBallVault / BlackHoleVault today.
 *
 * This module is pure (no wagmi/React) so it can be unit-tested and reused
 * from both the browser UI and node selfchecks.
 */
import { formatUnits, parseUnits, type Abi, type AbiFunction } from "viem";

export type FieldDescriptor = {
  name: string;
  fieldType: string;
  description: string;
  decimals: number;
};

export type ApproveAction = {
  tokenType: string;
  amountFieldName: string;
};

export type VaultMethodSchema = {
  name: string;
  description: string;
  inputs: readonly FieldDescriptor[];
  outputs: readonly FieldDescriptor[];
  approvals: readonly ApproveAction[];
  isInputArray: boolean;
  isOutputArray: boolean;
  isWriteMethod: boolean;
};

export type VaultUISchema = {
  vaultType: string;
  description: string;
  methods: readonly VaultMethodSchema[];
};

const FIELD_DESCRIPTOR_COMPONENTS = [
  { name: "name", type: "string" },
  { name: "fieldType", type: "string" },
  { name: "description", type: "string" },
  { name: "decimals", type: "uint8" },
] as const;

const APPROVE_ACTION_COMPONENTS = [
  { name: "tokenType", type: "string" },
  { name: "amountFieldName", type: "string" },
] as const;

const VAULT_METHOD_SCHEMA_COMPONENTS = [
  { name: "name", type: "string" },
  { name: "description", type: "string" },
  { name: "inputs", type: "tuple[]", components: FIELD_DESCRIPTOR_COMPONENTS },
  { name: "outputs", type: "tuple[]", components: FIELD_DESCRIPTOR_COMPONENTS },
  { name: "approvals", type: "tuple[]", components: APPROVE_ACTION_COMPONENTS },
  { name: "isInputArray", type: "bool" },
  { name: "isOutputArray", type: "bool" },
  { name: "isWriteMethod", type: "bool" },
] as const;

/** ABI for reading a vault's self-description (schema + live status banner). */
export const VAULT_UI_SCHEMA_ABI = [
  {
    name: "vaultUISchema",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "schema",
        type: "tuple",
        components: [
          { name: "vaultType", type: "string" },
          { name: "description", type: "string" },
          { name: "methods", type: "tuple[]", components: VAULT_METHOD_SCHEMA_COMPONENTS },
        ],
      },
    ],
  },
  {
    name: "description",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "taxToken",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "lpToken",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const satisfies Abi;

/** Minimal ERC-20 surface needed for ApproveAction handling. */
export const ERC20_MIN_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const satisfies Abi;

export const MSG_VALUE_FIELD_TYPE = "msg.value";
export const TIME_FIELD_TYPE = "time";

/** "time" is an ABI alias for uint256 (unix seconds); "msg.value" is not ABI-encoded at all. */
export function normalizeAbiType(fieldType: string): string {
  return fieldType === TIME_FIELD_TYPE ? "uint256" : fieldType;
}

export function isMsgValueField(field: FieldDescriptor): boolean {
  return field.fieldType === MSG_VALUE_FIELD_TYPE;
}

export function isTimeField(field: FieldDescriptor): boolean {
  return field.fieldType === TIME_FIELD_TYPE;
}

function toAbiInputs(fields: readonly FieldDescriptor[]) {
  return fields
    .filter((f) => !isMsgValueField(f))
    .map((f) => ({ name: f.name, type: normalizeAbiType(f.fieldType) }));
}

/**
 * Builds a single-function ABI for calling `method` directly on the vault.
 * Per IVaultSchemasV1.sol: non-array methods take/return flat parameters
 * (one per FieldDescriptor, in order); array methods take/return a single
 * `tuple[]` parameter whose components are the FieldDescriptor list.
 */
export function buildMethodAbi(method: VaultMethodSchema): [AbiFunction] {
  const inputs = method.isInputArray
    ? [{ name: "items", type: "tuple[]", components: toAbiInputs(method.inputs) }]
    : toAbiInputs(method.inputs);

  const outputs = method.isOutputArray
    ? [{ name: "items", type: "tuple[]", components: toAbiInputs(method.outputs) }]
    : method.outputs.map((f) => ({ name: f.name, type: normalizeAbiType(f.fieldType) }));

  return [
    {
      name: method.name,
      type: "function",
      stateMutability: method.isWriteMethod ? "payable" : "view",
      inputs,
      outputs,
    },
  ];
}

/** The method's `msg.value` input field, if it declares one (write methods only). */
export function findMsgValueField(method: VaultMethodSchema): FieldDescriptor | null {
  return method.inputs.find(isMsgValueField) ?? null;
}

/** Scales a human-entered string ("1.5") into the raw on-chain integer using field.decimals. */
export function parseScaledInput(raw: string, decimals: number): bigint {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("Value is required.");
  if (decimals > 0) return parseUnits(trimmed, decimals);
  if (!/^-?\d+$/.test(trimmed)) throw new Error("Expected a whole number.");
  return BigInt(trimmed);
}

/** Formats a raw on-chain integer for display using field.decimals. */
export function formatScaledOutput(raw: bigint, decimals: number): string {
  if (decimals > 0) return formatUnits(raw, decimals);
  return raw.toString();
}

/** Human countdown/timestamp rendering for `"time"` fields. */
export function formatTimeValue(raw: bigint): { iso: string; relative: string } {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { iso: "—", relative: "—" };
  }
  const date = new Date(seconds * 1000);
  const iso = date.toLocaleString();
  const deltaMs = date.getTime() - Date.now();
  const abs = Math.abs(deltaMs);
  const units: Array<[string, number]> = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ];
  let remaining = abs;
  const parts: string[] = [];
  for (const [label, ms] of units) {
    const value = Math.floor(remaining / ms);
    if (value > 0 && parts.length < 2) parts.push(`${value}${label}`);
    remaining %= ms;
  }
  const suffix = parts.length ? parts.join(" ") : "0s";
  const relative = deltaMs >= 0 ? `in ${suffix}` : `${suffix} ago`;
  return { iso, relative };
}

/** Groups schema methods for layout: stat-style views first, then forms, then write actions. */
export function partitionMethods(methods: readonly VaultMethodSchema[]): {
  statViews: VaultMethodSchema[];
  queryViews: VaultMethodSchema[];
  writes: VaultMethodSchema[];
} {
  const statViews: VaultMethodSchema[] = [];
  const queryViews: VaultMethodSchema[] = [];
  const writes: VaultMethodSchema[] = [];
  for (const m of methods) {
    if (m.isWriteMethod) writes.push(m);
    else if (m.inputs.length === 0) statViews.push(m);
    else queryViews.push(m);
  }
  return { statViews, queryViews, writes };
}
