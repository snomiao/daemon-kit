// @snomiao/daemon-kit — shared daemon helpers for codehost & agent-yes.
//
// Scope (the agreed cross-project boundary): this package owns the *daemon layer*
// only — pm2 process management, Windows hidden-launch, exponential restart
// backoff, login auto-start, TEMP/TMP normalization, and port-bind retry.
// Signaling/WebRTC stays in each project (different rooms/hosts), and each app
// keeps its own product surface (codehost = workspace/editor/provisioning,
// agent-yes = agent-execution/terminal/resize).

export { expandWinVars, normalizeTempEnv } from "./temp-env.js";
export { type DaemonSpec, pm2Available, pm2Delete, pm2Entry, pm2Online, pm2Start, quoteCmd } from "./pm2.js";
export { disablePm2LoginAutostart, enablePm2LoginAutostart } from "./login-autostart.js";
export { type BindRetryOptions, bindWithRetry } from "./port.js";
