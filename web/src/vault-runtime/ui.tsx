/**
 * The `@/src/ui` module the AI-generated component imports — a dark-themed
 * kit matching the primitives documented in FLAP_SDK_SURFACE_DOC
 * (server/ui-gen.ts). Styles are injected once at module init so the
 * component only has to write its own bespoke theming on top.
 */
import { type CSSProperties, type ReactNode } from "react";

const STYLE_ID = "fvk-runtime-styles";

const KIT_CSS = `
:root { color-scheme: dark; }
html, body { margin: 0; padding: 0; background: #0b0e14; color: #e6e9f0;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; }
input { font: inherit; }

.fvk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border-radius: 8px; border: 1px solid transparent; cursor: pointer; font-weight: 600;
  transition: opacity .15s, transform .1s, background .15s; white-space: nowrap; }
.fvk-btn:active:not(:disabled) { transform: translateY(1px); }
.fvk-btn:disabled { opacity: .45; cursor: not-allowed; }
.fvk-btn-md { padding: 8px 16px; font-size: 14px; }
.fvk-btn-sm { padding: 5px 12px; font-size: 12px; }
.fvk-btn-lg { padding: 12px 22px; font-size: 15px; }
.fvk-btn-primary { background: #4f7cff; color: #fff; }
.fvk-btn-primary:hover:not(:disabled) { background: #6089ff; }
.fvk-btn-secondary { background: #1b2233; color: #e6e9f0; border-color: #2c3650; }
.fvk-btn-secondary:hover:not(:disabled) { background: #232c42; }
.fvk-btn-ghost { background: transparent; color: #aeb7c8; }
.fvk-btn-ghost:hover:not(:disabled) { background: #ffffff12; color: #e6e9f0; }
.fvk-btn-danger { background: #b02a37; color: #fff; }
.fvk-btn-danger:hover:not(:disabled) { background: #c73344; }

.fvk-card { background: #11151f; border: 1px solid #232c42; border-radius: 12px; overflow: hidden; }
.fvk-card-header { padding: 14px 16px 4px; }
.fvk-card-title { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
.fvk-card-desc { margin: 4px 0 0; font-size: 12px; color: #8b94a8; }
.fvk-card-content { padding: 12px 16px 16px; }

.fvk-input { width: 100%; padding: 8px 12px; border-radius: 8px; background: #0b0e14;
  border: 1px solid #2c3650; color: #e6e9f0; outline: none; }
.fvk-input:focus { border-color: #4f7cff; }
.fvk-input:disabled { opacity: .5; }

.fvk-alert { padding: 10px 12px; border-radius: 8px; font-size: 13px; border: 1px solid; }
.fvk-alert-info { background: #12203a; border-color: #244a8f; color: #9fc0ff; }
.fvk-alert-warning { background: #33270e; border-color: #8f6b1c; color: #ffd27d; }
.fvk-alert-error { background: #34141a; border-color: #8f2437; color: #ff9daf; }
.fvk-alert-success { background: #0f2b1c; border-color: #1f7a45; color: #7fe0a8; }

.fvk-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px;
  border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .02em; border: 1px solid; }
.fvk-badge-success { background: #0f2b1c; border-color: #1f7a45; color: #7fe0a8; }
.fvk-badge-warning { background: #33270e; border-color: #8f6b1c; color: #ffd27d; }
.fvk-badge-danger { background: #34141a; border-color: #8f2437; color: #ff9daf; }
.fvk-badge-info { background: #12203a; border-color: #244a8f; color: #9fc0ff; }
.fvk-badge-neutral { background: #1b2233; border-color: #2c3650; color: #aeb7c8; }

.fvk-tile { background: #0b0e14; border: 1px solid #232c42; border-radius: 10px; padding: 10px 12px; }
.fvk-tile-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b94a8; }
.fvk-tile-value { margin-top: 2px; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums;
  transition: color .3s; word-break: break-word; }
.fvk-tile-hint { margin-top: 2px; font-size: 11px; color: #6b7488; }

.fvk-addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  color: #9fc0ff; cursor: pointer; border-bottom: 1px dotted #4f7cff55; }

.fvk-spinner { display: inline-block; border-radius: 50%; border: 2px solid #4f7cff33;
  border-top-color: #4f7cff; animation: fvk-spin .7s linear infinite; vertical-align: middle; }
@keyframes fvk-spin { to { transform: rotate(360deg); } }
`;

if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = KIT_CSS;
  document.head.appendChild(style);
}

// ── Components ───────────────────────────────────────────────────────────────

type Common = { children?: ReactNode; className?: string; style?: CSSProperties };

export function Button({
  variant = "primary",
  size = "md",
  disabled,
  onClick,
  children,
  className,
  style,
  type,
}: Common & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type ?? "button"}
      className={`fvk-btn fvk-btn-${size} fvk-btn-${variant} ${className ?? ""}`}
      style={style}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Card({ children, className, style }: Common) {
  return <div className={`fvk-card ${className ?? ""}`} style={style}>{children}</div>;
}
export function CardHeader({ children, className, style }: Common) {
  return <div className={`fvk-card-header ${className ?? ""}`} style={style}>{children}</div>;
}
export function CardTitle({ children, className, style }: Common) {
  return <h3 className={`fvk-card-title ${className ?? ""}`} style={style}>{children}</h3>;
}
export function CardDescription({ children, className, style }: Common) {
  return <p className={`fvk-card-desc ${className ?? ""}`} style={style}>{children}</p>;
}
export function CardContent({ children, className, style }: Common) {
  return <div className={`fvk-card-content ${className ?? ""}`} style={style}>{children}</div>;
}

export function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  className,
  style,
}: {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <input
      className={`fvk-input ${className ?? ""}`}
      style={style}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      type={type}
      disabled={disabled}
      spellCheck={false}
    />
  );
}

export function Alert({ variant = "info", children, className, style }: Common & { variant?: "info" | "warning" | "error" | "success" }) {
  return <div className={`fvk-alert fvk-alert-${variant} ${className ?? ""}`} style={style}>{children}</div>;
}

export function StatusBadge({ tone = "neutral", children, className, style }: Common & { tone?: "success" | "warning" | "danger" | "info" | "neutral" }) {
  return <span className={`fvk-badge fvk-badge-${tone} ${className ?? ""}`} style={style}>{children}</span>;
}

export function DetailTile({ label, value, hint, className, style }: { label: string; value: ReactNode; hint?: string; className?: string; style?: CSSProperties }) {
  return (
    <div className={`fvk-tile ${className ?? ""}`} style={style}>
      <div className="fvk-tile-label">{label}</div>
      <div className="fvk-tile-value">{value}</div>
      {hint ? <div className="fvk-tile-hint">{hint}</div> : null}
    </div>
  );
}

export type TxButtonState = "idle" | "pending" | "success" | "error";

export function TxButton({
  state,
  disabled,
  onClick,
  children,
  className,
  style,
  variant = "primary",
  size = "md",
}: Common & {
  state: TxButtonState;
  disabled?: boolean;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <Button
      variant={state === "error" ? "danger" : variant}
      size={size}
      disabled={disabled || state === "pending"}
      onClick={onClick}
      className={className}
      style={style}
    >
      {state === "pending" ? <Spinner size={14} /> : null}
      {children}
    </Button>
  );
}

export function AddressLink({ address, className, style }: { address: string; className?: string; style?: CSSProperties }) {
  const short = address && address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
  return (
    <span
      className={`fvk-addr ${className ?? ""}`}
      style={style}
      title={address}
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(address);
        } catch {
          // clipboard is usually unavailable in the sandbox — the title still shows the full address
        }
      }}
    >
      {short}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="fvk-spinner" style={{ width: size, height: size }} />;
}
