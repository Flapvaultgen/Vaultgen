import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { bscTestnet } from "viem/chains";
import type { Address, Hex } from "viem";
import { wagmiConfig } from "../lib/wagmi";
import { flapTestnetPublicClient } from "../lib/flap-factory";
import { explorerTxUrl } from "../lib/studio-config";
import {
  ERC20_MIN_ABI,
  VAULT_UI_SCHEMA_ABI,
  buildMethodAbi,
  findMsgValueField,
  formatScaledOutput,
  formatTimeValue,
  isMsgValueField,
  isTimeField,
  parseScaledInput,
  partitionMethods,
  type FieldDescriptor,
  type VaultMethodSchema,
  type VaultUISchema,
} from "../lib/vault-ui-schema";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";

type Props = {
  vaultAddress: Address;
  explorerBase: string | undefined;
};

// ── field rendering ─────────────────────────────────────────────────────────

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDescriptor;
  value: string;
  onChange: (v: string) => void;
}) {
  const label = isMsgValueField(field) ? `${field.name} (BNB sent with tx)` : field.name;
  if (field.fieldType === "bool") {
    return (
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          className="size-3.5 rounded border-input"
        />
        {label}
      </label>
    );
  }
  if (isTimeField(field)) {
    return (
      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground">{label}</label>
        <Input
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted-foreground" title={field.description}>
        {label}
        {field.decimals > 0 && <span className="ml-1 opacity-60">({field.decimals}d)</span>}
      </label>
      <Input
        type="text"
        inputMode={field.fieldType === "address" || field.fieldType === "string" ? "text" : "decimal"}
        placeholder={
          field.fieldType === "address"
            ? "0x…"
            : field.fieldType.startsWith("bytes")
              ? "0x…"
              : field.description || field.fieldType
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Converts a raw form field value into the encoded arg for one FieldDescriptor. */
function encodeFieldValue(field: FieldDescriptor, raw: string): unknown {
  if (field.fieldType === "bool") return raw === "true";
  if (field.fieldType === "address") return raw.trim() as Address;
  if (field.fieldType.startsWith("bytes") || field.fieldType === "string") return raw.trim();
  if (isTimeField(field)) {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) throw new Error(`"${field.name}" needs a valid date/time.`);
    return BigInt(Math.floor(ms / 1000));
  }
  return parseScaledInput(raw, field.decimals);
}

function defaultFieldValue(field: FieldDescriptor): string {
  return field.fieldType === "bool" ? "false" : "";
}

// ── row-based form for one method's inputs (supports isInputArray) ─────────

function useFieldRows(fields: readonly FieldDescriptor[], isArray: boolean) {
  const makeRow = useCallback(
    () => Object.fromEntries(fields.map((f) => [f.name, defaultFieldValue(f)])) as Record<string, string>,
    [fields]
  );
  const [rows, setRows] = useState<Record<string, string>[]>(() => [makeRow()]);

  useEffect(() => {
    setRows([makeRow()]);
  }, [makeRow]);

  const updateCell = (rowIdx: number, name: string, value: string) => {
    setRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, [name]: value } : r)));
  };
  const addRow = () => setRows((prev) => [...prev, makeRow()]);
  const removeRow = (rowIdx: number) => setRows((prev) => prev.filter((_, i) => i !== rowIdx));

  return { rows, updateCell, addRow, removeRow, isArray };
}

function FieldRowsForm({
  fields,
  state,
}: {
  fields: readonly FieldDescriptor[];
  state: ReturnType<typeof useFieldRows>;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="space-y-2">
      {state.rows.map((row, rowIdx) => (
        <div key={rowIdx} className="flex flex-wrap items-end gap-2 rounded-md border border-border/60 p-2">
          {fields.map((field) => (
            <div key={field.name} className="min-w-[8rem] flex-1">
              <FieldInput field={field} value={row[field.name] ?? ""} onChange={(v) => state.updateCell(rowIdx, field.name, v)} />
            </div>
          ))}
          {state.isArray && state.rows.length > 1 && (
            <Button type="button" size="icon" variant="ghost" onClick={() => state.removeRow(rowIdx)}>
              <Minus className="size-3.5" />
            </Button>
          )}
        </div>
      ))}
      {state.isArray && (
        <Button type="button" size="sm" variant="outline" onClick={state.addRow} className="gap-1.5">
          <Plus className="size-3.5" /> Add row
        </Button>
      )}
    </div>
  );
}

function encodeRows(fields: readonly FieldDescriptor[], rows: Record<string, string>[], isArray: boolean): unknown[] {
  const encodeRow = (row: Record<string, string>) =>
    Object.fromEntries(fields.map((f) => [f.name, encodeFieldValue(f, row[f.name] ?? "")]));
  if (isArray) return [rows.map(encodeRow)];
  const single = encodeRow(rows[0] ?? {});
  return fields.map((f) => single[f.name]);
}

// ── output rendering ────────────────────────────────────────────────────────

function OutputValue({ field, raw }: { field: FieldDescriptor; raw: unknown }) {
  if (isTimeField(field)) {
    const { iso, relative } = formatTimeValue(BigInt(raw as bigint));
    return (
      <span>
        {iso} <span className="text-muted-foreground">({relative})</span>
      </span>
    );
  }
  if (field.fieldType === "bool") return <span>{String(raw)}</span>;
  if (field.fieldType === "address") return <span className="break-all font-mono">{String(raw)}</span>;
  if (typeof raw === "bigint") {
    const formatted = formatScaledOutput(raw, field.decimals);
    return <span>{Number(formatted).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>;
  }
  return <span className="break-all">{String(raw)}</span>;
}

function OutputsDisplay({
  method,
  values,
}: {
  method: VaultMethodSchema;
  values: unknown[] | unknown[][] | null;
}) {
  if (values === null) return null;
  if (method.isOutputArray) {
    const rows = (values as unknown[][]) ?? [];
    if (rows.length === 0) return <p className="text-xs text-muted-foreground">No rows returned.</p>;
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              {method.outputs.map((f) => (
                <th key={f.name} className="whitespace-nowrap pb-1 pr-3 font-medium">
                  {f.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-border/60">
                {method.outputs.map((f, j) => (
                  <td key={f.name} className="whitespace-nowrap py-1 pr-3">
                    <OutputValue field={f} raw={(row as unknown[])[j]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const flat = values as unknown[];
  if (method.outputs.length === 1) {
    return (
      <p className="text-sm text-foreground">
        <OutputValue field={method.outputs[0]!} raw={flat[0]} />
      </p>
    );
  }
  return (
    <dl className="grid gap-1 sm:grid-cols-2">
      {method.outputs.map((f, i) => (
        <div key={f.name}>
          <dt className="text-[11px] text-muted-foreground">{f.name}</dt>
          <dd className="text-sm text-foreground">
            <OutputValue field={f} raw={flat[i]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── stat card: zero-input view method, auto-fetched + polled ───────────────

function StatViewCard({ vaultAddress, method }: { vaultAddress: Address; method: VaultMethodSchema }) {
  const [values, setValues] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchValue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const abi = buildMethodAbi(method);
      const result = await flapTestnetPublicClient.readContract({
        address: vaultAddress,
        abi,
        functionName: method.name,
      });
      setValues(method.outputs.length > 1 ? (result as unknown[]) : [result]);
    } catch (err) {
      setError(err instanceof Error ? err.message.split("\n")[0]! : "Read failed.");
    } finally {
      setLoading(false);
    }
  }, [vaultAddress, method]);

  useEffect(() => {
    void fetchValue();
    const id = setInterval(() => void fetchValue(), 20_000);
    return () => clearInterval(id);
  }, [fetchValue]);

  return (
    <div className="rounded-md border border-border/70 bg-secondary/10 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] text-muted-foreground" title={method.description}>
          {method.name}
        </p>
        <button type="button" onClick={() => void fetchValue()} className="text-muted-foreground hover:text-foreground">
          {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
        </button>
      </div>
      <div className="mt-1 font-medium text-foreground">
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : (
          <OutputsDisplay method={method} values={values} />
        )}
      </div>
    </div>
  );
}

// ── query card: view method with inputs ─────────────────────────────────────

function QueryViewCard({ vaultAddress, method }: { vaultAddress: Address; method: VaultMethodSchema }) {
  const formState = useFieldRows(method.inputs, method.isInputArray);
  const [values, setValues] = useState<unknown[] | unknown[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runQuery = async () => {
    setLoading(true);
    setError(null);
    try {
      const args = encodeRows(method.inputs, formState.rows, method.isInputArray);
      const abi = buildMethodAbi(method);
      const result = await flapTestnetPublicClient.readContract({
        address: vaultAddress,
        abi,
        functionName: method.name,
        args,
      });
      if (method.isOutputArray) {
        setValues(result as unknown[][]);
      } else {
        setValues(method.outputs.length > 1 ? (result as unknown[]) : [result]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message.split("\n")[0]! : "Query failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-md border border-border/70 bg-secondary/10 p-3">
      <p className="font-medium text-foreground">{method.name}</p>
      {method.description && <p className="mt-0.5 text-xs text-muted-foreground">{method.description}</p>}
      <div className="mt-2">
        <FieldRowsForm fields={method.inputs} state={formState} />
      </div>
      <Button type="button" size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => void runQuery()} disabled={loading}>
        {loading && <Loader2 className="size-3.5 animate-spin" />}
        Query
      </Button>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {values !== null && !error && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <OutputsDisplay method={method} values={values} />
        </div>
      )}
    </div>
  );
}

// ── write card: state-changing method, handles approvals + tx lifecycle ────

function WriteMethodCard({
  vaultAddress,
  method,
  explorerBase,
}: {
  vaultAddress: Address;
  method: VaultMethodSchema;
  explorerBase: string | undefined;
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const formState = useFieldRows(method.inputs, method.isInputArray);
  const [status, setStatus] = useState<"idle" | "approving" | "sending" | "confirming" | "success" | "error">("idle");
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);

  const msgValueField = findMsgValueField(method);
  const callInputs = method.inputs.filter((f) => !isMsgValueField(f));

  const submit = async () => {
    if (!address) {
      setError("Connect a wallet first.");
      setStatus("error");
      return;
    }
    setError(null);
    setTxHash(null);
    try {
      if (chainId !== bscTestnet.id) {
        await switchChainAsync({ chainId: bscTestnet.id });
      }

      const row = formState.rows[0] ?? {};
      const value = msgValueField ? parseScaledInput(row[msgValueField.name] || "0", msgValueField.decimals || 18) : 0n;

      if (method.approvals.length > 0) {
        setStatus("approving");
        for (const approval of method.approvals) {
          let tokenAddress: Address | null = null;
          if (approval.tokenType === "taxToken" || approval.tokenType === "lpToken") {
            tokenAddress = await flapTestnetPublicClient.readContract({
              address: vaultAddress,
              abi: VAULT_UI_SCHEMA_ABI,
              functionName: approval.tokenType,
            });
          }
          if (!tokenAddress) continue; // unknown tokenType — forward-compatible skip

          const amountField = method.inputs.find((f) => f.name === approval.amountFieldName);
          const amount = amountField ? parseScaledInput(row[amountField.name] || "0", amountField.decimals) : 0n;
          if (amount <= 0n) continue;

          const allowance = await flapTestnetPublicClient.readContract({
            address: tokenAddress,
            abi: ERC20_MIN_ABI,
            functionName: "allowance",
            args: [address, vaultAddress],
          });
          if (allowance >= amount) continue;

          const approveHash = await writeContract(wagmiConfig, {
            address: tokenAddress,
            abi: ERC20_MIN_ABI,
            functionName: "approve",
            args: [vaultAddress, amount],
            chainId: bscTestnet.id,
            account: address,
          });
          await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, chainId: bscTestnet.id });
        }
      }

      setStatus("sending");
      const args = encodeRows(callInputs, formState.rows, method.isInputArray);
      const abi = buildMethodAbi(method);
      const hash = await writeContract(wagmiConfig, {
        address: vaultAddress,
        abi,
        functionName: method.name,
        args,
        value,
        chainId: bscTestnet.id,
        account: address,
      });
      setTxHash(hash);
      setStatus("confirming");
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: bscTestnet.id });
      setStatus(receipt.status === "success" ? "success" : "error");
      if (receipt.status !== "success") setError("Transaction reverted on-chain.");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message.split("\n")[0]! : "Transaction failed.");
    }
  };

  const busy = status === "approving" || status === "sending" || status === "confirming";

  return (
    <div className="rounded-md border border-border/70 bg-secondary/10 p-3">
      <p className="font-medium text-foreground">{method.name}</p>
      {method.description && <p className="mt-0.5 text-xs text-muted-foreground">{method.description}</p>}
      {method.approvals.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-300">
          Requires ERC-20 approval of {method.approvals.map((a) => a.tokenType).join(", ")} before sending.
        </p>
      )}
      <div className="mt-2">
        <FieldRowsForm fields={method.inputs} state={formState} />
      </div>
      <Button
        type="button"
        size="sm"
        className="mt-2 gap-1.5"
        onClick={() => void submit()}
        disabled={busy || !isConnected}
      >
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        {status === "approving" ? "Approving…" : status === "sending" ? "Sending…" : status === "confirming" ? "Confirming…" : "Execute"}
      </Button>
      {!isConnected && <p className="mt-1 text-[11px] text-muted-foreground">Connect a wallet to execute this method.</p>}
      {status === "success" && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 className="size-3.5" /> Confirmed.
        </p>
      )}
      {error && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" /> {error}
        </p>
      )}
      {txHash && (
        <a
          href={explorerTxUrl(explorerBase, txHash)}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          View tx <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}

// ── top-level panel ──────────────────────────────────────────────────────────

export default function VaultUIPanel({ vaultAddress, explorerBase }: Props) {
  const [schema, setSchema] = useState<VaultUISchema | null>(null);
  const [liveDescription, setLiveDescription] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSchema = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [result, desc] = await Promise.all([
        flapTestnetPublicClient.readContract({
          address: vaultAddress,
          abi: VAULT_UI_SCHEMA_ABI,
          functionName: "vaultUISchema",
        }),
        flapTestnetPublicClient.readContract({
          address: vaultAddress,
          abi: VAULT_UI_SCHEMA_ABI,
          functionName: "description",
        }),
      ]);
      setSchema(result as unknown as VaultUISchema);
      setLiveDescription(desc);
    } catch (err) {
      setError(
        err instanceof Error
          ? `This vault doesn't expose vaultUISchema() (older vault, or not a VaultBaseV2 contract): ${err.message.split("\n")[0]}`
          : "Failed to read vault UI schema."
      );
    } finally {
      setLoading(false);
    }
  }, [vaultAddress]);

  useEffect(() => {
    void loadSchema();
    const id = setInterval(() => {
      flapTestnetPublicClient
        .readContract({ address: vaultAddress, abi: VAULT_UI_SCHEMA_ABI, functionName: "description" })
        .then(setLiveDescription)
        .catch(() => {});
    }, 12_000);
    return () => clearInterval(id);
  }, [vaultAddress, loadSchema]);

  const partitioned = useMemo(() => (schema ? partitionMethods(schema.methods) : null), [schema]);

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-secondary/20 p-4">
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading vault UI schema from chain…
        </p>
      </div>
    );
  }

  if (error || !schema) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
        <p className="inline-flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error ?? "No schema available for this vault."}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-primary">
            {schema.vaultType}
          </span>
          <p className="mt-1.5 text-sm text-muted-foreground">{schema.description}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadSchema()}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="size-3" /> Refresh
        </button>
      </div>

      {liveDescription && (
        <div className="mt-3 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs text-foreground">
          {liveDescription}
        </div>
      )}

      {schema.methods.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          This vault has no user-facing methods (auto-runs entirely from tax inflow).
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {partitioned!.statViews.length > 0 && (
            <section>
              <h3 className={cn("mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground")}>Vault stats</h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {partitioned!.statViews.map((m) => (
                  <StatViewCard key={m.name} vaultAddress={vaultAddress} method={m} />
                ))}
              </div>
            </section>
          )}

          {partitioned!.queryViews.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Lookups</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {partitioned!.queryViews.map((m) => (
                  <QueryViewCard key={m.name} vaultAddress={vaultAddress} method={m} />
                ))}
              </div>
            </section>
          )}

          {partitioned!.writes.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Actions</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {partitioned!.writes.map((m) => (
                  <WriteMethodCard key={m.name} vaultAddress={vaultAddress} method={m} explorerBase={explorerBase} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
