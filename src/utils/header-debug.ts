/**
 * Header debug logger — writes per-request JSON files capturing the full
 * inbound (client→proxy) and outbound (proxy→z.ai) request headers so the
 * operator can verify the translation pipeline has no header defects.
 *
 * v0.2.0.9+.
 *
 * === DESIGN ===
 *
 * Trigger: only the FIRST fetch attempt per request is recorded. Retries and
 * captcha re-solve fetches call the same fetchUpstreamDetected() but pass
 * isInitialAttempt=false, so they skip the logger entirely. This keeps the
 * output one-file-per-request — essential for diffing "what changed between
 * what the client sent and what the proxy sent upstream".
 *
 * Output location:
 *   - $ZCODE_PROXY_HEADER_DEBUG_DIR if set (absolute path recommended)
 *   - else ./header-debug/ relative to process.cwd()
 * The directory is created lazily on first write (mkdir -p). Files are named
 * `{timestamp}_{reqId}.json` so they sort chronologically and never collide.
 *
 * File format: one JSON object per file (NOT JSONL — one file per request
 * makes it easy to open in a JSON viewer / diff tool). Structure:
 *   {
 *     "reqId": "...",
 *     "timestamp": "ISO-8601",
 *     "format": "anthropic" | "openai" | "openai-responses",
 *     "inbound": {
 *       "method": "POST",
 *       "url": "/v1/messages",
 *       "headers": { "content-type": "...", "authorization": "Bearer ***", ... }
 *     },
 *     "upstream": {
 *       "method": "POST",
 *       "url": "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
 *       "headers": { "user-agent": "ZCode/3.1.8", "authorization": "Bearer abc12345...wxyz", ... },
 *       "bodyPreview": "... first 16KB of transformed body ..."
 *     }
 *   }
 *
 * Security:
 *   - Inbound `authorization` / `x-api-key` are masked (first-8...last-4) —
 *     the inbound key is the PROXY key, not the upstream key, but masking
 *     is still good hygiene in case the client sent something sensitive.
 *   - Upstream `authorization` is masked the same way — the upstream key IS
 *     sensitive, but we need enough of it to verify "did we send the right
 *     credential?". first-8...last-4 lets you identify which stored account
 *     was used without exposing the full secret on disk.
 *   - The output dir should be treated as sensitive; clear it with
 *     `rm -rf header-debug/` when done debugging.
 *
 * Performance:
 *   - All file I/O is async (atomicWriteFile) and fire-and-forget — the
 *     request path never awaits or blocks on debug logging.
 *   - The dir is created once (memoized), not per-write.
 *   - When headerDebug is disabled (the default), recordHeaders is a no-op
 *     checked at the call site, so there's zero overhead in normal operation.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "./fs.js";

/** Resolved output directory. Memoized so we only stat/mkdir once per process. */
let _debugDirPromise: Promise<string> | null = null;

/**
 * Resolve and create (if needed) the header-debug output directory.
 * Memoized — the first caller triggers mkdir, subsequent callers reuse.
 *
 * Resolution order:
 *   1. $ZCODE_PROXY_HEADER_DEBUG_DIR (absolute path, operator-controlled)
 *   2. ./header-debug/ relative to process.cwd() (the "project folder"
 *      location the user asked for — sits alongside config.yaml, src/, etc.)
 */
function getDebugDir(): Promise<string> {
  if (_debugDirPromise) return _debugDirPromise;
  _debugDirPromise = (async () => {
    const dir = process.env.ZCODE_PROXY_HEADER_DEBUG_DIR
      ? resolve(process.env.ZCODE_PROXY_HEADER_DEBUG_DIR)
      : join(process.cwd(), "header-debug");
    // mkdir -p, ignore EEXIST. recursive=true handles nested paths.
    await mkdir(dir, { recursive: true });
    return dir;
  })();
  return _debugDirPromise;
}

/** Allow tests to reset the memoized dir promise (e.g. to change the env). */
export function _resetHeaderDebugDirCacheForTesting(): void {
  _debugDirPromise = null;
}

/**
 * Mask a sensitive header value for logging: keep first 8 + last 4 chars,
 * replace the middle with "...". Short values (<=12 chars) are fully masked
 * as "***" so we never leak a short token in full.
 *
 * Examples:
 *   "sk-abc1234567890wxyz" → "sk-abc12...wxyz"
 *   "short"                → "***"
 *   ""                     → ""
 */
function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return "***";
  return value.slice(0, 8) + "..." + value.slice(-4);
}

/** Header names whose values are secrets — masked in both inbound + upstream. */
const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "cookie",
]);

/**
 * Convert a Headers object into a plain Record<string, string>, masking
 * sensitive values. Header names are lowercased for consistent diffing.
 */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    if (SECRET_HEADER_NAMES.has(k.toLowerCase())) {
      out[k] = maskSecret(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Max bytes of the transformed request body to include in the debug file. */
const MAX_BODY_PREVIEW_BYTES = 16 * 1024;

export interface HeaderDebugRecord {
  reqId: string;
  timestamp: string;
  format: string;
  inbound: {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  upstream: {
    method: string;
    url: string;
    headers: Record<string, string>;
    bodyPreview?: string;
  };
}

/**
 * Write a header debug record to disk as a JSON file.
 *
 * Fire-and-forget: returns void, never throws — debug logging must never
 * break a request. All errors are caught and logged to console.warn.
 *
 * @param inboundReq  The original client Request (as received by the proxy).
 * @param upstreamReq The translated Request built by buildUpstreamRequest()
 *                    (what actually goes on the wire to z.ai).
 * @param reqId       The proxy's internal request id (for correlation with
 *                    the dashboard log panel).
 * @param format      The inbound format ("anthropic" | "openai" | "openai-responses").
 * @param transformedBody The translated body string sent upstream (optional —
 *                    included as a preview so the operator can verify body
 *                    transformation alongside header transformation).
 */
export function recordHeaders(
  inboundReq: Request,
  upstreamReq: Request,
  reqId: string,
  format: string,
  transformedBody?: string,
): void {
  // Fire-and-forget — never let disk I/O or errors block the request path.
  void (async () => {
    try {
      const dir = await getDebugDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${timestamp}_${reqId}.json`;
      const filepath = join(dir, filename);

      const record: HeaderDebugRecord = {
        reqId,
        timestamp: new Date().toISOString(),
        format,
        inbound: {
          method: inboundReq.method,
          url: inboundReq.url,
          headers: headersToRecord(inboundReq.headers),
        },
        upstream: {
          method: upstreamReq.method,
          url: upstreamReq.url,
          headers: headersToRecord(upstreamReq.headers),
          ...(transformedBody
            ? {
                bodyPreview: transformedBody.length > MAX_BODY_PREVIEW_BYTES
                  ? transformedBody.slice(0, MAX_BODY_PREVIEW_BYTES) +
                    `...(truncated, total ${transformedBody.length} chars)`
                  : transformedBody,
              }
            : {}),
        },
      };

      // atomicWriteFile: write to temp then rename. Safe against partial writes
      // if the process crashes mid-debug-log. JSON.stringify with 2-space indent
      // for readability in a text editor / diff tool.
      await atomicWriteFile(filepath, JSON.stringify(record, null, 2) + "\n", "utf-8");
    } catch (err) {
      // Never throw — debug logging is best-effort. Surface to console so the
      // operator notices if the debug dir is unwritable, but keep the request
      // flowing.
      console.warn(`[header-debug] failed to write record for ${reqId}: ${(err as Error).message}`);
    }
  })();
}
