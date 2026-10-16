// Requests to t6-paneld. Paths are relative ("api/…"), so the same UI works
// on the kiosk's local surface (/) and behind the fnOS gateway (/app/t6-panel/).

import { emitter } from './events.js';

const TIMEOUT_MS = 8000;
// a proxy in front of t6-paneld (the fnOS gateway) answers these when the backend is down
const GATEWAY_DOWN = new Set([502, 503, 504]);

export class ApiError extends Error {
  /** status 0 = the backend did not answer at all. */
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
  get unreachable() { return this.status === 0; }
  get aborted() { return this.status === -1; }
}

/** Fires on every request that got no answer, so the backend monitor can check sooner. */
export const noAnswer = emitter();

/**
 * timeout: ms, or 0 for none (a long count the person can cancel instead).
 * signal: an AbortSignal to drop the request; it then rejects with ApiError
 * status -1 (`.aborted`), which callers ignore.
 */
export async function request(path, { method = 'GET', body, timeout = TIMEOUT_MS, signal } = {}) {
  const ctl = new AbortController();
  const timer = timeout ? setTimeout(() => ctl.abort(), timeout) : 0;
  signal?.addEventListener('abort', () => ctl.abort(), { once: true });
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method,
      cache: 'no-store',
      signal: ctl.signal,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    if (signal?.aborted) throw new ApiError(-1, 'cancelled');
    noAnswer.emit();
    throw new ApiError(0, 'no answer');
  } finally {
    clearTimeout(timer);
  }
  if (GATEWAY_DOWN.has(res.status)) {
    noAnswer.emit();
    throw new ApiError(0, 'no answer');
  }
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain-text error body */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || text || res.statusText, data);
  return data;
}

export const api = {
  get: (path, opts) => request(path, opts),
  put: (path, body) => request(path, { method: 'PUT', body }),
  post: (path, body) => request(path, { method: 'POST', body }),
  del: (path, body) => request(path, { method: 'DELETE', body }),
};
