/**
 * Near-flat backdrop: a single faint neutral wash at the top plus the hairline
 * that closes the fold. No color glow, no grid, no animation — the reference
 * sites get their depth from borders and type contrast, not ambient light.
 */
export default function HeroBackdrop() {
  return (
    <div
      className="pointer-events-none absolute inset-y-0 left-1/2 z-0 h-full w-screen -translate-x-1/2 overflow-hidden"
      aria-hidden
    >
      <div className="fgv-plasma absolute inset-0" />
      <div className="absolute inset-x-0 bottom-0 h-px bg-border" />
    </div>
  );
}
