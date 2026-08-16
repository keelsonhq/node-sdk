/**
 * Webhook replay and duplicate suppression by `svix-id`.
 *
 * Svix timestamp verification bounds replays to a ±5 minute window but does not
 * reject a *duplicate within that window*: the same signed delivery (same
 * `svix-id`) re-sent — a platform retry (delivery is at-least-once) or a
 * captured-payload replay — would otherwise reach the handler twice.
 *
 * The dispatch site runs a token-fenced three-state machine per `svix-id`:
 *
 *   reserve → handler → commit(token)   (on handler success)
 *   reserve → handler → release(token)  (on handler failure)
 *
 * `reserve` returns one of THREE states (never collapsing pending into completed):
 *
 * - `acquired`  — a fresh reservation (nothing prior, or the prior pending lease
 *   expired = crash takeover); the caller processes then commits/releases. It
 *   carries a `token` (generation) that fences `commit`/`release`.
 * - `pending`   — another attempt holds an un-expired pending reservation. The
 *   caller returns a **retryable 5xx** (never a 200 duplicate), so the platform
 *   keeps retrying until the in-flight attempt completes (→ deduped) or its lease
 *   expires (→ re-acquired). This is what makes crash recovery actually work.
 * - `completed` — already handled; the caller ACKs 200 without re-processing.
 *
 * `commit`/`release` take the `token` and are a compare-and-set: a stale attempt
 * (whose pending lease expired and was taken over by a newer attempt) can NOT
 * commit or release the newer attempt's reservation — a token mismatch is a no-op.
 *
 * Two backends:
 * - **Default (process-local):** a bounded, TTL'd in-memory state machine.
 *   Best-effort — a crash wipes it (so a post-crash retry re-processes) and it is
 *   not shared across instances.
 * - **Durable (pluggable):** {@link setIdempotencyStore}, backed by shared storage
 *   (the app's DB). `reserve` MUST be atomic, return the 3 states with a fencing
 *   token, expire a stale pending, and THROW on a backend error (so the dispatch
 *   site fails retryably instead of dropping the delivery).
 */

/** Result of {@link IdempotencyStore.reserve}. */
export type ReserveResult =
  | { status: "acquired"; token: string }
  | { status: "pending" }
  | { status: "completed" };

/**
 * Pluggable durable idempotency store (token-fenced reserve/commit/release).
 */
export interface IdempotencyStore {
  /**
   * Atomically resolve the reservation state for `id`. `acquired` (with a fencing
   * `token`) → process; `pending` → an un-expired reservation is in flight, the
   * caller returns a retryable 5xx; `completed` → duplicate, ACK 200. MUST throw
   * on a backend error (do not silently return `pending`/`completed`).
   */
  reserve(id: string): ReserveResult | Promise<ReserveResult>;
  /** Promote to COMPLETED iff `token` still owns the reservation (CAS; else no-op). */
  commit(id: string, token: string): void | Promise<void>;
  /** Remove the reservation iff `token` still owns it (CAS; else no-op). */
  release(id: string, token: string): void | Promise<void>;
}

/** Seconds a completed reservation is remembered — the Svix timestamp tolerance. */
const COMPLETED_TTL_SECONDS = 300;
/** Seconds a PENDING reservation is held before it is stale and re-acquirable. */
const PENDING_LEASE_SECONDS = 300;
/** Cap on remembered ids so a busy app cannot grow this unbounded. */
const MAX_ENTRIES = 10_000;

type Entry = { state: "pending" | "completed"; expiry: number; token: string };

const _seen = new Map<string, Entry>();
let _tokenCounter = 0;
let _store: IdempotencyStore | null = null;

/**
 * Install a durable idempotency store (or `null` to revert to the process-local
 * backend). Set this once at startup, before registering handlers.
 */
export function setIdempotencyStore(store: IdempotencyStore | null): void {
  _store = store;
}

function _prune(nowSec: number): void {
  for (const [id, entry] of _seen) {
    if (entry.expiry > nowSec) break; // insertion order ≈ expiry order (fixed TTLs)
    _seen.delete(id);
  }
}

function _reserveLocal(id: string, nowSec: number): ReserveResult {
  _prune(nowSec);
  const existing = _seen.get(id);
  if (existing !== undefined && existing.expiry > nowSec) {
    return existing.state === "completed" ? { status: "completed" } : { status: "pending" };
  }
  // No entry, or a stale pending whose lease expired → acquire (takeover).
  _seen.delete(id);
  const token = String(++_tokenCounter);
  _seen.set(id, {
    state: "pending",
    expiry: nowSec + PENDING_LEASE_SECONDS,
    token
  });
  if (_seen.size > MAX_ENTRIES) {
    const oldest = _seen.keys().next().value;
    if (oldest !== undefined) _seen.delete(oldest);
  }
  return { status: "acquired", token };
}

function _commitLocal(id: string, token: string, nowSec: number): void {
  const entry = _seen.get(id);
  if (entry === undefined || entry.token !== token) return; // CAS mismatch → no-op
  _seen.set(id, {
    state: "completed",
    expiry: nowSec + COMPLETED_TTL_SECONDS,
    token
  });
}

function _releaseLocal(id: string, token: string): void {
  const entry = _seen.get(id);
  if (entry === undefined || entry.token !== token) return; // CAS mismatch → no-op
  _seen.delete(id);
}

/**
 * Resolve the reservation state for a delivery id. Delegates to the configured
 * durable {@link IdempotencyStore} when set, else the process-local backend. May
 * reject if a durable store's backend errors.
 */
export async function reserveDelivery(
  id: string,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<ReserveResult> {
  if (_store) return await _store.reserve(id);
  return _reserveLocal(id, nowSec);
}

/** Promote a reservation to COMPLETED (CAS on `token`). */
export async function commitDelivery(
  id: string,
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<void> {
  if (_store) {
    await _store.commit(id, token);
    return;
  }
  _commitLocal(id, token, nowSec);
}

/** Release a reservation (CAS on `token`) so a failed delivery's retry re-processes. */
export async function releaseDelivery(id: string, token: string): Promise<void> {
  if (_store) {
    await _store.release(id, token);
    return;
  }
  _releaseLocal(id, token);
}

/** Test-only: clear the process-local reservations and the installed store. */
export function _resetDedup(): void {
  _seen.clear();
  _tokenCounter = 0;
  _store = null;
}
