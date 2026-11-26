# Architecture

```text
coding client
    |
numeric-loopback HTTP listener
    |
Host/Origin checks -> gateway authentication -> request/concurrency limits
    |
request ID + request log entry (no content)
    |
explicit alias + protocol -> supported-parameter and tool-result shape validation
    |
continuation owner lookup (Responses previous_response_id)
    |
optional deterministic tool-result compaction
    |
candidate eligibility: protocol, credential, capabilities, cooldown
    -> current pricing or explicit local/account policy
    |
native upstream request (provider credential added here only)
    |                         |
before first byte:             first byte received:
429/529/5xx/timeout ->        byte-preserving forwarding; idle timer;
classified cooldown + next    completion-signal observation; no replay
billing / no-retry -> stop
    |                         |
    +---------- aggregate usage counters ----------+
```

`src/config.mjs` validates endpoint, capability, and route configuration. `src/routing.mjs` derives a request's required capabilities, validates and forwards Anthropic protocol headers, and explains skipped candidates. `src/diagnostics.mjs` classifies failures and keeps the bounded request log. `src/observe.mjs` reads usage and completion events alongside forwarding. `src/handoff.mjs` implements the opt-in Claude Code crash handoff. `src/catalog.mjs` obtains and expires public model pricing evidence. `src/gateway.mjs` owns client authentication, routing, upstream deadlines, response forwarding, and cooldowns. `src/state.mjs` owns the private local token, aggregate usage persistence, and streaming usage observation. `src/compact.mjs` is the explicit lossy tool-result reducer. `bin/harbor.mjs` contains initialization, serving, discovery, diagnosis, and status commands.

The server forwards native wire formats. An adapter's protocol declaration controls eligibility; OpenRouter provides the native Chat, Responses, and Messages interfaces. This avoids inventing a partial mapping for tool calls or reasoning events. Other compatible endpoints may be configured for protocols they actually support.

The links module discovers model IDs from the chosen local gateway and atomically saves ordered routes. The browser and shell prompt clients share the generation endpoint and accounting.

Pricing checks are cached briefly and coalesced when requests arrive concurrently. A failed refresh does not resurrect expired evidence. Catalog checks contain no provider key and generate no model output.

Usage writes are serialized and atomically replace the state file. Missing token fields remain unknown. No model response cache or conversation database is present. A successful upstream response with a stream error is not counted as a successful generation merely because HTTP status was 200.

The test suite uses local HTTP listeners and injected upstream fixtures. It covers authentication and Host/Origin boundaries, pricing expiry, declared-tier policy, native protocols, exact SSE forwarding, tool-call deltas, cooldown/fallback, rejection of paid controls, interruption, cancellation, concurrency, body limits, token permissions, initialization, and usage persistence. It does not spend model tokens.
