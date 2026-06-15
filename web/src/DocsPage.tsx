import { useMemo } from "react";
import { ArrowLeft, BookOpen } from "lucide-react";
import doc from "../../docs/CODEGEN_STUDIO.md?raw";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

type Block =
  | { type: "h1" | "h2" | "h3"; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "hr" };

function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const pushParagraph = (buf: string[]) => {
    const text = buf.join(" ").trim();
    if (text) blocks.push({ type: "p", text });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "---") {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i++;
      const buf: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", lang, text: buf.join("\n") });
      i++;
      continue;
    }

    if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.slice(2).trim() });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3).trim() });
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4).trim() });
      i++;
      continue;
    }

    if (line.startsWith("|") && line.includes("|")) {
      const headers = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      i++;
      if (i < lines.length && /^\|[-:\s|]+\|$/.test(lines[i])) i++;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(
          lines[i]
            .split("|")
            .map((c) => c.trim())
            .filter(Boolean)
        );
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2).trim());
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !lines[i].startsWith("- ") && !lines[i].startsWith("|") && !lines[i].startsWith("```")) {
      buf.push(lines[i].trim());
      i++;
    }
    pushParagraph(buf);
  }

  return blocks;
}

function inline(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={idx} className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    return <span key={idx}>{part}</span>;
  });
}

type Props = { onBack: () => void };

export default function DocsPage({ onBack }: Props) {
  const blocks = useMemo(() => parseMarkdown(doc), []);

  return (
    <div className="min-h-screen">
      <div className="container max-w-3xl py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
            <ArrowLeft className="size-4" />
            Back to studio
          </Button>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <BookOpen className="size-3.5" />
            User guide
          </div>
        </div>

        <article className="space-y-6 text-sm leading-relaxed text-foreground/90">
          {blocks.map((block, idx) => {
            switch (block.type) {
              case "h1":
                return (
                  <h1 key={idx} className="text-3xl font-bold tracking-tight text-foreground">
                    {inline(block.text)}
                  </h1>
                );
              case "h2":
                return (
                  <h2 key={idx} className="border-b border-border pb-2 pt-4 text-xl font-semibold">
                    {inline(block.text)}
                  </h2>
                );
              case "h3":
                return (
                  <h3 key={idx} className="pt-2 text-base font-semibold">
                    {inline(block.text)}
                  </h3>
                );
              case "p":
                return (
                  <p key={idx} className="text-muted-foreground">
                    {inline(block.text)}
                  </p>
                );
              case "ul":
                return (
                  <ul key={idx} className="list-disc space-y-1.5 pl-5 text-muted-foreground">
                    {block.items.map((item, j) => (
                      <li key={j}>{inline(item)}</li>
                    ))}
                  </ul>
                );
              case "table":
                return (
                  <div key={idx} className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-card/80">
                        <tr>
                          {block.headers.map((h, j) => (
                            <th key={j} className="px-3 py-2 font-medium">
                              {inline(h)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {block.rows.map((row, ri) => (
                          <tr key={ri} className={cn("border-t border-border", ri % 2 === 1 && "bg-card/30")}>
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-3 py-2 text-muted-foreground">
                                {inline(cell)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              case "code":
                return (
                  <pre
                    key={idx}
                    className="overflow-x-auto rounded-lg border border-border bg-card/60 p-4 font-mono text-xs leading-relaxed text-foreground/80"
                  >
                    {block.text}
                  </pre>
                );
              case "hr":
                return <hr key={idx} className="border-border" />;
              default:
                return null;
            }
          })}
        </article>
      </div>
    </div>
  );
}
