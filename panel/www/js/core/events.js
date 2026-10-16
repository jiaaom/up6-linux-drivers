// A tiny publish/subscribe hub.

export function emitter() {
  const subs = new Set();
  return {
    /** Subscribe; returns an unsubscribe function. */
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(...args) { for (const fn of [...subs]) fn(...args); },
  };
}
