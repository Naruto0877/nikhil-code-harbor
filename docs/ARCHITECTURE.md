# Architecture

```text
coding client
    |
numeric-loopback HTTP listener
    |
Host/Origin checks -> gateway authentication -> request/concurrency limits
    |
explicit alias + protocol -> supported-parameter validation
    |
optional tool-result compaction
    |
candidate eligibility -> current pricing or explicit local/account policy
    |
native upstream request (provider credential added here only)
    |                         |
pre-response 429/5xx/error    successful JSON / event stream
    |                         |
bounded cooldown + next      byte-preserving forwarding; no stream replay
    |                         |
    +---------- aggregate usage counters ----------+
```

`src/config.mjs` validates endpoint, capability, and route configuration. `src/catalog.mjs` obtains and expires public model pricing evidence. `src/gateway.mjs` owns client authentication, routing, upstream deadlines, response forwarding, and cooldowns. `src/state.mjs` owns the private local token, aggregate usage persistence, and streaming usage observation. `src/compact.mjs` is the explicit lossy tool-result reducer. `bin/harbor.mjs` contains initialization, serving, discovery, diagnosis, and status commands.

The server forwards native wire formats. An adapter's protocol declaration controls eligibility; OpenRouter provides the native Chat, Responses, and Messages interfaces. This avoids inventing a partial mapping for tool calls or reasoning events. Other compatible endpoints may be configured for protocols they actually support.

The links module discovers model IDs from the chosen local gateway and atomically saves ordered routes. The browser and shell prompt clients share the generation endpoint and accounting.

Pricing checks are cached briefly and coalesced when requests arrive concurrently. A failed refresh does not resurrect expired evidence. Catalog checks contain no provider key and generate no model output.

Usage writes are serialized and atomically replace the state file. Missing token fields remain unknown. No model response cache or conversation database is present. A successful upstream response with a stream error is not counted as a successful generation merely because HTTP status was 200.

The test suite uses local HTTP listeners and injected upstream fixtures. It covers authentication and Host/Origin boundaries, pricing expiry, declared-tier policy, native protocols, exact SSE forwarding, tool-call deltas, cooldown/fallback, rejection of paid controls, interruption, cancellation, concurrency, body limits, token permissions, initialization, and usage persistence. It does not spend model tokens.
