import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Copy,
  Check,
  CircleCheck,
  CircleX,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
} from "lucide-react";
import {
  streamVault,
  streamVaultRefine,
  type CodegenEvent,
  type CodegenResult,
  type FixLogEntry,
  type RefineSession,
  type SpecAuditResult,
} from "./lib/codegen";
import { MAX_PIPELINE_ATTEMPTS, type CodeResetInfo, type PipelinePhase } from "./lib/pipeline-status";
import CodegenChatPanel, { type ChatUiMessage } from "./components/CodegenChatPanel";
import PipelineProgress from "./components/PipelineProgress";
import SpecAuditPanel from "./components/SpecAuditPanel";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";

const EXAMPLES = [
  "Stake-to-earn: holders stake tokens and earn a share of tax BNB proportional to their stake",
  "Top-10 holders snapshot airdrop of accumulated BNB every 24h",
  "Price-independent dividend: split all tax BNB pro-rata to current holders on claim",
  "Burn lottery: every deposit buys+burns, and one random burner wins a weekly jackpot",
];

const SAFETY = {
  pass: { label: "pass", cls: "text-success", Icon: ShieldCheck, badge: "success" as const },
  warn: { label: "review", cls: "text-warning", Icon: ShieldAlert, badge: "warning" as const },
  fail: { label: "blocked", cls: "text-destructive", Icon: ShieldX, badge: "destructive" as const },
};

type Phase = PipelinePhase;

function specFailRules(audit: SpecAuditResult): string[] {
  return audit.items.filter((i) => i.status === "fail").map((i) => i.id);
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type Props = {
  onChatActive?: (active: boolean) => void;
};

export default function CodegenStudio({ onChatActive }: Props) {
  const [prompt, setPrompt] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [viewMode, setViewMode] = useState<"prompt" | "chat">("prompt");
  const [chatMessages, setChatMessages] = useState<ChatUiMessage[]>([]);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CodegenResult | null>(null);
  const [copied, setCopied] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [attempt, setAttempt] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(MAX_PIPELINE_ATTEMPTS);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [fixLog, setFixLog] = useState<FixLogEntry[]>([]);
  const [resetInfo, setResetInfo] = useState<CodeResetInfo | null>(null);
  const [liveCode, setLiveCode] = useState("");
  const [liveName, setLiveName] = useState("");
  const [liveAudit, setLiveAudit] = useState<SpecAuditResult | null>(null);
  const codeRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    onChatActive?.(viewMode === "chat");
  }, [viewMode, onChatActive]);

  useEffect(() => {
    if (codeRef.current) codeRef.current.scrollTop = codeRef.current.scrollHeight;
  }, [liveCode]);

  const resetAll = useCallback(() => {
    setViewMode("prompt");
    setChatMessages([]);
    setInitialPrompt("");
    setPrompt("");
    setResult(null);
    setError(null);
    setLiveCode("");
    setLiveName("");
    setLiveAudit(null);
    setStatusMsg(null);
    setFixLog([]);
    setResetInfo(null);
    setPhase("idle");
    setAttempt(0);
    setMaxAttempts(MAX_PIPELINE_ATTEMPTS);
    setRunning(false);
  }, []);

  const handleEvent = useCallback((ev: CodegenEvent) => {
    switch (ev.type) {
      case "status":
        setPhase(ev.phase);
        setAttempt(ev.attempt);
        if (ev.maxAttempts) setMaxAttempts(ev.maxAttempts);
        setStatusMsg(ev.message ?? null);
        break;
      case "code_reset":
        setLiveCode("");
        setResetInfo({
          attempt: ev.attempt,
          reason: ev.reason ?? (ev.attempt <= 1 ? "initial" : "retry"),
          retryKind: ev.retryKind,
          message: ev.message,
        });
        break;
      case "fix_log":
        setFixLog((prev) => [...prev, ev.entry]);
        break;
      case "code_delta":
        setLiveCode((c) => c + ev.delta);
        break;
      case "name":
        setLiveName(ev.contractName);
        break;
      case "result":
        setResult(ev.result);
        if (ev.result.fixLog.length > 0) setFixLog(ev.result.fixLog);
        if (ev.result.safety.level === "fail" || !ev.result.compiled) {
          setStatusMsg(
            ev.result.attempts >= MAX_PIPELINE_ATTEMPTS
              ? `Auto-fix stopped after ${ev.result.attempts} passes — ${ev.result.safety.findings.find((f) => f.level === "block")?.detail ?? "see safety scan"}`
              : ev.result.safety.findings.find((f) => f.level === "block")?.detail ?? "Generation finished with issues"
          );
        }
        break;
      case "spec_audit":
        setLiveAudit(ev.audit);
        break;
      case "error":
        setError(ev.error);
        break;
    }
  }, []);

  const enterChat = useCallback((userPrompt: string, res: CodegenResult) => {
    setInitialPrompt(userPrompt);
    setChatMessages([
      { id: uid(), role: "user", content: userPrompt },
      { id: uid(), role: "assistant", content: res.explanation },
    ]);
    setViewMode("chat");
  }, []);

  const onGenerate = async () => {
    const p = prompt.trim();
    if (p.length < 8) return;
    setError(null);
    setResult(null);
    setLiveCode("");
    setLiveName("");
    setLiveAudit(null);
    setStatusMsg(null);
    setFixLog([]);
    setResetInfo(null);
    setAttempt(0);
    setMaxAttempts(MAX_PIPELINE_ATTEMPTS);
    setPhase("writing");
    setRunning(true);
    try {
      await streamVault(p, handleEvent);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Codegen failed");
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (viewMode === "prompt" && result && !running && initialPrompt === "") {
      enterChat(prompt.trim(), result);
    }
  }, [result, running, viewMode, prompt, initialPrompt, enterChat]);

  const onChatSend = async (message: string) => {
    if (!result || !initialPrompt) return;

    const historyForSession = chatMessages.map((m) => ({ role: m.role, content: m.content }));

    const userMsg: ChatUiMessage = { id: uid(), role: "user", content: message };
    const pendingId = uid();
    setChatMessages((prev) => [...prev, userMsg, { id: pendingId, role: "assistant", content: "", pending: true }]);
    setError(null);
    setLiveCode("");
    setLiveName(result.contractName);
    setLiveAudit(null);
    setStatusMsg(null);
    setFixLog([]);
    setResetInfo(null);
    setAttempt(0);
    setMaxAttempts(MAX_PIPELINE_ATTEMPTS);
    setPhase("writing");
    setRunning(true);

    const session: RefineSession = {
      initialPrompt,
      contractName: result.contractName,
      source: result.source,
      chatHistory: historyForSession,
    };

    let latest: CodegenResult | null = null;
    try {
      await streamVaultRefine(message, session, (ev) => {
        handleEvent(ev);
        if (ev.type === "result") latest = ev.result;
      });
      if (latest) {
        setChatMessages((prev) =>
          prev
            .filter((m) => m.id !== pendingId)
            .concat({ id: uid(), role: "assistant", content: latest!.explanation })
        );
      } else {
        setChatMessages((prev) => prev.filter((m) => m.id !== pendingId));
      }
    } catch (e) {
      setChatMessages((prev) => prev.filter((m) => m.id !== pendingId));
      setError(e instanceof Error ? e.message : "Refine failed");
    } finally {
      setRunning(false);
    }
  };

  const copy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, []);

  const deployable =
    !!result &&
    result.compiled &&
    result.safety.level !== "fail" &&
    result.specAudit.level !== "fail";
  const safety = result ? SAFETY[result.safety.level] : null;
  const specLevel = result?.specAudit.level;
  const specFails = result ? specFailRules(result.specAudit) : [];
  const displaySource = running && liveCode ? liveCode : result?.source ?? "";
  const numberedSource = useMemo(() => (displaySource ? displaySource.split("\n") : []), [displaySource]);

  const pipelineProgress = running ? (
    <PipelineProgress
      phase={phase}
      attempt={attempt}
      maxAttempts={maxAttempts}
      statusMsg={statusMsg}
      resetInfo={resetInfo}
      fixLog={fixLog.length > 0 ? fixLog : result?.fixLog ?? []}
    />
  ) : null;

  const vaultPanel = result ? (
    <Card className="flex h-full min-h-[520px] flex-col">
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className="font-mono">{result.contractName}.sol</span>
            <Badge variant={result.compiled ? "success" : "destructive"}>
              {result.compiled ? "Compiles" : "Compile failed"}
            </Badge>
            {safety && <Badge variant={safety.badge}>safety: {safety.label}</Badge>}
            {specLevel && specLevel !== "skipped" && (
              <Badge variant={specLevel === "pass" ? "success" : specLevel === "warn" ? "warning" : "destructive"}>
                spec: {specLevel}
              </Badge>
            )}
            {running && <Badge variant="warning">updating…</Badge>}
          </CardTitle>
          <CardDescription className="text-xs">{result.explanation}</CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          {pipelineProgress}

          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
            <div className="flex items-center justify-between border-b border-border bg-secondary/50 px-3 py-1.5">
              <span className="text-xs text-muted-foreground">Solidity</span>
              <button
                type="button"
                onClick={() => copy(result.source)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre
              ref={codeRef}
              className="max-h-[340px] overflow-auto p-3 font-mono text-[0.68rem] leading-relaxed lg:max-h-[420px]"
            >
              <code>
                {numberedSource.map((line, i) => (
                  <div key={i} className="grid grid-cols-[3ch_1fr] gap-2">
                    <span className="select-none text-right text-muted-foreground/40">{i + 1}</span>
                    <span className="whitespace-pre-wrap break-words text-foreground/90">{line}</span>
                  </div>
                ))}
              </code>
            </pre>
          </div>

          {result.specAudit && result.specAudit.level !== "skipped" && (
            <div className="max-h-48 overflow-y-auto">
              <SpecAuditPanel audit={result.specAudit} />
            </div>
          )}

          <div className="rounded-md border border-border bg-secondary/30 p-2.5 text-xs">
            <div className="flex items-center gap-2">
              {deployable ? (
                <CircleCheck className="size-3.5 text-success" />
              ) : (
                <CircleX className="size-3.5 text-destructive" />
              )}
              <span className="font-medium">{deployable ? "Ready for testnet" : "Not deployable yet"}</span>
            </div>
            {specFails.length > 0 && (
              <p className="mt-1 text-muted-foreground">FAIL rules: {specFails.join(", ")}</p>
            )}
          </div>
        </CardContent>
      </Card>
  ) : null;

  if (viewMode === "chat") {
    return (
      <div className="space-y-4">
        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="grid min-h-[calc(100vh-10rem)] gap-4 lg:grid-cols-[minmax(300px,380px)_1fr]">
          <CodegenChatPanel
            messages={chatMessages}
            running={running}
            phase={phase}
            attempt={attempt}
            maxAttempts={maxAttempts}
            statusMsg={statusMsg}
            resetInfo={resetInfo}
            fixLog={fixLog}
            contractName={result?.contractName ?? liveName}
            onSend={onChatSend}
            onNewVault={resetAll}
          />
          {vaultPanel ?? (
            <Card className="flex min-h-[520px] items-center justify-center">
              <Loader2 className="size-8 animate-spin text-primary" />
            </Card>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-4">
          <Textarea
            rows={5}
            placeholder="e.g. holders stake tokens and earn pro-rata tax BNB; weekly AI draw picks a winner from snapshotted entrants…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="min-h-[140px] resize-none text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void onGenerate();
              }
            }}
          />
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setPrompt(ex)}
                className="rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-left text-[0.65rem] text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground"
              >
                {ex.length > 48 ? `${ex.slice(0, 48)}…` : ex}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button variant="default" onClick={onGenerate} disabled={running || prompt.trim().length < 8}>
              {running ? <Loader2 className="animate-spin" /> : null}
              {running ? "Generating…" : "Generate Solidity"}
            </Button>
            <span className="text-xs text-muted-foreground">⌘↵</span>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </CardContent>
      </Card>

      {(running || liveCode) && !result && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-mono">
              {liveName ? `${liveName}.sol` : "Output"}
            </CardTitle>
            {running && pipelineProgress && <div className="pt-1">{pipelineProgress}</div>}
          </CardHeader>
          <CardContent>
            <pre
              ref={codeRef}
              className="max-h-[420px] overflow-auto rounded-md border border-border bg-background p-4 font-mono text-[0.72rem]"
            >
              <code className="whitespace-pre-wrap text-foreground/90">
                {liveCode || "Waiting for stream…"}
                {running && liveCode && <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-primary" />}
              </code>
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
