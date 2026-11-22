# Configuration

Copy and edit [config.example.json](../config.example.json) through `init`. Restart the harbor after changing its configuration or environment. Keep account-specific config out of Git.

## Settings

| Setting | Default | Behavior |
| --- | --- | --- |
| `host` | `127.0.0.1` | Numeric loopback only; public binds are rejected |
| `port` | `20130` | Listener port; `0` is useful for automated tests |
| `requestTimeoutMs` | `180000` | Deadline per provider attempt, including reading its response |
| `catalogTtlMs` | `300000` | Maximum age of cached OpenRouter pricing evidence |
| `maxBodyBytes` | `2097152` | Maximum request body size |
| `maxConcurrentRequests` | `4` | Concurrent generation requests; excess requests return 429 |
| `toolOutputLimitChars` | `0` | Disabled; otherwise 256–200000 UTF-16 characters per tool-result text segment |
| `allowDeclaredFreeTiers` | `false` | Explicitly accepts operator-declared account eligibility; does not independently verify it |

Use `providers[].apiKeyEnv` to identify a provider-key environment variable. Inline `apiKey`, `token`, `secret`, and arbitrary `headers` fields are rejected. The optional `authHeader` is `authorization` (Bearer, default) or `x-api-key`. Provider endpoints require HTTPS except numeric-loopback `local` endpoints. Redirects are rejected rather than followed with credentials.

`protocols` is an explicit capability declaration: `chat`, `responses`, or `messages`. Add a protocol only when the upstream endpoint actually supports it. The Groq and NVIDIA presets declare only `chat`; the harbor does not translate those APIs into another protocol.

## Ordered routes

Clients select route aliases, not arbitrary upstream model IDs. To configure fallback for chat, enable a running local server and set its installed model ID:

```json
{
  "routes": {
    "harbor-auto": [
      { "provider": "openrouter", "model": "openrouter/free" },
      { "provider": "local", "model": "your-installed-local-model" }
    ]
  }
}
```

This is a fragment to merge into the full config, not a complete config. Set the local provider's `enabled` to `true` and its `baseUrl` to the real numeric-loopback endpoint. Install and run the local model separately. A chat-only local server is skipped for Responses and Messages requests. There is no automatic model installation.

Fallback happens before a successful upstream response starts, on connection failures, HTTP 429, or HTTP 500/502/503/504. Authentication errors and invalid requests are terminal. All candidates for a provider share its cooldown, so a shared account limit is not treated as fresh quota for each model. Cross-provider fallback can change model behavior and expose the supplied conversation to another configured provider.

## Linked gateways

Use the `models` and `link` commands described in the [quick start](../README.md#build-a-route-across-gateways). A `linked-gateway` must have a numeric loopback base URL ending in `/v1`, a gateway key environment variable and a port distinct from the Harbor listener. A route containing a linked gateway can contain only linked gateways. Its eligibility label is `upstream-managed`. Order entries in the config to change priority, then restart the server.

## Groq, NVIDIA, and custom free tiers

Before enabling a `declared-free-tier` provider, check that the actual account and selected model have a free allowance and refuse excess usage instead of charging. Set `allowDeclaredFreeTiers` to `true` only if you accept that this is your declaration rather than live billing verification.

The provider's `freeTier` needs:

```text
source:       HTTPS documentation or account policy URL, without credentials
verifiedAt:   ISO timestamp when you checked the actual allowance
expiresAt:    Future ISO timestamp no more than 31 days after verifiedAt
hardStop:     true, only after confirming the account refuses excess usage
```

Then enable the provider, supply its API-key environment variable, and add the selected model to an ordered route. Expired or missing declarations block inference. No monthly token count is inferred from rate limits or a declared free tier.

## Optional compaction

Set `toolOutputLimitChars` to a value such as `8000` to trim oversized tool-result text. The harbor retains the beginning and end and inserts a visible omission marker. This is lossy: omitted lines may matter to a coding task. Keep it disabled when exact output is necessary.

Only Chat `role: tool` text, Responses `function_call_output` strings, and Anthropic `tool_result` text are eligible. User prompts, function arguments, IDs, images, and ordinary assistant text are unchanged. Each Anthropic text segment has its own limit. This is not a total conversation-token cap. The `x-harbor-omitted-tool-chars` response header reports omission; it is not a claimed percentage reduction in billed tokens.

## Usage and evidence

`GET /v1/status` shows route evidence and local aggregate usage. Evidence starts as `not-checked`, then becomes `verified-zero-price`, `declared-free-tier`, or `local` after validation. Its timestamp and optional expiry distinguish it from a currently guaranteed quota.

Counters cover attempts, successes, failures, known input/output tokens, and successful requests with unknown or partial usage. Streaming usage fields are observed without changing forwarded bytes. The harbor does not estimate missing values or pretend local usage totals are the provider's remaining balance.
