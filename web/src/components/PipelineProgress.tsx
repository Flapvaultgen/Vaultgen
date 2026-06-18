import { ClipboardCheck, Hammer, Loader2, PencilLine, RefreshCw, Wrench } from "lucide-react";
import type { FixLogEntry } from "../lib/codegen";
import {
  describeCodeReset,
  describeFixEntry,
  describePipelineHeadline,
  FIX_PHASE_LABEL,
  type CodeResetInfo,
  type PipelinePhase,
} from "../lib/pipeline-status";
import { cn } from "../lib/utils";

const STAGES: { key: string; label: string; Icon: typeof PencilLine; phases: PipelinePhase[] }[] = [
  { key: "write", label: "Write", Icon: PencilLine, phases: ["writing", "fixing", "fixing_spec"] },
  { key: "compile", label: "Compile", Icon: Hammer, phases: ["compiling", "compile_failed"] },
  { key: "fix", label: "Auto-fix", Icon: Wrench, phases: ["compile_failed", "fixing", "fixing_spec"] },
  { key: "tests", label: "Tests", Icon: ClipboardCheck, phases: ["generating_tests"] },
  { key: "audit", label: "Pre-audit", Icon: ClipboardCheck, phases: ["auditing"] },
];

type Props = {
  phase: PipelinePhase;
  attempt: number;
  maxAttempts: number;
  statusMsg: string | null;
  resetInfo: CodeResetInfo | null;
  fixLog: FixLogEntry[];
  compact?: boolean;
};

export default function PipelineProgress({
  phase,
  attempt,
  maxAttempts,
  statusMsg,
  resetInfo,
  fixLog,
  compact = false,
}: Props) {
  const headline = describePipelineHeadline(phase, attempt, maxAttempts, statusMsg);
  const activeStageIdx = STAGES.findIndex((s) => s.phases.includes(phase));
  const resetCopy = resetInfo && resetInfo.reason === "retry" ? describeCodeReset(resetInfo) : null;
  const retryEntries = fixLog.filter((e) =>
    ["compile_fix", "safety_fix", "spec_fix"].includes(e.phase)
  );

  return (
    <div className={cn("space-y-3", compact && "space-y-2")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent" />
          <div className="min-w-0">
            <p className={cn("font-medium text-foreground", compact ? "text-xs" : "text-sm")}>{headline}</p>
            {attempt > 0 && (
              <p className="mt-0.5 text-[0.65rem] text-muted-foreground">
                Pipeline pass {attempt} of {maxAttempts} — compile, safety, and spec checks run after each draft.
              </p>
            )}
          </div>
        </div>
        {attempt > 1 && (
          <span className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[0.65rem] text-accent">
            Retry {attempt - 1}
          </span>
        )}
      </div>

      {resetCopy && (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
          <div>
            <p className="font-medium text-amber-100">{resetCopy.title}</p>
            <p className="mt-0.5 text-amber-100/80">{resetCopy.detail}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {STAGES.map((stage, i) => {
          const active = i === activeStageIdx;
          const done = activeStageIdx > i || phase === "done";
          return (
            <div
              key={stage.key}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.65rem]",
                active ? "border-accent/50 bg-accent/10 text-accent" : done ? "text-success" : "text-muted-foreground"
              )}
            >
              {active && <Loader2 className="size-3 animate-spin" />}
              {stage.label}
            </div>
          );
        })}
      </div>

      {retryEntries.length > 0 && (
        <div className="rounded-lg border border-border bg-secondary/20 px-3 py-2">
          <p className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
            Why it retried
          </p>
          <ul className="mt-1.5 space-y-1">
            {retryEntries.map((entry, i) => (
              <li key={`${entry.phase}-${entry.attempt}-${i}`} className="text-[0.68rem] text-foreground/85">
                <span className="font-medium text-muted-foreground">
                  Pass {entry.attempt} · {FIX_PHASE_LABEL[entry.phase]}:
                </span>{" "}
                {describeFixEntry(entry)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
