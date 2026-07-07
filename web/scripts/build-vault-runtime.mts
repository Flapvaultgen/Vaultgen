/**
 * Bundles the sandboxed vault-UI runtime (src/vault-runtime/main.tsx) into a
 * single self-contained script at public/vault-runtime.js. The sandboxed
 * iframe (unique origin, allow-scripts only) loads it as a classic script, so
 * everything — React, lucide-react, the SDK/UI shims and the bridge client —
 * must be inlined.
 *
 * Runs automatically before `npm run dev` / `dev:all` / `build`.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [path.join(webRoot, "src/vault-runtime/main.tsx")],
  outfile: path.join(webRoot, "public/vault-runtime.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`[vault-runtime] public/vault-runtime.js built (${Math.round(bytes / 1024)} KB)`);
