import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Send } from "lucide-react";
import type { FixLogEntry } from "../lib/codegen";
import { describePipelineHeadline, type CodeResetInfo, type PipelinePhase } from "../lib/pipeline-status";
import PipelineProgress from "./PipelineProgress";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { cn } from "../lib/utils";

export type ChatUiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
};

type Props = {
  messages: ChatUiMessage[];
  running: boolean;
  phase: PipelinePhase;
  attempt: number;
  maxAttempts: number;
  statusMsg: string | null;
  resetInfo: CodeResetInfo | null;
  fixLog: FixLogEntry[];
  contractName: string | null;
  onSend: (text: string) => void;
  onNewVault: () => void;
};

export default function CodegenChatPanel({
  messages,
  running,
  phase,
  attempt,
  maxAttempts,
  statusMsg,
  resetInfo,
  fixLog,
  contractName,
  onSend,
  onNewVault,
}: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, running, statusMsg, fixLog.length]);

  const submit = () => {
    const text = input.trim();
    if (text.length < 2 || running) return;
    setInput("");
    onSend(text);
  };

  const pendingHeadline = running
    ? describePipelineHeadline(phase, attempt, maxAttempts, statusMsg)
    : "Updating vault…";

  return (
    <div className="flex h-full min-h-[520px] flex-col rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Refine</p>
          {contractName && (
            <p className="truncate font-mono text-xs text-muted-foreground">{contractName}.sol</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onNewVault} className="shrink-0 gap-1.5 text-xs">
          <Plus className="size-3.5" />
          New vault
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              "max-w-[95%] rounded-lg px-3 py-2 text-sm leading-relaxed",
              m.role === "user"
                ? "ml-auto bg-secondary text-foreground"
                : "mr-auto border border-border bg-background text-foreground/90"
            )}
          >
            {m.pending ? (
              <div className="space-y-2">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {pendingHeadline}
                </span>
                {running && (
                  <PipelineProgress
                    compact
                    phase={phase}
                    attempt={attempt}
                    maxAttempts={maxAttempts}
                    statusMsg={statusMsg}
                    resetInfo={resetInfo}
                    fixLog={fixLog}
                  />
                )}
              </div>
            ) : (
              m.content
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-3">
        <div className="flex gap-2">
          <Textarea
            rows={2}
            placeholder="e.g. add unstake cooldown, cap entrants at 255…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={running}
            className="min-h-[56px] resize-none text-sm"
          />
          <Button
            variant="default"
            size="icon"
            onClick={submit}
            disabled={running || input.trim().length < 2}
            className="shrink-0 self-end"
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
