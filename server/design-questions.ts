/**
 * Design questions — Phase 8 (non-coder mechanic design).
 *
 * The app is for NON-CODERS. When a prompt leaves a safety-relevant mechanic
 * decision open (single vs multi assignee, reward amount, proof submission,
 * abandon/cancel paths, eligibility), the system must not silently pick a
 * risky default and generate launch-ready Solidity. Instead it either:
 *
 *   1. asks plain-English design questions (deliverable "design_questions"),
 *   2. proceeds with CONSERVATIVE, clearly-explained defaults after the user
 *      explicitly chooses "closest_draft", or
 *   3. keeps a spec-only draft when the user chooses "spec_only".
 *
 * Everything here is deterministic — no LLM, no model routing.
 */

import type { AssignmentModel, LifecycleSpec, MechanicSpec } from "./mechanic-spec.js";

export type DesignQuestion = {
  id: string;
  /** Plain-English question a non-coder can answer. */
  question: string;
  /** Plain-English consequence of leaving this undecided. */
  whyItMatters: string;
  /** Suggested answers, in plain English. */
  options: string[];
  /** true → leaving this unresolved must prevent launch-ready output. */
  critical: boolean;
};

/** How the pipeline should proceed given the open questions and the user's explicit choice. */
export type DesignGateDecision =
  | { action: "proceed"; questions: DesignQuestion[] }
  | { action: "ask"; questions: DesignQuestion[] }
  | { action: "proceed_conservative"; questions: DesignQuestion[] }
  | { action: "spec_only"; questions: DesignQuestion[] };

function promptDecidesEligibility(prompt: string): boolean {
  return /\bholders?\b|\bany(one| wallet)\b|\bwhitelist|\bapproved (users|wallets|members)|\beveryone\b|\ballowlist/i.test(prompt);
}

function payoutAmountDecided(spec: MechanicSpec): boolean {
  return spec.payoutRules.some(
    (r) =>
      r.claimAmountSource.trim().length > 0 ||
      r.distributionMode === "fixed_per_user" ||
      r.distributionMode === "manager_assigned_amount" ||
      r.distributionMode === "pro_rata_snapshot"
  );
}

/**
 * Deterministic plain-English design questions derived from the MechanicSpec's
 * lifecycle gaps. Empty when the mechanic has no discrete assignable resource
 * or when every safety-relevant decision is already recorded.
 */
export function generateDesignQuestions(prompt: string, spec: MechanicSpec): DesignQuestion[] {
  const lc = spec.lifecycle;
  if (!lc || !lc.resourceType || lc.assignmentModel === "not_applicable") return [];
  const r = lc.resourceType;
  const questions: DesignQuestion[] = [];

  if (lc.assignmentModel === "unspecified") {
    questions.push({
      id: "assignment-model",
      question: `Can one user or many users accept the same ${r}?`,
      whyItMatters: `If many users can accept the same ${r} but finishing it for one user switches it off for everyone, the other users get stuck — they cannot claim, finish, or move on.`,
      options: [
        `Only one user at a time — a second accept is rejected`,
        `Many users, each with their own progress and their own reward`,
        `No accepting at all — anyone eligible just acts directly`,
      ],
      critical: true,
    });
  }

  if (!payoutAmountDecided(spec)) {
    questions.push({
      id: "reward-amount",
      question: `Should each ${r} have its own reward amount, and who sets it?`,
      whyItMatters: `Without a decision, the code could bake in an arbitrary fixed number you never chose, or promise rewards the vault cannot actually pay.`,
      options: [
        `The manager sets a reward amount when posting each ${r}`,
        `Every ${r} pays the same fixed amount (tell us the amount)`,
        `Rewards are shared from a pool according to a rule (describe the rule)`,
      ],
      critical: true,
    });
  }

  if (!promptDecidesEligibility(prompt)) {
    questions.push({
      id: "eligibility",
      question: `Who is allowed to accept a ${r}: any wallet, token holders, or an approved list?`,
      whyItMatters: `If eligibility is not enforced in the code, anyone — including bots — can take ${r} rewards meant for your community.`,
      options: [`Any wallet`, `Token holders only`, `Only users the manager approves`],
      critical: true,
    });
  }

  if (lc.requiresSubmission === "unspecified") {
    questions.push({
      id: "proof-submission",
      question: `Does the user need to submit proof of the work, and what kind: text, a link, a file hash, or off-chain review only?`,
      whyItMatters: `Without on-chain proof, approval is pure manager trust — the vault cannot show what was approved or why.`,
      options: [
        `Yes — the user submits a proof (link or file hash) on-chain before approval`,
        `No — the manager checks the work off-chain and just approves (disclosed trust)`,
      ],
      critical: true,
    });
  }

  if (!lc.abandonPath) {
    questions.push({
      id: "abandon-path",
      question: `Can a user abandon a ${r} they accepted?`,
      whyItMatters: `Without an exit, a user who accepted a dead ${r} is stuck forever — they cannot claim and may not be able to accept another one.`,
      options: [`Yes — they can abandon any time before approval`, `Yes — but only after a deadline passes`, `No (risky — users can get stuck)`],
      critical: true,
    });
  }

  if (!lc.cancelPath) {
    questions.push({
      id: "cancel-path",
      question: `Can the manager cancel a ${r} that is no longer needed?`,
      whyItMatters: `Without cancellation, dead ${r}s pile up and any user attached to one may be trapped.`,
      options: [`Yes — the manager can cancel an open or expired ${r} without trapping assigned users`, `No (risky)`],
      critical: true,
    });
  }

  if (!lc.timeoutOrExpiry) {
    questions.push({
      id: "deadline",
      question: `Is there a deadline or expiry for a ${r}, and what happens if the manager never marks completion?`,
      whyItMatters: `If the manager disappears and there is no deadline or abandon path, users wait forever.`,
      options: [`Each ${r} has a deadline set when posted`, `No deadline — users rely on the abandon path to exit`],
      critical: false,
    });
  }

  if (lc.rewardReservationPoint === "unspecified") {
    questions.push({
      id: "reward-reservation",
      question: `When is the reward BNB set aside: when the ${r} is posted, when it is accepted, or when it is approved?`,
      whyItMatters: `Reserving at approval into the user's personal claimable balance is the safest default; reserving too late can promise money the vault no longer has.`,
      options: [`When posted`, `When accepted`, `When approved (recommended safe default)`],
      critical: false,
    });
  }

  if (lc.assignmentModel === "unspecified" || lc.assignmentModel === "multi_assignee") {
    questions.push({
      id: "multi-tasking",
      question: `Can the same user work on multiple ${r}s at once, and can one ${r} pay multiple users?`,
      whyItMatters: `This decides how progress and rewards are tracked per user, and whether finishing one user's work may affect another's.`,
      options: [`One ${r} per user at a time`, `Users can work several ${r}s in parallel`, `One ${r} can pay several users, tracked per user`],
      critical: false,
    });
  }

  return questions;
}

export function criticalDesignQuestions(questions: DesignQuestion[]): DesignQuestion[] {
  return questions.filter((q) => q.critical);
}

/**
 * Central design gate. Mirrors consentGate(): unresolved CRITICAL decisions
 * halt the pipeline until the user explicitly picks a path — silent risky
 * defaults are impossible.
 */
export function designQuestionGate(
  prompt: string,
  spec: MechanicSpec,
  consent?: "closest_draft" | "spec_only"
): DesignGateDecision {
  const questions = generateDesignQuestions(prompt, spec);
  if (criticalDesignQuestions(questions).length === 0) return { action: "proceed", questions };
  if (consent === "closest_draft") return { action: "proceed_conservative", questions };
  if (consent === "spec_only") return { action: "spec_only", questions };
  return { action: "ask", questions };
}

/**
 * Conservative, SAFE defaults for every unresolved lifecycle decision — used
 * only after the user explicitly chose to proceed. Returns the updated spec
 * plus a plain-English record of every decision made on the user's behalf.
 * Every default keeps users un-stuck; none of them weakens a launch gate —
 * the lifecycle scanners still verify the generated code independently.
 */
export function applyConservativeLifecycleDefaults(
  prompt: string,
  spec: MechanicSpec
): { spec: MechanicSpec; decisions: string[] } {
  const lc = spec.lifecycle;
  if (!lc || !lc.resourceType || lc.assignmentModel === "not_applicable") return { spec, decisions: [] };
  const r = lc.resourceType;
  const decisions: string[] = [];
  const next: LifecycleSpec = { ...lc, stuckStateRisks: [...lc.stuckStateRisks] };

  if (next.assignmentModel === "unspecified") {
    next.assignmentModel = "single_assignee" satisfies AssignmentModel;
    next.maxAssignees = 1;
    decisions.push(
      `Single assignee: only one user can accept each ${r} at a time — a second accept is rejected. (Safest default; say "many users can work the same ${r}" to change it.)`
    );
  }
  if (next.requiresSubmission === "unspecified") {
    next.requiresSubmission = "yes";
    decisions.push(`Proof required: the user submits a proof (e.g. a link or file hash) on-chain before the manager can approve.`);
  }
  if (next.completionAuthority === "unspecified") {
    next.completionAuthority = "manager";
    decisions.push(`The manager reviews and approves completed work (disclosed trust assumption).`);
  }
  if (!next.abandonPath) {
    next.abandonPath = `assignee can abandon the ${r} any time before approval, clearing their assignment`;
    next.userExitPaths = [...next.userExitPaths, next.abandonPath];
    decisions.push(`Abandon path: a user can abandon an accepted ${r} before approval, so nobody can get stuck.`);
  }
  if (!next.cancelPath) {
    next.cancelPath = `manager can cancel an open or expired ${r}; cancellation must not trap any assigned user`;
    next.managerExitPaths = [...next.managerExitPaths, next.cancelPath];
    decisions.push(`Cancel path: the manager can cancel an open or expired ${r} without trapping assigned users.`);
  }
  if (next.rewardReservationPoint === "unspecified" || next.rewardReservationPoint === "not_applicable") {
    next.rewardReservationPoint = "on_approval";
    decisions.push(`Reward timing: the reward is reserved into the user's personal claimable balance at approval time; the user then claims it themselves.`);
  }
  if (!next.timeoutOrExpiry) {
    decisions.push(`No deadline chosen: users rely on the abandon path to exit if the manager never acts.`);
  }
  next.stuckStateRisks = next.stuckStateRisks.filter(
    (risk) => !/undecided|not? .*decided|no abandon path decided|no cancel path decided/i.test(risk)
  );

  const nextSpec: MechanicSpec = { ...spec, lifecycle: next };

  if (!payoutAmountDecided(nextSpec)) {
    decisions.push(
      `Reward amount: the manager sets each ${r}'s reward when posting it; the amount is reserved per user at approval — no hardcoded reward constants.`
    );
    if (nextSpec.payoutRules.length > 0) {
      nextSpec.payoutRules = nextSpec.payoutRules.map((rule) =>
        rule.claimAmountSource.trim()
          ? rule
          : {
              ...rule,
              distributionMode: "manager_assigned_amount",
              liabilityModel: "reserved_on_approval",
              claimAmountSource: `the per-${r} reward amount set by the manager when posting, reserved into claimable[user] at approval`,
              winnerTakesAll: false,
              perUserAccountingRequired: true,
            }
      );
    }
  }

  if (promptDecidesEligibility(prompt) && /\bholders?\b/i.test(prompt)) {
    decisions.push(`Eligibility: only token holders can accept a ${r} (the code must check the holder's balance).`);
  } else if (!promptDecidesEligibility(prompt)) {
    decisions.push(`Eligibility: only token holders can accept a ${r} (safe default for a community vault; say "any wallet" to open it up).`);
  }

  next.stateVisibilityRequirements = Array.from(
    new Set([
      ...next.stateVisibilityRequirements,
      `a count view and a per-id getter for each ${r}`,
      `a per-user view of the user's current assignment/status`,
      `a per-user view of the claimable amount`,
      `a view of the reward funding bucket`,
    ])
  );

  return { spec: nextSpec, decisions };
}
