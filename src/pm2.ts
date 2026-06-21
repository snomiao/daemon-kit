import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// pm2-backed daemon management, shared by codehost and agent-yes. Both projects
// independently grew the same Windows-specific workarounds; this is the single
// home for them:
//   - pm2 is invoked via its resolved JS entry under the current runtime (bun) —
//     never the bare `pm2` command, whose PATH shim has no .exe/.cmd extension so
//     spawnSync can't resolve it.
//   - starting pm2 (which forks its God daemon + the managed child) is routed
//     through a hidden VBScript launcher so no console window flashes — a plain
//     spawn with windowsHide isn't enough, the detached daemon/fork still pop
//     their own windows.
//   - the daemon is registered with exponential restart backoff, so a persistent
//     crash (e.g. a port held by a stale instance) can't storm-restart.

const require = createRequire(import.meta.url);

export interface DaemonSpec {
  /** pm2 process name (caller namespaces it, e.g. `codehost-foo` / `agent-yes`). */
  name: string;
  /** Executable pm2 runs directly (e.g. the bun runtime path). */
  script: string;
  /** Arguments passed to `script`. */
  args: string[];
  /** Working directory. */
  cwd: string;
  /** Combined stdout/stderr log path. */
  log: string;
  /** Exponential restart-backoff seed in ms (pm2 grows it on repeat crashes). Default 200. */
  expBackoffMs?: number;
  /** Directory for the generated hidden-launch .cmd/.vbs files. Default ~/.daemon-kit/launchers. */
  launcherDir?: string;
}

function defaultLauncherDir(): string {
  return join(homedir(), ".daemon-kit", "launchers");
}

/** Resolve pm2's CLI entry from a local dep or the bun/npm global install. */
export function pm2Entry(): string | null {
  const attempts: Array<() => string> = [
    () => require.resolve("pm2/bin/pm2"),
    () => createRequire(join(bunGlobalRoot(), "_")).resolve("pm2/bin/pm2"),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // try next
    }
  }
  return null;
}

/** Where `bun add -g` drops global packages. */
function bunGlobalRoot(): string {
  const base = process.env.BUN_INSTALL ?? join(homedir(), ".bun");
  return join(base, "install", "global", "node_modules");
}

/** True if a runnable pm2 is resolvable. */
export function pm2Available(): boolean {
  return pm2Entry() != null;
}

/** Run the pm2 CLI under the current runtime (bun). Window stays hidden. */
function pm2(args: string[], opts: SpawnSyncOptions = {}) {
  const entry = pm2Entry();
  if (!entry) return { status: 1, stdout: "", stderr: "" } as const;
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", windowsHide: true, ...opts });
}

/**
 * Start (replacing any same-named instance) a daemon, launched hidden so no
 * window appears, with exponential restart backoff, and persist the process list
 * (`pm2 save`). Returns true once pm2 reports the process online.
 */
export function pm2Start(spec: DaemonSpec): boolean {
  const entry = pm2Entry();
  if (!entry) return false;
  const backoff = String(spec.expBackoffMs ?? 200);

  // `--interpreter none` execs the script directly with the args after `--`.
  const start = [
    process.execPath, entry, "start", spec.script,
    "--name", spec.name,
    "--cwd", spec.cwd,
    "--interpreter", "none",
    "--output", spec.log,
    "--error", spec.log,
    "--exp-backoff-restart-delay", backoff,
    "--", ...spec.args,
  ];
  const save = [process.execPath, entry, "save", "--force"];
  runHidden([start, save], spec.name, spec.launcherDir ?? defaultLauncherDir());

  // pm2 start is synchronous (the hidden launcher waits), so liveness is the
  // source of truth — more reliable than the launcher's exit code.
  return pm2Online(spec.name);
}

/** True if pm2 currently has `name` online. */
export function pm2Online(name: string): boolean {
  const r = pm2(["jlist"]);
  if (r.status !== 0 || !r.stdout) return false;
  try {
    const list = JSON.parse(String(r.stdout)) as Array<{ name: string; pm2_env?: { status?: string } }>;
    return list.some((p) => p.name === name && p.pm2_env?.status === "online");
  } catch {
    return false;
  }
}

/** Stop + deregister a pm2-managed daemon and re-save the list. */
export function pm2Delete(name: string): void {
  pm2(["delete", name], { stdio: "ignore" });
  pm2(["save", "--force"], { stdio: "ignore" });
}

/**
 * Run one or more command argv's hidden, in order, waiting for completion. Writes
 * a launcher .cmd (so we get normal Windows quoting, not VBS string escaping) and
 * a .vbs that runs it with window style 0 via wscript (no console host at all).
 */
function runHidden(commands: string[][], name: string, launcherDir: string): void {
  mkdirSync(launcherDir, { recursive: true });
  const cmdPath = join(launcherDir, `${name}.cmd`);
  const vbsPath = join(launcherDir, `${name}.vbs`);
  const body = ["@echo off", ...commands.map(quoteCmd)].join("\r\n") + "\r\n";
  writeFileSync(cmdPath, body);
  // Hidden launcher: wscript (no console host) runs the .cmd with window style 0
  // and waits. The path is wrapped in literal quotes — in VBS source a `"` inside
  // a string is written `""`, so a quoted path becomes `"""<path>"""`.
  writeFileSync(vbsPath, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${cmdPath}""", 0, True\r\n`);
  spawnSync("wscript", ["//B", "//Nologo", vbsPath], { windowsHide: true });
}

/** Quote an argv into a single cmd.exe command line. Paths/tokens here never
 *  contain double quotes, so simple space-aware quoting is sufficient. */
export function quoteCmd(argv: string[]): string {
  return argv.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a)).join(" ");
}
