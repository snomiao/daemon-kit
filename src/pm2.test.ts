import { describe, expect, test } from "bun:test";
import { quoteCmd } from "./pm2.js";

describe("quoteCmd", () => {
  test("quotes args containing spaces or shell metachars", () => {
    expect(quoteCmd(["bun.exe", "C:\\Program Files\\app\\x.js", "serve"])).toBe(
      'bun.exe "C:\\Program Files\\app\\x.js" serve',
    );
  });

  test("leaves simple args unquoted", () => {
    expect(quoteCmd(["pm2", "start", "--name", "agent-yes"])).toBe("pm2 start --name agent-yes");
  });
});
