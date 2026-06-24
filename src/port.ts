// Retry a port bind that races a stale instance's release.
//
// A daemon restart can race the previous instance's port release (TIME_WAIT /
// slow shutdown), so a single listen() throws EADDRINUSE and the daemon exits
// straight into another restart. Wrapping the bind in backoff lets the restart
// self-heal; combined with pm2 exp-backoff, a transient clash never storms.
//
// The transient race is the common case. The OTHER case (opt-in `reclaim`) is a
// LIVE holder that won't release on its own: on Windows a listen socket is
// inheritable, so a detached grandchild can inherit it and keep the port in
// LISTEN after its parent dies — netstat then shows a *dead* owner pid and plain
// backoff can never succeed. `reclaim` frees it; see freeStalePort.

import { spawnSync } from "node:child_process";

export interface BindRetryOptions {
  /** Max attempts before giving up. Default 6 (~5.75s of total backoff). */
  attempts?: number;
  /** First backoff delay in ms; doubles each retry. Default 250. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 2000. */
  maxDelayMs?: number;
  /** Injectable sleep (for tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Opt-in DESTRUCTIVE port reclaim, attempted ONCE after normal retries
   * exhaust (then one final bind). Off unless provided. Only use this for a port
   * the caller OWNS (a daemon reclaiming its own port across a restart) — it
   * kills whatever holds the port.
   */
  reclaim?: {
    /** The port to free (the same one `bind` listens on). */
    port: number;
    /**
     * Command-line substring/regex identifying the caller's own orphaned holder
     * processes. Required to recover the inherited-socket case (where the netstat
     * owner pid is dead and the real holder is a differently-pid'd orphan). Without
     * it, only the live netstat owner is killed.
     */
    signature?: string | RegExp;
    /** Override the reclaim implementation (tests). Defaults to freeStalePort. */
    free?: (port: number, signature?: string | RegExp) => void | Promise<void>;
  };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `bind` (which throws `EADDRINUSE` while a stale instance still holds the
 * port) with exponential backoff. Non-EADDRINUSE errors re-throw immediately. If
 * `reclaim` is set, a single destructive reclaim runs after the backoff is
 * exhausted, followed by one last bind; otherwise the last EADDRINUSE re-throws.
 */
export async function bindWithRetry<T>(bind: () => T | Promise<T>, opts: BindRetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 2000;
  const sleep = opts.sleep ?? realSleep;
  let reclaimed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await bind();
    } catch (e) {
      const inUse = (e as { code?: string } | null)?.code === "EADDRINUSE";
      if (inUse && attempt < attempts - 1) {
        await sleep(Math.min(max, base * 2 ** attempt));
        continue;
      }
      // Backoff exhausted. One opt-in destructive reclaim, then a final bind try.
      if (inUse && opts.reclaim && !reclaimed) {
        reclaimed = true;
        const free = opts.reclaim.free ?? freeStalePort;
        await free(opts.reclaim.port, opts.reclaim.signature);
        continue; // attempt++ → final bind; if it still throws, reclaimed → throw
      }
      throw e;
    }
  }
}

/**
 * Free a port held by a stale/orphaned holder. Two phases:
 *   1. Kill the port's current LISTEN owner (per the OS connection table). Handles
 *      a live-but-stuck previous instance.
 *   2. If `signature` is given and the port is STILL held, kill processes whose
 *      command line matches `signature` — the inherited-socket case, where the
 *      netstat owner pid is already dead and the real holder is a different pid.
 * Best-effort and DESTRUCTIVE; intended for a daemon reclaiming its own port.
 */
export async function freeStalePort(
  port: number,
  signature?: string | RegExp,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<void> {
  // Phase 1 — kill the live netstat/connection-table owner.
  for (const pid of listenerPids(port)) killPid(pid);
  await sleep(250);

  // Phase 2 — inherited-socket orphan: owner pid is dead, real holder differs.
  if (signature && listenerPids(port).length > 0) {
    for (const pid of pidsByCommandLine(signature)) killPid(pid);
    await sleep(250);
  }
}

/** PIDs currently LISTENING on `port`, via the OS connection table. */
function listenerPids(port: number): number[] {
  if (process.platform === "win32") {
    const r = spawnSync("netstat", ["-ano", "-p", "TCP"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const pids = new Set<number>();
    for (const line of String(r.stdout).split(/\r?\n/)) {
      // "  TCP    127.0.0.1:7432   0.0.0.0:0   LISTENING   1234"  (IPv6: [::1]:7432)
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
      if (m && Number(m[1]) === port) pids.add(Number(m[2]));
    }
    return [...pids];
  }
  // POSIX: lsof, then ss as a fallback.
  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (lsof.status === 0 && lsof.stdout) return uniqueInts(lsof.stdout);
  const ss = spawnSync("ss", ["-ltnHp", `sport = :${port}`], { encoding: "utf8" });
  if (ss.status === 0 && ss.stdout) {
    return [...new Set([...String(ss.stdout).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
  }
  return [];
}

/** PIDs whose full command line matches `signature`. */
function pidsByCommandLine(signature: string | RegExp): number[] {
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.status !== 0 || !r.stdout) return [];
    let list: Array<{ ProcessId: number; CommandLine: string | null }>;
    try {
      const parsed = JSON.parse(String(r.stdout));
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
    return list
      .filter((p) => p.CommandLine != null && matches(p.CommandLine, signature))
      .map((p) => Number(p.ProcessId))
      .filter((pid) => pid > 1);
  }
  // POSIX: pgrep -f matches against the full argv.
  const pat = typeof signature === "string" ? signature : signature.source;
  const r = spawnSync("pgrep", ["-f", pat], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  return uniqueInts(r.stdout).filter((pid) => pid !== process.pid);
}

function matches(haystack: string, sig: string | RegExp): boolean {
  return typeof sig === "string" ? haystack.includes(sig) : sig.test(haystack);
}

function killPid(pid: number): void {
  if (!pid || pid <= 1 || pid === process.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // already gone / no permission — best-effort
  }
}

function uniqueInts(out: string): number[] {
  return [
    ...new Set(
      out
        .split(/\s+/)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 1),
    ),
  ];
}
