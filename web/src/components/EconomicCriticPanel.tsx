import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { EconomicCriticReport } from "../lib/codegen";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

const SEVERITY = {
  blocking: { label: "blocking", badge: "destructive" as const, cls: "text-destructive" },
  high: { label: "high", badge: "warning" as const, cls: "text-warning" },
  medium: { label: "medium", badge: "warning" as const, cls: "text-warning" },
  low: { label: "low", badge: "outline" as const, cls: "text-muted-foreground" },
};

type Props = {
  report: EconomicCriticReport;
};

export default function EconomicCriticPanel({ report }: Props) {
  const blockingCount = report.findings.filter((f) => f.severity === "blocking").length;
  const highCount = report.findings.filter((f) => f.severity === "high").length;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Economic critic</span>
        <Badge variant="outline" className="text-[0.6rem]">
          advisory
        </Badge>
        {report.reviewed && report.findings.length === 0 && (
          <Badge variant="success" className="gap-1 text-[0.6rem]">
            <CircleCheck className="size-3" />
            no issues flagged
          </Badge>
        )}
        {!report.reviewed && (
          <Badge variant="outline" className="text-[0.6rem] text-muted-foreground">
            not reviewed
          </Badge>
        )}
        {blockingCount > 0 && (
          <span className="text-xs text-destructive">
            {blockingCount} blocking-severity finding(s)
          </span>
        )}
        {highCount > 0 && (
          <span className="text-xs text-warning">{highCount} high-severity finding(s)</span>
        )}
      </div>

      <p className="inline-flex items-start gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span>
          Advisory only — does <strong className="text-foreground">not</strong> block compile, safety scanners, or
          deploy. Deterministic scanners remain the hard gate. Read blocking/high findings before mainnet.
        </span>
      </p>

      {report.summary && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {report.summary}
          {report.reviewed && report.model ? (
            <span className="ml-1 text-muted-foreground/70">({report.model})</span>
          ) : null}
        </p>
      )}

      {report.findings.length > 0 && (
        <div className="max-h-56 space-y-2 overflow-y-auto">
          {report.findings.map((item, idx) => {
            const sev = SEVERITY[item.severity] ?? SEVERITY.medium;
            return (
              <div key={`${item.finding}-${idx}`} className="rounded-lg border border-border bg-background/40 p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <TriangleAlert className={cn("size-3.5 shrink-0", sev.cls)} />
                  <span className="font-mono text-xs text-muted-foreground">{item.finding}</span>
                  <Badge variant={sev.badge} className="px-1.5 py-0 text-[0.6rem]">
                    {sev.label}
                  </Badge>
                  {item.ruleIds.length > 0 && (
                    <span className="text-[0.65rem] text-muted-foreground">
                      Rules {item.ruleIds.join(", ")}
                    </span>
                  )}
                </div>
                {item.explanation && (
                  <p className="text-xs leading-relaxed text-muted-foreground">{item.explanation}</p>
                )}
                {item.suggestedRepair && (
                  <p className="mt-1.5 text-xs leading-relaxed text-foreground/80">
                    <span className="font-medium text-foreground/90">Suggested fix:</span> {item.suggestedRepair}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
