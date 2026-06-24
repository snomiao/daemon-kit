import { describe, expect, test } from "bun:test";
import { bindWithRetry, freeStalePort } from "./port.js";

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

describe("freeStalePort", () => {
  const noSleep = async () => {};

  test("phase 2 stops once the port frees — a loose signature spares the rest", async () => {
    const killed: number[] = [];
    // Real holder is the SECOND match; killing it frees the port. A loose
    // signature also matched 111 (before) and 333 (after). listeners reports the
    // DEAD owner pid (9999) until the real holder (42) is killed.
    const held = new Set([42]);
    await freeStalePort(7432, "ay serve", {
      listeners: () => (held.size ? [9999] : []),
      candidates: () => [111, 42, 333],
      kill: (pid) => {
        killed.push(pid);
        held.delete(pid); // only killing the holder (42) empties `held`
      },
      sleep: noSleep,
    });
    expect(killed).toContain(42); // the real holder is killed (frees the port)
    expect(killed).not.toContain(333); // …and we STOP — the later match is spared
  });

  test("kills only the real holder (plus the dead owner) when it matches first", async () => {
    const killed: number[] = [];
    const held = new Set([42]);
    await freeStalePort(7432, "ay serve", {
      listeners: () => (held.size ? [9999] : []),
      candidates: () => [42, 111, 222],
      kill: (pid) => {
        killed.push(pid);
        held.delete(pid);
      },
      sleep: noSleep,
    });
    expect(killed).toContain(42); // freed on the first candidate…
    expect(killed).not.toContain(111); // …so the rest are untouched
    expect(killed).not.toContain(222);
  });

  test("skips phase 2 entirely when phase 1 already freed the port", async () => {
    const killed: number[] = [];
    let phase1Owner = [123];
    let candidatesCalled = false;
    await freeStalePort(7432, "ay serve", {
      listeners: () => phase1Owner,
      candidates: () => {
        candidatesCalled = true;
        return [999];
      },
      kill: (pid) => {
        killed.push(pid);
        phase1Owner = []; // phase 1's kill frees it
      },
      sleep: noSleep,
    });
    expect(killed).toEqual([123]); // only the phase-1 owner
    expect(candidatesCalled).toBe(false); // signature path never engaged
  });

  test("no signature → phase 1 only (live owner), no command-line matching", async () => {
    const killed: number[] = [];
    let owner = [55];
    await freeStalePort(7432, undefined, {
      listeners: () => owner,
      candidates: () => {
        throw new Error("should not be called without a signature");
      },
      kill: (pid) => {
        killed.push(pid);
        owner = [];
      },
      sleep: noSleep,
    });
    expect(killed).toEqual([55]);
  });
});
