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

  test("reclaim runs once after backoff exhausts, then a final bind succeeds", async () => {
    let calls = 0;
    let freed = 0;
    const result = await bindWithRetry(
      () => {
        calls++;
        if (freed === 0) throw eaddrinuse(); // held until reclaim runs
        return "bound";
      },
      {
        attempts: 3,
        sleep: noSleep,
        reclaim: {
          port: 7432,
          free: () => {
            freed++;
          },
        },
      },
    );
    expect(result).toBe("bound");
    expect(freed).toBe(1); // reclaimed exactly once
    expect(calls).toBe(4); // 3 normal attempts + 1 post-reclaim
  });

  test("reclaim is attempted only once; still-held re-throws", async () => {
    let calls = 0;
    let freed = 0;
    await expect(
      bindWithRetry(
        () => {
          calls++;
          throw eaddrinuse();
        },
        {
          attempts: 2,
          sleep: noSleep,
          reclaim: {
            port: 7432,
            free: () => {
              freed++;
            },
          },
        },
      ),
    ).rejects.toThrow("address in use");
    expect(freed).toBe(1); // one reclaim, no looping
    expect(calls).toBe(3); // 2 normal + 1 post-reclaim
  });

  test("no reclaim option → behaves exactly as before (no free hook)", async () => {
    let calls = 0;
    await expect(
      bindWithRetry(
        () => {
          calls++;
          throw eaddrinuse();
        },
        { attempts: 2, sleep: noSleep },
      ),
    ).rejects.toThrow("address in use");
    expect(calls).toBe(2);
  });
});
