/**
 * Foundry compile gate + on-disk artifact reading for the codegen pipeline.
 * Writes the generated child contract (wrapped in the injected PREAMBLE) to
 * src/_codegen/, runs `forge build`, and reads back ABI + bytecode size from
 * the compiled artifact. Also implements the EIP-170 --via-ir rescue path
 * and the deployed-bytecode-size safety finding.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PREAMBLE } from "./codegen-prompts.js";
import { isForgeCompileSuccess } from "./codegen-patches.js";
import type { SafetyFinding } from "./codegen.js";

const execAsync = promisify(exec);

// Repo root is one level up from /server.
export const REPO_ROOT = path.resolve(process.cwd(), "..");
const FORGE =
  process.env.FORGE_PATH ??
  (existsSync(path.join(os.homedir(), ".foundry", "bin", "forge"))
    ? path.join(os.homedir(), ".foundry", "bin", "forge")
    : "forge");
const CODEGEN_DIR = path.join(REPO_ROOT, "src", "_codegen");

// ── forge compile gate ──────────────────────────────────────────────────────
export async function compile(
  contractName: string,
  body: string
): Promise<{ ok: boolean; errors: string; artifactPath: string; filePath: string }> {
  // Clear any prior generated file so stale/broken attempts never pollute `forge build`/`forge test`.
  await rm(CODEGEN_DIR, { recursive: true, force: true });
  await mkdir(CODEGEN_DIR, { recursive: true });
  const fileName = `${contractName}.sol`;
  const filePath = path.join(CODEGEN_DIR, fileName);
  const source = `${PREAMBLE}\n${body.trim()}\n`;
  await writeFile(filePath, source, "utf8");

  const artifactPath = path.join(REPO_ROOT, "out", fileName, `${contractName}.json`);

  try {
    // Build only the generated file's tree; the rest of the repo is cached.
    const { stdout } = await execAsync(`"${FORGE}" build "${filePath}" 2>&1`, {
      cwd: REPO_ROOT,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 16,
    });
    // Pretty-print so the source shown in the UI is readable (best-effort).
    try {
      await execAsync(`"${FORGE}" fmt "${filePath}"`, { cwd: REPO_ROOT, timeout: 20_000 });
    } catch {
      /* formatting is cosmetic — ignore failures */
    }
    return { ok: true, errors: "", artifactPath, filePath };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout || "") + (e.stderr || "") || e.message || "Unknown compile error";
    if (isForgeCompileSuccess(raw)) {
      try {
        await execAsync(`"${FORGE}" fmt "${filePath}"`, { cwd: REPO_ROOT, timeout: 20_000 });
      } catch {
        /* formatting is cosmetic */
      }
      return { ok: true, errors: "", artifactPath, filePath };
    }
    return { ok: false, errors: cleanForgeOutput(raw), artifactPath: "", filePath };
  }
}

function cleanForgeOutput(out: string): string {
  // Keep solc/forge errors; drop dependency revision noise when no real failure.
  const cleaned = out
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => !/Dependency 'lib\//.test(l) || !/revision mismatch/.test(l));
  const hasSolcError = cleaned.some((l) => /\bError\b/.test(l) && !/Warning/.test(l));
  const lines = hasSolcError ? cleaned : cleaned.filter((l) => !/^Warning:/.test(l.trim()));
  return lines.slice(0, 80).join("\n");
}

export async function cleanupCodegen(): Promise<void> {
  if (existsSync(CODEGEN_DIR)) await rm(CODEGEN_DIR, { recursive: true, force: true });
}

export async function readArtifact(artifactPath: string): Promise<{
  abi: unknown[] | null;
  creationBytecode: string | null;
  bytecodeSize: number | null;
  deployedBytecodeSize: number | null;
}> {
  try {
    const raw = await readFile(artifactPath, "utf8");
    const json = JSON.parse(raw);
    const bytecode: string = json?.bytecode?.object ?? "";
    const creationBytecode = bytecode.startsWith("0x") ? bytecode : null;
    const size = creationBytecode ? (creationBytecode.length - 2) / 2 : null;
    const deployedBytecode: string = json?.deployedBytecode?.object ?? "";
    const deployedSize = deployedBytecode.startsWith("0x") ? (deployedBytecode.length - 2) / 2 : null;
    return { abi: json?.abi ?? null, creationBytecode, bytecodeSize: size, deployedBytecodeSize: deployedSize };
  } catch {
    return { abi: null, creationBytecode: null, bytecodeSize: null, deployedBytecodeSize: null };
  }
}

/** EIP-170 (Spurious Dragon): a deployed contract's runtime code can never exceed 24,576 bytes
 *  on any EVM chain. This is a hard protocol limit, not a Flap/gas/network issue — a vault over
 *  this size will ALWAYS fail to deploy via CREATE2 (factory sees `vault == address(0)` and
 *  reverts DeployFailed()), no matter how many times it's registered/re-launched. Catch it at
 *  compile time so it never reaches a user as a cryptic on-chain revert. */
export const MAX_DEPLOYED_BYTECODE_SIZE = 24_576;

/**
 * One-shot rescue for a vault that compiles and passes every check EXCEPT it's over the
 * EIP-170 deployed-bytecode limit: recompile with solc's IR-based pipeline (`--via-ir`),
 * which for large, branch-heavy generated contracts routinely produces meaningfully
 * smaller runtime bytecode than the legacy codegen path (observed ~40% smaller on a real
 * oversized vault) at the cost of a much slower single compile. Only worth trying once,
 * on demand, never as the default pipeline compiler (it would make every iterative
 * compile-fix-retry cycle far too slow).
 */
export async function tryViaIRRescue(
  filePath: string,
  artifactPath: string
): Promise<{
  abi: unknown[] | null;
  creationBytecode: string | null;
  bytecodeSize: number | null;
  deployedBytecodeSize: number | null;
} | null> {
  if (!filePath || !artifactPath) return null;
  try {
    await execAsync(`"${FORGE}" build "${filePath}" --via-ir --optimizer-runs 200 --force 2>&1`, {
      cwd: REPO_ROOT,
      timeout: 240_000,
      maxBuffer: 1024 * 1024 * 16,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const raw = (e.stdout || "") + (e.stderr || "") || e.message || "";
    if (!isForgeCompileSuccess(raw)) return null;
  }
  const artifact = await readArtifact(artifactPath);
  if (deployedSizeFinding(artifact.deployedBytecodeSize)) return null;
  return artifact;
}

export function deployedSizeFinding(deployedBytecodeSize: number | null): SafetyFinding | null {
  if (deployedBytecodeSize === null || deployedBytecodeSize <= MAX_DEPLOYED_BYTECODE_SIZE) return null;
  const overBy = deployedBytecodeSize - MAX_DEPLOYED_BYTECODE_SIZE;
  return {
    level: "block",
    rule: "deployed-bytecode-exceeds-eip170",
    detail:
      `Deployed (runtime) bytecode is ${deployedBytecodeSize} bytes — ${overBy} bytes over the ` +
      `${MAX_DEPLOYED_BYTECODE_SIZE}-byte EIP-170 limit every EVM chain enforces. CREATE2 deployment ` +
      `will ALWAYS fail (factory sees vault == address(0) and reverts DeployFailed()) regardless of ` +
      `network or retries. Shrink the contract: split rarely-used admin/view logic into fewer, more ` +
      `generic functions, remove redundant state/events, or simplify the mechanic surface. This is a ` +
      `hard on-chain limit, not a style preference.`,
  };
}
