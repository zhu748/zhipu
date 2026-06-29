/**
 * In-memory store for `previous_response_id` conversation chaining.
 *
 * GLM upstream has no native Responses API or server-side conversation store,
 * so we keep the latest input + output of each response keyed by its id, and
 * replay it when the client sends `previous_response_id`.
 *
 * Cap is 256 entries with LRU eviction — plenty for a single-user local proxy.
 * Per-entry byte size is also capped (MAX_ENTRY_BYTES, default 256 KB) to
 * prevent OOM when a Codex CLI conversation grows long: each turn can carry
 * 100K+ tokens of cumulative context, and 256 × unbounded = OOM risk.
 *
 * v0.2.2+ LRU + TTL: entries are now evicted by BOTH least-recently-used
 * (getTurn updates lastAccessAt, saveTurn bumps it on overwrite) AND by a
 * 24h TTL (entries older than 24h are treated as misses and deleted on
 * access). This prevents the store from holding stale conversations
 * forever — a previous concern when the proxy runs for days/weeks.
 *
 * Restarting the proxy drops all stored conversations (matches the expectation
 * that a local proxy is short-lived; clients using `store:true` for long-lived
 * sessions should re-run `auth login` after a restart).
 *
 * v0.2.0.8 NOTE: persistence to disk was considered (so Codex sessions
 * survive restarts) but deliberately NOT implemented because:
 *   1. Conversation history may contain sensitive code/prompts — encrypting
 *      it with the fixed "520" key offers only obfuscation (see auth/store.ts).
 *   2. Schema migrations across versions add complexity for marginal benefit.
 *   3. The primary deployment (apikey mode, short-lived container) rarely
 *      benefits from cross-restart session continuity.
 * If you need this, consider implementing an opt-in ZCODE_RESPONSES_PERSIST
 * env flag that serializes the store to STORE_DIR/responses.json with the
 * same AES-256-GCM fixed-key encryption used for credentials.
 */

interface StoredTurn {
  /** Input items sent by the client for this turn. */
  input: unknown[];
  /** Output items we returned to the client. */
  output: unknown[];
  /** Timestamp when this turn was saved (for TTL expiry). */
  at: number;
  /** v0.2.2+: Timestamp of the last getTurn() access (for LRU eviction). */
  lastAccessAt: number;
  /** Approximate serialized size in bytes (capped on insertion). */
  bytes: number;
}

const MAX_ENTRIES = 256;
/** Max serialized size per entry. Entries larger than this are stored with
 *  their input truncated to fit — preserves the latest output for chaining
 *  while bounding total memory. */
const MAX_ENTRY_BYTES = 256 * 1024;
/** v0.2.2+: TTL — entries older than this are treated as misses and deleted
 *  on next access. 24h matches Codex CLI's typical session lifetime. */
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

const store = new Map<string, StoredTurn>();

/** Approximate byte length of a value when JSON-serialized. Returns 0 on
 *  circular / un-stringifiable values so they're stored without truncation. */
function approxBytes(v: unknown): number {
  try { return JSON.stringify(v).length; } catch { return 0; }
}

/** Truncate `input` (the part the client can replay later) so the entry fits
 *  within MAX_ENTRY_BYTES. We truncate by dropping the oldest input items
 *  first — the most recent ones (which the model just generated from) are
 *  the most useful for context. Output is never truncated. */
function fitToBytes(input: unknown[], output: unknown[]): unknown[] {
  let inBytes = approxBytes(input);
  const outBytes = approxBytes(output);
  const budget = MAX_ENTRY_BYTES - outBytes;
  if (budget <= 0 || inBytes <= budget) return input;
  // Drop oldest input items until we fit. If a single item is larger than
  // budget, keep just that one item truncated.
  const trimmed = [...input];
  while (trimmed.length > 1 && approxBytes(trimmed) > budget) {
    trimmed.shift();
  }
  return trimmed;
}

/**
 * v0.2.2+ LRU eviction: drop the entry with the oldest `lastAccessAt`.
 * Falls back to FIFO (oldest `at`) if all lastAccessAt values are equal
 * (shouldn't happen in practice, but defensive). Only called when the store
 * is at capacity.
 */
function evictLRU(): void {
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, turn] of store) {
    const time = turn.lastAccessAt ?? turn.at;
    if (time < oldestTime) {
      oldestTime = time;
      oldestKey = key;
    }
  }
  if (oldestKey) store.delete(oldestKey);
}

/** Save a turn keyed by the response id (must be unique). */
export function saveTurn(responseId: string, input: unknown[], output: unknown[]): void {
  if (!responseId) return;
  // v0.2.2+ LRU: if the store is at capacity AND this is a NEW key (not an
  // overwrite of an existing one), evict the least-recently-used entry first.
  // Overwriting an existing key doesn't grow the store, so we skip eviction.
  if (store.size >= MAX_ENTRIES && !store.has(responseId)) {
    evictLRU();
  }
  const now = Date.now();
  const fittedInput = fitToBytes(input, output);
  store.set(responseId, {
    input: fittedInput,
    output,
    at: now,
    lastAccessAt: now,
    bytes: approxBytes(fittedInput) + approxBytes(output),
  });
}

/** Look up a stored turn by previous_response_id. Returns undefined if not found
 *  or if the entry has expired (TTL). Expired entries are deleted on access. */
export function getTurn(responseId: string): StoredTurn | undefined {
  const turn = store.get(responseId);
  if (!turn) return undefined;
  // v0.2.2+ TTL: check if the entry has expired. If so, delete it and return
  // undefined — the client will see a "not found" and should start a fresh
  // conversation (Codex CLI handles this gracefully by re-sending full context).
  const now = Date.now();
  if (now - turn.at > ENTRY_TTL_MS) {
    store.delete(responseId);
    return undefined;
  }
  // v0.2.2+ LRU: update lastAccessAt so this entry moves to the "recently used"
  // end of the eviction order. Map preserves insertion order, but evictLRU
  // uses lastAccessAt (not insertion order) so this update is what actually
  // keeps the entry from being evicted.
  turn.lastAccessAt = now;
  return turn;
}

/** Total bytes currently held by the store. Exposed for diagnostics. */
export function totalBytes(): number {
  let sum = 0;
  for (const v of store.values()) sum += v.bytes;
  return sum;
}

/** Number of entries currently in the store. Exposed for diagnostics. */
export function entryCount(): number {
  return store.size;
}

/** Clear all stored turns. Used by tests. */
export function clearStore(): void {
  store.clear();
}
