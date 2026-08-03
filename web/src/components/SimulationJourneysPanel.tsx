import { CircleCheck, CircleX, MinusCircle } from "lucide-react";
import type { SimulationReport } from "../lib/codegen";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

const STATUS = {
  pass: { label: "passed", badge: "success" as const, icon: CircleCheck, cls: "text-success" },
  fail: { label: "failed", badge: "destructive" as const, icon: CircleX, cls: "text-destructive" },
  skipped: { label: "skipped", badge: "outline" as const, icon: MinusCircle, cls: "text-muted-foreground" },
};

type Props = {
  report: SimulationReport;
};

/**
 * Renders the actual fork-simulation user journeys (buy → tax → payout, etc.)
 * that ran against this vault before launch — not raw forge/solc output, the
 * same scenario × actor × expectation structure the pipeline already builds
 * from the MechanicSpec (see server/test-gen.ts SimulationReport).
 */
export default function SimulationJourneysPanel({ report }: Props) {
  const passCount = report.scenarios.filter((s) => s.status === "pass").length;
  const failCount = report.scenarios.filter((s) => s.status === "fail").length;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Fork simulation — user journeys</span>
        <Badge variant={report.passed ? "success" : "destructive"} className="text-[0.6rem]">
          {report.passed ? "all passed" : "issues found"}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {passCount}/{report.scenarios.length} passed
          {failCount > 0 ? ` · ${failCount} failed` : ""}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Each row below is a real journey run against a forked BNB chain — a wallet actually calling the
        contract's methods the way a holder, manager, or keeper would — not just a compile check.
      </p>

      {report.scenarios.length > 0 && (
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {report.scenarios.map((s, idx) => {
            const st = STATUS[s.status] ?? STATUS.skipped;
            const Icon = st.icon;
            return (
              <div key={`${s.scenario}-${idx}`} className="rounded-lg border border-border bg-background/40 p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Icon className={cn("size-3.5 shrink-0", st.cls)} />
                  <span className="text-xs font-medium text-foreground/90">{s.scenario}</span>
                  <Badge variant={st.badge} className="px-1.5 py-0 text-[0.6rem]">
                    {st.label}
                  </Badge>
                  {s.blocksLaunch && s.status === "fail" && (
                    <span className="text-[0.65rem] text-destructive">blocks launch</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">{s.actor}</span> — expected: {s.expected}
                </p>
                {s.status === "fail" && s.failureSummary && (
                  <p className="mt-1 text-xs leading-relaxed text-destructive/90">{s.failureSummary}</p>
                )}
                {s.notes && <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">{s.notes}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
