/**
 * In-process orchestration for generation runs.
 *
 * start-generation registers a run and returns IDs immediately; the actual
 * codegen pipeline starts on the first stream subscription (or explicit
 * startRun call). Events are buffered in memory for live replay to (re)connecting
 * SSE clients, and major events are persisted through the chat store —
 * Supabase when configured, in-memory fallback otherwise.
 */
import type { ApproximationConsent, CodegenEvent, CodegenResult } from "./codegen.js";
import type { ChatStore } from "./chat-store.js";
import type { GenerationEventType } from "./chat-types.js";

/** Wire shape streamed to SSE clients (superset of what is persisted). */
export type RunStreamEvent = {
  type: GenerationEventType;
  sequence: number;
  message?: string;
  payload?: unknown;
};

export type PipelineGenerator = (
  prompt: string,
  emit: (ev: CodegenEvent) => void,
  approximationConsent?: ApproximationConsent
) => Promise<void>;

type RegisteredRun = {
  runId: string;
  chatId: string;
  assistantMessageId: string;
  prompt: string;
  approximationConsent?: ApproximationConsent;
  status: "pending" | "running" | "completed" | "failed";
  sequence: number;
  buffer: RunStreamEvent[];
  listeners: Set<(ev: RunStreamEvent) => void>;
  started: boolean;
};

/** Pipeline phases → user-facing progress copy (chat page renders these verbatim). */
const PHASE_PROGRESS: Record<string, string> = {
  classifying: "Planning your vault mechanic…",
  writing: "Generating Solidity…",
  compiling: "Compiling…",
  compile_failed: "Compiling… (fixing compile errors)",
  fixing: "Running safety scanners…",
  fixing_spec: "Checking Flap compatibility…",
  test_fix: "Running simulation…",
  generating_tests: "Generating tests…",
  auditing: "Running economic critic…",
  ui_gen: "Designing the custom vault UI…",
  done: "Finalizing result…",
};

/** Buffered but never persisted (too chatty for the events table). */
const EPHEMERAL_EVENTS: ReadonlySet<GenerationEventType> = new Set(["code_delta", "heartbeat"]);

/** Trimmed result for persisted payloads — full source lives in generated_artifacts. */
function persistableResult(result: CodegenResult): Record<string, unknown> {
  const { source: _source, creationBytecode: _bytecode, abi: _abi, uiArtifact: _uiArtifact, ...rest } = result;
  // Keep a marker so replayed results know a custom UI exists (content lives in the vault_ui artifact).
  return { ...rest, uiArtifact: result.uiArtifact ? { bytes: result.uiArtifact.bytes, model: result.uiArtifact.model } : null } as Record<string, unknown>;
}

export class RunManager {
  private runs = new Map<string, RegisteredRun>();

  constructor(
    private store: () => ChatStore,
    private generator: PipelineGenerator
  ) {}

  register(input: {
    runId: string;
    chatId: string;
    assistantMessageId: string;
    prompt: string;
    approximationConsent?: ApproximationConsent;
  }): void {
    if (this.runs.has(input.runId)) return;
    this.runs.set(input.runId, {
      ...input,
      status: "pending",
      sequence: 0,
      buffer: [],
      listeners: new Set(),
      started: false,
    });
  }

  getActive(runId: string): { status: RegisteredRun["status"] } | null {
    const run = this.runs.get(runId);
    return run ? { status: run.status } : null;
  }

  /**
   * Replays buffered events, then subscribes to live events. Starts the
   * pipeline if it has not started yet. Returns an unsubscribe function,
   * or null when the run is unknown to this process.
   */
  subscribe(runId: string, listener: (ev: RunStreamEvent) => void): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;

    for (const ev of run.buffer) listener(ev);
    run.listeners.add(listener);

    if (!run.started) {
      run.started = true;
      void this.execute(run);
    }

    return () => {
      run.listeners.delete(listener);
    };
  }

  private emitStream(run: RegisteredRun, type: GenerationEventType, message?: string, payload?: unknown): RunStreamEvent {
    const ev: RunStreamEvent = { type, sequence: ++run.sequence, message, payload };
    run.buffer.push(ev);
    for (const listener of run.listeners) listener(ev);
    return ev;
  }

  private async persist(run: RegisteredRun, ev: RunStreamEvent): Promise<void> {
    if (EPHEMERAL_EVENTS.has(ev.type)) return;
    try {
      await this.store().appendEvent({
        runId: run.runId,
        chatId: run.chatId,
        eventType: ev.type,
        sequence: ev.sequence,
        message: ev.message ?? null,
        payload: (ev.payload as Record<string, unknown>) ?? {},
      });
    } catch (err) {
      // Persistence must never kill a live stream.
      console.error(`[run-manager] failed to persist ${ev.type} event:`, err);
    }
  }

  private async event(run: RegisteredRun, type: GenerationEventType, message?: string, payload?: unknown): Promise<void> {
    const ev = this.emitStream(run, type, message, payload);
    await this.persist(run, ev);
  }

  private async execute(run: RegisteredRun): Promise<void> {
    const store = this.store();
    run.status = "running";

    await this.event(run, "run_started", "Planning your vault mechanic…");
    await store.updateRun(run.runId, { status: "running" }).catch(() => null);
    await store.updateMessage(run.assistantMessageId, { status: "streaming" }).catch(() => null);

    let result: CodegenResult | null = null;
    let streamError: string | null = null;
    // Populated by the "error" codegen event — the pipeline's top-level catch
    // swallows the exception and emits this instead of throwing, so this is
    // the only way to recover the real reason (e.g. "Anthropic overloaded")
    // rather than falling back to a generic message.
    let codegenError: string | null = null;

    try {
      await this.generator(
        run.prompt,
        (ev) => {
          void this.handleCodegenEvent(
            run,
            ev,
            (r) => {
              result = r;
            },
            (msg) => {
              codegenError = msg;
            }
          );
        },
        run.approximationConsent
      );
    } catch (err) {
      streamError = err instanceof Error ? err.message : "Codegen failed";
    }

    if (result) {
      await this.finishWithResult(run, result);
    } else {
      await this.finishWithError(run, streamError ?? codegenError ?? "Generation produced no result.");
    }
  }

  private async handleCodegenEvent(
    run: RegisteredRun,
    ev: CodegenEvent,
    onResult: (r: CodegenResult) => void,
    onError: (message: string) => void
  ): Promise<void> {
    switch (ev.type) {
      case "status": {
        const message = PHASE_PROGRESS[ev.phase] ?? ev.message ?? "Working…";
        await this.event(run, "status", ev.message ?? message, {
          phase: ev.phase,
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          progressLabel: message,
        });
        break;
      }
      case "code_delta":
        this.emitStream(run, "code_delta", undefined, { delta: ev.delta });
        break;
      case "name":
        await this.event(run, "status", `Contract: ${ev.contractName}`, { contractName: ev.contractName });
        break;
      case "fix_log": {
        const isRepair = ev.entry.phase === "critic_repair";
        await this.event(
          run,
          isRepair ? "repair_attempt" : "scanner_result",
          isRepair ? "Attempting repair…" : ev.entry.message.slice(0, 200),
          { entry: ev.entry }
        );
        break;
      }
      case "code_reset":
        await this.event(run, "status", ev.message ?? (ev.reason === "initial" ? "Writing the contract…" : `Rewriting contract (pass ${ev.attempt})…`), {
          attempt: ev.attempt,
          reason: ev.reason,
          codeReset: true,
        });
        break;
      case "mechanic_spec":
        await this.event(run, "mechanic_spec", "Creating MechanicSpec…", { spec: ev.spec });
        break;
      case "scope":
        await this.event(run, "scope", "Checking Flap compatibility…", { scope: ev.scope });
        break;
      case "design_questions":
        await this.event(run, "design_questions", "Checking if design questions are needed…", {
          questions: ev.questions,
          options: ev.options,
          spec: ev.spec,
        });
        break;
      case "consent_required":
        await this.event(run, "consent_required", "Waiting for your choice — idea is not launch-ready as requested.", {
          scope: ev.scope,
          options: ev.options,
          spec: ev.spec,
        });
        break;
      case "spec_audit":
        await this.event(run, "scanner_result", "Running safety scanners…", { audit: ev.audit });
        break;
      case "simulation_report":
        await this.event(run, "simulation_report", "Running simulation…", { report: ev.report });
        break;
      case "economic_critique":
        await this.event(run, "economic_critique", "Running economic critic…", { report: ev.report });
        break;
      case "explanation":
        await this.event(run, "status", "Finalizing result…", { explanation: ev.text });
        break;
      case "result":
        onResult(ev.result);
        break;
      case "error":
        onError(ev.error);
        await this.event(run, "status", ev.error, { error: true });
        break;
    }
  }

  private async finishWithResult(run: RegisteredRun, result: CodegenResult): Promise<void> {
    const store = this.store();
    run.status = "completed";

    try {
      await store.updateRun(run.runId, {
        status: "completed",
        deliverable: result.deliverable ?? "contract",
        scope: result.scope ?? null,
        mechanicSpec: result.mechanicSpec ?? null,
        simulationReport: result.simulationReport ?? null,
        economicCritique: result.economicCritique ?? null,
        approximationReport: result.approximation ?? null,
        repairAttempts: result.repairAttempts ?? null,
        completedAt: new Date().toISOString(),
      });

      await store.updateMessage(run.assistantMessageId, {
        content: result.explanation || `Generated ${result.contractName}.`,
        status: "completed",
        metadata: {
          contractName: result.contractName,
          compiled: result.compiled,
          deliverable: result.deliverable ?? "contract",
          integrationTestsPassed: result.integrationTestsPassed,
          bytecodeSize: result.bytecodeSize,
        },
      });

      if (result.source) {
        await store.createArtifact({
          chatId: run.chatId,
          runId: run.runId,
          artifactType: "solidity",
          name: `${result.contractName}.sol`,
          content: result.source,
          metadata: {
            compiled: result.compiled,
            bytecodeSize: result.bytecodeSize,
            creationBytecode: result.creationBytecode,
            abi: result.abi,
          },
        });
      }
      if (result.mechanicSpec) {
        await store.createArtifact({
          chatId: run.chatId,
          runId: run.runId,
          artifactType: "mechanic_spec",
          name: `${result.contractName}.mechanic-spec.json`,
          content: JSON.stringify(result.mechanicSpec, null, 2),
        });
      }
      if (result.simulationReport) {
        await store.createArtifact({
          chatId: run.chatId,
          runId: run.runId,
          artifactType: "simulation_report",
          name: `${result.contractName}.simulation.json`,
          content: JSON.stringify(result.simulationReport, null, 2),
        });
      }
      if (result.economicCritique) {
        await store.createArtifact({
          chatId: run.chatId,
          runId: run.runId,
          artifactType: "economic_critique",
          name: `${result.contractName}.economic-critique.json`,
          content: JSON.stringify(result.economicCritique, null, 2),
        });
      }
      if (result.uiArtifact) {
        await store.createArtifact({
          chatId: run.chatId,
          runId: run.runId,
          artifactType: "vault_ui",
          name: `${result.contractName}.vault-ui.json`,
          content: JSON.stringify(result.uiArtifact),
          metadata: { model: result.uiArtifact.model, bytes: result.uiArtifact.bytes, format: result.uiArtifact.format },
        });
      }
      if (result.approximation) {
        await store.createArtifact({
          chatId: run.chatId,
          runId: run.runId,
          artifactType: "approximation_report",
          name: `${result.contractName}.approximation.json`,
          content: JSON.stringify(result.approximation, null, 2),
        });
      }
      for (const attempt of result.repairAttempts ?? []) {
        await store.createRepairAttempt({
          runId: run.runId,
          attemptNumber: attempt.attempt,
          reason: attempt.reason,
          model: attempt.model,
          findingsAddressed: attempt.findingsAddressed,
          compilePassed: attempt.compileResult === "pass",
          scannersPassed: attempt.scannerResult === "skip" ? null : attempt.scannerResult === "pass",
          testsPassed: attempt.testResult === "skip" ? null : attempt.testResult === "pass",
          criticReran: attempt.criticResult !== "not_rerun",
          remainingIssues: attempt.remainingIssues,
        });
      }

      const chat = await store.getChat(run.chatId);
      if (chat && (chat.title === "New vault chat" || !chat.title) && result.contractName) {
        await store.updateChat(run.chatId, { title: result.contractName });
      }
    } catch (err) {
      console.error("[run-manager] failed to persist run completion:", err);
    }

    if (result.source) {
      await this.event(run, "code_complete", `${result.contractName}.sol ready`, {
        contractName: result.contractName,
        compiled: result.compiled,
        bytecodeSize: result.bytecodeSize,
      });
    }
    // Live payload carries the full result (source included) so the chat page
    // can render panels without an extra fetch; the persisted copy is trimmed.
    const ev = this.emitStream(run, "run_completed", "Generation complete.", { result });
    await this.persist(run, { ...ev, payload: { result: persistableResult(result) } });
  }

  private async finishWithError(run: RegisteredRun, error: string): Promise<void> {
    const store = this.store();
    run.status = "failed";

    try {
      await store.updateRun(run.runId, {
        status: "failed",
        error,
        completedAt: new Date().toISOString(),
      });
      await store.updateMessage(run.assistantMessageId, {
        content: `Generation failed: ${error}`,
        status: "failed",
        metadata: { error },
      });
    } catch (err) {
      console.error("[run-manager] failed to persist run failure:", err);
    }

    await this.event(run, "run_failed", error, { error });
  }
}
