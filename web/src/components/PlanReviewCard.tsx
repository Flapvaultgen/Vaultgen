import { ClipboardList, Loader2 } from "lucide-react";
import type { MechanicSpec, VaultScope } from "../lib/codegen";
import { Button } from "./ui/button";

type Props = {
  scope: VaultScope;
  spec: MechanicSpec;
  approving: boolean;
  onApprove: () => void;
};

/** Short, plain-English one-liner for a single planned action. */
function actionLine(a: MechanicSpec["userActions"][number]): string {
  return `${a.caller} can ${a.name}${a.description ? ` — ${a.description}` : ""}`;
}

function payoutLine(p: MechanicSpec["payoutRules"][number]): string {
  return `${p.recipients} get paid from "${p.source}" on ${p.trigger}`;
}

/**
 * Phase 9 plan-approval pause: shows the MechanicSpec the pipeline computed
 * — before any Solidity exists — so the user can catch a wrong assumption
 * without spending tokens on code they didn't want. "Approve" resumes
 * straight into codegen for this exact spec; typing a change request in the
 * normal chat box instead replans and shows an updated plan here again.
 */
export default function PlanReviewCard({ scope, spec, approving, onApprove }: Props) {
  const actions = [...spec.userActions, ...spec.managerActions].slice(0, 6);
  const payouts = spec.payoutRules.slice(0, 4);

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ClipboardList className="size-4 shrink-0 text-primary" />
        <span className="text-sm font-medium">Plan ready for your review</span>
        <span className="text-[0.65rem] text-muted-foreground">no code written yet</span>
      </div>

      {spec.productSummary && (
        <p className="text-xs leading-relaxed text-foreground/90">{spec.productSummary}</p>
      )}

      {actions.length > 0 && (
        <div>
          <p className="mb-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
            What people can do
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {actions.map((a, i) => (
              <li key={`${a.name}-${i}`} className="flex gap-1.5">
                <span className="text-primary">•</span>
                <span>{actionLine(a)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {payouts.length > 0 && (
        <div>
          <p className="mb-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
            How money moves
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {payouts.map((p, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="text-primary">•</span>
                <span>{payoutLine(p)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {spec.fairnessModel && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Fairness:</span> {spec.fairnessModel}
        </p>
      )}
      {spec.emergencyControls && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Emergency controls:</span> {spec.emergencyControls}
        </p>
      )}

      {scope.verdict !== "launch_ready_possible" && scope.summary && (
        <p className="text-xs text-amber-200">{scope.summary}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" disabled={approving} onClick={onApprove} className="gap-1.5">
          {approving && <Loader2 className="size-3.5 animate-spin" />}
          Looks good — write the code
        </Button>
        <span className="text-[0.65rem] text-muted-foreground">
          Or describe a change below and we'll update the plan first.
        </span>
      </div>
    </div>
  );
}
