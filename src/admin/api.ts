/**
 * Admin dashboard API routes — provides CRUD endpoints for the web UI.
 *
 * All routes require the proxy API key (same key used by API clients).
 * Mounted under /admin/api/* in server.ts.
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { Credential as AppCredential } from "../auth/types.js";
import { loadCredential, saveCredential, clearCredential } from "../auth/store.js";
import { ZaiOAuthClient, BigmodelOAuthClient } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { errorResponse } from "../proxy/handler.js";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AdminOptions {
  config: ProxyConfig;
  auth: AuthManager;
  configPath: string;
  startTime: number;
}

// In-memory stats collector
const stats = {
  total: 0,
  success: 0,
  failed: 0,
  retried: 0,
  requests: [] as Array<{ id: string; time: string; model: string; status: number; ttfb: string; tokens: string }>,
  models: {} as Record<string, { count: number; avgTtfb: number; tokens: number }>,
};

/** Record a request for stats. Called from handler.ts printRow. */
export function recordStat(entry: { id: string; time: string; model: string; status: number; ttfb: string; tokens: string; retried?: boolean }) {
  stats.total++;
  if (entry.status >= 200 && entry.status < 300) stats.success++;
  else stats.failed++;
  if (entry.retried) stats.retried++;
  stats.requests.push(entry);
  if (stats.requests.length > 200) stats.requests = stats.requests.slice(-100);
  const m = stats.models[entry.model] ?? { count: 0, avgTtfb: 0, tokens: 0 };
  m.count++;
  const ttfbMs = parseInt(entry.ttfb) || 0;
  m.avgTtfb = Math.round((m.avgTtfb * (m.count - 1) + ttfbMs) / m.count);
  m.tokens += parseInt(entry.tokens) || 0;
  stats.models[entry.model] = m;
}

// Active OAuth flows (in-memory)
const activeFlows = new Map<string, { provider: string; flowId: string; pollToken: string; expiresAt: number }>();

// Log buffer for streaming
const logBuffer: Array<{ time: string; level: string; message: string }> = [];
const logWaiters: Array<{ resolve: (value: unknown) => void }> = [];

/** Add a log entry to the buffer (called by intercepting console.log). */
export function appendLog(level: string, message: string) {
  const entry = { time: new Date().toISOString().slice(11, 19), level, message: message.slice(0, 500) };
  logBuffer.push(entry);
  if (logBuffer.length > 2000) logBuffer.splice(0, 1000);
  // Wake up any waiting SSE connections
  while (logWaiters.length > 0) {
    logWaiters.shift()!.resolve(entry);
  }
}

/** Read the bundled dashboard HTML. */
export function getDashboardHTML(): string {
  // Use import.meta to resolve the path relative to this module
  const htmlPath = join(import.meta.dir, "dashboard.html");
  return readFileSync(htmlPath, "utf-8");
}

/** Handle admin API routes. Returns null if the path doesn't match. */
export async function handleAdminRoute(req: Request, opts: AdminOptions): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Serve dashboard page
  if (path === "/admin" || path === "/admin/") {
    return new Response(getDashboardHTML(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Verify auth token for API routes
  if (path.startsWith("/admin/api/") && path !== "/admin/api/verify") {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (opts.config.auth.proxyApiKey && token !== opts.config.auth.proxyApiKey) {
      return errorResponse(401, "authentication_error", "Invalid admin token");
    }
  }

  // --- API Routes ---

  // Verify token
  if (path === "/admin/api/verify" && method === "GET") {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!opts.config.auth.proxyApiKey || token === opts.config.auth.proxyApiKey) {
      return jsonResp({ valid: true });
    }
    return errorResponse(401, "authentication_error", "Invalid token");
  }

  // Get config
  if (path === "/admin/api/config" && method === "GET") {
    return jsonResp(sanitizeConfig(opts.config));
  }

  // Update config
  if (path === "/admin/api/config" && method === "PUT") {
    try {
      const body = await req.json() as Record<string, unknown>;
      const newConfig = { ...opts.config, ...body };
      // Persist to YAML (simplified: write as JSON-compatible YAML)
      const yaml = configToYaml(newConfig);
      writeFileSync(opts.configPath, yaml, "utf-8");
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get credentials
  if (path === "/admin/api/credentials" && method === "GET") {
    const cred = await loadCredential();
    if (!cred) return jsonResp({ credential: null });
    return jsonResp({
      credential: {
        provider: cred.provider,
        apiKeyMask: cred.apiKey.slice(0, 8) + "..." + cred.apiKey.slice(-4),
        hasSecret: !!cred.secret,
        userId: cred.userId,
        expiresAt: cred.expiresAt,
        mode: opts.config.auth.mode,
      },
    });
  }

  // Add API key
  if (path === "/admin/api/credentials" && method === "POST") {
    try {
      const body = await req.json() as { provider: string; apiKey: string };
      const cred = { apiKey: body.apiKey, provider: body.provider as "zai" | "bigmodel" } as AppCredential;
      await saveCredential(cred);
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Clear credentials
  if (path === "/admin/api/credentials" && method === "DELETE") {
    clearCredential();
    return jsonResp({ ok: true });
  }

  // Import from ZCode
  if (path === "/admin/api/import" && method === "POST") {
    try {
      const body = await req.json() as { provider: string };
      const provider = body.provider as "zai" | "bigmodel";
      const cred = importFromZCodeConfig(provider);
      await saveCredential(cred);
      return jsonResp({ ok: true, apiKeyMask: cred.apiKey.slice(0, 8) + "..." + cred.apiKey.slice(-4) });
    } catch (err) {
      return errorResponse(500, "import_failed", (err as Error).message);
    }
  }

  // OAuth init
  if (path === "/admin/api/oauth/init" && method === "POST") {
    try {
      const body = await req.json() as { provider: string };
      const provider = body.provider as "zai" | "bigmodel";

      if (provider === "bigmodel") {
        const oauth = new BigmodelOAuthClient();
        const { authorizeUrl, callbackUrl, state } = await oauth.start();
        // Store flow info for polling
        const flowId = `bm_${state.slice(0, 16)}`;
        activeFlows.set(flowId, { provider, flowId, pollToken: state, expiresAt: Date.now() + 300_000 });
        // Start background process to wait for callback
        (async () => {
          try {
            const authCode = await oauth.waitForCallback(300_000);
            const { accessToken, userId, jwt } = await oauth.exchangeCode(authCode, callbackUrl, state);
            const resolver = new KeyResolver();
            const cred = await resolver.resolveCodingPlanCredential(accessToken, provider, userId);
            if (jwt) cred.jwt = jwt;
            await saveCredential(cred);
            // Mark flow as ready
            const flow = activeFlows.get(flowId);
            if (flow) { (flow as any).status = "ready"; }
            await oauth.close();
          } catch (err) {
            const flow = activeFlows.get(flowId);
            if (flow) { (flow as any).status = "failed"; (flow as any).error = (err as Error).message; }
            try { await oauth.close(); } catch {}
          }
        })();
        return jsonResp({ flowId, authorizeUrl });
      }

      // Z.AI OAuth
      const oauth = new ZaiOAuthClient();
      const init = await oauth.init("zai");
      activeFlows.set(init.flowId, { provider, flowId: init.flowId, pollToken: init.pollToken, expiresAt: init.expiresAt });
      // Background poll
      (async () => {
        try {
          const result = await oauth.waitForAuth(init);
          const resolver = new KeyResolver();
          const cred = await resolver.resolveCodingPlanCredential(result.accessToken, provider, result.userId);
          if (result.jwt) cred.jwt = result.jwt;
          await saveCredential(cred);
          const flow = activeFlows.get(init.flowId);
          if (flow) { (flow as any).status = "ready"; }
        } catch (err) {
          const flow = activeFlows.get(init.flowId);
          if (flow) { (flow as any).status = "failed"; (flow as any).error = (err as Error).message; }
        }
      })();
      return jsonResp({ flowId: init.flowId, authorizeUrl: init.authorizeUrl });
    } catch (err) {
      return errorResponse(500, "oauth_init_failed", (err as Error).message);
    }
  }

  // OAuth poll
  if (path === "/admin/api/oauth/poll" && method === "GET") {
    const flowId = url.searchParams.get("flowId");
    if (!flowId) return errorResponse(400, "missing_param", "flowId required");
    const flow = activeFlows.get(flowId);
    if (!flow) return errorResponse(404, "not_found", "Unknown flow");
    const status = (flow as any).status || "pending";
    if (status === "ready") activeFlows.delete(flowId);
    if (status === "failed") activeFlows.delete(flowId);
    return jsonResp({ status });
  }

  // Update endpoints
  if (path === "/admin/api/endpoints" && method === "PUT") {
    try {
      const body = await req.json() as { zai?: Record<string, string>; bigmodel?: Record<string, string> };
      if (body.zai) Object.assign(opts.config.providers.zai, body.zai);
      if (body.bigmodel) Object.assign(opts.config.providers.bigmodel, body.bigmodel);
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get stats
  if (path === "/admin/api/stats" && method === "GET") {
    return jsonResp({
      ...stats,
      uptime: Date.now() - opts.startTime,
    });
  }

  // Log stream (SSE)
  if (path === "/admin/api/logs/stream" && method === "GET") {
    // For WebSocket upgrade, Bun handles it differently; use SSE for simplicity
    const stream = new ReadableStream({
      async start(controller) {
        // Send existing logs
        for (const entry of logBuffer.slice(-100)) {
          controller.enqueue(`data: ${JSON.stringify(entry)}\n\n`);
        }
        // Send new logs as they come
        const interval = setInterval(() => {
          // Poll for new entries
          const latest = logBuffer[logBuffer.length - 1];
          if (latest) {
            controller.enqueue(`data: ${JSON.stringify(latest)}\n\n`);
          }
        }, 1000);
        // Clean up on cancel
        // Note: SSE stream will be cleaned up when connection closes
        setTimeout(() => {
          clearInterval(interval);
          try { controller.close(); } catch {}
        }, 3600000); // 1 hour max
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  }

  // Get logs (batch)
  if (path === "/admin/api/logs" && method === "GET") {
    const level = url.searchParams.get("level");
    const search = url.searchParams.get("search")?.toLowerCase();
    let logs = logBuffer;
    if (level) logs = logs.filter(l => l.level === level);
    if (search) logs = logs.filter(l => l.message.toLowerCase().includes(search));
    return jsonResp({ logs: logs.slice(-200) });
  }

  return null; // Not an admin route
}

// --- Helpers ---

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sanitizeConfig(config: ProxyConfig): Record<string, unknown> {
  return {
    server: config.server,
    provider: config.provider,
    plan: config.plan,
    auth: {
      mode: config.auth.mode,
      // Don't expose full API key, just indicate presence
      apiKey: config.auth.apiKey ? "***configured***" : "",
      proxyApiKey: config.auth.proxyApiKey ? "***configured***" : "",
    },
    providers: config.providers,
    defaultModel: config.defaultModel,
    models: config.models,
    identity: config.identity,
    logging: config.logging,
    retry: config.retry,
  };
}

function configToYaml(config: ProxyConfig): string {
  const lines: string[] = [];
  lines.push(`server:`);
  lines.push(`  port: ${config.server.port}`);
  lines.push(`  host: "${config.server.host}"`);
  lines.push(``);
  lines.push(`auth:`);
  lines.push(`  mode: ${config.auth.mode}`);
  if (config.auth.apiKey) lines.push(`  apiKey: "${config.auth.apiKey}"`);
  if (config.auth.proxyApiKey) lines.push(`  proxyApiKey: "${config.auth.proxyApiKey}"`);
  lines.push(``);
  lines.push(`provider: ${config.provider}`);
  lines.push(`plan: ${config.plan}`);
  lines.push(``);
  lines.push(`providers:`);
  lines.push(`  zai:`);
  lines.push(`    anthropicBase: "${config.providers.zai.anthropicBase}"`);
  lines.push(`    openaiBase: "${config.providers.zai.openaiBase}"`);
  if (config.providers.zai.credential) lines.push(`    credential: "${config.providers.zai.credential}"`);
  lines.push(`  bigmodel:`);
  lines.push(`    anthropicBase: "${config.providers.bigmodel.anthropicBase}"`);
  lines.push(`    openaiBase: "${config.providers.bigmodel.openaiBase}"`);
  if (config.providers.bigmodel.credential) lines.push(`    credential: "${config.providers.bigmodel.credential}"`);
  lines.push(``);
  lines.push(`defaultModel: ${config.defaultModel}`);
  lines.push(``);
  lines.push(`models:`);
  for (const m of config.models) lines.push(`  - ${m}`);
  lines.push(``);
  lines.push(`identity:`);
  lines.push(`  appVersion: "${config.identity.appVersion}"`);
  lines.push(`  sourceTitle: "${config.identity.sourceTitle}"`);
  lines.push(`  refererOrigin: "${config.identity.refererOrigin}"`);
  lines.push(``);
  lines.push(`logging:`);
  lines.push(`  level: ${config.logging.level}`);
  lines.push(``);
  lines.push(`retry:`);
  lines.push(`  maxRetries: ${config.retry.maxRetries}`);
  lines.push(`  initialDelayMs: ${config.retry.initialDelayMs}`);
  lines.push(`  maxDelayMs: ${config.retry.maxDelayMs}`);
  lines.push(`  backoffFactor: ${config.retry.backoffFactor}`);
  lines.push(`  retryableStatuses:`);
  for (const s of config.retry.retryableStatuses) lines.push(`    - ${s}`);
  return lines.join("\n");
}

function importFromZCodeConfig(provider: string): AppCredential {
  const configPath = join(homedir(), ".zcode", "v2", "config.json");
  if (!existsSync(configPath)) throw new Error("ZCode config not found at " + configPath);
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as {
    provider?: Record<string, { options?: { apiKey?: string }; enabled?: boolean }>;
  };
  const providerKey = `builtin:${provider}-coding-plan`;
  const entry = config.provider?.[providerKey];
  const apiKey = entry?.options?.apiKey?.trim();
  if (!apiKey) throw new Error(`No API key for ${providerKey} in ZCode config`);
  const startPlanKey = `builtin:${provider}-start-plan`;
  const jwt = config.provider?.[startPlanKey]?.options?.apiKey?.trim() || undefined;
  return { apiKey, provider: provider as "zai" | "bigmodel", jwt };
}
