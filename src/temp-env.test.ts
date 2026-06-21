import { describe, expect, test } from "bun:test";
import { expandWinVars, normalizeTempEnv } from "./temp-env.js";

describe("expandWinVars", () => {
  test("expands a known %VAR% from the given env", () => {
    expect(expandWinVars("%USERPROFILE%\\AppData\\Local\\Temp", { USERPROFILE: "C:\\Users\\x" })).toBe(
      "C:\\Users\\x\\AppData\\Local\\Temp",
    );
  });

  test("leaves unknown vars untouched", () => {
    expect(expandWinVars("%NOPE%\\a", {})).toBe("%NOPE%\\a");
  });

  test("passes through a path with no vars", () => {
    expect(expandWinVars("C:\\Users\\x\\Temp", {})).toBe("C:\\Users\\x\\Temp");
  });
});

describe("normalizeTempEnv", () => {
  test("rewrites a literal %USERPROFILE% TEMP to a real path (win32)", () => {
    if (process.platform !== "win32") return; // no-op off Windows
    const saved = process.env.TEMP;
    try {
      process.env.TEMP = "%USERPROFILE%\\AppData\\Local\\Temp";
      normalizeTempEnv();
      expect(process.env.TEMP).not.toContain("%");
    } finally {
      process.env.TEMP = saved;
    }
  });

  test("is a no-op when TEMP is already expanded", () => {
    if (process.platform !== "win32") return;
    const saved = process.env.TEMP;
    try {
      process.env.TEMP = "C:\\Users\\x\\AppData\\Local\\Temp";
      expect(normalizeTempEnv()).not.toContain("TEMP");
    } finally {
      process.env.TEMP = saved;
    }
  });
});
