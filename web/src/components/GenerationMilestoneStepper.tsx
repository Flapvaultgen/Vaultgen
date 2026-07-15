import { Check, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import { MILESTONE_ORDER, type MilestoneId } from "../lib/generation-milestones";

export type MilestoneStep = { id: MilestoneId; label: string };

type Props = {
  steps: MilestoneStep[];
  activeId: MilestoneId | null;
  /** When true every step shows as completed (run finished). */
  allComplete?: boolean;
  /** Optional detail line under the active step, e.g. "Fixing compile errors…". */
  detail?: string | null;
  orientation?: "horizontal" | "vertical";
  className?: string;
};

function stepIndex(id: MilestoneId | null): number {
  if (!id) return 0;
  const idx = MILESTONE_ORDER.indexOf(id);
  return idx >= 0 ? idx : 0;
}

function StepNode({
  done,
  active,
  index,
}: {
  done: boolean;
  active: boolean;
  index: number;
}) {
  return (
    <div
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border text-[0.65rem] font-semibold transition-colors",
        done && "border-primary bg-primary text-primary-foreground",
        active && !done && "border-primary bg-primary/15 text-primary ring-2 ring-primary/25",
        !done && !active && "border-border/80 bg-background text-muted-foreground/70"
      )}
    >
      {done ? <Check className="size-3" strokeWidth={2.5} /> : active ? <Loader2 className="size-3 animate-spin" /> : index + 1}
    </div>
  );
}

function Connector({ done, vertical }: { done: boolean; vertical?: boolean }) {
  return (
    <div
      className={cn(
        done ? "bg-primary/50" : "bg-border/70",
        vertical ? "mx-auto w-px min-h-[1.1rem] flex-1" : "h-px flex-1 min-w-[0.35rem]"
      )}
    />
  );
}

export default function GenerationMilestoneStepper({
  steps,
  activeId,
  allComplete = false,
  detail,
  orientation = "vertical",
  className,
}: Props) {
  const activeIdx = allComplete ? steps.length : stepIndex(activeId);

  if (orientation === "horizontal") {
    return (
      <div className={cn("w-full", className)}>
        <div className="flex items-start">
          {steps.map((step, i) => {
            const done = allComplete || i < activeIdx;
            const active = !allComplete && i === activeIdx;
            return (
              <div key={step.id} className="flex min-w-0 flex-1 flex-col items-center">
                <div className="flex w-full items-center px-0.5">
                  {i > 0 && <Connector done={done || active} />}
                  <StepNode done={done} active={active} index={i} />
                  {i < steps.length - 1 && <Connector done={done} />}
                </div>
                <span
                  className={cn(
                    "mt-1.5 max-w-full truncate px-0.5 text-center text-[0.6rem] leading-tight",
                    active ? "font-medium text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/55"
                  )}
                >
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
        {detail && !allComplete && (
          <p className="mt-3 text-center text-[0.65rem] text-muted-foreground">{detail}</p>
        )}
      </div>
    );
  }

  return (
    <div className={cn("w-full", className)}>
      <ol className="space-y-0">
        {steps.map((step, i) => {
          const done = allComplete || i < activeIdx;
          const active = !allComplete && i === activeIdx;
          const isLast = i === steps.length - 1;
          return (
            <li key={step.id} className="flex gap-3">
              <div className="flex w-6 shrink-0 flex-col items-center">
                <StepNode done={done} active={active} index={i} />
                {!isLast && <Connector done={done} vertical />}
              </div>
              <div className={cn("min-w-0", isLast ? "pb-0" : "pb-3")}>
                <p
                  className={cn(
                    "text-xs leading-tight",
                    active ? "font-medium text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/55"
                  )}
                >
                  {step.label}
                </p>
                {active && detail && (
                  <p className="mt-1 text-[0.65rem] leading-snug text-muted-foreground">{detail}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
