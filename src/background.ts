/**
 * Lean in-process background work for one container: answer 200 first, then
 * keep processing the event in this process (no queue, no Redis, no new
 * infrastructure). A detached task that rejects reports through `onError`
 * (usually the structured logger) instead of crashing the process or
 * vanishing silently.
 *
 * Limits, stated plainly: in-flight work dies with the container (a deploy
 * mid-processing loses it — the SENDER's retry redelivers, which is why
 * every consumer must still dedupe), and two replicas would process the
 * same redelivery twice (dedupe is per-container). Reach for a real queue
 * when replicas or an outbound queue need shared state.
 */

const inFlight = new Set<Promise<unknown>>();

export interface DetachOptions {
  label: string;
  onError: (error: unknown) => void;
}

export function detach(promise: Promise<unknown>, options: DetachOptions): void {
  inFlight.add(promise);
  promise
    .catch((error: unknown) => {
      options.onError(error);
    })
    .finally(() => {
      inFlight.delete(promise);
    });
}

/** How many background tasks are currently running (health/debug only). */
export function backgroundTaskCount(): number {
  return inFlight.size;
}

/**
 * Jittered per-installation catch-up for one container:
 * iterate every stored installation and run `forInstallation` (a token
 * proof-call, a resync batch, an inbox poll — whatever the app needs
 * hourly), with:
 *
 * - one uniform `0–maxStartJitterMs` start sleep (default 600 s, matching
 *   the mint bucket's /600 divisor so N containers spread over ~10 min),
 * - per-installation error isolation (one failure never stops the run;
 *   failures are collected in the returned summary),
 * - at most `concurrency` installations in flight (default 2 — keep it ≤
 *   the store pool size; the Postgres store runs max 2),
 * - a 429 from `forInstallation` (a `QueekApiError` with `retryAfterMs`)
 *   honored once per installation (sleep, retry once), then recorded as a
 *   failure like any other error.
 *
 * Resolves to `{ ok, failed }` — it never throws for an installation's
 * failure (only `listInstallations()` itself failing throws, since there
 * is nothing to iterate).
 */

export interface CatchupInstallation {
  installationId: string;
  installationPid: string;
}

export interface CatchupFailure {
  installationId: string;
  error: unknown;
}

export interface CatchupResult {
  ok: string[];
  failed: CatchupFailure[];
}

export interface CatchupOptions {
  /** Installations to visit. Defaults to the store's `listInstallations()`. */
  installations?: CatchupInstallation[] | Promise<CatchupInstallation[]>;
  store?: import("./store.js").InstallationStore;
  forInstallation: (installation: CatchupInstallation) => Promise<void>;
  /** Uniform start-jitter ceiling in ms (default 600_000). Set 0 in tests. */
  maxStartJitterMs?: number;
  /** Max in-flight installations (default 2; keep ≤ pool size). */
  concurrency?: number;
  onError?: (failure: CatchupFailure) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable uniform [0,1) for jitter. Defaults to `Math.random`. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runInstallationCatchup(options: CatchupOptions): Promise<CatchupResult> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxStartJitterMs = options.maxStartJitterMs ?? 600_000;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));

  if (maxStartJitterMs > 0) {
    await sleep(Math.floor(random() * maxStartJitterMs));
  }

  const installations = options.installations ?? (await options.store?.listInstallations()) ?? [];
  const resolved = await installations;
  const result: CatchupResult = { ok: [], failed: [] };
  let next = 0;

  async function worker(): Promise<void> {
    while (next < resolved.length) {
      const installation = resolved[next] as CatchupInstallation;
      next += 1;
      try {
        try {
          await options.forInstallation(installation);
        } catch (error) {
          // Honor ONE 429 per installation (the server's Retry-After when
          // present, else a 1 s breather), then treat a repeat like any
          // other failure.
          const fields =
            error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
          if (fields?.isRateLimited === true) {
            const retryAfterMs = fields.retryAfterMs;
            await sleep(typeof retryAfterMs === "number" ? retryAfterMs : 1_000);
            await options.forInstallation(installation);
          } else {
            throw error;
          }
        }
        result.ok.push(installation.installationId);
      } catch (error) {
        const failure = { installationId: installation.installationId, error };
        result.failed.push(failure);
        options.onError?.(failure);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, resolved.length) }, () => worker()));
  return result;
}
