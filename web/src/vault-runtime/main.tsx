/**
 * Entry point of the sandboxed vault-UI runtime bundle (public/vault-runtime.js,
 * built by scripts/build-vault-runtime.mts).
 *
 * The host page's srcdoc sets `window.__VAULT_UI_INIT__` (context, i18n and
 * the server-compiled CJS for Component.tsx / VaultABI.ts), then loads this
 * bundle. We evaluate the compiled modules against a fixed module registry —
 * exactly the import surface allowed by the server-side validator — and
 * render the component under an error boundary. The AI's code never gets
 * anything beyond React, lucide icons and our SDK/UI shims; all chain access
 * goes through the postMessage bridge.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import * as Lucide from "lucide-react";
import type { VaultUiRuntimeInit } from "../lib/vault-ui-bridge";
import * as sdk from "./sdk";
import * as ui from "./ui";
import { announceReady } from "./bridge-client";

const STATIC_MODULES: Record<string, unknown> = {
  react: React,
  "react/jsx-runtime": JsxRuntime,
  "react/jsx-dev-runtime": JsxRuntime,
  "lucide-react": Lucide,
  "@/src/sdk": sdk,
  "@/src/ui": ui,
};

function evalCjs(code: string, requireFn: (name: string) => unknown): Record<string, unknown> {
  const module = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("require", "module", "exports", code)(requireFn, module, module.exports);
  return module.exports;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  render() {
    if (this.state.error) return <FatalError message={this.state.error} />;
    return this.props.children;
  }
}

function FatalError({ message }: { message: string }) {
  return (
    <div style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui, sans-serif", color: "#ff9daf" }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Custom UI crashed</div>
      <div style={{ fontSize: 13, color: "#aeb7c8", wordBreak: "break-word" }}>{message}</div>
    </div>
  );
}

function PreviewBadge() {
  return (
    <div
      style={{
        position: "fixed",
        right: 10,
        bottom: 10,
        zIndex: 9999,
        padding: "4px 10px",
        borderRadius: 999,
        background: "#33270eE6",
        border: "1px solid #8f6b1c",
        color: "#ffd27d",
        fontSize: 11,
        fontWeight: 700,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        pointerEvents: "none",
      }}
    >
      PREVIEW — sample data
    </div>
  );
}

function boot(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) return;
  const root = createRoot(rootEl);
  try {
    const init = (window as unknown as { __VAULT_UI_INIT__?: VaultUiRuntimeInit }).__VAULT_UI_INIT__;
    if (!init || typeof init.componentJs !== "string") throw new Error("Missing runtime init payload.");

    const abiExports = evalCjs(init.vaultAbiJs, (name) => {
      throw new Error(`VaultABI.ts must not import anything (tried "${name}").`);
    });
    const requireShim = (name: string): unknown => {
      if (name === "./VaultABI" || name === "./VaultABI.ts" || name === "./VaultABI.js") return abiExports;
      if (name in STATIC_MODULES) return STATIC_MODULES[name];
      throw new Error(`Module "${name}" is not available in the vault UI sandbox.`);
    };
    const componentExports = evalCjs(init.componentJs, requireShim);
    const Component = componentExports.default as React.ComponentType<Record<string, never>> | undefined;
    if (typeof Component !== "function") throw new Error("Component.tsx has no default-exported component.");

    root.render(
      <ErrorBoundary>
        <Component />
        {init.preview ? <PreviewBadge /> : null}
      </ErrorBoundary>
    );
    announceReady();
  } catch (err) {
    root.render(<FatalError message={err instanceof Error ? err.message : String(err)} />);
  }
}

boot();
