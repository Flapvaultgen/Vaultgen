/** Full-bleed static backdrop, dark palette — no animation/glow/grid. */
export default function HeroBackdrop() {
  return (
    <div
      className="pointer-events-none absolute inset-y-0 left-1/2 z-0 h-full w-screen -translate-x-1/2 overflow-hidden"
      aria-hidden
    >
      <div className="fgv-plasma absolute inset-0 opacity-90" />
      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background via-background/40 to-transparent sm:h-32" />
      <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/70 to-transparent sm:h-40" />
    </div>
  );
}
