import { ArrowLeft } from "lucide-react";
import { Button } from "./components/ui/button";
import { useI18n } from "./lib/i18n/context";
import type { Dictionary } from "./lib/i18n/types";

const C = {
  bg: "#0e130c",
  surface: "#161b13",
  surf2: "#25331f",
  border: "#2c3328",
  text: "#f0f0f0",
  muted: "#8a9385",
  accent: "#caff00",
};

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28 space-y-6">
      <header className="space-y-1.5">
        <p className="fgv-section-eyebrow">{eyebrow}</p>
        <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{title}</h2>
      </header>
      <div className="space-y-5 text-[15px] leading-relaxed text-foreground/85">{children}</div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fgv-doc-card">
      <h3 className="mb-2 font-bold tracking-tight text-foreground">{title}</h3>
      <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

function DiagramFrame({ children, caption }: { children: React.ReactNode; caption: string }) {
  return (
    <figure className="fgv-diagram-frame">
      <div className="overflow-x-auto">{children}</div>
      <figcaption className="mt-3 text-center text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

function TocLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="block border-l-2 border-border py-1 pl-3 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
    >
      {label}
    </a>
  );
}

function PipelineDiagram({ steps }: { steps: { title: string; note: string }[] }) {
  const W = 960;
  const H = 200;
  const padX = 40;
  const innerW = W - padX * 2;
  const stepW = innerW / steps.length;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Vault generation steps">
      <line x1={padX} y1={H / 2} x2={W - padX} y2={H / 2} stroke={C.border} strokeWidth="2" />
      {steps.map((step, i) => {
        const cx = padX + stepW * i + stepW / 2;
        return (
          <g key={step.title}>
            <circle cx={cx} cy={H / 2} r="14" fill={C.bg} stroke={C.accent} strokeWidth="2" />
            <text x={cx} y={H / 2 + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill={C.accent}>
              {i + 1}
            </text>
            <text x={cx} y={H / 2 - 36} textAnchor="middle" fontSize="13" fontWeight="700" fill={C.text}>
              {step.title}
            </text>
            <text x={cx} y={H / 2 + 48} textAnchor="middle" fontSize="10" fill={C.muted}>
              {step.note}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ArchitectureDiagram({ d }: { d: Dictionary["docsPage"]["diagram"] }) {
  return (
    <svg viewBox="0 0 880 320" className="h-auto w-full" role="img" aria-label="How the studio fits together">
      <defs>
        <marker id="arrow-fgv" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 Z" fill={C.accent} />
        </marker>
      </defs>
      <g>
        <rect x="20" y="130" width="130" height="64" rx="14" fill={C.surface} stroke={C.border} strokeWidth="1.5" />
        <text x="85" y="158" textAnchor="middle" fontSize="13" fontWeight="700" fill={C.text}>
          {d.you}
        </text>
        <text x="85" y="176" textAnchor="middle" fontSize="10" fill={C.muted}>
          {d.yourWords}
        </text>
      </g>
      <g>
        <rect x="210" y="40" width="220" height="110" rx="16" fill={C.surface} stroke={C.border} strokeWidth="1.5" />
        <text x="320" y="68" textAnchor="middle" fontSize="11" fontWeight="700" fill={C.muted} letterSpacing="2">
          {d.studioLabel}
        </text>
        <text x="320" y="96" textAnchor="middle" fontSize="14" fontWeight="700" fill={C.text}>
          {d.studioName}
        </text>
        <text x="320" y="118" textAnchor="middle" fontSize="11" fill={C.muted}>
          {d.studioPlansIt}
        </text>
        <text x="320" y="136" textAnchor="middle" fontSize="11" fill={C.muted}>
          {d.studioBuildsFixes}
        </text>
      </g>
      <g>
        <rect x="210" y="180" width="220" height="100" rx="16" fill={C.surface} stroke={C.border} strokeWidth="1.5" />
        <text x="320" y="208" textAnchor="middle" fontSize="11" fontWeight="700" fill={C.muted} letterSpacing="2">
          {d.safetyLabel}
        </text>
        <text x="320" y="232" textAnchor="middle" fontSize="13" fontWeight="700" fill={C.text}>
          {d.safetyChecksTests}
        </text>
        <text x="320" y="252" textAnchor="middle" fontSize="11" fill={C.muted}>
          {d.safetyFairPayout}
        </text>
        <text x="320" y="268" textAnchor="middle" fontSize="11" fill={C.muted}>
          {d.safetyFlapRules}
        </text>
      </g>
      <g>
        <rect x="490" y="90" width="200" height="140" rx="16" fill={C.surf2} stroke={C.accent} strokeWidth="1.8" />
        <text x="590" y="118" textAnchor="middle" fontSize="11" fontWeight="700" fill={C.accent} letterSpacing="2">
          {d.chainLabel}
        </text>
        <text x="590" y="146" textAnchor="middle" fontSize="14" fontWeight="700" fill={C.text}>
          {d.chainYourToken}
        </text>
        <text x="590" y="168" textAnchor="middle" fontSize="11" fill={C.muted}>
          {d.chainDeployed}
        </text>
        <text x="590" y="186" textAnchor="middle" fontSize="11" fill={C.muted}>
          {d.chainCompatible}
        </text>
        <text x="590" y="204" textAnchor="middle" fontSize="11" fill={C.muted}>
          {d.chainTestFirst}
        </text>
      </g>
      <g>
        <rect x="730" y="100" width="130" height="120" rx="14" fill={C.bg} stroke={C.border} strokeWidth="1.5" strokeDasharray="4 3" />
        <text x="795" y="124" textAnchor="middle" fontSize="11" fontWeight="700" fill={C.muted} letterSpacing="2">
          {d.onFlapLabel}
        </text>
        <text x="795" y="148" textAnchor="middle" fontSize="11" fill={C.text}>
          {d.onFlapLaunch}
        </text>
        <text x="795" y="168" textAnchor="middle" fontSize="11" fill={C.text}>
          {d.onFlapFees}
        </text>
        <text x="795" y="188" textAnchor="middle" fontSize="11" fill={C.text}>
          {d.onFlapScreen}
        </text>
      </g>
      <line x1="150" y1="162" x2="208" y2="95" stroke={C.accent} strokeWidth="1.5" markerEnd="url(#arrow-fgv)" />
      <line x1="150" y1="162" x2="208" y2="230" stroke={C.accent} strokeWidth="1.5" markerEnd="url(#arrow-fgv)" />
      <line x1="430" y1="95" x2="488" y2="160" stroke={C.accent} strokeWidth="1.5" markerEnd="url(#arrow-fgv)" />
      <line x1="430" y1="230" x2="488" y2="160" stroke={C.accent} strokeWidth="1.5" markerEnd="url(#arrow-fgv)" />
      <line x1="690" y1="160" x2="728" y2="160" stroke={C.accent} strokeWidth="1.5" markerEnd="url(#arrow-fgv)" />
    </svg>
  );
}

type Props = { onBack: () => void };

export default function DocsPage({ onBack }: Props) {
  const { dict } = useI18n();
  const d = dict.docsPage;

  return (
    <div className="min-h-screen pt-[calc(3.5rem+env(safe-area-inset-top))]">
      <div className="container max-w-[1200px] px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-10 flex items-center justify-between gap-4">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
            <ArrowLeft className="size-4" />
            {d.backToStudio}
          </Button>
          <p className="text-xs text-muted-foreground">{d.noCodingRequired}</p>
        </div>

        <div className="grid gap-12 lg:grid-cols-[220px_1fr] lg:gap-16">
          <nav className="hidden space-y-1 lg:block lg:sticky lg:top-24 lg:self-start">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-primary">{d.tocTitle}</p>
            <TocLink href="#overview" label={d.toc.overview} />
            <TocLink href="#pipeline" label={d.toc.pipeline} />
            <TocLink href="#scope" label={d.toc.scope} />
            <TocLink href="#custom-ui" label={d.toc.customUi} />
            <TocLink href="#create" label={d.toc.create} />
            <TocLink href="#prompts" label={d.toc.prompts} />
            <TocLink href="#lottery" label={d.toc.lottery} />
            <TocLink href="#checks" label={d.toc.checks} />
            <TocLink href="#deploy" label={d.toc.deploy} />
          </nav>

          <article className="min-w-0 space-y-14">
            <header className="space-y-4 border-b border-border pb-10">
              <p className="fgv-section-eyebrow">{d.eyebrow}</p>
              <h1 className="font-display text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{d.title}</h1>
              <p className="max-w-2xl text-muted-foreground">{d.intro}</p>
              <div className="grid gap-3 pt-2 sm:grid-cols-2">
                <p className="rounded-lg border border-border/60 bg-card/40 p-3 text-sm text-muted-foreground">
                  {d.walletNote}
                </p>
                <p className="rounded-lg border border-border/60 bg-card/40 p-3 text-sm text-muted-foreground">
                  {d.languageNote}
                </p>
              </div>
            </header>

            <Section id="overview" eyebrow={d.overview.eyebrow} title={d.overview.title}>
              <p>{d.overview.p1}</p>
              <p>
                <strong className="text-foreground">{d.overview.p2Strong}</strong> {d.overview.p2}
              </p>
              <p>{d.overview.p3}</p>
              <DiagramFrame caption={d.diagram.architectureCaption}>
                <ArchitectureDiagram d={d.diagram} />
              </DiagramFrame>
            </Section>

            <Section id="pipeline" eyebrow={d.pipeline.eyebrow} title={d.pipeline.title}>
              <p>{d.pipeline.intro}</p>
              <DiagramFrame caption={d.diagram.pipelineCaption}>
                <PipelineDiagram steps={d.diagram.pipelineSteps} />
              </DiagramFrame>
              <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
                {d.pipeline.steps.map((step) => (
                  <li key={step.title}>
                    <strong className="text-foreground">{step.title}</strong> — {step.body}
                  </li>
                ))}
              </ol>
            </Section>

            <Section id="scope" eyebrow={d.scope.eyebrow} title={d.scope.title}>
              <p>{d.scope.intro}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {d.scope.cards.map((card) => (
                  <Card key={card.title} title={card.title}>
                    {card.body}
                  </Card>
                ))}
              </div>
              <p>{d.scope.outro}</p>
            </Section>

            <Section id="custom-ui" eyebrow={d.customUi.eyebrow} title={d.customUi.title}>
              <p>{d.customUi.intro}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Card title={d.customUi.standardTitle}>{d.customUi.standardBody}</Card>
                <Card title={d.customUi.bespokeTitle}>{d.customUi.bespokeBody}</Card>
              </div>
              <h3 className="pt-2 font-semibold text-foreground">{d.customUi.workbenchTitle}</h3>
              <p>{d.customUi.workbenchBody}</p>
            </Section>

            <Section id="create" eyebrow={d.create.eyebrow} title={d.create.title}>
              <h3 className="font-semibold text-foreground">{d.create.step1Title}</h3>
              <p>{d.create.step1Body}</p>
              <p className="text-sm text-muted-foreground">{d.create.examplesLabel}</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {d.create.examples.map((ex) => (
                  <li key={ex}>{ex}</li>
                ))}
              </ul>

              <h3 className="pt-4 font-semibold text-foreground">{d.create.step2Title}</h3>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-card/80">
                    <tr>
                      <th className="px-3 py-2 font-medium">{d.create.table.colWhatYouSee}</th>
                      <th className="px-3 py-2 font-medium">{d.create.table.colWhatItMeans}</th>
                    </tr>
                  </thead>
                  <tbody className="text-muted-foreground">
                    {d.create.table.rows.map((row, i) => (
                      <tr key={row.label} className={`border-t border-border ${i % 2 === 1 ? "bg-card/30" : ""}`}>
                        <td className="px-3 py-2 font-medium text-foreground">{row.label}</td>
                        <td className="px-3 py-2">{row.meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="pt-4 font-semibold text-foreground">{d.create.step3Title}</h3>
              <p>
                {d.create.step3Body.split("{newVault}")[0]}
                <strong className="text-foreground">{dict.chatPage.newVault}</strong>
                {d.create.step3Body.split("{newVault}")[1]}
              </p>
            </Section>

            <Section id="prompts" eyebrow={d.prompts.eyebrow} title={d.prompts.title}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Card title={d.prompts.doTitle}>
                  <ul className="list-disc space-y-1 pl-4">
                    {d.prompts.doItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </Card>
                <Card title={d.prompts.avoidTitle}>
                  <ul className="list-disc space-y-1 pl-4">
                    {d.prompts.avoidItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </Card>
              </div>
            </Section>

            <Section id="lottery" eyebrow={d.lottery.eyebrow} title={d.lottery.title}>
              <p>{d.lottery.intro}</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {d.lottery.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p>{d.lottery.outro}</p>
            </Section>

            <Section id="checks" eyebrow={d.checks.eyebrow} title={d.checks.title}>
              <p>{d.checks.intro}</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {d.checks.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>

              <h3 className="pt-4 font-semibold text-foreground">{d.checks.rulesTitle}</h3>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-card/80">
                    <tr>
                      <th className="px-3 py-2">{d.checks.rulesTable.colRule}</th>
                      <th className="px-3 py-2">{d.checks.rulesTable.colWhatItChecks}</th>
                    </tr>
                  </thead>
                  <tbody className="text-muted-foreground">
                    {d.checks.rulesTable.rows.map(([rule, desc], i) => (
                      <tr key={rule} className={`border-t border-border ${i % 2 === 1 ? "bg-card/30" : ""}`}>
                        <td className="px-3 py-2 font-medium text-foreground">{rule}</td>
                        <td className="px-3 py-2">{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section id="deploy" eyebrow={d.deploy.eyebrow} title={d.deploy.title}>
              <p>
                <strong className="text-foreground">{d.deploy.readyStrong}</strong> {d.deploy.readyBody}
              </p>
              <p>{d.deploy.beforeYouLaunch}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                {d.deploy.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <div className="grid gap-3 sm:grid-cols-2">
                <Card title={d.deploy.metadataTitle}>{d.deploy.metadataBody}</Card>
                <Card title={d.deploy.galleryTitle}>{d.deploy.galleryBody}</Card>
              </div>
              <p>{d.deploy.outro}</p>
            </Section>
          </article>
        </div>
      </div>
    </div>
  );
}
