import { useEffect, useState } from "react";
import { BookOpen, Code2 } from "lucide-react";
import CodegenStudio from "./CodegenStudio";
import DocsPage from "./DocsPage";
import MetaMaskConnect from "./components/MetaMaskConnect";
import { Button } from "./components/ui/button";
import { apiUrl, initApiBase } from "./lib/api-base";
import { cn } from "./lib/utils";

export default function App() {
  const [aiMode, setAiMode] = useState("…");
  const [view, setView] = useState<"studio" | "docs">("studio");
  const [wideLayout, setWideLayout] = useState(false);

  useEffect(() => {
    void initApiBase().then((base) =>
      fetch(apiUrl("/api/health"))
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((h) => setAiMode(h.aiMode === "openai" ? "OpenAI" : "no API key"))
        .catch(() => setAiMode(base ? "offline (API unreachable)" : "no API URL"))
    );
  }, []);

  if (view === "docs") {
    return <DocsPage onBack={() => setView("studio")} />;
  }

  return (
    <div className="min-h-screen">
      <div className={cn("container py-12", wideLayout ? "max-w-7xl" : "max-w-5xl")}>
        <div className="mb-6 flex items-center justify-between gap-4">
          <Button variant="ghost" size="sm" onClick={() => setView("docs")} className="gap-2 text-muted-foreground">
            <BookOpen className="size-4" />
            Docs
          </Button>
          <MetaMaskConnect />
        </div>

        <header className="mb-10 text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-1.5 text-xs font-medium text-muted-foreground">
            <Code2 className="size-3.5 text-accent" />
            Flap Vault Gen
            <span
              className={cn(
                "ml-1 rounded-full px-2 py-0.5 text-[0.6rem]",
                aiMode === "OpenAI" ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground"
              )}
            >
              {aiMode}
            </span>
          </div>
          <h1 className="bg-gradient-to-br from-white to-white/60 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
            Describe any mechanic. AI writes the vault.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-balance text-muted-foreground">
            Not a fixed menu — describe whatever you want (staking, dividends, snapshots, lotteries) and the AI writes
            real Solidity, compiles it with solc 0.8.26, auto-fixes errors, and runs Flap&apos;s 9-rule pre-audit.
          </p>
        </header>

        <CodegenStudio onChatActive={setWideLayout} />

        <footer className="mt-12 space-y-2 border-t border-border pt-6 text-center text-xs text-muted-foreground">
          <p>
            <button type="button" onClick={() => setView("docs")} className="underline underline-offset-2 hover:text-foreground">
              Read the docs
            </button>{" "}
            for the AI pipeline, API, prompts, and why this beats raw ChatGPT.
          </p>
          <p>
            Generated code is UNAUDITED. Deploy via CodegenVaultFactory (CREATE2) — testnet first. Mainnet is gated until
            audited.
          </p>
        </footer>
      </div>
    </div>
  );
}
