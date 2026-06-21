import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pm2Entry, quoteCmd } from "./pm2.js";

// Windows login auto-start for pm2-managed daemons. pm2 core has no Windows
// startup integration (`pm2 startup` errors "Init system not found"), so we
// persist the process list and add a per-user HKCU\…\Run entry that runs
// `pm2 resurrect` *hidden* at login. No admin required; fully reversible.
//
// Note: on a locked-down host where Controlled Folder Access blocks Startup-menu
// writes and `schtasks /create` needs elevation, this HKCU Run approach is the
// one mechanism that still works without elevation.

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function launcherDir(custom?: string): string {
  return custom ?? join(homedir(), ".daemon-kit", "launchers");
}

/**
 * Enable login auto-start: `pm2 save` then a hidden HKCU Run entry that runs
 * `pm2 resurrect` at login. `valueName` is the Run value (use a per-tool name,
 * e.g. "codehost" / "agent-yes"). Returns true on success; no-op off Windows.
 */
export function enablePm2LoginAutostart(valueName: string, dir?: string): boolean {
  if (process.platform !== "win32") return false;
  const entry = pm2Entry();
  if (!entry) return false;

  // Persist the current process list so `pm2 resurrect` has something to restore.
  if (spawnSync(process.execPath, [entry, "save", "--force"], { windowsHide: true }).status !== 0) return false;

  const d = launcherDir(dir);
  mkdirSync(d, { recursive: true });
  const cmdPath = join(d, `${valueName}-resurrect.cmd`);
  const vbsPath = join(d, `${valueName}-resurrect.vbs`);
  writeFileSync(cmdPath, `@echo off\r\n${quoteCmd([process.execPath, entry, "resurrect"])}\r\n`);
  // Fire-and-forget (no wait) hidden launcher; `"""<path>"""` is a quoted path in VBS.
  writeFileSync(vbsPath, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${cmdPath}""", 0, False\r\n`);

  const data = `wscript //B //Nologo "${vbsPath}"`;
  return spawnSync("reg", ["add", RUN_KEY, "/v", valueName, "/t", "REG_SZ", "/d", data, "/f"], { windowsHide: true })
    .status === 0;
}

/** Remove the login auto-start Run entry. Returns true if removed (or absent). */
export function disablePm2LoginAutostart(valueName: string): boolean {
  if (process.platform !== "win32") return false;
  const r = spawnSync("reg", ["delete", RUN_KEY, "/v", valueName, "/f"], { windowsHide: true });
  return r.status === 0 || /cannot find/i.test(String(r.stderr ?? ""));
}
