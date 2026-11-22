# Nikhil Code Harbor

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/Dependencies-0%20(Pure%20Node)-brightgreen.svg)](package.json)
[![Protocols](https://img.shields.io/badge/Protocols-Anthropic%20%7C%20OpenAI%20%7C%20Codex-orange.svg)](docs/CLIENTS.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**A high-performance, local-first AI coding gateway and developer workbench designed for agentic workflows.**  
*Native Anthropic Messages & OpenAI protocol routing, byte-preserving SSE streaming, multi-gateway fallback, and live browser monitoring.*

[Quick Start](#quick-start) • [Claude Code Integration](#claude-code--terminal-workflows) • [Architecture](docs/ARCHITECTURE.md) • [Client Integrations](docs/CLIENTS.md) • [Contributing](CONTRIBUTING.md)

</div>

---

## Overview

Modern agentic coding assistants—such as **Claude Code**, VS Code Copilot, Cursor, and Continue.dev—frequently hit provider rate limits (HTTP 429), regional outages, or context window bottlenecks during intensive multi-file refactoring and testing sessions.

**Nikhil Code Harbor** solves this by acting as a lightweight, zero-latency local proxy and resilience layer:
1. **Unified Routing:** Map alias routes (e.g. `coding`) across multiple upstream providers or local model runtimes.
2. **Resilient Failover:** When an upstream provider returns a 429 rate limit or 5xx server error, Harbor automatically fails over to the next configured candidate before output starts.
3. **Exact Wire Protocol Preservation:** Natively implements the **Anthropic Messages API**, **OpenAI Chat Completions**, and **Codex Responses**—faithfully forwarding Server-Sent Events (SSE), tool-call deltas, and reasoning chunks without lossy transformations.
4. **Agentic Tool Compaction:** Optional bounded reduction for massive tool outputs (such as huge test logs or git diffs) to protect model context windows while preserving prompt integrity.
5. **Zero External Dependencies:** Implemented in pure, modern Node.js using standard library primitives (`node:http`, `node:crypto`, `node:events`).

---

## System Architecture

```text
       [ Claude Code CLI ]     [ VS Code / Continue ]     [ Shell Pipelines ]
                │                       │                         │
                └───────────────────────┼─────────────────────────┘
                                        │
                                        ▼
                      ┌───────────────────────────────────┐
                      │    Nikhil Code Harbor Gateway     │
                      │    (Loopback: 127.0.0.1:20130)    │
                      └─────────────────┬─────────────────┘
                                        │
         ┌──────────────────────────────┼──────────────────────────────┐
         ▼                              ▼                              ▼
┌──────────────────┐           ┌──────────────────┐           ┌──────────────────┐
│ Anthropic API    │           │ OpenRouter /     │           │ Local Engines    │
│ (Claude Sonnet/  │◄─Fallback─┤ Declared Tiers   │◄─Fallback─┤ (Ollama, vLLM,   │
│  Opus / Haiku)   │           │ (Zero-Price IDs) │           │  Local Proxies)  │
└──────────────────┘           └──────────────────┘           └──────────────────┘
```

---

## Features

- **Native Anthropic Messages Endpoint (`/v1/messages`):** Seamless drop-in gateway for Claude-based coding tools, preserving reasoning tokens, tool declarations, and live streaming.
- **Automated Fallback & Cooldown Engine:** Smart exponential backoff and provider cooldowns preventing repeated hammering of rate-limited endpoints.
- **Interactive Browser Console:** Built-in web UI served directly at `http://127.0.0.1:20130/` to test prompts, inspect active routes, view latency, and monitor fallback events.
- **Privacy & Security First:** Binds strictly to numeric loopback (`127.0.0.1`), enforces local token authentication, keeps credentials out of logs and git, and stores only local aggregate counters.
- **Lossless SSE Streaming:** Preserves exact raw chunk boundaries and event structures required by agentic CLI tools.

---

## Quick Start

Requires Node.js 22 or newer.

```sh
# 1. Clone the repository
git clone https://github.com/Naruto0877/nikhil-code-harbor.git
cd nikhil-code-harbor

# 2. Initialize configuration and generate a private gateway token
node bin/harbor.mjs init

# 3. Start the local Harbor gateway
node bin/harbor.mjs serve
```

Harbor starts immediately on `http://127.0.0.1:20130`. Your private authentication token is generated at `~/.nikhil-code-harbor/gateway.token`.

---

## Claude Code & Terminal Workflows

Harbor is optimized for agentic coding tools like **Claude Code**. You can direct terminal coding sessions through Harbor to benefit from automatic gateway fallback, request telemetry, and multi-model routing:

```sh
# Point Claude Code to your local Harbor gateway
export ANTHROPIC_BASE_URL="http://127.0.0.1:20130"
export ANTHROPIC_API_KEY="$(cat ~/.nikhil-code-harbor/gateway.token)"

# Launch Claude Code using your configured route alias
claude --model coding
```

### Automated Git Diff Code Reviews

Pipe staged code directly into your Harbor route from the terminal:

```sh
git diff --cached | node bin/harbor.mjs ask \
  --route coding \
  --prompt "Perform a rigorous code review on these staged changes. Flag potential bugs, regressions, or security concerns." \
  --stdin
```

---

## IDE & Editor Integration

Connect VS Code, Cursor, or Continue.dev using Harbor as an OpenAI-compatible endpoint:

- **Base URL:** `http://127.0.0.1:20130/v1`
- **API Key:** Value of `HARBOR_GATEWAY_TOKEN` (from `~/.nikhil-code-harbor/gateway.token`)
- **Model:** Your configured alias (e.g. `coding` or `harbor-auto`)

Inspect your custom setup string anytime:
```sh
node bin/harbor.mjs client --route coding
```

---

## Configuring Routes & Fallback

Configure candidate gateways in priority order in `~/.nikhil-code-harbor/config.json`:

```json
{
  "host": "127.0.0.1",
  "port": 20130,
  "routes": {
    "coding": [
      { "provider": "anthropic", "model": "claude-3-7-sonnet-20250219" },
      { "provider": "openrouter", "model": "anthropic/claude-3.5-sonnet" },
      { "provider": "local", "model": "qwen2.5-coder-32b" }
    ]
  }
}
```

If the primary candidate encounters an HTTP 429 rate limit or network timeout, Harbor seamlessly attempts the next candidate in the chain before responding to the client.

---

## Verification & Test Suite

The project includes unit, gateway, and integration test suites utilizing simulated local HTTP providers:

```sh
# Run syntax and static module integrity checks
npm run check

# Run full automated test suite
npm test
```

Test coverage exercises:
- Native SSE event-stream forwarding and chunk preservation
- Tool call deltas and function argument buffering
- Host and Origin header enforcement (preventing DNS rebinding / CSRF)
- Non-leaking error responses (provider tokens and internal headers are never exposed)
- Bounded memory usage and request concurrency limits

---

## Ecosystem Impact & Open Source Mission

Nikhil Code Harbor is maintained as an open-source contribution to the developer community. By democratizing resilient, multi-provider AI gateway routing, our goal is to empower developers worldwide to build reliable agentic systems without vendor lock-in or fragile single-provider dependencies.

If you are building open-source developer tooling or researching agentic workflows, contributions and collaboration are warmly invited!

---

## Documentation

- [Architecture & Protocol Design](docs/ARCHITECTURE.md)
- [Client Integration Guide](docs/CLIENTS.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Security & Threat Model](SECURITY.md)
- [Contributing Guidelines](CONTRIBUTING.md)

---

## License

This project is licensed under the [MIT License](LICENSE) — free and open for personal, academic, and commercial use.
