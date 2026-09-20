/**
 * `after` runs its callback once the response is on its way out.
 *
 * Deliberately not awaited, matching production: the webhook route answers the
 * provider first and does the work behind it, and the tests that care wait for
 * the write to land rather than for the request. What they wait on is
 * `afterSettled()` below rather than a sleep — the work is a `sell()` and a
 * send against a real database, and any fixed timeout is either too long for
 * every passing run or too short for one loaded one.
 */
const inFlight = new Set<Promise<unknown>>();

export function after(callback: () => unknown) {
  const work = Promise.resolve().then(callback).finally(() => {
    inFlight.delete(work);
  });
  inFlight.add(work);
}

/**
 * Resolves once every callback scheduled so far has finished, including any
 * scheduled by those callbacks in turn. A rejection is swallowed the way an
 * unawaited `after` swallows one — the test asserts on what was written, not
 * on this.
 */
export async function afterSettled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}
