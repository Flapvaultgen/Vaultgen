/**
 * Writes web/public/config.json at build time from VITE_API_URL (Vercel/Railway split deploy).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const publicConfig = path.join(dir, "../public/config.json");

let existing = {};
try {
  existing = JSON.parse(readFileSync(publicConfig, "utf8"));
} catch {
  /* fresh */
}

// On Vercel, /api is proxied to Railway (see root vercel.json) — same-origin avoids CORS on every deploy URL.
const raw = (process.env.VITE_API_URL ?? "").trim().replace(/\/$/, "");
const apiUrl = process.env.VERCEL
  ? ""
  : !raw
    ? ""
    : /^https?:\/\//i.test(raw)
      ? raw
      : `https://${raw}`;

const sandboxDeployer = (process.env.VITE_SANDBOX_DEPLOYER ?? "").trim();

writeFileSync(
  publicConfig,
  JSON.stringify(
    {
      ...existing,
      apiUrl,
      ...(sandboxDeployer ? { sandboxDeployer } : {}),
    },
    null,
    2
  ) + "\n"
);

console.log(apiUrl ? `config.json apiUrl=${apiUrl}` : "config.json apiUrl=(empty — local dev uses Vite proxy)");
