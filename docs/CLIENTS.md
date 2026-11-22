# Client Integrations & Endpoints

Nikhil Code Harbor exposes native wire formats for today's standard AI coding interfaces without lossy translations. This enables developers to connect terminal-based agentic workflows, IDE extensions, and automated shell pipelines through a single resilient local gateway.

- **Loopback Origin:** `http://127.0.0.1:20130`
- **Default Route:** `harbor-auto` (or custom routes like `coding`)
- **Authentication:** Local gateway token (`HARBOR_GATEWAY_TOKEN` or `~/.nikhil-code-harbor/gateway.token`)

---

## 1. Anthropic Messages & Claude Code

Harbor provides first-class support for the native Anthropic Messages API (`POST /v1/messages`), preserving exact Server-Sent Events (SSE) streaming chunks, reasoning blocks, and client-side tool execution deltas.

### Direct API Request
```sh
curl http://127.0.0.1:20130/v1/messages \
  -H "x-api-key: $HARBOR_GATEWAY_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "coding",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Review this architectural design for potential deadlocks."}],
    "stream": true
  }'
```

### Claude Code CLI Integration
To route terminal-based agentic tools like **Claude Code** through Nikhil Code Harbor for resilience and gateway failover:

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:20130"
export ANTHROPIC_API_KEY="$HARBOR_GATEWAY_TOKEN"
claude --model coding
```
*Note: Any model identifier requested by Claude Code is cleanly dispatched to the target route configured in Harbor.*

---

## 2. OpenAI Chat Completions (VS Code, Cursor, Continue.dev)

Compatible with any editor or extension expecting an OpenAI-compatible endpoint.

### Endpoint: `POST /v1/chat/completions`

```sh
curl http://127.0.0.1:20130/v1/chat/completions \
  -H "Authorization: Bearer $HARBOR_GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "coding",
    "stream": true,
    "messages": [
      {"role": "system", "content": "You are an expert systems programmer."},
      {"role": "user", "content": "Explain async generator pipelines in Node.js."}
    ]
  }'
```

### Continue.dev Configuration (`~/.continue/config.json`)
```json
{
  "models": [
    {
      "title": "Nikhil Code Harbor",
      "provider": "openai",
      "model": "coding",
      "apiBase": "http://127.0.0.1:20130/v1",
      "apiKey": "YOUR_HARBOR_GATEWAY_TOKEN"
    }
  ]
}
```

---

## 3. Responses API (Codex Format)

Harbor implements the raw Responses wire protocol (`POST /v1/responses`) for tools and pipelines utilizing Codex-style completions:

```sh
curl http://127.0.0.1:20130/v1/responses \
  -H "Authorization: Bearer $HARBOR_GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "coding",
    "input": "Write a TypeScript function to calculate rolling exponential moving averages.",
    "stream": true
  }'
```

---

## 4. Status, Health & Telemetry

Inspect active cooldowns, provider eligibility, and local usage tokens:

```sh
node bin/harbor.mjs status
```

### Response Headers
Every generation response forwarded by Harbor includes non-intrusive trace headers:
- `x-harbor-provider`: The ID of the provider that successfully served the request.
- `x-harbor-model`: The specific upstream model that generated the output.
- `x-harbor-request-id`: A localized UUID for tracing request lifecycles.
- `x-harbor-omitted-tool-chars`: Number of characters reduced if tool-compaction was active.
