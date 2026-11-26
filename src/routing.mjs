import { GatewayError } from "./config.mjs";

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
// Beta names that concern credentials rather than request features are never forwarded.
const BLOCKED_BETA = /^oauth-/i;

// Anthropic protocol headers the client may set. The client's own credential
// (the Harbor token) is never forwarded; the provider's key is added separately.
export function anthropicHeaders(headers) {
  const version = headers["anthropic-version"];
  if (version !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(version)) throw new GatewayError(400, "invalid_anthropic_version", "anthropic-version must be a date such as 2023-06-01");
  const out = { "anthropic-version": version ?? DEFAULT_ANTHROPIC_VERSION };
  const raw = headers["anthropic-beta"];
  const betas = [];
  if (raw !== undefined) {
    for (const value of String(raw).split(",").map(x => x.trim()).filter(Boolean)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(value)) throw new GatewayError(400, "invalid_anthropic_beta", "anthropic-beta must be a comma-separated list of beta names");
      if (!BLOCKED_BETA.test(value)) betas.push(value);
    }
    if (betas.length > 32) throw new GatewayError(400, "invalid_anthropic_beta", "Too many anthropic-beta values");
  }
  if (betas.length) out["anthropic-beta"] = betas.join(",");
  return out;
}

function hasCacheControl(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(v => hasCacheControl(v, depth + 1));
  if (Object.hasOwn(value, "cache_control")) return true;
  return ["content", "system", "tools", "messages"].some(k => hasCacheControl(value[k], depth + 1));
}

// Capabilities a candidate must offer to serve this request without losing meaning.
export function requiredCapabilities(body, protocol, headers = {}) {
  const required = new Set();
  if (Array.isArray(body.tools) && body.tools.length) required.add("tools");
  if (body.stream === true) required.add("streaming");
  if (protocol === "messages") {
    if (body.thinking !== undefined) required.add("thinking");
    if (body.context_management !== undefined) required.add("context_management");
    if (hasCacheControl(body)) required.add("prompt_caching");
    if (headers["anthropic-beta"]) required.add("anthropic_beta");
  }
  if (protocol === "responses" && (body.store === true || body.previous_response_id !== undefined)) required.add("response_storage");
  return required;
}

export function supports(provider, capability) {
  if (capability === "response_storage") return Array.isArray(provider.capabilities) && provider.capabilities.includes(capability);
  return !Array.isArray(provider.capabilities) || provider.capabilities.includes(capability);
}

// Returns null when eligible, otherwise a short reason that never contains secrets.
export function skipReason(provider, protocol, required, env) {
  if (!provider.enabled) return "disabled";
  if (!provider.protocols.includes(protocol)) return `does not declare the ${protocol} protocol (declares ${provider.protocols.join(", ")})`;
  if (provider.apiKeyEnv && !env[provider.apiKeyEnv]) return `credential environment variable ${provider.apiKeyEnv} is not set`;
  const missing = [...required].filter(c => !supports(provider, c));
  if (missing.length) return `does not declare required capabilities: ${missing.join(", ")}`;
  return null;
}
