import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Repair an unexpanded TEMP/TMP on Windows.
//
// Windows stores TEMP/TMP in the registry as REG_EXPAND_SZ — literally
// `%USERPROFILE%\AppData\Local\Temp` — and some launch contexts (services,
// scheduled tasks, a parent started by one) pass that string through without
// expanding it. bun/node/bash never expand `%VAR%`, so every temp write then
// resolves *relative to cwd*, littering the working dir with a
// `%USERPROFILE%/AppData/Local/Temp` tree (codehost + agent-yes both hit this —
// ~1GB of native-addon prebuilds re-extracted inside a provisioned worktree).
//
// Call normalizeTempEnv() as early as possible — before any native dep or child
// process reads the env. No-op off Windows.

/** Expand `%VAR%` references in `value` against `env`; unknown vars are left
 *  as-is. (`%VAR%` is cmd.exe syntax — bun/node/bash never expand it.) */
export function expandWinVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole);
}

/**
 * Expand any unexpanded `%VAR%` left in TEMP/TMP and write the result back to
 * process.env, falling back to the canonical per-user temp under the home dir if
 * a var is unresolved or the dir can't be created. Idempotent; no-op off Windows.
 * Returns the keys it changed.
 */
export function normalizeTempEnv(): string[] {
  if (process.platform !== "win32") return [];
  const changed: string[] = [];
  for (const key of ["TEMP", "TMP"]) {
    const raw = process.env[key];
    if (!raw || !raw.includes("%")) continue; // already a real path
    const expanded = expandWinVars(raw);
    const fixed = expanded.includes("%") || !ensureDir(expanded) ? fallbackTemp() : expanded;
    process.env[key] = fixed;
    changed.push(key);
  }
  return changed;
}

function fallbackTemp(): string {
  const dir = join(homedir(), "AppData", "Local", "Temp");
  ensureDir(dir);
  return dir;
}

function ensureDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
