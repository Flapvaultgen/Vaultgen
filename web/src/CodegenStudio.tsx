import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Copy,
  Check,
  CircleCheck,
  CircleX,
  Download,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Sparkles,
  Lightbulb,
  Info,
  Ban,
  Wallet,
} from "lucide-react";
import { useAccount } from "wagmi";
import {
  streamVault,
  streamVaultRefine,
  type ApproximationConsent,
  type ApproximationReport,
  type CodegenEvent,
  type CodegenResult,
  type FixLogEntry,
  type EconomicCriticReport,
  type MechanicSpec,
  type RefineSession,
  type RepairAttempt,
  type SpecAuditResult,
  type VaultScope,
} from "./lib/codegen";
import { MAX_TOTAL_PIPELINE_ATTEMPTS, type CodeResetInfo, type PipelinePhase } from "./lib/pipeline-status";
import { getDeployBlockReason, isDeployReady, isLaunchReady } from "./lib/deploy-gate";
import { isUsableCreationBytecode } from "./lib/flap-register";
import { saveVaultBytecode } from "./lib/studio-config";
import { rememberLocalAnonymousChat, startGeneration } from "./lib/chat-api";
import { getCurrentUserId } from "./lib/current-user";
import { chatPath, navigate } from "./lib/router";
import CodegenChatPanel, { type ChatUiMessage } from "./components/CodegenChatPanel";
import PipelineProgress from "./components/PipelineProgress";
import EconomicCriticPanel from "./components/EconomicCriticPanel";
import SpecAuditPanel from "./components/SpecAuditPanel";
import LaunchOnFlapPanel from "./components/LaunchOnFlapPanel";
import VaultCustomUI from "./components/VaultCustomUI";
import { downloadVaultUiPackage, parseVaultUiArtifact } from "./lib/vault-ui-bridge";
import HeroBackdrop from "./components/HeroBackdrop";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";
import { useI18n } from "./lib/i18n/context";
import { VAULT_GENERATION_ENABLED } from "./lib/studio-flags";

// Free-form mechanic ideas — inspiration, not a menu. Any Flap-compatible
// mechanic can be described; the AI plans whatever is written. Localized
// per-language via dict.hero.examples (see web/src/lib/i18n).

const SAFETY = {
  pass: { label: "pass", cls: "text-success", Icon: ShieldCheck, badge: "success" as const },
  warn: { label: "review", cls: "text-warning", Icon: ShieldAlert, badge: "warning" as const },
  fail: { label: "blocked", cls: "text-destructive", Icon: ShieldX, badge: "destructive" as const },
};

// Phase 6 Draft/Launch verdicts — capability-based, never archetype-based.
// Labels come from dict.studio.scopeVerdicts (see web/src/lib/i18n) — only the
// icon/color styling is static here.
const SCOPE_META = {
  launch_ready_possible: { Icon: Sparkles, box: "border-success/30 bg-success/5", accent: "text-success" },
  draft_only: { Icon: Lightbulb, box: "border-warning/30 bg-warning/5", accent: "text-warning" },
  needs_custom_ui: { Icon: Info, box: "border-warning/40 bg-warning/10", accent: "text-warning" },
  needs_protocol_extension: { Icon: Ban, box: "border-destructive/40 bg-destructive/10", accent: "text-destructive" },
  unsafe_or_unsupported: { Icon: Ban, box: "border-destructive/40 bg-destructive/10", accent: "text-destructive" },
} as const;

function ScopeBanner({ scope }: { scope: VaultScope }) {
  const { dict } = useI18n();
  const meta = SCOPE_META[scope.verdict] ?? SCOPE_META.launch_ready_possible;
  const label = dict.studio.scopeVerdicts[scope.verdict] ?? dict.studio.scopeVerdicts.launch_ready_possible;
  const { Icon } = meta;
  return (
    <div className={`rounded-md border p-3 text-xs ${meta.box}`}>
      <div className="flex items-center gap-2">
        <Icon className={`size-4 shrink-0 ${meta.accent}`} />
        <span className={`font-semibold ${meta.accent}`}>{label}</span>
      </div>
      <p className="mt-1.5 text-foreground/90">{scope.summary}</p>
      {scope.unsupported.length > 0 && (
        <div className="mt-2">
          <span className="font-medium text-muted-foreground">{dict.studio.notDeliveredAsRequested}</span>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {scope.unsupported.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {scope.requiredForLaunch.length > 0 && (
        <div className="mt-2">
          <span className="font-medium text-muted-foreground">{dict.studio.requiredToLaunch}</span>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {scope.requiredForLaunch.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {scope.suggestion && (
        <p className="mt-2 text-muted-foreground">
          <span className="font-medium text-foreground/80">{dict.studio.next}</span> {scope.suggestion}
        </p>
      )}
    </div>
  );
}

/** Honest preserved/dropped record for a consented closest-draft approximation. */
function ApproximationBanner({ report }: { report: ApproximationReport }) {
  const { dict } = useI18n();
  return (
    <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Info className="size-4 shrink-0 text-warning" />
        <span className="font-semibold text-warning">{dict.studio.approximatedDraftTitle}</span>
      </div>
      <p className="mt-1.5 text-foreground/90">{report.whyNotLaunchReady}</p>
      {report.preserved.length > 0 && (
        <p className="mt-2 text-muted-foreground">
          <span className="font-medium text-foreground/80">{dict.studio.preserved}</span> {report.preserved.join("; ")}
        </p>
      )}
      {report.dropped.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          <span className="font-medium text-foreground/80">{dict.studio.dropped}</span> {report.dropped.join("; ")}
        </p>
      )}
      {report.requiredForLaunch.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          <span className="font-medium text-foreground/80">{dict.studio.toBuildAsRequested}</span>{" "}
          {report.requiredForLaunch.join("; ")}
        </p>
      )}
    </div>
  );
}

type ConsentRequest = Extract<CodegenEvent, { type: "consent_required" }>;

/** Explicit approximation choice — generation never proceeds silently. */
function ConsentCard({
  request,
  running,
  onChoose,
  onStop,
}: {
  request: ConsentRequest;
  running: boolean;
  onChoose: (consent: ApproximationConsent) => void;
  onStop: () => void;
}) {
  return (
    <Card className="border-warning/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Info className="size-4 text-warning" />
          Choose how to proceed
        </CardTitle>
        <CardDescription className="text-xs">
          This idea is not launch-ready as requested — nothing was generated yet. Pick one:
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ScopeBanner scope={request.scope} />
        <div className="flex flex-col gap-2">
          <Button variant="default" disabled={running} onClick={() => onChoose("closest_draft")}>
            Build the closest Flap-compatible draft (differences listed honestly)
          </Button>
          <Button variant="secondary" disabled={running} onClick={() => onChoose("spec_only")}>
            Keep as a draft spec only — no contract yet
          </Button>
          <Button variant="ghost" disabled={running} onClick={onStop}>
            Stop — the requirements above explain what it would take
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const REPAIR_REASON_LABEL: Record<RepairAttempt["reason"], string> = {
  critic_finding: "economic critic findings",
  test_failure: "integration test failure",
  critic_and_test: "critic findings + test failure",
};

/** Compact record of automatic repair attempts (critic feeds repair; launch gates stay deterministic). */
export function RepairSummaryBanner({ attempts }: { attempts: RepairAttempt[] }) {
  const total = attempts.length;
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-semibold text-foreground/90">Automatic repair</span>
        <span className="text-muted-foreground">
          {total} attempt{total === 1 ? "" : "s"} — triggered by advisory critic findings
        </span>
      </div>
      <div className="mt-2 space-y-2">
        {attempts.map((a) => (
          <div key={a.attempt} className="rounded border border-border/60 bg-background/40 p-2">
            <p className="text-foreground/90">
              <span className="font-medium">
                Repair attempt {a.attempt} / {total}
              </span>{" "}
              — {REPAIR_REASON_LABEL[a.reason]}
              {a.escalated ? " · escalation model" : ""}
              <span className="ml-1 font-mono text-muted-foreground">({a.model})</span>
            </p>
            {a.findingsAddressed.length > 0 && (
              <p className="mt-0.5 text-muted-foreground">Addressed: {a.findingsAddressed.join(", ")}</p>
            )}
            <p className="mt-0.5 text-muted-foreground">
              compile: {a.compileResult} · scanners: {a.scannerResult} · tests: {a.testResult} · critic:{" "}
              {a.criticResult === "clean" ? "clean" : a.criticResult === "findings_remain" ? "findings remain" : "not rerun"}
            </p>
            {a.remainingIssues.length > 0 && (
              <p className="mt-0.5 text-warning">Remaining: {a.remainingIssues.join("; ")}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Compact plan-first summary: the MechanicSpec produced before Solidity generation. */
function MechanicPlanBanner({ spec }: { spec: MechanicSpec }) {
  const applicableRules = Object.entries(spec.ruleAnalysis ?? {})
    .filter(([, entry]) => entry?.applies)
    .map(([id]) => id)
    .sort();
  const actions = [...spec.userActions, ...spec.managerActions].map((a) => a.name);
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Lightbulb className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-semibold text-foreground/90">Mechanic plan</span>
        {applicableRules.length > 0 && (
          <span className="text-muted-foreground">Flap rules: {applicableRules.join(", ")}</span>
        )}
      </div>
      <p className="mt-1.5 text-foreground/90">{spec.productSummary}</p>
      {actions.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          <span className="font-medium text-foreground/80">Actions:</span> {actions.join(", ")}
        </p>
      )}
    </div>
  );
}

type Phase = PipelinePhase;

function specFailRules(audit: SpecAuditResult): string[] {
  return audit.items.filter((i) => i.status === "fail").map((i) => i.id);
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type Props = {
  onChatActive?: (active: boolean) => void;
  heroLayout?: boolean;
};

export default function CodegenStudio({ onChatActive, heroLayout = false }: Props) {
  const { isConnected: walletConnected } = useAccount();
  const { dict } = useI18n();
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
  const [maxAttempts, setMaxAttempts] = useState(MAX_TOTAL_PIPELINE_ATTEMPTS);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [fixLog, setFixLog] = useState<FixLogEntry[]>([]);
  const [resetInfo, setResetInfo] = useState<CodeResetInfo | null>(null);
  const [liveCode, setLiveCode] = useState("");
  const [liveName, setLiveName] = useState("");
  const [liveAudit, setLiveAudit] = useState<SpecAuditResult | null>(null);
  const [liveEconomicCritique, setLiveEconomicCritique] = useState<EconomicCriticReport | null>(null);
  const [scope, setScope] = useState<VaultScope | null>(null);
  const [mechanicSpec, setMechanicSpec] = useState<MechanicSpec | null>(null);
  const [consentRequest, setConsentRequest] = useState<ConsentRequest | null>(null);
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
    setLiveEconomicCritique(null);
    setScope(null);
    setMechanicSpec(null);
    setConsentRequest(null);
    setStatusMsg(null);
    setFixLog([]);
    setResetInfo(null);
    setPhase("idle");
    setAttempt(0);
    setMaxAttempts(MAX_TOTAL_PIPELINE_ATTEMPTS);
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
        if (isUsableCreationBytecode(ev.result.creationBytecode)) {
          saveVaultBytecode(ev.result.contractName, ev.result.creationBytecode);
        }
        if (ev.result.scope) setScope(ev.result.scope);
        if (ev.result.mechanicSpec) setMechanicSpec(ev.result.mechanicSpec);
        if (ev.result.fixLog.length > 0) setFixLog(ev.result.fixLog);
        if (ev.result.safety.level === "fail" || !ev.result.compiled) {
          setStatusMsg(
            ev.result.attempts >= MAX_TOTAL_PIPELINE_ATTEMPTS
              ? `Auto-fix stopped after ${ev.result.attempts} passes — ${ev.result.safety.findings.find((f) => f.level === "block")?.detail ?? "see safety scan"}`
              : ev.result.safety.findings.find((f) => f.level === "block")?.detail ?? "Generation finished with issues"
          );
        }
        break;
      case "spec_audit":
        setLiveAudit(ev.audit);
        break;
      case "economic_critique":
        setLiveEconomicCritique(ev.report);
        break;
      case "scope":
        setScope(ev.scope);
        break;
      case "mechanic_spec":
        setMechanicSpec(ev.spec);
        break;
      case "consent_required":
        setConsentRequest(ev);
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

  const runGenerate = useCallback(
    async (p: string, consent?: ApproximationConsent) => {
      setError(null);
      setResult(null);
      setLiveCode("");
      setLiveName("");
      setLiveAudit(null);
      setLiveEconomicCritique(null);
      setScope(null);
      setMechanicSpec(null);
      setConsentRequest(null);
      setStatusMsg(null);
      setFixLog([]);
      setResetInfo(null);
      setAttempt(0);
      setMaxAttempts(MAX_TOTAL_PIPELINE_ATTEMPTS);
      setPhase("writing");
      setRunning(true);
      try {
        await streamVault(p, handleEvent, consent);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Codegen failed");
      } finally {
        setRunning(false);
      }
    },
    [handleEvent]
  );

  /**
   * Prompt submit: create the chat + run server-side (fast, no LLM work),
   * then navigate straight to the chat page, which connects to the run's
   * SSE stream. The in-place runGenerate flow remains for consent re-runs.
   */
  const onGenerate = async () => {
    const p = prompt.trim();
    if (p.length < 8 || running || !walletConnected || !VAULT_GENERATION_ENABLED) return;
    setError(null);
    setRunning(true);
    try {
      const resp = await startGeneration({ prompt: p });
      if (!getCurrentUserId()) rememberLocalAnonymousChat(resp.chatId);
      navigate(chatPath(resp.chatId, resp.runId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start generation");
    } finally {
      setRunning(false);
    }
  };

  /** Explicit approximation choice — re-runs generation with the consent recorded. */
  const onConsent = useCallback(
    (consent: ApproximationConsent) => {
      const p = prompt.trim();
      if (p.length < 8) return;
      void runGenerate(p, consent);
    },
    [prompt, runGenerate]
  );

  useEffect(() => {
    const isContract = !result?.deliverable || result.deliverable === "contract";
    if (viewMode === "prompt" && result && isContract && result.source && !running && initialPrompt === "") {
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
    setLiveEconomicCritique(null);
    setStatusMsg(null);
    setFixLog([]);
    setResetInfo(null);
    setAttempt(0);
    setMaxAttempts(MAX_TOTAL_PIPELINE_ATTEMPTS);
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

  const deployable = !!result && isDeployReady(result);
  const launchReady = !!result && isLaunchReady(result);
  const deployBlockReason = result ? getDeployBlockReason(result) : null;
  const safety = result ? SAFETY[result.safety.level] : null;
  const specLevel = result?.specAudit.level;
  const specFails = result ? specFailRules(result.specAudit) : [];
  const economicCritique = result?.economicCritique ?? liveEconomicCritique;
  const displaySource = running && liveCode ? liveCode : result?.source ?? "";
  const numberedSource = useMemo(() => (displaySource ? displaySource.split("\n") : []), [displaySource]);
  const studioUiArtifact = useMemo(() => parseVaultUiArtifact(result?.uiArtifact ?? null), [result]);

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

          {mechanicSpec && <MechanicPlanBanner spec={mechanicSpec} />}
          {scope && scope.verdict !== "launch_ready_possible" && <ScopeBanner scope={scope} />}
          {result.approximation && <ApproximationBanner report={result.approximation} />}

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

          {economicCritique && (
            <div className="max-h-64 overflow-y-auto">
              <EconomicCriticPanel report={economicCritique} />
            </div>
          )}

          {result.repairAttempts && result.repairAttempts.length > 0 && (
            <div className="max-h-56 overflow-y-auto">
              <RepairSummaryBanner attempts={result.repairAttempts} />
            </div>
          )}

          <div className="rounded-md border border-border bg-secondary/30 p-2.5 text-xs">
            <div className="flex items-center gap-2">
              {deployable ? (
                <CircleCheck className="size-3.5 text-success" />
              ) : (
                <CircleX className="size-3.5 text-destructive" />
              )}
              <span className="font-medium">{deployable ? "Ready to launch on Flap" : "Not deployable yet"}</span>
            </div>
            {deployBlockReason && (
              <p className="mt-1 text-muted-foreground">{deployBlockReason}</p>
            )}
            {specFails.length > 0 && (
              <p className="mt-1 text-muted-foreground">Spec FAIL rules: {specFails.join(", ")}</p>
            )}
          </div>

          {studioUiArtifact && (
            <div className="rounded-md border border-border bg-secondary/30 p-2.5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium">Custom vault UI (AI-generated preview)</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 px-2.5 text-xs"
                  onClick={() => void downloadVaultUiPackage(studioUiArtifact, result.contractName)}
                >
                  <Download className="size-3" /> Download package
                </Button>
              </div>
              <VaultCustomUI
                artifact={studioUiArtifact}
                tokenName={result.contractName}
                className="h-[420px] w-full rounded-md border border-border bg-background"
              />
            </div>
          )}

          <LaunchOnFlapPanel
            launchReady={launchReady}
            deployReady={deployable}
            deployBlockReason={deployBlockReason}
            running={running}
            contractName={result.contractName}
            vaultDescription={result.explanation}
            creationBytecode={result.creationBytecode}
            deployedBytecodeSize={result.deployedBytecodeSize ?? null}
            uiArtifactJson={studioUiArtifact ? JSON.stringify(studioUiArtifact) : null}
          />
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

  const nonContractResult =
    result && result.deliverable && result.deliverable !== "contract" && result.deliverable !== "consent_required"
      ? result
      : null;

  const promptPanel = (
    <div className={heroLayout ? "space-y-3 text-left" : "space-y-4"}>
      {!walletConnected && (
        <p className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <Wallet className="size-3.5 shrink-0" /> {dict.hero.walletNotice}
        </p>
      )}
      {walletConnected && !VAULT_GENERATION_ENABLED && (
        <p className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">
          <Sparkles className="size-3.5 shrink-0" /> {dict.hero.comingSoonNotice}
        </p>
      )}
      <Textarea
        rows={heroLayout ? 3 : 5}
        placeholder={
          !walletConnected
            ? dict.hero.placeholderDisconnected
            : VAULT_GENERATION_ENABLED
              ? dict.hero.placeholderConnected
              : dict.hero.comingSoonPlaceholder
        }
        value={prompt}
        disabled={!walletConnected || !VAULT_GENERATION_ENABLED}
        onChange={(e) => setPrompt(e.target.value)}
        className={heroLayout ? "fgv-hero-textarea min-h-[96px] text-sm" : "min-h-[140px] resize-none text-sm"}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void onGenerate();
          }
        }}
      />
      <div className="flex flex-wrap justify-center gap-2">
        {dict.hero.examples.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={!walletConnected || !VAULT_GENERATION_ENABLED}
            onClick={() => setPrompt(ex)}
            className="rounded-full border border-border/70 bg-card/60 px-3 py-1.5 text-left text-[0.68rem] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border/70 disabled:hover:bg-card/60"
          >
            {ex.length > 48 ? `${ex.slice(0, 48)}…` : ex}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-3">
        <Button
          variant="default"
          size={heroLayout ? "lg" : "default"}
          onClick={onGenerate}
          disabled={
            running ||
            !walletConnected ||
            !VAULT_GENERATION_ENABLED ||
            prompt.trim().length < 8
          }
          className={heroLayout ? "gap-2" : undefined}
        >
          {running ? <Loader2 className="animate-spin" /> : <Sparkles className={heroLayout ? "size-4" : "hidden"} />}
          {running
            ? dict.hero.generating
            : walletConnected && !VAULT_GENERATION_ENABLED
              ? dict.hero.comingSoon
              : dict.hero.generate}
        </Button>
        <span className="text-xs text-muted-foreground">⌘↵</span>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );

  const resultsBlock = (
    <div className={heroLayout ? "container max-w-[1200px] space-y-4 px-4 py-8 sm:px-6 lg:px-8" : "space-y-4"}>
      {consentRequest && !running && (
        <ConsentCard
          request={consentRequest}
          running={running}
          onChoose={onConsent}
          onStop={() => setConsentRequest(null)}
        />
      )}

      {nonContractResult && !running && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {nonContractResult.deliverable === "spec_only" ? dict.studio.draftSpecTitle : dict.studio.notGeneratedTitle}
            </CardTitle>
            <CardDescription className="text-xs">{nonContractResult.explanation}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {mechanicSpec && <MechanicPlanBanner spec={mechanicSpec} />}
            {scope && <ScopeBanner scope={scope} />}
            {nonContractResult.approximation && <ApproximationBanner report={nonContractResult.approximation} />}
          </CardContent>
        </Card>
      )}

      {(running || liveCode) && !result && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-mono">{liveName ? `${liveName}.sol` : "Output"}</CardTitle>
            {running && pipelineProgress && <div className="pt-1">{pipelineProgress}</div>}
          </CardHeader>
          <CardContent className="space-y-3">
            {mechanicSpec && <MechanicPlanBanner spec={mechanicSpec} />}
            {scope && scope.verdict !== "launch_ready_possible" && <ScopeBanner scope={scope} />}
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

  if (heroLayout) {
    // Only takes up space once there's something to show — otherwise the
    // hero section alone fills the viewport and the landing page never scrolls.
    const hasResultsContent = Boolean(consentRequest || nonContractResult || running || liveCode);
    return (
      <>
        {/*
          min-h-screen (not a fixed h-screen + overflow-hidden): on short or
          zoomed viewports the content below can be taller than the viewport.
          A fixed height with overflow-hidden used to clip the bottom of the
          panel (the Generate button could end up cut off below the fold) —
          growing the section instead means everything stays reachable, and
          on normal-height screens it still reads as a single, non-scrolling
          hero because the content fits within one viewport.
        */}
        <section className="relative mb-0 h-screen w-full overflow-hidden">
          <HeroBackdrop />
          <div className="relative z-10 mx-auto flex h-full w-full max-w-[1200px] items-center justify-center px-4 pt-14 sm:px-6 lg:px-8">
            <div className="w-full max-w-[680px] py-3 text-center">
              <h1 className="mb-3 flex flex-col gap-0.5 font-display font-bold leading-[0.98] tracking-[-0.02em] text-foreground">
                <span className="fgv-kinetic-line block overflow-hidden text-[clamp(1.6rem,3.4vw+2.2vh,4rem)] lg:text-[clamp(1.9rem,2.6vw+2.2vh,4.6rem)]">
                  {dict.hero.headlineLine1}
                </span>
                <span className="fgv-kinetic-line block overflow-hidden text-[clamp(1.6rem,3.4vw+2.2vh,4rem)] lg:text-[clamp(1.9rem,2.6vw+2.2vh,4.6rem)]">
                  {dict.hero.headlineLine2}
                </span>
                <span className="block h-0.5" aria-hidden />
                <span className="fgv-kinetic-line block overflow-hidden text-[clamp(1.3rem,2.7vw+1.8vh,3.4rem)]">
                  <span className="mr-[0.25em] font-medium text-muted-foreground">{dict.hero.withWord}</span>
                  <span className="fgv-accent-gradient italic">{dict.hero.accentWord}</span>
                </span>
              </h1>
              <p className="mx-auto mb-3 max-w-[480px] text-[13px] leading-relaxed text-muted-foreground sm:text-sm lg:text-[15px] lg:leading-7">
                {dict.hero.subtitle}
              </p>
              {promptPanel}
              <p className="mt-2 text-[11px] tracking-wide text-muted-foreground/70">{dict.hero.trustLine}</p>
            </div>
          </div>
        </section>
        {hasResultsContent && resultsBlock}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-4">{promptPanel}</CardContent>
      </Card>
      {resultsBlock}
    </div>
  );
}
