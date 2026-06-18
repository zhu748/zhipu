/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import type { Format } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { getProvider } from "../provider/providers.js";
import { buildUpstreamRequest } from "./upstream.js";
import { transformRequestBody } from "./body-transformer.js";

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Forward a client request to the upstream provider with injected auth.
 *
 * Uses `decompress: false` on the upstream fetch so compressed response bodies
 * (gzip/deflate/br) pass through untouched — the raw bytes and Content-Encoding
 * header are forwarded as-is, letting the client handle decompression.
 *
 * No upstream timeout is applied — matches ZCode desktop client behaviour
 * (the bundle has no automatic timer on LLM calls, only user-initiated abort).
 * Connection-level errors (ECONNREFUSED, DNS failure) still surface as 502.
 */
export async function proxyRequest(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  const { config, auth } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();

  const body = await readBody(clientReq);

  const meta = peekBody(body);

  const staticProvider = getProvider(config.provider);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[config.provider].anthropicBase,
    openaiBaseURL: config.providers[config.provider].openaiBase,
  };

  let cred;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    logRequest(format, meta, 503, started);
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }

  const transformedBody = transformRequestBody(body, { format, userId: cred.userId });
  const upstreamReq = buildUpstreamRequest(clientReq, format, provider, cred, transformedBody, config.identity, config.plan);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetchImpl(upstreamReq, { decompress: false });
  } catch (err) {
    logRequest(format, meta, 502, started);
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }

  if (upstreamResp.status === 401 && config.plan === "start-plan") {
    logRequest(format, meta, 401, started);
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
  }

  logRequest(format, meta, upstreamResp.status, started);
  return passthroughResponse(upstreamResp);
}

/** Read the request body as a string, returning undefined for empty bodies. */
async function readBody(req: Request): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const text = await req.text();
  if (text.length === 0) return undefined;
  return text;
}

/**
 * Create a passthrough response that streams the upstream body to the client.
 * Preserves status, headers, and body stream.
 */
function passthroughResponse(upstream: Response): Response {
  const headers = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-encoding",
    "cache-control",
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];

  for (const h of forwardHeaders) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Build a JSON error response. */
export function errorResponse(status: number, type: string, message: string): Response {
  const body = JSON.stringify({
    error: { type, message },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RequestMeta {
  model: string;
  stream: boolean;
}

function peekBody(body: string | undefined): RequestMeta {
  if (!body) return { model: "-", stream: false };
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    return {
      model: typeof p.model === "string" ? p.model : "-",
      stream: p.stream === true,
    };
  } catch {
    return { model: "-", stream: false };
  }
}

function logRequest(format: Format, meta: RequestMeta, status: number, started: number): void {
  const ts = new Date().toISOString().slice(11, 23);
  const elapsed = Date.now() - started;
  const tag = format === "anthropic" ? "ANT" : "OAI";
  const mode = meta.stream ? "stream" : "batch";
  console.log(
    `[${ts}] ${tag} ${meta.model.padEnd(14)} ${mode.padEnd(6)} ${String(status).padEnd(4)} ${elapsed}ms`,
  );
}
