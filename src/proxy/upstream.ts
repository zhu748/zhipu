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
 * === HEADER FINGERPRINT ALIGNMENT (2026-06, verified vs app.asar) ===
 *
 * Reverse-engineered from the ZCode Electron client's buildZCodeSourceHeaders()
 * / withZCodeEndpointHeaders(). The real client sends:
 *   - User-Agent: ZCode/{appVersion}        (e.g. ZCode/3.1.8)
 *   - X-ZCode-App-Version / X-Title / HTTP-Referer / X-Platform /
 *     X-Client-Language / X-Client-Timezone / X-Os-Category / X-Os-Version
 *     (these IDENTITY headers ARE how the client proves it is ZCode)
 *   - Accept: text/event-stream              (always, even for non-stream)
 *   - x-request-id: <uuid>                   (fresh per request, via
 *                                             withRequestIdHeader())
 *   - NO x-session-id / x-query-id / x-zcode-trace-id
 *   - NO anthropic-beta (the real client sends none — verified 2026-06;
 *                          we strip it entirely, including claude-code-*)
 *
 * An earlier revision did the OPPOSITE (shipped `User-Agent: ai-sdk/anthropic/3.0.81`
 * and stripped every X-ZCode-* header), based on a flawed reverse note. That
 * made the request look like it was *pretending* to be ZCode while omitting
 * every signal the real client uses to identify itself. We now emit the real
 * client's identity set verbatim.
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
  // anthropic-beta: STRIP ENTIRELY. The real ZCode desktop client sends NO
  // anthropic-beta header at all on normal /v1/messages traffic (verified
  // against app.asar buildZCodeSourceHeaders, 2026-06). Beta flags are an
  // Anthropic-SDK / Claude-Code-CLI artifact, not part of ZCode's fingerprint,
  // so forwarding them is a tell. Previously we filtered to keep only
  // claude-code-* flags, but that was based on a flawed assumption — there
  // are no claude-code-* flags in the real client either.
  "anthropic-beta",
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "transfer-encoding",
  "x-request-id",
  "x-zcode-trace-id",
  "x-query-id",
  "x-session-id",
  // Proxy-forwarding headers injected by downstream clients or reverse
  // proxies (X-Forwarded-* / X-Real-IP). The real ZCode desktop client never
  // sends these — they'd leak the proxy chain. We read XFF/X-Real-IP only for
  // diagnostics via clientIp(), never forward them upstream.
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-real-ip",
  "x-real-port",
  // Strip all client-side identity / SDK headers so nothing from the
  // downstream client (Cherry Studio, Codex CLI, a browser) leaks upstream.
  // We rebuild the full ZCode identity header set in buildIdentityHeaders()
  // (User-Agent: ZCode/{version}, X-ZCode-App-Version, X-Title, HTTP-Referer,
  // X-Platform, X-Client-*, X-Os-*). buildUpstreamRequest layers authHeaders
  // AFTER passthrough, so our injected identity always wins; stripping here
  // keeps the passthrough set clean and free of contradictory values.
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
  "x-platform",
  "x-client-language",
  "x-client-timezone",
  "x-os-category",
  "x-os-version",
  "x-release-channel",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
]);

/**
 * Derive the client IP for logging/diagnostics (NOT for session IDs — see
 * the note in buildAuthHeaders: the real client sends no session header).
 *
 * vceshi0.0.8+ SECURITY: previously this read X-Forwarded-For unconditionally
 * to key a session-ID cache; any client could spoof XFF to share/pollute
 * another user's upstream session. The session cache is gone now, but the IP
 * resolution is retained for diagnostics and (if re-introduced) should honor:
 *   1. The TCP socket peer address (via resolveClientIp, wired to Bun's
 *      server.requestIP) — un-spoofable, the default in production.
 *   2. X-Forwarded-For / X-Real-IP ONLY when the operator has explicitly
 *      opted in via `config.server.trustProxy = true`.
 */
function clientIp(
  req: Request,
  resolveClientIp?: (req: Request) => string | undefined,
  trustProxy?: boolean,
): string {
  if (resolveClientIp) {
    try {
      const ip = resolveClientIp(req);
      if (ip) return ip;
    } catch { /* ignore */ }
  }
  if (trustProxy) {
    const xRealIp = req.headers.get("x-real-ip");
    if (xRealIp) return xRealIp;
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  return "";
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
  // NOTE: clientFingerprintStr is retained in the signature for API
  // stability (callers in handler.ts pass it) but is no longer used — the
  // real ZCode client does NOT send x-session-id / x-query-id /
  // x-zcode-trace-id headers (verified against app.asar, 2026-06). Those
  // were fabricated headers and have been removed.
  void clientFingerprintStr;
  const credStr = plan === "start-plan" && cred.jwt ? cred.jwt : credentialString(cred);
  const base: Record<string, string> = {
    ...buildIdentityHeaders(identity),
    // Accept: text/event-stream — real ZCode client ALWAYS sends this,
    // even for non-stream requests. Missing it is a fingerprint.
    "accept": "text/event-stream",
    // x-request-id: fresh UUID per request. The real client sets this via
    // withRequestIdHeader() (app.asar) — every request gets a new id if
    // none is present. No other fabricated trace headers are sent.
    "x-request-id": crypto.randomUUID(),
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
    // STRIP_HEADERS now includes ALL identity / SDK / trace / beta headers —
    // we rebuild the ZCode identity set from scratch in buildAuthHeaders to
    // match the real client exactly. The only headers we passthrough are
    // genuinely unknown ones (rare in practice).
    if (STRIP_HEADERS.has(lower)) continue;
    // Content-Type is set explicitly below; don't passthrough a potentially
    // wrong value from the client.
    if (lower === "content-type") continue;
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
   * vceshi0.0.8+: socket-aware client IP resolver, retained for diagnostics.
   * NOTE: as of the identity-header rework it is no longer used to derive a
   * session ID (the real client sends no session header — see module header).
   * Kept in the signature for API stability; the value is intentionally unused.
   */
  resolveClientIp?: (req: Request) => string | undefined,
  trustProxy?: boolean,
): Request {
  // Resolve and discard — kept for API symmetry, no session header is built.
  void clientIp(clientReq, resolveClientIp, trustProxy);
  const url = buildUpstreamURL(format, provider, plan);
  const authHeaders = buildAuthHeaders(format, cred, identity, plan);
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
