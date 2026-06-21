import { Loader2, RefreshCw } from "lucide-react";
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

const STAGES: { key: string; label: string; phases: PipelinePhase[] }[] = [
  { key: "write", label: "Write", phases: ["writing", "fixing", "fixing_spec"] },
  { key: "compile", label: "Compile", phases: ["compiling", "compile_failed"] },
  { key: "fix", label: "Fix", phases: ["compile_failed", "fixing", "fixing_spec"] },
  { key: "tests", label: "Tests", phases: ["generating_tests"] },
  { key: "audit", label: "Audit", phases: ["auditing"] },
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
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
          <div className="min-w-0">
            <p className={cn("font-medium text-foreground", compact ? "text-xs" : "text-sm")}>{headline}</p>
            {attempt > 0 && !compact && (
              <p className="mt-0.5 text-[0.65rem] text-muted-foreground">
                Pass {attempt} of {maxAttempts}
              </p>
            )}
          </div>
        </div>
        {attempt > 1 && (
          <span className="shrink-0 rounded-md bg-secondary px-2 py-0.5 text-[0.65rem] text-muted-foreground">
            Retry {attempt - 1}
          </span>
        )}
      </div>

      {resetCopy && (
        <div className="flex gap-2 rounded-md border border-border bg-secondary/50 px-3 py-2 text-xs">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-foreground">{resetCopy.title}</p>
            <p className="mt-0.5 text-muted-foreground">{resetCopy.detail}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1">
        {STAGES.map((stage, i) => {
          const active = i === activeStageIdx;
          const done = activeStageIdx > i || phase === "done";
          return (
            <span
              key={stage.key}
              className={cn(
                "rounded-md px-2 py-0.5 text-[0.65rem]",
                active ? "bg-primary/15 font-medium text-primary" : done ? "text-success" : "text-muted-foreground"
              )}
            >
              {stage.label}
            </span>
          );
        })}
      </div>

      {retryEntries.length > 0 && !compact && (
        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
          <p className="text-[0.65rem] font-medium text-muted-foreground">Why it retried</p>
          <ul className="mt-1.5 space-y-1">
            {retryEntries.map((entry, i) => (
              <li key={`${entry.phase}-${entry.attempt}-${i}`} className="text-[0.68rem] text-foreground/85">
                <span className="text-muted-foreground">
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
