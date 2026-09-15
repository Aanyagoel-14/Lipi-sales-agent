/**
 * `after` runs its callback once the response is on its way out.
 *
 * Deliberately not awaited, matching production: the webhook route answers the
 * provider first and does the work behind it, and the tests that care wait for
 * the write to land rather than for the request.
 */
export function after(callback: () => unknown) {
  void Promise.resolve().then(callback);
}
