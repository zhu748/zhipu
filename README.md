# zcode-proxy

A reverse proxy for Z.AI / Bigmodel.cn coding-plan APIs that exposes both OpenAI-compatible and Anthropic-format endpoints.

## Quick Start

```bash
# Install dependencies
bun install

# Start the proxy — first run auto-creates config.yaml from the bundled
# template if it doesn't already exist (no need to cp from config.example.yaml)
bun run src/index.ts

# Or specify a config path
bun run src/index.ts /path/to/config.yaml
```

## Authentication

### Option 1: Direct API Key (simplest)

1. Get an API key from [Z.AI](https://z.ai) or [Bigmodel](https://bigmodel.cn)
2. For Z.AI you need `{apiKey}.{secretKey}` format
3. For Bigmodel you need `{apiKey}` format
4. Set it in `config.yaml`:

```yaml
auth:
  mode: apikey
  apiKey: "yourApiKey.yourSecretKey"
provider: zai  # or bigmodel
```

### Option 2: OAuth Login (browser-based, both providers)

```bash
# Z.AI device/poll flow (coding-plan is the default; use --plan=start-plan for start-plan)
bun run src/index.ts auth login zai [--plan=coding-plan|start-plan]

# Bigmodel auth-code flow (via zcode.z.ai proxy)
bun run src/index.ts auth login bigmodel [--plan=coding-plan|start-plan]

# This will:
# 1. Print an authorize URL and open your browser
# 2. Exchange the auth code for upstream credentials
# 3. Resolve your coding-plan API key automatically
# 4. Save encrypted credentials to ~/.zcode-proxy/credentials.json

# Then set config.yaml:
auth:
  mode: oauth
provider: zai  # or bigmodel
```

### Option 3: Import from ZCode Config (skip OAuth)

If you already use the ZCode desktop app, import the API key directly:

```bash
bun run src/index.ts auth login bigmodel --import
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions (streaming + non-streaming) |
| `POST` | `/v1/messages` | Anthropic-format messages (streaming + non-streaming) |
| `POST` | `/v1/responses` | OpenAI Responses API (streaming + non-streaming, Codex CLI compatible) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check (also served at `/`) |
| `GET` | `/admin` | Admin dashboard (web UI: stats, logs, config, accounts, OAuth login) |
| `*`   | `/admin/api/*` | Admin API endpoints used by the dashboard |

## Admin Dashboard

Open `http://localhost:8080/admin` in your browser. The dashboard lets you:

- View live request stats (counts, latency, tokens/s, model breakdown)
- Stream live logs (filter by level / search)
- Edit config (provider, plan, models, identity, retry, routing rules, model mappings)
- Manage stored accounts (multi-account: add, switch active, edit label/plan, export/import)
- Trigger OAuth login for Z.AI or Bigmodel
- Inspect upstream 4xx debug dumps (transformed request bodies that triggered errors)

The dashboard uses the same `auth.proxyApiKey` as the API endpoints (pass it as
`Authorization: Bearer <key>`). When `proxyApiKey` is unset the dashboard is
**open to anyone with network access** — set the key in production.

## Usage Examples

### OpenAI Format

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Anthropic Format

```bash
curl http://localhost:8080/v1/messages \
  -H "x-api-key: your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "Write a poem"}],
    "stream": true
  }'
```

### OpenAI Responses API (Codex CLI)

```bash
curl http://localhost:8080/v1/responses \
  -H "Authorization: Bearer your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello!"}]}],
    "stream": false
  }'
```

Codex CLI integration — set these env vars before launching `codex`:

```bash
export OPENAI_API_KEY="your-proxy-secret"
export OPENAI_BASE_URL="http://localhost:8080/v1"
# Instruct Codex CLI to use the Responses wire format
# (already default in recent versions; older versions may need this)
codex --model glm-4.6
```

The proxy translates `POST /v1/responses` to Anthropic Messages upstream and back,
emitting the full Responses streaming event sequence (`response.created` →
`response.output_text.delta` → `response.completed`) that Codex CLI expects.
`previous_response_id` is supported via an in-memory LRU store (256 turns,
each capped at 256 KB of serialized input+output to bound memory).

### List Models

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-proxy-secret"
```

## Configuration

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `server.port` | `ZCODE_PROXY_PORT` | `8080` | Listen port |
| `auth.apiKey` | `ZCODE_API_KEY` | — | Upstream API key |
| `auth.proxyApiKey` | `ZCODE_PROXY_API_KEY` | — | Client auth key |
| `provider` | `ZCODE_PROVIDER` | `zai` | Upstream provider |
| `identity.appVersion` | `ZCODE_APP_VERSION` | `3.1.1` | `User-Agent: ZCode/{version}` |
| `identity.sourceTitle` | `ZCODE_SOURCE_TITLE` | `cli` | `X-Title: Z Code@{title}` |
| `identity.refererOrigin` | `ZCODE_REFERER_ORIGIN` | `https://zcode.z.ai` | `HTTP-Referer` URL |
| — | `ZCODE_PROXY_CREDENTIAL_SECRET` | derived from `homedir` | Override the AES-256-GCM key for `~/.zcode-proxy/credentials.json` |
| — | `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE` | unset | Set to `1` to allow loading a plaintext credentials.json (debug/test only) |
| — | `ZCODE_PROXY_CORS_ALLOWLIST` | unset | Comma-separated allowed origins for `Access-Control-Allow-Origin`. When unset, any origin is echoed (legacy permissive behavior). When set, only listed origins get `Access-Control-Allow-Origin: <origin>`; all others get `null`. |
| — | `ZCODE_PROXY_CONFIG` | `config.yaml` | Path to the config file (used when `serve` is called with no positional arg) |

## Security Notes

- **`auth.proxyApiKey`**: if unset, anyone with network access to the port can use your upstream credentials. The proxy prints a warning at startup if this is missing.
- **Credential store encryption**: `~/.zcode-proxy/credentials.json` is AES-256-GCM encrypted using a key derived from your homedir/platform. The key can be overridden with `ZCODE_PROXY_CREDENTIAL_SECRET` (useful for test isolation). Plaintext loading is gated behind `ZCODE_PROXY_ALLOW_PLAINTEXT_STORE=1` to prevent bypass-via-file-write attacks.
- **CORS**: by default the proxy echoes the requesting Origin. For production, set `ZCODE_PROXY_CORS_ALLOWLIST` to the comma-separated list of origins you trust (e.g. `http://localhost:3000,https://your-dashboard.example.com`).
- **Upstream timeouts**: stream requests time out after 10 minutes; batch requests after 5 minutes. A hung upstream connection no longer pins a Bun worker forever — it surfaces as `502 upstream_unreachable`.

## Architecture

```
Client Request
      │
      ▼
Proxy API Key Auth (shared secret)
      │
      ▼
Route Detection + Plan-aware Routing
  /v1/chat/completions (OpenAI client format)
    ├─ coding-plan → TRANSLATE to Anthropic → provider's anthropic endpoint
    └─ start-plan  → TRANSLATE to Anthropic → zcode.z.ai gateway (JWT + captcha)
  /v1/messages     (Anthropic client format)
    ├─ coding-plan → passthrough to provider's anthropic endpoint
    └─ start-plan  → passthrough to zcode.z.ai gateway (JWT + captcha)
      │
      ▼
Body Transformation (ZCode-equivalent mutations)
  OpenAI streaming    → inject stream_options.include_usage
  Anthropic           → add cache_control to last user message
  Anthropic + OAuth   → inject metadata.user_id
      │
      ▼
[Translation mode only] OpenAI request → Anthropic request body
      │
      ▼
Auth + Identity Header Injection
  Translation/coding-plan:  x-api-key: {credential} + anthropic-version
  Translation/start-plan:   Authorization: Bearer {jwt} + anthropic-version
  Passthrough/start-plan:   Authorization: Bearer {jwt} + anthropic-version
  Passthrough/coding-plan:  x-api-key: {credential} + anthropic-version
  Both:                     User-Agent: ZCode/{version} + X-ZCode-* + trace headers
      │
      ▼
Upstream Forward (Bun.fetch)
  Translation mode:   decompress enabled (proxy reads + translates body)
  Passthrough:        decompress disabled (raw gzip bytes stream through)
      │
      ▼
Response Handling
  Passthrough:              raw bytes → client (content-encoding preserved)
  Translation batch:        Anthropic JSON → OpenAI JSON → gzip if client accepts
  Translation SSE stream:   Anthropic SSE → OpenAI SSE chunks → client
```

## Development

```bash
# Run tests
bun test

# Type check
bun x tsc --noEmit

# Run in dev mode
bun run src/index.ts config.yaml
```

## Available Models

The proxy lists these models on `GET /v1/models` (pinned to the GLM coding-plan tier):

| Model | Context | Max Output |
|-------|---------|------------|
| `glm-4.5-air` | 200K | 128K |
| `glm-4.6` | 200K | 128K |
| `glm-4.6v` | 200K | 128K |
| `glm-4.7` | 200K | 128K |
| `glm-5` | 200K | 128K |
| `glm-5-turbo` | 200K | 128K |
| `glm-5v-turbo` | 200K | 128K |
| `glm-5.1` | 200K | 128K |
| `glm-5.2` | 1M | 128K |

Requests for models not in this list are still forwarded upstream — the listing is informational, not a gate.

## License

MIT
