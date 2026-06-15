import { cn } from "../lib/utils";
import type { SpecAuditResult, SpecCheckItem } from "../lib/codegen";
import { CircleCheck, CircleX, Minus, TriangleAlert } from "lucide-react";
import { Badge } from "./ui/badge";

const STATUS = {
  pass: { label: "PASS", Icon: CircleCheck, cls: "text-success", badge: "success" as const },
  warn: { label: "WARN", Icon: TriangleAlert, cls: "text-warning", badge: "warning" as const },
  fail: { label: "FAIL", Icon: CircleX, cls: "text-destructive", badge: "destructive" as const },
  na: { label: "N/A", Icon: Minus, cls: "text-muted-foreground", badge: "outline" as const },
};

const LEVEL_BADGE = {
  pass: "success" as const,
  warn: "warning" as const,
  fail: "destructive" as const,
  skipped: "outline" as const,
};

function RuleRow({ item }: { item: SpecCheckItem }) {
  const s = STATUS[item.status];
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <s.Icon className={cn("size-3.5 shrink-0", s.cls)} />
        <span className="font-mono text-xs text-muted-foreground">{item.id}</span>
        <Badge variant={s.badge} className="px-1.5 py-0 text-[0.6rem]">
          {s.label}
        </Badge>
        <span className="text-sm font-medium">{item.title}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
    </div>
  );
}

export default function SpecAuditPanel({ audit }: { audit: SpecAuditResult }) {
  if (audit.level === "skipped") {
    return (
      <div className="rounded-lg border border-border bg-secondary/20 p-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Flap pre-audit verification</p>
        <p className="mt-1 text-xs">{audit.summary}</p>
      </div>
    );
  }

  const failCount = audit.items.filter((i) => i.status === "fail").length;
  const warnCount = audit.items.filter((i) => i.status === "warn").length;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Flap pre-audit verification</span>
        <Badge variant={LEVEL_BADGE[audit.level]}>spec: {audit.level}</Badge>
        {failCount > 0 && (
          <span className="text-xs text-destructive">{failCount} failure(s)</span>
        )}
        {warnCount > 0 && (
          <span className="text-xs text-warning">{warnCount} warning(s)</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{audit.summary}</p>
      <div className="space-y-2">
        {audit.items.map((item) => (
          <RuleRow key={item.id} item={item} />
        ))}
      </div>
      {audit.level === "fail" && (
        <p className="text-xs text-destructive">
          Fix all FAIL items before integration tests and third-party audit (see FlapVaultExample pre-audit flow).
        </p>
      )}
    </div>
  );
}
