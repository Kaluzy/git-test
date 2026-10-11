import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const scopes = new AsyncLocalStorage();

export class WorkerDeadlineError extends Error {
  constructor() {
    super('Worker deadline reached; durable work will continue on a later delivery.');
    this.name = 'WorkerDeadlineError';
    this.code = 'worker_deadline';
    this.retryAfterMs = 1000;
  }
}

/** Request-local cancellation. Never put a worker signal on a shared client. */
export function throwIfExpired() {
  const scope = scopes.getStore();
  if (!scope) return;
  if (scope.closed || performance.now() >= scope.expiresAt) scope.controller.abort(scope.error);
  if (scope.signal.aborted) throw scope.signal.reason ?? scope.error;
}

/** Milliseconds available for the next operation, capped by its own timeout. */
export function remainingMs(cap = Infinity) {
  if (!(cap >= 0) || (cap !== Infinity && !Number.isFinite(cap))) throw new TypeError('Invalid deadline cap');
  const scope = scopes.getStore();
  if (!scope) return cap;
  if (scope.closed || scope.signal.aborted) return 0;
  return Math.max(0, Math.min(cap, scope.expiresAt - performance.now()));
}

export function deadlineSignal(existing) {
  throwIfExpired();
  const scoped = scopes.getStore()?.signal;
  if (!scoped) return existing;
  if (!existing || existing === scoped) return scoped;
  return AbortSignal.any([existing, scoped]);
}

/** Bound an await even when an injected client ignores its abort signal. */
export async function awaitWithSignal(promise, signal) {
  const observed = Promise.resolve(promise);
  // Attach before cancellation checks: an already-started request may reject
  // after the scope has expired, and must not become an unhandled rejection.
  observed.catch(() => {});
  signal ??= deadlineSignal();
  throwIfExpired();
  signal?.throwIfAborted();
  if (!signal) return await observed;
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    const result = await Promise.race([observed, cancelled]);
    throwIfExpired();
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener('abort', listener); }
}

/**
 * The callback must await its work. Its context closes on return or timeout,
 * so a late provider response cannot start another ledger/provider operation.
 * A request already accepted remotely may still commit after cancellation;
 * the caller's durable mutation receipt remains necessary for reconciliation.
 */
export async function withDeadline(ms, fn) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647 || typeof fn !== 'function') throw new TypeError('Invalid worker deadline');
  throwIfExpired();
  const parent = scopes.getStore();
  const controller = new AbortController();
  const scope = {
    controller, error: new WorkerDeadlineError(), closed: false,
    expiresAt: Math.min(performance.now() + ms, parent?.expiresAt ?? Infinity),
    signal: parent ? AbortSignal.any([controller.signal, parent.signal]) : controller.signal,
  };
  const timer = setTimeout(() => controller.abort(scope.error), Math.max(1, Math.ceil(scope.expiresAt - performance.now())));
  try {
    return await scopes.run(scope, async () => {
      const work = Promise.resolve().then(() => { throwIfExpired(); return fn(); });
      return await awaitWithSignal(work, scope.signal);
    });
  } finally {
    clearTimeout(timer);
    scope.closed = true;
    controller.abort(scope.error);
  }
}
