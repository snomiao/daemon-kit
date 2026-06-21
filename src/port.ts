// Retry a port bind that races a stale instance's release.
//
// A daemon restart can race the previous instance's port release (TIME_WAIT /
// slow shutdown), so a single listen() throws EADDRINUSE and the daemon exits
// straight into another restart. Wrapping the bind in backoff lets the restart
// self-heal; combined with pm2 exp-backoff, a transient clash never storms.

export interface BindRetryOptions {
  /** Max attempts before giving up. Default 6 (~5.75s of total backoff). */
  attempts?: number;
  /** First backoff delay in ms; doubles each retry. Default 250. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 2000. */
  maxDelayMs?: number;
  /** Injectable sleep (for tests). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `bind` (which throws `EADDRINUSE` while a stale instance still holds the
 * port) with exponential backoff. Non-EADDRINUSE errors re-throw immediately; the
 * last EADDRINUSE re-throws after attempts are exhausted.
 */
export async function bindWithRetry<T>(bind: () => T | Promise<T>, opts: BindRetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 2000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await bind();
    } catch (e) {
      const inUse = (e as { code?: string } | null)?.code === "EADDRINUSE";
      if (inUse && attempt < attempts - 1) {
        await sleep(Math.min(max, base * 2 ** attempt));
        continue;
      }
      throw e;
    }
  }
}
