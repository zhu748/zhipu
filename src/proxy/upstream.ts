/**
 * Upstream request builder — constructs the forwarded HTTP request.
 *
 * **`format` semantics**: This is the *upstream* format — the format used to
 * talk to the upstream LLM provider, not the client's inbound format. When
 * `handler.ts` translates an OpenAI client request to Anthropic upstream in
 * coding-plan mode, it passes `"anthropic"` here even though the client
 * originally spoke OpenAI. The route's format is tracked separately in
 * `handler.ts` for response translation decisions.
 *
 * === HEADER FINGERPRINT ALIGNMENT (2026-06 WAF fix) ===
 *
 * Real ZCode client (reverse-engineered) sends:
 *   - User-Agent: ai-sdk/anthropic/3.0.81   (Vercel AI SDK, NOT ZCode/x.y.z)
 *   - Accept: text/event-stream              (always, even for non-stream)
 *   - x-request-id: <uuid>                   (fresh per request)
 *   - x-zcode-trace-id: <uuid>               (fresh per request)
 *   - x-session-id: <uuid>                   (STABLE within a session)
 *   - x-query-id: <uuid>                     (fresh per query, NO "query_" prefix)
 *   - NO X-ZCode-App-Version / X-Title / X-ZCode-Agent / HTTP-Referer
 *   - NO anthropic-beta unless explicitly needed
 *
 * Session ID stability is critical: real ZCode generates ONE session ID when
 * the Electron app starts and reuses it for the entire app lifecycle. The
 * previous implementation generated a fresh session ID per fetch (including
 * retries) — a clear WAF fingerprint. We now cache session IDs per client
 * (keyed on client IP + proxy API key) with a 30-minute TTL.
 *
 * @see _reverse/NOTEPAD.md "Real ZCode Request Headers (2026-06)"
 */
import type { Format } from "../translator/types.js";
import type { ProviderDef } from "../provider/types.js";
import type { Credential } from "../auth/types.js";
import type { ProxyIdentity } from "../config/types.js";
import { credentialString } from "../auth/types.js";
import { buildIdentityHeaders } from "./identity.js";

const ANTHROPIC_VERSION = "2023-06-01";

const STARTPLAN_ANTHROPIC_BASE = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

const STRIP_HEADERS = new Set([
  "host",
  "authorization",
  "x-api-key",
  "anthropic-version",
  // NOTE: anthropic-beta is NOT in this set — it's handled separately below
  // (filtered to keep only claude-code-* flags, matching the real ZCode
  // client behavior).
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "transfer-encoding",
  "x-request-id",
  "x-zcode-trace-id",
  "x-query-id",
  "x-session-id",
  // Strip client-side SDK headers that would leak the proxy's true identity.
  // Real ZCode only sends ai-sdk/anthropic UA — anything else here is a
  // fingerprint. Also strip Vercel AI SDK headers from inbound requests
  // (Cherry Studio / Codex CLI send these) so we don't double-inject.
  "user-agent",
  "accept",
  "accept-language",
  "accept-encoding",
  "origin",
  "referer",
  "http-referer",
  "x-title",
  "x-zcode-agent",
  "x-zcode-app-version",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
]);

// ---------------------------------------------------------------------------
// Session ID cache — keyed on client fingerprint (IP + proxy API key).
//
// Real ZCode generates one session-id when the Electron app starts and
// reuses it for the entire app lifecycle (hours/days). The previous
// implementation generated a fresh session-id per fetch, which is a strong
// WAF fingerprint — no real client would spawn hundreds of sessions in
// minutes.
//
// We cache per client fingerprint so each distinct downstream client gets
// its own stable session ID, mimicking "one ZCode app instance per client".
// 30-minute TTL mirrors typical Electron app session length.
// ---------------------------------------------------------------------------

interface SessionCacheEntry {
  sessionId: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const sessionCache = new Map<string, SessionCacheEntry>();

// Cap the cache to prevent unbounded growth under proxy rotation / NAT pools.
const SESSION_CACHE_MAX = 1024;

function getSessionId(clientFingerprint: string): string {
  const now = Date.now();
  const existing = sessionCache.get(clientFingerprint);
  if (existing && existing.expiresAt > now) {
    // Refresh TTL on hit — active sessions shouldn't expire mid-use.
    existing.expiresAt = now + SESSION_TTL_MS;
    return existing.sessionId;
  }
  // Evict expired entries if cache is full.
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    for (const [k, v] of sessionCache) {
      if (v.expiresAt <= now) sessionCache.delete(k);
    }
    // If still full after eviction, drop the oldest 10%.
    if (sessionCache.size >= SESSION_CACHE_MAX) {
      const entries = [...sessionCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      const dropCount = Math.ceil(SESSION_CACHE_MAX * 0.1);
      for (let i = 0; i < dropCount; i++) sessionCache.delete(entries[i][0]);
    }
  }
  const newId = crypto.randomUUID();
  sessionCache.set(clientFingerprint, { sessionId: newId, expiresAt: now + SESSION_TTL_MS });
  return newId;
}

/**
 * Derive a stable client fingerprint from the inbound request.
 *
 * vceshi0.0.8+ SECURITY: previously this read X-Forwarded-For unconditionally,
 * which meant any client could spoof XFF to share/pollute another user's
 * upstream session ID — potentially causing cross-user session stickiness on
 * the upstream WAF. Now the fingerprint uses:
 *   1. The TCP socket peer address (via resolveClientIp, wired to Bun's
 *      server.requestIP) — un-spoofable, the default in production.
 *   2. X-Forwarded-For / X-Real-IP ONLY when the operator has explicitly
 *      opted in via `config.server.trustProxy = true` (because the proxy
 *      is behind a trusted reverse proxy).
 *   3. The empty string when neither is available (e.g., tests with no
 *      socket and no trustProxy). Combined with the auth header slice,
 *      this still produces a per-user-stable fingerprint.
 *
 * The auth header (Authorization / x-api-key) is always included so that
 * two different proxy users on the same IP don't share a session.
 */
function clientFingerprint(
  req: Request,
  resolveClientIp?: (req: Request) => string | undefined,
  trustProxy?: boolean,
): string {
  let ip = "";
  if (resolveClientIp) {
    try { ip = resolveClientIp(req) ?? ""; } catch { /* ignore */ }
  }
  if (!ip && trustProxy) {
    // Only fall back to XFF when the operator has explicitly trusted it.
    const xRealIp = req.headers.get("x-real-ip");
    if (xRealIp) {
      ip = xRealIp;
    } else {
      const xff = req.headers.get("x-forwarded-for");
      if (xff) ip = xff.split(",")[0].trim();
    }
  }
  const auth = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
  return `${ip}::${auth.slice(0, 32)}`;
}

/**
 * Build the upstream URL based on format + plan + provider.
 *
 * The `format` parameter is the *upstream* format — callers in handler.ts
 * pass the format the upstream will receive, which may differ from the
 * client's inbound format when the proxy is in translation mode.
 */
export function buildUpstreamURL(format: Format, provider: ProviderDef, plan: "coding-plan" | "start-plan" = "coding-plan"): string {
  if (plan === "start-plan") {
    return `${STARTPLAN_ANTHROPIC_BASE}/v1/messages`;
  }
  if (format === "anthropic") {
    return `${provider.anthropicBaseURL}/v1/messages`;
  }
  return `${provider.openaiBaseURL}/chat/completions`;
}

/**
 * Build auth + identity + trace headers for the upstream request.
 *
 * The `format` parameter is the *upstream* format — selects auth scheme
 * (`x-api-key` + `anthropic-version` for Anthropic upstream, `Authorization:
 * Bearer` for OpenAI upstream). See module header for translation semantics.
 *
 * `clientFingerprintStr` is the stable client fingerprint — used to look up
 * (or create) the stable session ID. Caller must derive it from the inbound
 * request via `clientFingerprint(req)`.
 */
export function buildAuthHeaders(
  format: Format,
  cred: Credential,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  clientFingerprintStr?: string,
): Record<string, string> {
  const credStr = plan === "start-plan" && cred.jwt ? cred.jwt : credentialString(cred);
  const base: Record<string, string> = {
    ...buildIdentityHeaders(identity),
    // Accept: text/event-stream — real ZCode client ALWAYS sends this,
    // even for non-stream requests. Missing it is a fingerprint.
    "accept": "text/event-stream",
    // x-request-id / x-zcode-trace-id: fresh UUID per request (real client
    // behavior — these are per-request tracing IDs).
    "x-request-id": crypto.randomUUID(),
    "x-zcode-trace-id": crypto.randomUUID(),
    // x-session-id: STABLE within a client session. Real ZCode reuses one
    // session ID for the entire Electron app lifecycle. We cache per client
    // fingerprint for 30 minutes. Falls back to a fresh UUID if no
    // fingerprint is provided (test paths).
    "x-session-id": clientFingerprintStr ? getSessionId(clientFingerprintStr) : crypto.randomUUID(),
    // x-query-id: fresh UUID per request, NO "query_" prefix. The previous
    // implementation prepended "query_" — real ZCode sends a bare UUID.
    "x-query-id": crypto.randomUUID(),
  };

  if (format === "anthropic") {
    if (plan === "start-plan" && cred.jwt) {
      base["authorization"] = `Bearer ${cred.jwt}`;
    } else {
      base["x-api-key"] = credStr;
    }
    base["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    base["authorization"] = `Bearer ${credStr}`;
  }

  return base;
}

function collectPassthroughHeaders(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    // STRIP_HEADERS now includes ALL identity / SDK / trace headers — we
    // rebuild them from scratch in buildAuthHeaders to ensure they match
    // the real ZCode client exactly. The only headers we passthrough are
    // genuinely unknown ones (rare in practice).
    if (STRIP_HEADERS.has(lower)) continue;
    // Content-Type is set explicitly below; don't passthrough a potentially
    // wrong value from the client.
    if (lower === "content-type") continue;
    if (lower === "anthropic-beta") {
      // Filter out beta flags that correspond to features we strip from the
      // request body. ZCode's start-plan gateway validates that the body
      // matches what the beta flags declare — if we strip context_management
      // from the body but leave the flag in the header, the gateway 3001s.
      //
      // Flags we strip (because we strip the corresponding body field):
      //   - context-management-*        → we delete body.context_management
      //   - effort-*                    → we delete body.output_config
      //   - interleaved-thinking-*      → we strip thinking blocks from messages
      //   - redact-thinking-*           → we strip thinking/redacted_thinking blocks
      //   - prompt-caching-scope-*      → we sanitize cache_control on non-text blocks
      //   - mid-conversation-system-*   → we relocate system messages to top-level system
      //
      // Flags we keep (body-compatible):
      //   - claude-code-*               → client identification, no body field
      //
      // NOTE: real ZCode client (reverse-engineered 2026-06) does NOT send
      // anthropic-beta at all in normal /v1/messages traffic. Keeping this
      // filter is safe — if the client doesn't send the header, nothing
      // happens. If they do, we filter to only the safe flags.
      const filtered = value
        .split(",")
        .map(s => s.trim())
        .filter(flag => flag.startsWith("claude-code-"))
        .join(",");
      if (filtered) {
        result[lower] = filtered;
      }
      continue;
    }
    result[lower] = value;
  }
  return result;
}

export function buildUpstreamRequest(
  clientReq: Request,
  format: Format,
  provider: ProviderDef,
  cred: Credential,
  body: string | undefined,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  extraHeaders?: Record<string, string>,
  /**
   * vceshi0.0.8+: socket-aware client IP resolver, used for the session
   * fingerprint. See clientFingerprint() docstring for the security
   * rationale. When omitted, falls back to XFF only if trustProxy is true.
   */
  resolveClientIp?: (req: Request) => string | undefined,
  trustProxy?: boolean,
): Request {
  const url = buildUpstreamURL(format, provider, plan);
  const fp = clientFingerprint(clientReq, resolveClientIp, trustProxy);
  const authHeaders = buildAuthHeaders(format, cred, identity, plan, fp);
  const passthrough = collectPassthroughHeaders(clientReq);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept-encoding": "gzip",
    ...passthrough,
    ...authHeaders,
    ...extraHeaders,
  };

  const init: RequestInit = {
    method: "POST",
    headers,
  };

  if (body !== undefined) {
    init.body = body;
  }

  return new Request(url, init);
}
