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

Follow the [README quick start](../README.md#quick-start-from-init-to-a-first-claude-code-request). In short:

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:20130"
export ANTHROPIC_AUTH_TOKEN="$(cat ~/.nikhil-code-harbor/gateway.token)"   # sent as Authorization: Bearer
export ANTHROPIC_MODEL=coding ANTHROPIC_DEFAULT_HAIKU_MODEL=coding \
       ANTHROPIC_DEFAULT_SONNET_MODEL=coding ANTHROPIC_DEFAULT_OPUS_MODEL=coding
claude
```

Notes:

- Claude Code requests route **aliases**. A model name that is not a route returns 400 `unknown_route`. Background tasks use the Haiku slot, so set every variable above.
- The route needs a candidate that declares `messages`. `harbor doctor` shows `"claudeCode": "eligible"` for each such candidate, or the reason it is skipped.
- `anthropic-version`, `anthropic-beta` (except `oauth-*`), `cache_control` and `context_management` are forwarded. `/v1/messages/count_tokens` is not implemented, and Claude Code falls back to its own estimate.
- Billing belongs to whichever provider serves the request. With a local server that is your own compute. Harbor does not use or rotate Claude subscription accounts.

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

Inspect active cooldowns, the last failure, recent requests, and per-provider input / cache-read / cache-write / output tokens:

```sh
node bin/harbor.mjs status          # summary
node bin/harbor.mjs status --json   # full GET /v1/status
```

### Response Headers
Every generation response forwarded by Harbor includes non-intrusive trace headers:
- `x-harbor-provider`: The ID of the provider that successfully served the request.
- `x-harbor-model`: The specific upstream model that generated the output.
- `x-harbor-request-id`: A localized UUID for tracing request lifecycles.
- `x-harbor-omitted-tool-chars`: Number of characters reduced if tool-compaction was active.
- `x-harbor-fallback`: `true` when an earlier candidate failed or was cooling down. This is a common cause of prompt-cache misses.

---

## Troubleshooting rate limits and failures

Start with `node bin/harbor.mjs status`. It shows the last time Harbor received a request, the last failure (category, provider, request ID, earliest known retry), each provider's cooldown, and recent requests.

- **No request recorded** at the time of the error: Claude Code stopped before contacting Harbor. That can be a client-side limit, a local file-read size limit, or a wrong `ANTHROPIC_BASE_URL`. Harbor cannot see or fix these.
- **A request is recorded:** use its category below. The same fields appear in the error JSON (`error.request_id`, `error.category`, `error.provider`, `error.retry_at`) and the `x-harbor-request-id`, `retry-after` and `x-should-retry` headers.

### Failure categories

| Category | Meaning | Recovery |
| --- | --- | --- |
| `harbor_concurrency_limit` | Harbor's `maxConcurrentRequests` was reached. **No upstream call was made.** | Retry shortly or raise the limit |
| `upstream_rate_limited` | Provider HTTP 429. Harbor tried the next eligible provider. The cooldown follows `Retry-After`, capped at 7 days | Wait for `retry_at`, or add another configured provider |
| `upstream_overloaded` | Provider HTTP 529. This is an availability problem, not a quota charge | Retry, or rely on a backup candidate |
| `upstream_unavailable` | Connection failure, 5xx, or a response that ended before its first byte | Check the provider or local server |
| `all_candidates_cooling` | Every eligible provider is in cooldown. No upstream call was made | Wait for `retry_at`. If it is absent, the providers gave no retry time |
| `upstream_billing` | The provider reported a spend cap, credit, quota or billing restriction. Harbor stopped without fallback | Fix it in that provider's account |
| `upstream_no_retry` | The provider sent `x-should-retry: false` | Do not retry automatically |
| `upstream_rejected` | Invalid request or authentication error upstream | Check the provider key and request |
| `no_eligible_candidate` | No candidate supports the protocol, credentials or capabilities. The message lists each skip reason | Run `harbor doctor` |
| `first_byte_timeout` / `stream_idle_timeout` | No first byte within `firstByteTimeoutMs`, or silence after output began | Tune the timeouts. Idle streams are not replayed |
| `stream_incomplete` / `stream_interrupted` / `stream_error_event` | The stream ended without its completion event, the connection broke, or the stream carried an error event | Retry the turn. A partial tool call is never replayed elsewhere |
| `deadline_exceeded` | `requestDeadlineMs` elapsed. Before output, no further provider is tried. During a stream, the stream is cut off and recorded as interrupted, never replayed | Retry, or raise `requestDeadlineMs` for very long generations |
| `attempt_limit` | `maxAttempts` was used up before output | Retry later |
| `client_cancelled` | The client disconnected | — |
| `unknown` | Harbor could not determine the cause | Check the provider's own logs |

Outcomes are recorded as `completed`, `interrupted`, `failed`, `client_cancelled` or `rejected`. A Messages stream counts as completed only after `message_stop`, Chat after `[DONE]` or a `finish_reason`, and Responses after `response.completed` or `response.incomplete`. The forwarded bytes are never modified.
