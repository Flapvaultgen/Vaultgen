import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
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
        .catch(() => setAiMode(base ? "offline" : "no API URL"))
    );
  }, []);

  if (view === "docs") {
    return <DocsPage onBack={() => setView("studio")} />;
  }

  const online = aiMode === "OpenAI";

  return (
    <div className="min-h-screen">
      <div className={cn("container py-8 sm:py-10", wideLayout ? "max-w-7xl" : "max-w-2xl")}>
        <header className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold tracking-tight text-foreground">Flap Vault Gen</p>
            <p className="text-xs text-muted-foreground">Tax vault codegen for Flap V2</p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "hidden rounded-md px-2 py-1 text-[0.65rem] font-medium sm:inline",
                online ? "bg-success/10 text-success" : "bg-secondary text-muted-foreground"
              )}
            >
              {online ? "API online" : aiMode}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setView("docs")} className="gap-1.5 text-muted-foreground">
              <BookOpen className="size-3.5" />
              Docs
            </Button>
            <MetaMaskConnect />
          </div>
        </header>

        {!wideLayout && (
          <div className="mb-8">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Describe your vault mechanic
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Plain English in → Flap-compliant Solidity out. Foundry compile, static safety scanners, 9-rule
              pre-audit, then refine in chat. Deploy bytecode through{" "}
              <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.8em]">CodegenVaultFactory</code>.
              Testnet first.
            </p>
          </div>
        )}

        <CodegenStudio onChatActive={setWideLayout} />

        {!wideLayout && (
          <footer className="mt-8 text-center text-xs text-muted-foreground">
            <button type="button" onClick={() => setView("docs")} className="underline-offset-2 hover:underline">
              Documentation
            </button>
            <span className="mx-2">·</span>
            <span>Unaudited output — testnet first</span>
          </footer>
        )}
      </div>
    </div>
  );
}
