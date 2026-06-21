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
  enablePm2LoginAutostart, disablePm2LoginAutostart, // Windows login auto-start
  normalizeTempEnv,                                 // fix unexpanded %USERPROFILE% TEMP/TMP
  bindWithRetry,                                    // EADDRINUSE retry with backoff
} from "@snomiao/daemon-kit";

// Repair TEMP/TMP before any native dep or child reads it (call first).
normalizeTempEnv();

// Start a hidden, restart-backed daemon (no console window flashes on Windows).
pm2Start({
  name: "agent-yes",
  script: process.execPath,          // the bun runtime
  args: [entryScript, "serve", "--webrtc"],
  cwd: projectDir,
  log: "C:\\Users\\me\\.agent-yes\\logs\\daemon.log",
  expBackoffMs: 200,                 // exponential restart backoff (anti-storm)
});

enablePm2LoginAutostart("agent-yes"); // HKCU Run -> hidden `pm2 resurrect` at login

// Self-heal a port clash during restart instead of crash-looping.
const server = await bindWithRetry(() => Bun.serve(opts));
```

### What each helper does

- **`pm2Start(spec)`** — replaces any same-named instance and starts the daemon via a hidden VBScript launcher (`wscript //B`, window style `0`) so neither the pm2 daemon nor its fork pops a console window. Registers `--exp-backoff-restart-delay` so a persistent crash can't storm-restart. Returns `true` once pm2 reports it online.
- **`pm2Online` / `pm2Delete` / `pm2Available`** — liveness, teardown, and a resolvable-pm2 probe (resolves pm2's JS entry under the current runtime; never the bare `pm2` shim).
- **`enablePm2LoginAutostart(name)` / `disablePm2LoginAutostart(name)`** — `pm2 save` + a hidden `HKCU\…\Run` entry running `pm2 resurrect` at login (no admin; works where Startup-folder writes and `schtasks /create` are blocked).
- **`normalizeTempEnv()`** — expands a literal `%USERPROFILE%\AppData\Local\Temp` left in `TEMP`/`TMP` (Windows `REG_EXPAND_SZ` passed through unexpanded), so temp writes don't litter the cwd. No-op off Windows.
- **`bindWithRetry(fn)`** — runs a `listen()`/`Bun.serve()` with exponential backoff on `EADDRINUSE`, so a daemon restart racing the old instance's port release self-heals.

## Develop

```bash
bun install
bun test
bun run build      # tsc -> dist/ (+ .d.ts)
```

## License

MIT
