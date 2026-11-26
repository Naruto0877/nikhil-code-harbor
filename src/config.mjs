import { readFile } from "node:fs/promises";

export const PROTOCOL_PATHS = Object.freeze({
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
});
// Optional per-provider feature declarations. A provider without a `capabilities`
// list is assumed to accept every feature except provider-side response storage,
// which must always be declared explicitly.
export const CAPABILITIES = Object.freeze(["tools", "streaming", "thinking", "prompt_caching", "context_management", "anthropic_beta", "response_storage"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"]);
export function isLoopback(host) { return LOCAL_HOSTS.has(host); }

export const safeModelId = id => typeof id === "string" && id.length < 256 && /^[\x21-\x7e]+$/.test(id);

export class GatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireConfig(condition, message) {
  if (!condition) throw new Error(`Invalid configuration: ${message}`);
}
function boundedInteger(value, fallback, min, max, name) {
  const n = value ?? fallback;
  requireConfig(Number.isInteger(n) && n >= min && n <= max, name);
  return n;
}

export function validateConfig(input) {
  requireConfig(input && typeof input === "object" && !Array.isArray(input), "expected an object");
  const config = structuredClone(input);
  config.host ??= "127.0.0.1";
  requireConfig(isLoopback(config.host), "host must be a numeric loopback address");
  config.port = boundedInteger(config.port, 20130, 0, 65535, "port");
  config.requestTimeoutMs = boundedInteger(config.requestTimeoutMs, 180000, 100, 900000, "requestTimeoutMs");
  // Time allowed for an upstream's response headers and first body byte.
  config.firstByteTimeoutMs = boundedInteger(config.firstByteTimeoutMs, config.requestTimeoutMs, 100, 900000, "firstByteTimeoutMs");
  // Longest silence allowed between body chunks once a response has started.
  config.streamIdleTimeoutMs = boundedInteger(config.streamIdleTimeoutMs, 120000, 100, 900000, "streamIdleTimeoutMs");
  // Overall budget for the whole request: provider selection, attempts, and streaming.
  config.requestDeadlineMs = boundedInteger(config.requestDeadlineMs, Math.max(1800000, config.firstByteTimeoutMs), 100, 3600000, "requestDeadlineMs");
  config.maxAttempts = boundedInteger(config.maxAttempts, 3, 1, 20, "maxAttempts");
  config.catalogTtlMs = boundedInteger(config.catalogTtlMs, 300000, 100, 3600000, "catalogTtlMs");
  config.maxBodyBytes = boundedInteger(config.maxBodyBytes, 2097152, 1024, 16777216, "maxBodyBytes");
  config.maxConcurrentRequests = boundedInteger(config.maxConcurrentRequests, 4, 1, 64, "maxConcurrentRequests");
  config.toolOutputLimitChars = boundedInteger(config.toolOutputLimitChars, 0, 0, 200000, "toolOutputLimitChars");
  requireConfig(config.toolOutputLimitChars === 0 || config.toolOutputLimitChars >= 256, "toolOutputLimitChars must be zero (disabled) or at least 256");
  config.toolOutputBudgetChars = boundedInteger(config.toolOutputBudgetChars, config.toolOutputLimitChars * 4, 0, 800000, "toolOutputBudgetChars");
  requireConfig(config.toolOutputLimitChars === 0 ? config.toolOutputBudgetChars === 0 : config.toolOutputBudgetChars >= config.toolOutputLimitChars, "toolOutputBudgetChars must be at least toolOutputLimitChars (and zero when compaction is disabled)");
  config.allowDeclaredFreeTiers ??= false;
  requireConfig(typeof config.allowDeclaredFreeTiers === "boolean", "allowDeclaredFreeTiers must be boolean");
  requireConfig(Array.isArray(config.providers) && config.providers.length > 0, "providers must be nonempty");
  const ids = new Set();
  for (const p of config.providers) {
    requireConfig(typeof p.id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(p.id) && !ids.has(p.id), "unique provider IDs required");
    ids.add(p.id);
    requireConfig(["openrouter", "declared-free-tier", "local", "linked-gateway"].includes(p.kind), `unsupported kind for ${p.id}`);
    requireConfig(p.enabled === undefined || typeof p.enabled === "boolean", `enabled for ${p.id}`);
    p.enabled ??= true;
    let url;
    try { url = new URL(p.baseUrl); } catch { throw new Error(`Invalid base URL for ${p.id}`); }
    requireConfig(!url.username && !url.password && !url.search && !url.hash, `base URL cannot contain credentials, a query, or a fragment: ${p.id}`);
    requireConfig(url.protocol === "https:" || (["local", "linked-gateway"].includes(p.kind) && url.protocol === "http:" && isLoopback(url.hostname)), `HTTPS required for ${p.id}`);
    requireConfig(p.kind !== "local" || isLoopback(url.hostname), `local provider must use numeric loopback: ${p.id}`);
    if (p.kind === "linked-gateway") {
      requireConfig(isLoopback(url.hostname) && url.pathname.replace(/\/$/, "") === "/v1", "linked gateways require a numeric loopback /v1 endpoint");
      requireConfig(Number(url.port || (url.protocol === "https:" ? 443 : 80)) !== config.port, "a linked gateway must use a different listener port");
    }
    if (p.kind === "openrouter") {
      requireConfig(url.origin === "https://openrouter.ai" && url.pathname.replace(/\/$/, "") === "/api/v1", "OpenRouter endpoint is fixed so credentials and price checks use the same service");
    }
    p.baseUrl = url.href.replace(/\/$/, "");
    requireConfig(Array.isArray(p.protocols) && p.protocols.length > 0 && p.protocols.every(x => Object.hasOwn(PROTOCOL_PATHS, x)), `protocols for ${p.id}`);
    requireConfig(!p.apiKeyEnv || /^[A-Z][A-Z0-9_]*$/.test(p.apiKeyEnv), `API key environment variable for ${p.id}`);
    requireConfig(p.kind === "local" || Boolean(p.apiKeyEnv), `API key environment variable required for ${p.id}`);
    requireConfig(p.capabilities === undefined || (Array.isArray(p.capabilities) && p.capabilities.every(c => CAPABILITIES.includes(c))), `capabilities for ${p.id} must be a list drawn from: ${CAPABILITIES.join(", ")}`);
    requireConfig(!p.authHeader || ["authorization", "x-api-key"].includes(p.authHeader), `authHeader for ${p.id}`);
    // Keys in config are rejected rather than accidentally committed or displayed.
    requireConfig(!Object.keys(p).some(k => /^(apiKey|token|secret|headers)$/i.test(k)), `credentials must be environment variables: ${p.id}`);
  }
  requireConfig(config.routes && typeof config.routes === "object" && !Array.isArray(config.routes), "routes required");
  requireConfig(Object.keys(config.routes).length > 0, "at least one route required");
  for (const [alias, candidates] of Object.entries(config.routes)) {
    requireConfig(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(alias), "route alias");
    requireConfig(Array.isArray(candidates) && candidates.length > 0 && candidates.length <= 20, `candidates for ${alias}`);
    let linkedCount = 0;
    for (const c of candidates) {
      requireConfig(c && ids.has(c.provider) && safeModelId(c.model), `candidate for ${alias}`);
      if (config.providers.find(p => p.id === c.provider).kind === "linked-gateway") linkedCount++;
    }
    requireConfig(linkedCount === 0 || linkedCount === candidates.length, "linked gateways need their own route");
  }
  return config;
}

export async function loadConfig(path) {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}
