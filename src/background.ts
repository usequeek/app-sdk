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
