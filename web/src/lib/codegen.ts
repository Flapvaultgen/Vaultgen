export type SafetyFinding = { level: "block" | "warn"; rule: string; detail: string; sourceScope?: "child" | "full-injected" };

export type SpecCheckStatus = "pass" | "warn" | "fail" | "na";

export type SpecCheckItem = {
  id: string;
  title: string;
  status: SpecCheckStatus;
  detail: string;
};

export type SpecAuditResult = {
  level: "pass" | "warn" | "fail" | "skipped";
  summary: string;
  items: SpecCheckItem[];
  mode: "openai" | "skipped";
};

export type FixLogEntry = {
  phase: "writing" | "classifying" | "compile_fix" | "safety_fix" | "test_fix" | "spec_fix" | "generating_tests" | "auditing";
  attempt: number;
  rule?: string;
  message: string;
};

export type VaultPlan = {
  kind: string;
  usesNativeRewards: boolean;
  usesEntrants: boolean;
  usesFlapAI: boolean;
  usesStaking: boolean;
  requiresTokenHolding: boolean;
  requiresPullPayments: boolean;
  nativeBuckets: string[];
  tokenCustodyBuckets: string[];
  requiredPublicViews: string[];
  requiredEvents: string[];
  forbiddenPatterns: string[];
  stateVariables: string[];
  payoutMode: string;
  riskDisclosure: string[];
};

export type CodegenResult = {
  contractName: string;
  explanation: string;
  source: string;
  compiled: boolean;
  compileErrors: string;
  safety: { level: "pass" | "warn" | "fail"; findings: SafetyFinding[] };
  specAudit: SpecAuditResult;
  vaultPlan: VaultPlan;
  abi: unknown[] | null;
  bytecodeSize: number | null;
  attempts: number;
  integrationTestPath: string | null;
  integrationTestsPassed: boolean;
  fixLog: FixLogEntry[];
  autoFixExhausted: boolean;
  mode: "openai" | "stub";
};

export type RefineChatTurn = { role: "user" | "assistant"; content: string };

export type RefineSession = {
  initialPrompt: string;
  contractName: string;
  source: string;
  chatHistory: RefineChatTurn[];
};

import { apiUrl, initApiBase } from "./api-base";

export type CodegenEvent =
  | {
      type: "status";
      phase: "writing" | "classifying" | "fixing" | "fixing_spec" | "test_fix" | "compiling" | "compile_failed" | "auditing" | "generating_tests" | "done" | "error";
      attempt: number;
      maxAttempts?: number;
      message?: string;
    }
  | {
      type: "code_reset";
      attempt: number;
      reason: "initial" | "retry";
      retryKind?: FixLogEntry["phase"];
      message?: string;
    }
  | { type: "fix_log"; entry: FixLogEntry }
  | { type: "code_delta"; delta: string }
  | { type: "name"; contractName: string }
  | { type: "explanation"; text: string }
  | { type: "spec_audit"; audit: SpecAuditResult }
  | { type: "result"; result: CodegenResult }
  | { type: "error"; error: string };

async function consumeSse(res: Response, onEvent: (ev: CodegenEvent) => void): Promise<void> {
  if (!res.body) throw new Error("Empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = raw.trim();
      if (line.startsWith("data:")) {
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as CodegenEvent);
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  }
}

export async function streamVault(prompt: string, onEvent: (ev: CodegenEvent) => void): Promise<void> {
  await initApiBase();
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/codegen-vault-stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  } catch {
    throw new Error("Can't reach the AI server. Start it with `npm run dev:all`.");
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Codegen failed (${res.status})`);
  }
  await consumeSse(res, onEvent);
}

export async function streamVaultRefine(
  message: string,
  session: RefineSession,
  onEvent: (ev: CodegenEvent) => void
): Promise<void> {
  await initApiBase();
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/codegen-vault-refine-stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session }),
    });
  } catch {
    throw new Error("Can't reach the AI server. Start it with `npm run dev:all`.");
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Refine failed (${res.status})`);
  }
  await consumeSse(res, onEvent);
}

export async function generateVault(prompt: string): Promise<CodegenResult> {
  await initApiBase();
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/codegen-vault"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  } catch {
    throw new Error("Can't reach the AI server. Start it with `npm run dev:all`.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(body.error);
    throw new Error(`Codegen failed (${res.status})`);
  }
  return res.json() as Promise<CodegenResult>;
}
