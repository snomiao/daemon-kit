import { describe, expect, test } from "bun:test";
import { bindWithRetry } from "./port.js";

const eaddrinuse = () => Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
const noSleep = async () => {};

describe("bindWithRetry", () => {
  test("retries EADDRINUSE then succeeds", async () => {
    let calls = 0;
    const result = await bindWithRetry(
      () => {
        calls++;
        if (calls < 3) throw eaddrinuse();
        return "bound";
      },
      { sleep: noSleep },
    );
    expect(result).toBe("bound");
    expect(calls).toBe(3);
  });

  test("re-throws EADDRINUSE after exhausting attempts", async () => {
    let calls = 0;
    await expect(
      bindWithRetry(
        () => {
          calls++;
          throw eaddrinuse();
        },
        { attempts: 4, sleep: noSleep },
      ),
    ).rejects.toThrow("address in use");
    expect(calls).toBe(4);
  });

  test("re-throws a non-EADDRINUSE error immediately", async () => {
    let calls = 0;
    await expect(
      bindWithRetry(
        () => {
          calls++;
          throw new Error("boom");
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
