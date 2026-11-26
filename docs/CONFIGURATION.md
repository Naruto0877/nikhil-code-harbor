# Configuration

Copy and edit [config.example.json](../config.example.json) through `init`. Restart the harbor after changing its configuration or environment. Keep account-specific config out of Git.

## Settings

| Setting | Default | Behavior |
| --- | --- | --- |
| `host` | `127.0.0.1` | Numeric loopback only; public binds are rejected |
| `port` | `20130` | Listener port; `0` is useful for automated tests |
| `requestTimeoutMs` | `180000` | Legacy name; the default for `firstByteTimeoutMs` |
| `firstByteTimeoutMs` | `requestTimeoutMs` | Time an attempt may wait for response headers and the first body byte. Expiry is `first_byte_timeout` and Harbor may fall back |
| `streamIdleTimeoutMs` | `120000` | Longest silence between body chunks after output began. Expiry is `stream_idle_timeout` and the request is not replayed |
| `requestDeadlineMs` | `1800000` | Overall limit for the whole request, measured from when Harbor receives it: provider selection, attempts **and** streaming. Before output it stops further attempts. After output began it ends the stream as interrupted (`deadline_exceeded`), and the partial response is never replayed |
| `maxAttempts` | `3` | Upstream attempts per request, across all candidates |
| `catalogTtlMs` | `300000` | Maximum age of cached OpenRouter pricing evidence |
| `maxBodyBytes` | `2097152` | Maximum request body size |
| `maxConcurrentRequests` | `4` | Concurrent generation requests. Excess requests return 429 `harbor_concurrency_limit` with no upstream call |
| `toolOutputLimitChars` | `0` | Compaction disabled; otherwise 256–200000 UTF-16 characters per tool-result text segment |
| `toolOutputBudgetChars` | `4 × toolOutputLimitChars` | Combined limit for the tool results in one turn (one Messages user message, or one run of Chat `tool` messages / Responses outputs) |
| `allowDeclaredFreeTiers` | `false` | Explicitly accepts operator-declared account eligibility; does not independently verify it |

Use `providers[].apiKeyEnv` to identify a provider-key environment variable. Inline `apiKey`, `token`, `secret`, and arbitrary `headers` fields are rejected. The optional `authHeader` is `authorization` (Bearer, default) or `x-api-key`. Provider endpoints require HTTPS except numeric-loopback `local` endpoints. Redirects are rejected rather than followed with credentials.

`protocols` is an explicit declaration: `chat`, `responses`, or `messages`. Add a protocol only when the upstream endpoint actually supports it. The Groq and NVIDIA presets declare only `chat`. Harbor does not translate between protocols, so a chat-only endpoint never receives a Messages request.

The optional `capabilities` list narrows what a provider receives. Values: `tools`, `streaming`, `thinking`, `prompt_caching` (any `cache_control`), `context_management`, `anthropic_beta` (any forwarded `anthropic-beta` value), `response_storage`. Without the list, Harbor assumes every capability **except** `response_storage`, which must always be declared. Before sending the conversation, Harbor skips a candidate that lacks the protocol, credential, or a required capability, and records why. `node bin/harbor.mjs doctor` prints the same reasons for each route and protocol.

### Anthropic protocol headers

For Messages requests Harbor forwards the client's `anthropic-version` (default `2023-06-01`) and `anthropic-beta`, with credential-related `oauth-*` betas removed. Paired body fields `cache_control` (top-level and per block) and `context_management` are accepted. The client's Harbor token is never forwarded; each provider receives only its own configured key.

Claude Code's gateway guidance asks gateways to forward request bodies as open lists. Harbor deliberately keeps a field allowlist so clients cannot add hosted paid tools, routing overrides, or `service_tier`. A new Claude Code field outside the allowlist will be rejected with `unsupported_parameter` naming the field.

### Responses continuations

`store: true` is sent upstream only to providers that declare `response_storage`; otherwise Harbor rejects it with `response_storage_unsupported`. Harbor remembers (in memory, up to 2000 IDs) which provider issued each stored response. A request with `previous_response_id` goes only to that provider, with no fallback. If Harbor did not record the owner, for example after a restart, it returns 409 `continuation_owner_unknown` instead of guessing.

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

Fallback happens only before any byte has been sent to the client. It is triggered by connection failures, first-byte timeouts, a response that ends before its first byte, HTTP 429, HTTP 529, or HTTP 5xx. `Retry-After` (delay-seconds or HTTP date) and `retry-after-ms` set the provider's cooldown. Values up to 7 days are honored in full. Longer values are capped at 7 days, so a provider cannot be disabled indefinitely by one response. Without either header Harbor uses 30 seconds and reports the retry time as unknown.

These responses stop the request without fallback:

- `x-should-retry: false`
- a billing or spend-cap error. This is HTTP 402, or a structured code such as `error.details.error_code: "enforced_spend_limit_reached"`, `insufficient_quota` or `billing_hard_limit_reached`, which is read first, even on a 429. Error-message wording is used only when the provider gives no specific code.
- authentication errors and invalid requests A billing stop returns 402 `upstream_billing`. Upstream error text is examined but never returned or stored. An upstream 529 is an availability signal. Anthropic documents that overload errors do not deduct subscription quota. All candidates for a provider share its cooldown, so a shared account limit is not treated as fresh quota for each model. Cross-provider fallback can change model behavior and expose the supplied conversation to another configured provider.

## Linked gateways

Use the `models` and `link` commands (`node bin/harbor.mjs help`). A `linked-gateway` must have a numeric loopback base URL ending in `/v1`, a gateway key environment variable and a port distinct from the Harbor listener. A route containing a linked gateway can contain only linked gateways. Its eligibility label is `upstream-managed`. Order entries in the config to change priority, then restart the server.

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

## Local routes

`node bin/harbor.mjs local --base-url http://127.0.0.1:PORT/v1 --model ID --protocols messages[,chat] [--route coding] [--capabilities LIST]` enables the built-in `local` provider at a loopback endpoint you run. It checks that `ID` appears in `GET /models` and appends the model to the route. The config edit is locked, validated and atomic. Harbor installs no models and adds no hosted providers.

## Optional compaction

Compaction is off by default. Set `toolOutputLimitChars` (for example `8000`) to enable it, and optionally `toolOutputBudgetChars`. It is lossy and deterministic:

- Tool-result shapes are validated first. Malformed content returns 400 `invalid_tool_result` with its JSON path, and this validation runs even when compaction is off.
- Test logs keep failing test names, assertion and error lines with nearby context, `file:line` references, and the final summary. Diffs keep `diff --git`, `---`/`+++` file headers and `@@` hunk headers. Other text keeps the beginning and end. Every gap becomes a `[Harbor omitted N lines, C chars]` marker.
- The results of one turn share `toolOutputBudgetChars`. Small results stay whole and large ones share the remainder. When there are so many results that fragments would be useless, the smallest results are kept whole and the others are replaced by `[Harbor omitted tool output: C chars]`.
- Output depends only on that turn's tool results, so a turn compacted in an earlier request is reproduced byte-for-byte later. This keeps the forwarded prefix stable for prompt caching.
- User text, tool-call IDs, tool arguments, images, thinking blocks and their signatures are never modified.

The inbound `maxBodyBytes` limit still applies first. A larger body gets an actionable 413 before compaction runs. If Claude Code reports that a file was too large to read, that limit is Claude Code's own and the request never reached Harbor. The `x-harbor-omitted-tool-chars` header reports how much was removed. It is not a claimed reduction in billed tokens.

## Usage and evidence

`GET /v1/status` shows route evidence and local aggregate usage. Evidence starts as `not-checked`, then becomes `verified-zero-price`, `declared-free-tier`, or `local` after validation. Its timestamp and optional expiry distinguish it from a currently guaranteed quota.

Per provider, counters cover attempts, completed / interrupted / failed / client-cancelled outcomes, successes served after a fallback, and provider-reported **ordinary input**, **cache-read**, **cache-write** and **output** tokens. Anthropic `input_tokens` already excludes cache tokens. For OpenAI-style usage, `cached_tokens` is subtracted from the prompt total. Streaming usage is cumulative, so Harbor keeps the largest value seen for each field and repeated events never inflate totals. Missing fields stay unknown: per request they are `null`, and per provider they are counted in `unknownUsageRequests` / `unknownCacheUsageRequests`. Version 1 usage files load with cache counters at zero.

Harbor does not infer subscription quota, does not promise cache hits, and does not estimate missing values. A cache miss after a provider switch shows up as a fallback request with cache writes on the new provider.
