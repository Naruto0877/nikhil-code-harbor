# Nikhil Code Harbor

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/Dependencies-0%20(Pure%20Node)-brightgreen.svg)](package.json)
[![Protocols](https://img.shields.io/badge/Protocols-Anthropic%20%7C%20OpenAI%20%7C%20Codex-orange.svg)](docs/CLIENTS.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**A local-first AI coding gateway and developer workbench for agentic workflows.**  
*Native Anthropic Messages and OpenAI protocol routing, byte-preserving SSE streaming, classified fallback, and live browser monitoring.*

[Quick Start](#quick-start-from-init-to-a-first-claude-code-request) • [Diagnostics](#diagnosing-a-stopped-request) • [Handoff](docs/HANDOFF.md) • [Architecture](docs/ARCHITECTURE.md) • [Client Integrations](docs/CLIENTS.md) • [Contributing](CONTRIBUTING.md)

</div>

---

## Overview

Agentic coding tools such as **Claude Code**, VS Code extensions, Cursor and Continue.dev can stall on rate limits, overloaded providers, or oversized tool output. **Nikhil Code Harbor** is a local, loopback-only gateway that routes those clients to providers *you* configure, falls back between them before any output is sent, and tells you exactly why a request stopped.

1. **Route aliases:** clients ask for `coding`; Harbor tries that route's candidates in order, skipping any that cannot serve the request's protocol or features.
2. **Classified failures:** every request gets an ID. Harbor's own concurrency limit, an upstream 429, an upstream 529, a billing/spend-cap stop, and "every provider is cooling down" are reported separately, with the provider and the earliest known retry time.
3. **Native wire formats:** Anthropic Messages, OpenAI Chat Completions and Responses are forwarded natively. Streams are forwarded byte-for-byte and a partly delivered response is never replayed to another provider.
4. **Cache-aware usage:** ordinary input, cache-read, cache-write and output tokens are counted per provider, with unknown values kept unknown.
5. **Optional evidence-preserving compaction** of huge test logs and diffs.
6. **Optional crash handoff** (`harbor handoff`) that records what changed and which checks finished during a Claude Code session.

Zero npm dependencies; Node.js 22+.

---

## System Architecture

```text
   [ Claude Code ]   [ VS Code / Continue ]   [ harbor ask ]
          └──────────────────┼──────────────────┘
                             ▼
             ┌───────────────────────────────┐
             │  Nikhil Code Harbor (loopback) │  auth · request IDs · limits
             │  route alias -> candidates     │  protocol/capability filter
             └───────────────┬───────────────┘
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                     ▼
 ┌──────────────┐   ┌──────────────────┐   ┌───────────────────┐
 │ Local server │   │ OpenRouter free  │   │ Linked local      │
 │ (your model) │   │ (verified $0) /  │   │ gateways (billing │
 │              │   │ declared tiers   │   │ is theirs)        │
 └──────────────┘   └──────────────────┘   └───────────────────┘
```

Harbor never adds a paid provider by itself and never rotates between subscription accounts. Every endpoint is one you configured.

---

## Quick Start: from `init` to a first Claude Code request

This is the supported, tested setup (`test/handoff.test.mjs` runs these exact steps against a local fixture).

**Prerequisites**

- Node.js 22 or newer and Git.
- A model server **you run** on `127.0.0.1` that implements `GET /v1/models` and the Anthropic Messages API `POST /v1/messages` with tool use and streaming. Harbor does not translate Chat Completions into Messages, so a chat-only server cannot serve Claude Code. Check your server's documentation for Anthropic-compatible `/v1/messages` support before you start.
- Claude Code installed.

**Billing:** with this setup the only cost is your local machine's compute. Harbor sends nothing to Anthropic or any hosted provider. Your Claude subscription or Anthropic API key is not used for these requests, because Claude Code authenticates to Harbor with Harbor's local token.

```sh
git clone https://github.com/Naruto0877/nikhil-code-harbor.git
cd nikhil-code-harbor

# 1. Create ~/.nikhil-code-harbor/config.json and a private gateway token.
node bin/harbor.mjs init

# 2. Add your local server to a `coding` route. Harbor checks that the model is listed.
node bin/harbor.mjs local --base-url http://127.0.0.1:11434/v1 --model YOUR_MODEL_ID \
  --protocols messages,chat --route coding

# 3. Confirm the route: look for "claudeCode": "eligible" and "reachable": "model listed".
node bin/harbor.mjs doctor

# 4. Start Harbor (leave it running).
node bin/harbor.mjs serve
```

In another terminal, send a first request, then start Claude Code:

```sh
TOKEN="$(cat ~/.nikhil-code-harbor/gateway.token)"
curl -s http://127.0.0.1:20130/v1/messages \
  -H "authorization: Bearer $TOKEN" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"coding","max_tokens":64,"messages":[{"role":"user","content":"Say hello"}]}'

export ANTHROPIC_BASE_URL="http://127.0.0.1:20130"
export ANTHROPIC_AUTH_TOKEN="$TOKEN"
export ANTHROPIC_MODEL=coding ANTHROPIC_DEFAULT_HAIKU_MODEL=coding \
       ANTHROPIC_DEFAULT_SONNET_MODEL=coding ANTHROPIC_DEFAULT_OPUS_MODEL=coding
claude
```

`node bin/harbor.mjs client --route coding` prints the same settings for your configuration. Claude Code also uses the Haiku slot for background tasks, so every model variable must name a route that exists. Otherwise those calls fail with `unknown_route`.

If a step fails, `node bin/harbor.mjs status` shows the last request Harbor received and why it stopped. If Harbor has **no** record of a request, Claude Code stopped before reaching it. See [Troubleshooting](docs/CLIENTS.md#troubleshooting-rate-limits-and-failures).

---

## Diagnosing a stopped request

```sh
node bin/harbor.mjs status          # readable summary
node bin/harbor.mjs status --json   # full JSON, same as GET /v1/status
```

Each failed response carries `request_id`, `category`, `provider` and `retry_at` in its JSON error, plus `x-harbor-request-id`, `retry-after` and `x-should-retry` headers. The categories are described in [docs/CLIENTS.md](docs/CLIENTS.md#failure-categories). The browser workbench at `http://127.0.0.1:20130/` shows the same provider state, last failure and recent requests.

---

## Other clients

- **OpenAI-compatible editors:** base URL `http://127.0.0.1:20130/v1`, API key = the Harbor token, model = a route alias.
- **Shell:** `git diff --cached | node bin/harbor.mjs ask --route coding --prompt "Review this" --stdin` (requires a route that declares `chat`).

---

## Configuring routes and fallback

Routes live in `~/.nikhil-code-harbor/config.json` and refer only to configured providers. For example, with the default OpenRouter free route plus your local server as a backup:

```json
{
  "routes": {
    "harbor-auto": [
      { "provider": "openrouter", "model": "openrouter/free" },
      { "provider": "local", "model": "YOUR_MODEL_ID" }
    ]
  }
}
```

Before any output starts, Harbor falls back on connection failures, first-byte timeouts, HTTP 429 (honouring `Retry-After`, capped at 7 days), 529 and 5xx. It stops without falling back on billing or spend-cap errors, `x-should-retry: false`, and invalid requests. Attempts are bounded by `maxAttempts` and `requestDeadlineMs`. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Crash handoff for Claude Code (opt-in)

`node bin/harbor.mjs handoff install` prints Claude Code hook settings. After a crash, `node bin/harbor.mjs handoff show` lists files that were already modified before the session, files changed during it, and checks whose outcome is unknown. See [docs/HANDOFF.md](docs/HANDOFF.md).

---

## Verification & Test Suite

```sh
npm run check   # syntax checks
npm test        # fixtures only; no paid inference
```

The suite covers fallback and cooldown, failure classification, 529 handling, stream completion and interruption, capability routing, Responses continuation ownership, cache-aware usage, compaction bounds, the handoff companion, and the init-to-first-request setup.

---

## Ecosystem Impact & Open Source Mission

Nikhil Code Harbor is maintained as an open-source contribution to the developer community. By democratizing resilient, multi-provider AI gateway routing, our goal is to empower developers worldwide to build reliable agentic systems without vendor lock-in or fragile single-provider dependencies.

If you are building open-source developer tooling or researching agentic workflows, contributions and collaboration are warmly invited!

---

## Documentation

- [Architecture & Protocol Design](docs/ARCHITECTURE.md)
- [Client Integration Guide](docs/CLIENTS.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Crash Handoff](docs/HANDOFF.md)
- [Security & Threat Model](SECURITY.md)
- [Contributing Guidelines](CONTRIBUTING.md)

---

## License

This project is licensed under the [MIT License](LICENSE) — free and open for personal, academic, and commercial use.
