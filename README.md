# @snomiao/daemon-kit

Shared daemon helpers for [**codehost**](https://github.com/snomiao/codehost) and [**agent-yes**](https://github.com/snomiao/agent-yes). Both projects independently grew the *same* Windows daemon workarounds — and the same bugs. This is their single home.

## Why this exists

codehost and agent-yes each ship a `serve`-style command that runs a long-lived process as a managed daemon (pm2 on Windows, oxmgr elsewhere). On the same day, both repos separately fixed an identical set of Windows daemon bugs: hidden launch, restart backoff, login auto-start, and a port-clash restart storm. Duplicated fixes drift — so the daemon layer is factored out here.

## Scope boundary (the co-work contract)

| Concern | Owner |
| --- | --- |
| pm2 process mgmt · hidden launch · exp-backoff · login auto-start · TEMP normalize · port-bind retry | **daemon-kit** (this package) |
| WebRTC / signaling (rooms, tokens, hosts) | **each project** — stays separate (`signal.codehost.dev` vs `agent-yes.com`) |
| Remote workspace / editor access · repo provisioning · `tree/<branch>` worktrees | **codehost** |
| Agent execution · auto-yes · terminal/resize · `ay ls/tail/send` | **agent-yes** |

The two apps **compose**: codehost provisions & serves a worktree → agent-yes runs an agent inside it. They share this daemon layer and nothing in each other's product surface.

## API

```ts
import {
  pm2Start, pm2Online, pm2Delete, pm2Available,   // pm2 daemon management
  enablePm2LoginAutostart, disablePm2LoginAutostart, // login/boot auto-start
  normalizeTempEnv,                                 // fix unexpanded %USERPROFILE% TEMP/TMP
  bindWithRetry, freeStalePort,                     // EADDRINUSE retry (+ stale-holder reclaim)
} from "@snomiao/daemon-kit";

// Repair TEMP/TMP before any native dep or child reads it (call first).
normalizeTempEnv();

// Start a restart-backed daemon (hidden launch on Windows; direct on POSIX).
pm2Start({
  name: "agent-yes",
  script: process.execPath,          // the bun runtime
  args: [entryScript, "serve", "--webrtc"],
  cwd: projectDir,
  log: "C:\\Users\\me\\.agent-yes\\logs\\daemon.log",
  expBackoffMs: 200,                 // exponential restart backoff (anti-storm)
});

enablePm2LoginAutostart("agent-yes"); // Win: HKCU Run -> hidden `pm2 resurrect`; POSIX: `pm2 startup`

// Self-heal a port clash during restart instead of crash-looping. With `reclaim`,
// also recover a LIVE stale holder (e.g. a detached child that inherited the
// listen socket and orphan-holds the port — netstat shows a dead owner pid).
const server = await bindWithRetry(() => Bun.serve(opts), {
  reclaim: { port: 7432, signature: "ay serve" }, // opt-in, destructive — your own port only
});
```

### What each helper does

- **`pm2Start(spec)`** — replaces any same-named instance (deletes first) and starts the daemon with `--exp-backoff-restart-delay` so a persistent crash can't storm-restart. On **Windows** it launches via a hidden VBScript launcher (`wscript //B`, window style `0`) so neither the pm2 daemon nor its fork pops a console window; on **POSIX** it starts pm2 directly. Returns `true` once pm2 reports it online.
- **`pm2Online` / `pm2Delete` / `pm2Available`** — liveness, teardown, and a resolvable-pm2 probe (resolves pm2's JS entry under the current runtime; never the bare `pm2` shim).
- **`enablePm2LoginAutostart(name)`** — auto-start at login/boot. **Windows:** `pm2 save` + a hidden `HKCU\…\Run` entry running `pm2 resurrect` (no admin; works where Startup-folder writes and `schtasks /create` are blocked). **POSIX:** pm2's native `pm2 save` + `pm2 startup` (may print a one-off sudo command).
- **`disablePm2LoginAutostart(name)`** — remove the per-tool **Windows** HKCU Run entry. No-op off Windows by design: pm2's `startup` hook is global (shared by all pm2 daemons), so a single tool's uninstall must not tear it down — `pm2Delete` + the re-saved list already stop *this* daemon being resurrected.
- **`normalizeTempEnv()`** — expands a literal `%USERPROFILE%\AppData\Local\Temp` left in `TEMP`/`TMP` (Windows `REG_EXPAND_SZ` passed through unexpanded), so temp writes don't litter the cwd. No-op off Windows.
- **`bindWithRetry(fn, opts?)`** — runs a `listen()`/`Bun.serve()` with exponential backoff on `EADDRINUSE`, so a daemon restart racing the old instance's port release self-heals. With opt-in `reclaim: { port, signature? }`, after the backoff exhausts it runs one **destructive** reclaim then a final bind — for a LIVE holder that won't release on its own (the inherited-socket / dead-owner-pid case).
- **`freeStalePort(port, signature?)`** — the reclaim primitive (also usable standalone): phase 1 kills the port's current LISTEN owner; phase 2, if `signature` is given and the port is still held, kills processes whose command line matches it (the inherited-socket orphan, whose pid differs from the dead netstat owner). Cross-platform (`netstat`/`taskkill` on Windows; `lsof`/`ss` + `SIGKILL` on POSIX). **Destructive — use only for a port you own.**

## Develop

```bash
bun install
bun test
bun run build      # tsc -> dist/ (+ .d.ts)
```

## License

MIT
