import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleCheck,
  CircleX,
  Copy,
  Download,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  Send,
  Wallet,
} from "lucide-react";
import { useAccount, useChainId } from "wagmi";
import { bscTestnet } from "viem/chains";
import {
  getChat,
  getChatArtifacts,
  getChatConfig,
  getChatMessages,
  getChatRuns,
  listVisibleChats,
  mergeVaultState,
  rememberLocalAnonymousChat,
  startGeneration,
  streamRunEvents,
  type Chat,
  type ChatConfig,
  type ChatMessage,
  type GeneratedArtifact,
  type RunStreamEvent,
} from "./lib/chat-api";
import type { ApproximationConsent, CodegenResult, RepairAttempt } from "./lib/codegen";
import { getDeployBlockReason, isDeployReady, isLaunchReady, scopeAllowsLaunch } from "./lib/deploy-gate";
import { isUsableCreationBytecode } from "./lib/flap-register";
import { loadVaultBytecode, saveVaultBytecode } from "./lib/studio-config";
import { getCurrentUserId, subscribeCurrentUser } from "./lib/current-user";
import { chatPath, navigate, replaceUrl } from "./lib/router";
import EconomicCriticPanel from "./components/EconomicCriticPanel";
import GenerationMilestoneStepper from "./components/GenerationMilestoneStepper";
import LaunchOnFlapPanel from "./components/LaunchOnFlapPanel";
import VaultCustomUI from "./components/VaultCustomUI";
import { downloadVaultUiPackage, parseVaultUiArtifact } from "./lib/vault-ui-bridge";
import { RepairSummaryBanner } from "./CodegenStudio";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";
import { cn } from "./lib/utils";
import { useI18n } from "./lib/i18n/context";
import type { Dictionary } from "./lib/i18n/types";
import {
  advanceMilestone,
  MILESTONE_ORDER,
  milestoneForEvent,
  type MilestoneId,
} from "./lib/generation-milestones";

type ConsentPrompt = {
  message: string;
  options: { id: ApproximationConsent | "stop"; label: string }[];
};

type ProgressDict = Dictionary["chatPage"]["progress"];

/**
 * Maps raw pipeline events to short, friendly stage labels. Raw scanner
 * findings / compiler errors (rule IDs, solc output) stay out of the progress
 * log — the review tab shows the technical detail after the run.
 */
function progressLineFor(ev: RunStreamEvent, p: ProgressDict): string | null {
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "run_started":
      return p.planning;
    case "status": {
      if (payload.connected) return p.connecting;
      if (payload.error) return ev.message ?? null; // real errors stay verbatim
      if (payload.codeReset) {
        const pass = Number(payload.attempt ?? 0);
        return payload.reason === "initial" || pass <= 1 ? p.writing : p.rewriting.replace("{pass}", String(pass));
      }
      if (typeof payload.contractName === "string") return p.contractName.replace("{name}", payload.contractName);
      if (typeof payload.explanation === "string") return p.finalizing;
      switch (payload.phase) {
        case "classifying":
          return p.planning;
        case "writing":
          return p.writing;
        case "compiling":
          return p.compiling;
        case "compile_failed":
          return p.fixingCompile;
        case "fixing":
          return p.fixingSafety;
        case "fixing_spec":
          return p.improvingCompat;
        case "test_fix":
          return p.fixingTests;
        case "generating_tests":
          return p.generatingTests;
        case "auditing":
          return p.auditing;
        case "ui_gen":
          return p.designingUi;
        case "done":
          return p.finalizing;
        default:
          return null;
      }
    }
    case "repair_attempt":
      return p.repairing;
    case "simulation_report":
      return p.simulationDone;
    case "economic_critique":
      return p.economicReview;
    case "code_complete":
      return p.finalizing;
    // mechanic_spec / scope / scanner_result carry technical payloads already
    // summarized by the surrounding status events.
    default:
      return null;
  }
}

type ResultTab = "code" | "review" | "ui" | "launch";

/** One row of the launch-readiness checklist. */
function GateRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      {ok ? (
        <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
      ) : (
        <CircleX className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      )}
      <span className={ok ? "text-foreground/90" : "text-foreground"}>
        {label}
        {detail && <span className="ml-1 text-muted-foreground">— {detail}</span>}
      </span>
    </div>
  );
}

type Props = { chatId: string };

export default function ChatPage({ chatId }: Props) {
  const { dict } = useI18n();
  const [chat, setChat] = useState<Chat | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [config, setConfig] = useState<ChatConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [activeMilestone, setActiveMilestone] = useState<MilestoneId | null>(null);
  const [milestonesComplete, setMilestonesComplete] = useState(false);
  const [liveCode, setLiveCode] = useState("");
  const [result, setResult] = useState<CodegenResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [consent, setConsent] = useState<ConsentPrompt | null>(null);

  const [artifacts, setArtifacts] = useState<GeneratedArtifact[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resultTab, setResultTab] = useState<ResultTab>("code");

  const { isConnected: walletConnected, address: walletAddress } = useAccount();
  const walletChainId = useChainId();
  const onTestnet = walletChainId === bscTestnet.id;

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const milestoneSteps = useMemo(
    () => MILESTONE_ORDER.map((id) => ({ id, label: dict.chatPage.milestones[id] })),
    [dict]
  );
  const codeRef = useRef<HTMLPreElement>(null);

  const streaming = activeRunId !== null && result === null && runError === null && consent === null;

  const lastUserPrompt = useMemo(() => {
    const userMessages = messages.filter((m) => m.role === "user");
    return userMessages.length > 0 ? userMessages[userMessages.length - 1]!.content : "";
  }, [messages]);

  const refreshMessages = useCallback(async () => {
    try {
      setMessages(await getChatMessages(chatId));
    } catch {
      /* transient */
    }
  }, [chatId]);

  const connectToRun = useCallback(
    (runId: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setActiveRunId(runId);
      setProgress(dict.chatPage.progress.connecting);
      setActiveMilestone(null);
      setMilestonesComplete(false);
      setLiveCode("");
      setResult(null);
      setRunError(null);
      setConsent(null);

      const onEvent = (ev: RunStreamEvent) => {
        switch (ev.type) {
          case "heartbeat":
            break;
          case "code_delta":
            setLiveCode((c) => c + String(ev.payload?.delta ?? ""));
            break;
          case "run_completed": {
            const r = ev.payload?.result as CodegenResult | undefined;
            if (r) {
              setResult(r);
              if (r.contractName && isUsableCreationBytecode(r.creationBytecode)) {
                saveVaultBytecode(r.contractName, r.creationBytecode!);
              }
            }
            setProgress(null);
            setMilestonesComplete(true);
            setActiveMilestone("finalize");
            // Keep the consent prompt visible: consent_required runs finish with
            // run_completed right after emitting the choice options.
            void refreshMessages();
            void getChatArtifacts(chatId)
              .then(setArtifacts)
              .catch(() => undefined);
            break;
          }
          case "run_failed":
            setRunError(ev.message ?? "Generation failed.");
            setProgress(null);
            void refreshMessages();
            break;
          case "consent_required":
          case "design_questions": {
            const options = (ev.payload?.options ?? []) as ConsentPrompt["options"];
            setConsent({ message: ev.message ?? "A choice is needed to continue.", options });
            setProgress(null);
            break;
          }
          default: {
            const ms = milestoneForEvent(ev);
            if (ms) setActiveMilestone((prev) => advanceMilestone(prev, ms));
            const line = progressLineFor(ev, dict.chatPage.progress);
            if (line) setProgress(line);
          }
        }
      };

      void streamRunEvents(runId, onEvent, controller.signal)
        .catch((err) => {
          if (!controller.signal.aborted) {
            setRunError(err instanceof Error ? err.message : "Stream lost.");
            setProgress(null);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setProgress(null);
        });
    },
    [chatId, refreshMessages, dict]
  );

  // Initial load: chat, messages, sidebar, storage mode, artifacts, active run.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [chatData, messageData, chatList, cfg, artifactData] = await Promise.all([
          getChat(chatId),
          getChatMessages(chatId),
          listVisibleChats(getCurrentUserId()).catch(() => [] as Chat[]),
          getChatConfig().catch(() => null),
          getChatArtifacts(chatId).catch(() => [] as GeneratedArtifact[]),
        ]);
        if (cancelled) return;
        // Opening an anonymous chat directly (bookmark, or created before a
        // wallet was connected) means this browser knows its id — keep it in
        // the local "my chats" index so it still shows up without a wallet.
        if (!chatData.userId) rememberLocalAnonymousChat(chatData.id);
        setChat(chatData);
        setMessages(messageData);
        setChats(chatList);
        setConfig(cfg);
        setArtifacts(artifactData);

        const runParam = new URLSearchParams(window.location.search).get("run");
        if (runParam) {
          connectToRun(runParam);
          return;
        }
        const runs = await getChatRuns(chatId).catch(() => []);
        if (cancelled) return;
        const active = runs.find((r) => r.status === "running" || r.status === "pending");
        // No active run: replay the latest run's persisted events so the
        // result panels (badges, critic, launch) render on reopen too.
        const target = active ?? runs[runs.length - 1];
        if (target) connectToRun(target.id);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load chat.");
      }
    })();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [chatId, connectToRun]);

  // Re-scope the sidebar to the connected wallet's chats when it (dis)connects.
  useEffect(() => {
    return subscribeCurrentUser(() => {
      void listVisibleChats(getCurrentUserId())
        .then(setChats)
        .catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, progress, result, runError]);

  useEffect(() => {
    if (codeRef.current) codeRef.current.scrollTop = codeRef.current.scrollHeight;
  }, [liveCode]);

  const startNewRun = useCallback(
    async (prompt: string, approximationConsent?: ApproximationConsent) => {
      setSending(true);
      setRunError(null);
      try {
        const resp = await startGeneration({ prompt, chatId, approximationConsent });
        if (!getCurrentUserId()) rememberLocalAnonymousChat(chatId);
        replaceUrl(chatPath(chatId, resp.runId));
        await refreshMessages();
        connectToRun(resp.runId);
      } catch (err) {
        setRunError(err instanceof Error ? err.message : "Failed to start generation.");
      } finally {
        setSending(false);
      }
    },
    [chatId, connectToRun, refreshMessages]
  );

  const onSend = useCallback(() => {
    const text = input.trim();
    if (text.length < 8 || sending || streaming || !walletConnected) return;
    setInput("");
    void startNewRun(text);
  }, [input, sending, streaming, walletConnected, startNewRun]);

  const onRetry = useCallback(() => {
    if (lastUserPrompt) void startNewRun(lastUserPrompt);
  }, [lastUserPrompt, startNewRun]);

  const copySource = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, []);

  const latestSolidity = useMemo(() => {
    const sols = artifacts.filter((a) => a.artifactType === "solidity");
    return sols.length > 0 ? sols[sols.length - 1]! : null;
  }, [artifacts]);

  // Custom UI artifact: live results carry the full package inline; persisted
  // replays only carry a size marker, so fall back to the chat's vault_ui
  // artifact (a JSON-serialized package).
  const latestVaultUi = useMemo(() => {
    const uis = artifacts.filter((a) => a.artifactType === "vault_ui");
    return uis.length > 0 ? uis[uis.length - 1]! : null;
  }, [artifacts]);
  const vaultUiArtifact = useMemo(
    () => parseVaultUiArtifact(result?.uiArtifact ?? null) ?? parseVaultUiArtifact(latestVaultUi?.content ?? null),
    [result, latestVaultUi]
  );

  // Consent/spec-only/refused runs carry a result without generated code —
  // don't show contract badges or launch panels for them.
  const isContractResult = !!result && (result.deliverable ?? "contract") === "contract";

  const displaySource = result?.source || (streaming ? liveCode : latestSolidity?.content ?? "");
  const displayName =
    (isContractResult ? result?.contractName : null) ?? latestSolidity?.name?.replace(/\.sol$/, "") ?? null;
  const numberedSource = useMemo(() => (displaySource ? displaySource.split("\n") : []), [displaySource]);

  // The database (generated_artifacts / launch_status), not localStorage, is
  // the source of truth for factory/register/launch state — this is what
  // makes the launch panel work the same on any device or browser for this
  // chat. localStorage is kept only as a same-browser cache for instant
  // paint before this loads.
  const persistedVault = useMemo(() => mergeVaultState(artifacts), [artifacts]);

  const deployable = !!result && isDeployReady(result);
  const launchReady =
    !!result &&
    (isLaunchReady(result) ||
      // Persisted results are trimmed (no bytecode) — fall back to the
      // database-persisted or locally cached bytecode when other gates pass.
      (result.compiled &&
        result.safety.level !== "fail" &&
        isUsableCreationBytecode(persistedVault.creationBytecode ?? loadVaultBytecode(result.contractName)) &&
        isDeployReady(result)));
  const deployBlockReason = result ? getDeployBlockReason(result) : null;
  const launchBytecode =
    result && isUsableCreationBytecode(result.creationBytecode)
      ? result.creationBytecode
      : result
        ? (persistedVault.creationBytecode ?? loadVaultBytecode(result.contractName))
        : null;
  const repairAttempts: RepairAttempt[] = result?.repairAttempts ?? [];
  const hasReviewContent = Boolean(result?.economicCritique) || repairAttempts.length > 0;

  // Jump straight to the launch tab when a run finishes deploy-ready — the
  // next action should be obvious without scrolling past the code block.
  useEffect(() => {
    if (result && !streaming) {
      if (isContractResult && (deployable || persistedVault.launched)) setResultTab("launch");
      else setResultTab("code");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, streaming]);

  if (loadError) {
    return (
      <div className="container max-w-3xl px-4 py-24 text-center">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button className="mt-4" variant="outline" onClick={() => navigate("/")}>
          {dict.chatPage.backToStudio}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1760px] flex-col px-4 pt-[calc(3.5rem+1rem)] pb-4 sm:px-6 lg:h-screen lg:px-8">
      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[260px_minmax(360px,34%)_1fr]">
        {/* Sidebar: chat history */}
        <div className="hidden h-full min-h-0 flex-col lg:flex">
          <Button
            variant="outline"
            size="sm"
            className="mb-3 w-full shrink-0 gap-1.5"
            onClick={() => navigate("/")}
          >
            <MessageSquarePlus className="size-3.5" />
            {dict.chatPage.newVault}
          </Button>
          {config?.storage === "memory" && (
            <p className="mb-3 shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[0.65rem] text-amber-200">
              {dict.chatPage.memoryWarning}
            </p>
          )}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-lg border border-border bg-card p-2">
            {chats.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate(chatPath(c.id))}
                className={cn(
                  "w-full truncate rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                  c.id === chatId
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                )}
              >
                {c.title || dict.chatPage.untitled}
              </button>
            ))}
            {chats.length === 0 && (
              <p className="px-2 py-1 text-[0.65rem] text-muted-foreground">{dict.chatPage.noPreviousChats}</p>
            )}
          </div>
        </div>

        {/* Messages column */}
        <div className="flex h-[70vh] min-h-0 flex-col rounded-lg border border-border bg-card lg:h-full">
          <div className="shrink-0 border-b border-border px-4 py-3">
            <p className="truncate text-sm font-medium">{chat?.title ?? dict.chatPage.loadingChat}</p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.map((m) => {
              const isPlaceholder = m.role === "assistant" && (m.status === "pending" || m.status === "streaming");
              return (
                <div
                  key={m.id}
                  className={cn(
                    "max-w-[92%] rounded-lg px-3 py-2 text-xs leading-relaxed",
                    m.role === "user"
                      ? "ml-auto bg-primary/15 text-foreground"
                      : "bg-secondary/60 text-foreground/90",
                    m.status === "failed" && "border border-destructive/40"
                  )}
                >
                  {isPlaceholder && streaming ? (
                    <span className="inline-flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      {activeMilestone ? dict.chatPage.milestones[activeMilestone] : (progress ?? dict.hero.generating)}
                    </span>
                  ) : (
                    m.content || (isPlaceholder ? "…" : "")
                  )}
                </div>
              );
            })}

            {streaming && (
              <div className="rounded-md border border-border/60 bg-background/50 px-3 py-3">
                <GenerationMilestoneStepper
                  steps={milestoneSteps}
                  activeId={activeMilestone}
                  allComplete={milestonesComplete}
                  detail={progress}
                  orientation="vertical"
                />
              </div>
            )}

            {consent && (
              <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
                <p className="text-xs text-amber-100">{consent.message}</p>
                <div className="flex flex-wrap gap-2">
                  {consent.options
                    .filter((o) => o.id !== "stop")
                    .map((o) => (
                      <Button
                        key={o.id}
                        size="sm"
                        variant="outline"
                        disabled={sending}
                        onClick={() => void startNewRun(lastUserPrompt, o.id as ApproximationConsent)}
                      >
                        {o.label}
                      </Button>
                    ))}
                  <Button size="sm" variant="ghost" onClick={() => setConsent(null)}>
                    Stop here
                  </Button>
                </div>
              </div>
            )}

            {runError && (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5">
                <p className="inline-flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="size-3.5" />
                  {runError}
                </p>
                {lastUserPrompt && (
                  <Button size="sm" variant="outline" disabled={sending} onClick={onRetry} className="gap-1.5">
                    <RotateCcw className="size-3.5" />
                    Retry
                  </Button>
                )}
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          <div className="shrink-0 border-t border-border p-3">
            {!walletConnected ? (
              <p className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <Wallet className="size-3.5 shrink-0" /> {dict.chatPage.walletNotice}
              </p>
            ) : (
              <div className="flex gap-2">
                <Textarea
                  rows={2}
                  value={input}
                  placeholder={
                    streaming ? dict.chatPage.composerPlaceholderStreaming : dict.chatPage.composerPlaceholderIdle
                  }
                  disabled={streaming || sending}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      onSend();
                    }
                  }}
                  className="min-h-[52px] flex-1 resize-none text-xs"
                />
                <Button size="sm" disabled={streaming || sending || input.trim().length < 8} onClick={onSend}>
                  {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Result / live code panel */}
        <Card className="flex h-[70vh] min-h-0 flex-col overflow-hidden lg:h-full">
          <CardHeader className="shrink-0 pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <span className="font-mono">{displayName ? `${displayName}.sol` : dict.chatPage.outputLabel}</span>
              {isContractResult && result && (
                <Badge variant={result.compiled ? "success" : "destructive"}>
                  {result.compiled ? "Compiles" : "Compile failed"}
                </Badge>
              )}
              {isContractResult && result?.integrationTestsPassed && <Badge variant="success">Tests pass</Badge>}
              {isContractResult && result && (
                <Badge
                  variant={
                    result.safety.level === "pass"
                      ? "success"
                      : result.safety.level === "warn"
                        ? "warning"
                        : "destructive"
                  }
                >
                  safety: {result.safety.level}
                </Badge>
              )}
              {streaming && (
                <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {progress ?? "Working…"}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            {displaySource || (isContractResult && result) ? (
              <>
                {/* Section tabs — keep the deploy/launch card reachable without
                    scrolling past the code block. Hidden while streaming. */}
                {isContractResult && result && !streaming && (
                  <div className="flex shrink-0 items-center gap-1 border-b border-border pb-2">
                    {(
                      [
                        { id: "code" as ResultTab, label: "Code", show: true },
                        { id: "review" as ResultTab, label: "Review", show: hasReviewContent },
                        { id: "ui" as ResultTab, label: "Vault UI", show: !!vaultUiArtifact },
                        { id: "launch" as ResultTab, label: "Deploy & Launch", show: true },
                      ] satisfies { id: ResultTab; label: string; show: boolean }[]
                    )
                      .filter((t) => t.show)
                      .map((t) => (
                        <Button
                          key={t.id}
                          size="sm"
                          variant={resultTab === t.id ? "secondary" : "ghost"}
                          className="h-7 gap-1.5 px-2.5 text-xs"
                          onClick={() => setResultTab(t.id)}
                        >
                          {t.label}
                          {t.id === "launch" &&
                            (deployable || persistedVault.launched ? (
                              <CircleCheck className="size-3 text-success" />
                            ) : (
                              <CircleX className="size-3 text-destructive" />
                            ))}
                        </Button>
                      ))}
                  </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {(streaming || !isContractResult || !result || resultTab === "code") && (
                  <>
                    {displaySource ? (
                      <>
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            onClick={() => void copySource(displaySource)}
                          >
                            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                            {copied ? "Copied" : "Copy source"}
                          </Button>
                        </div>
                        <pre
                          ref={codeRef}
                          className="flex-1 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[0.7rem] leading-relaxed"
                        >
                          <code>
                            {numberedSource.map((line, i) => (
                              <div key={i} className="grid grid-cols-[3ch_1fr] gap-2">
                                <span className="select-none text-right text-muted-foreground/40">{i + 1}</span>
                                <span className="whitespace-pre-wrap break-words text-foreground/90">{line}</span>
                              </div>
                            ))}
                            {streaming && liveCode && (
                              <span className="ml-[calc(3ch+0.5rem)] inline-block h-3.5 w-0.5 animate-pulse bg-primary" />
                            )}
                          </code>
                        </pre>
                      </>
                    ) : (
                      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                        No source available for this result.
                      </div>
                    )}
                  </>
                )}

                {!streaming && isContractResult && result && resultTab === "review" && (
                  <div className="flex flex-col gap-3 overflow-y-auto">
                    {result.economicCritique && <EconomicCriticPanel report={result.economicCritique} />}
                    {repairAttempts.length > 0 && <RepairSummaryBanner attempts={repairAttempts} />}
                    {!hasReviewContent && (
                      <p className="text-xs text-muted-foreground">No review findings for this run.</p>
                    )}
                  </div>
                )}

                {!streaming && isContractResult && result && resultTab === "ui" && vaultUiArtifact && (
                  <div className="flex flex-col gap-3 overflow-y-auto">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {persistedVault.launched
                          ? "Live custom UI — connected to the launched vault through this page's sandbox bridge."
                          : "Preview with placeholder values — goes live automatically once the token is launched. This UI always works on our site; download the artifact to submit it to Flap's Workbench so flap.sh shows it too after their review."}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() =>
                          void downloadVaultUiPackage(vaultUiArtifact, result.contractName, {
                            factoryAddress: persistedVault.launched?.factoryAddress ?? persistedVault.factoryAddress,
                            tokenAddress: persistedVault.launched?.tokenAddress ?? null,
                          })
                        }
                      >
                        <Download className="size-3.5" /> Download package
                      </Button>
                    </div>
                    <VaultCustomUI
                      artifact={vaultUiArtifact}
                      vaultAddress={(persistedVault.launched?.vaultAddress ?? null) as `0x${string}` | null}
                      tokenAddress={(persistedVault.launched?.tokenAddress ?? null) as `0x${string}` | null}
                      factoryAddress={(persistedVault.launched?.factoryAddress ?? null) as `0x${string}` | null}
                      tokenName={result.contractName}
                      className="h-[64vh] w-full rounded-md border border-border bg-background"
                    />
                  </div>
                )}

                {!streaming && isContractResult && result && resultTab === "launch" && (
                  <div className="flex flex-col gap-3 overflow-y-auto">
                    <div className="rounded-md border border-border bg-secondary/30 p-3">
                      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
                        {deployable ? (
                          <CircleCheck className="size-3.5 text-success" />
                        ) : (
                          <CircleX className="size-3.5 text-destructive" />
                        )}
                        {!deployable
                          ? "Launch blocked"
                          : walletConnected && onTestnet
                            ? "All launch gates pass"
                            : "Contract ready — connect your wallet on BNB testnet to continue"}
                      </div>
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        <GateRow ok={result.compiled} label="Compiled" />
                        <GateRow
                          ok={result.safety.level !== "fail"}
                          label="Safety scanners"
                          detail={result.safety.level}
                        />
                        <GateRow ok={result.integrationTestsPassed} label="Integration tests" />
                        <GateRow
                          ok={scopeAllowsLaunch(result)}
                          label="Scope"
                          detail={result.scope?.verdict ?? "launch_ready_possible"}
                        />
                        <GateRow
                          ok={isUsableCreationBytecode(launchBytecode)}
                          label="Bytecode"
                          detail={isUsableCreationBytecode(launchBytecode) ? "present" : "missing — paste it below"}
                        />
                        <GateRow
                          ok={walletConnected}
                          label="Wallet"
                          detail={
                            walletConnected && walletAddress
                              ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
                              : "not connected"
                          }
                        />
                        <GateRow
                          ok={walletConnected && onTestnet}
                          label="Network"
                          detail={
                            !walletConnected ? "—" : onTestnet ? "BNB testnet (97)" : `wrong chain (${walletChainId})`
                          }
                        />
                      </div>
                      {deployBlockReason && (
                        <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                          {deployBlockReason}
                        </p>
                      )}
                    </div>

                    <LaunchOnFlapPanel
                      launchReady={launchReady}
                      deployReady={deployable}
                      deployBlockReason={deployBlockReason}
                      running={streaming}
                      contractName={result.contractName}
                      vaultDescription={result.explanation}
                      creationBytecode={launchBytecode}
                      uiArtifactJson={vaultUiArtifact ? JSON.stringify(vaultUiArtifact) : null}
                      chatId={chatId}
                      runId={activeRunId}
                      persistedVaultState={persistedVault}
                    />
                    {!deployable && !persistedVault.launched && (
                      <p className="text-xs text-muted-foreground">
                        Deploy and launch actions unlock once every gate above passes. Fix the blocking reason (or
                        send a refinement message) and this section updates automatically.
                      </p>
                    )}
                  </div>
                )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-8">
                {streaming ? (
                  <div className="w-full max-w-md">
                    <GenerationMilestoneStepper
                      steps={milestoneSteps}
                      activeId={activeMilestone}
                      allComplete={milestonesComplete}
                      detail={progress}
                      orientation="horizontal"
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No generated code in this chat yet.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
