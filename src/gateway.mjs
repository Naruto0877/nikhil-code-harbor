import { readFile } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { GatewayError, PROTOCOL_PATHS, isLoopback, validateConfig } from "./config.mjs";
import { FreeCatalog, boundedText } from "./catalog.mjs";
import { UsageStore, UsageObserver, sameToken } from "./state.mjs";
import { compactToolOutputs } from "./compact.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/app.css", ["app.css", "text/css"]],
]);
const ENDPOINTS = new Map(Object.entries(PROTOCOL_PATHS).map(([protocol, path]) => [`/v1${path}`, protocol]));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const COMMON_FIELDS = ["model", "stream", "temperature", "top_p", "tools", "tool_choice", "metadata"];
const FIELDS = {
  chat: new Set([...COMMON_FIELDS, "messages", "max_tokens", "max_completion_tokens", "stop", "presence_penalty", "frequency_penalty", "seed", "response_format", "parallel_tool_calls", "stream_options", "logprobs", "top_logprobs", "reasoning_effort"]),
  responses: new Set([...COMMON_FIELDS, "input", "instructions", "max_output_tokens", "parallel_tool_calls", "reasoning", "text", "truncation", "include", "store", "previous_response_id", "prompt_cache_key", "stream_options"]),
  messages: new Set([...COMMON_FIELDS, "messages", "system", "max_tokens", "stop_sequences", "top_k", "thinking", "output_config"]),
};

export function preparePayload(body, protocol, candidate, provider) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new GatewayError(400, "invalid_request", "JSON body must be an object");
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new GatewayError(400, "invalid_stream", "stream must be boolean");
  const unsupported = Object.keys(body).filter(k => !FIELDS[protocol].has(k));
  if (unsupported.length) throw new GatewayError(400, "unsupported_parameter", "The request contains unsupported or routing/add-on parameters");
  if (protocol !== "responses" && !Array.isArray(body.messages)) throw new GatewayError(400, "invalid_messages", "messages must be an array");
  if (protocol === "responses" && body.input === undefined && !body.previous_response_id) throw new GatewayError(400, "invalid_input", "input or previous_response_id required");
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.some(t => !t || typeof t !== "object" || Array.isArray(t) || !((protocol === "messages" && t.type === undefined) || ["function", "custom"].includes(t.type)))) {
      throw new GatewayError(400, "unsupported_tool", "Only caller-executed function/custom tools are supported; hosted paid tools are disabled");
    }
  }
  if (body.stream_options && (typeof body.stream_options !== "object" || Array.isArray(body.stream_options) || Object.keys(body.stream_options).some(k => k !== "include_usage"))) throw new GatewayError(400, "invalid_stream_options", "Only stream_options.include_usage is supported");
  if (body.store === true) throw new GatewayError(400, "response_storage_disabled", "Provider-side response storage is disabled");
  const result = { ...body, model: candidate.model };
  if (protocol === "responses") result.store = false;
  if (protocol === "chat" && body.stream) result.stream_options = { include_usage: true };
  if (provider.kind === "openrouter") {
    // The client cannot override these fields through the allowlisted body.
    result.provider = { allow_fallbacks: false, data_collection: "deny", max_price: { prompt: 0, completion: 0 } };
  }
  return result;
}

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  if (Number(req.headers["content-length"]) > limit) { req.resume(); throw new GatewayError(413, "body_too_large", "Request body exceeds the configured limit"); }
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new GatewayError(413, "body_too_large", "Request body exceeds the configured limit"); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new GatewayError(400, "invalid_json", "Request body is not valid JSON"); }
}
function requestToken(req) {
  if (req.headers.authorization !== undefined) return req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  return req.headers["x-api-key"] ?? "";
}
function validateOrigin(req) {
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { throw new GatewayError(403, "invalid_host", "Numeric loopback Host required"); }
  if (!isLoopback(host.hostname) || host.username || host.password || host.pathname !== "/" || host.search || host.hash) throw new GatewayError(403, "invalid_host", "Numeric loopback Host required");
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new GatewayError(403, "cross_origin_blocked", "Cross-origin requests are disabled");
}
function retryDelay(header, now) {
  const seconds = Number(header);
  const milliseconds = header && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Math.min(3600000, Math.max(1000, Number.isFinite(milliseconds) ? milliseconds : 30000));
}

export function createGateway({ config: rawConfig, token, env = process.env, fetchImpl = fetch, now = Date.now, usage = new UsageStore(), catalog, log = () => {} }) {
  const config = validateConfig(rawConfig);
  if (typeof token !== "string" || token.length < 32) throw new Error("Gateway authentication token must contain at least 32 characters");
  const providers = new Map(config.providers.map(p => [p.id, p]));
  const pricing = catalog ?? new FreeCatalog({ fetchImpl, now, ttlMs: config.catalogTtlMs });
  const cooldowns = new Map();
  const evidence = new Map();
  const activeControllers = new Set();
  let inFlight = 0;

  const status = () => ({
    name: "nikhil-code-harbor", version: "0.2.0", inFlight,
    policy: { directPaidFallback: false, linkedGatewayBilling: "upstream-managed", declaredFreeTiersAllowed: config.allowDeclaredFreeTiers, providerDataCollection: "deny-for-openrouter", storedPrompts: false, toolOutputLimitChars: config.toolOutputLimitChars },
    providers: config.providers.map(p => ({ id: p.id, kind: p.kind, enabled: p.enabled, credentialConfigured: !p.apiKeyEnv || Boolean(env[p.apiKeyEnv]), protocols: p.protocols, cooldownUntil: cooldowns.get(p.id) ?? null })),
    routes: Object.fromEntries(Object.entries(config.routes).map(([alias, entries]) => [alias, entries.map(c => ({ ...c, evidence: evidence.get(`${c.provider}:${c.model}`) ?? { status: "not-checked", monthlyTokens: null } }))])),
    usage: usage.snapshot(),
  });

  async function generate(req, res, protocol, body, requestId) {
    if (typeof body?.model !== "string" || !Object.hasOwn(config.routes, body.model)) throw new GatewayError(400, "unknown_route", "Choose a configured model alias from /v1/models");
    // Provider-side state is not transferable across fallback providers.
    const route = body.previous_response_id ? config.routes[body.model].slice(0, 1) : config.routes[body.model];
    const compacted = compactToolOutputs(body, protocol, config.toolOutputLimitChars);
    let lastError = new GatewayError(503, "no_eligible_provider", "No configured provider is eligible for this request");
    for (const candidate of route) {
      const provider = providers.get(candidate.provider);
      if (!provider.enabled || !provider.protocols.includes(protocol) || (provider.apiKeyEnv && !env[provider.apiKeyEnv])) continue;
      if ((cooldowns.get(provider.id) ?? 0) > now()) continue;
      // Validate the caller's request before any pricing or inference traffic.
      const payload = preparePayload(compacted.body, protocol, candidate, provider);
      try {
        evidence.set(`${provider.id}:${candidate.model}`, await pricing.verify(provider, candidate.model, config));
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        lastError = error;
        continue;
      }
      if (res.destroyed) return;
      const controller = new AbortController();
      activeControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      const disconnected = () => { if (!res.writableFinished) controller.abort(); };
      res.on("close", disconnected);
      let upstream;
      const observe = new UsageObserver();
      try {
        const headers = { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" };
        if (provider.apiKeyEnv) {
          const key = env[provider.apiKeyEnv];
          if (/[\r\n]/.test(key)) throw new GatewayError(503, "invalid_credential", "Configured provider credential is invalid");
          headers[provider.authHeader ?? "authorization"] = provider.authHeader === "x-api-key" ? key : `Bearer ${key}`;
        }
        if (protocol === "messages") headers["anthropic-version"] = "2023-06-01";
        try {
          upstream = await fetchImpl(`${provider.baseUrl}${PROTOCOL_PATHS[protocol]}`, { method: "POST", headers, body: JSON.stringify(payload), redirect: "error", signal: controller.signal });
        } catch {
          if (res.destroyed) return;
          lastError = new GatewayError(503, "upstream_unavailable", `Provider ${provider.id} did not return a response`);
          cooldowns.set(provider.id, now() + 30000);
          await usage.record(provider.id, { success: false, status: 503 });
          continue;
        }
        if (!upstream.ok) {
          const code = upstream.status;
          if (upstream.body) await upstream.body.cancel();
          await usage.record(provider.id, { success: false, status: code });
          if (RETRYABLE.has(code)) {
            cooldowns.set(provider.id, now() + retryDelay(upstream.headers.get("retry-after"), now()));
            lastError = new GatewayError(503, "providers_exhausted", "Eligible providers are rate-limited or temporarily unavailable");
            continue;
          }
          throw new GatewayError(code === 400 || code === 422 ? 400 : 502, "upstream_rejected", `Provider ${provider.id} rejected the request (HTTP ${code}); credentials and upstream error bodies are not exposed`);
        }
        const streaming = upstream.headers.get("content-type")?.includes("text/event-stream");
        const responseHeaders = { "content-type": streaming ? "text/event-stream" : "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-harbor-provider": provider.id, "x-harbor-model": candidate.model, "x-harbor-request-id": requestId, "x-harbor-omitted-tool-chars": String(compacted.removedChars) };
        if (streaming) {
          if (!upstream.body) throw new GatewayError(502, "empty_upstream", "Provider returned an empty stream");
          res.writeHead(200, responseHeaders);
          for await (const chunk of upstream.body) {
            observe.push(chunk);
            if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal });
          }
          // Never retry after an upstream success/stream has started.
          res.end();
        } else {
          const text = await boundedText(upstream, 16 * 1024 * 1024);
          let parsed;
          try { parsed = JSON.parse(text); } catch { throw new GatewayError(502, "invalid_upstream_json", "Provider returned invalid JSON"); }
          observe.observe(parsed);
          res.writeHead(200, responseHeaders);
          res.end(text);
        }
        await usage.record(provider.id, { success: !observe.failed, status: observe.failed ? 502 : 200, ...observe.result() });
        log({ requestId, provider: provider.id, status: 200 });
        return;
      } catch (error) {
        if (upstream?.ok) await usage.record(provider.id, { success: false, status: 502, ...observe.result() });
        if (res.headersSent || res.destroyed) { res.destroy(); return; }
        throw error instanceof GatewayError ? error : new GatewayError(502, "upstream_interrupted", "Provider response was interrupted; request was not replayed");
      } finally {
        clearTimeout(timer);
        res.off("close", disconnected);
        activeControllers.delete(controller);
      }
    }
    throw lastError;
  }

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    let counted = false;
    try {
      validateOrigin(req);
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (req.method === "GET" && assets.has(pathname)) {
        const [file, type] = assets.get(pathname);
        const asset = await readFile(new URL("../web/" + file, import.meta.url));
        res.writeHead(200, { "content-type": type + "; charset=utf-8", "cache-control": "no-store",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        res.end(asset);
        return;
      }
      if (req.method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });
      if (!sameToken(requestToken(req), token)) throw new GatewayError(401, "authentication_required", "A valid gateway token is required");
      if (req.method === "GET" && pathname === "/v1/status") return json(res, 200, status());
      if (req.method === "GET" && pathname === "/v1/models") return json(res, 200, { object: "list", data: Object.keys(config.routes).map(id => ({ id, object: "model", created: 0, owned_by: "nikhil-code-harbor" })) });
      const protocol = ENDPOINTS.get(pathname);
      if (req.method !== "POST" || !protocol) throw new GatewayError(404, "not_found", "Endpoint not supported");
      if (inFlight >= (config.maxConcurrentRequests ?? 4)) throw new GatewayError(429, "gateway_busy", "Gateway concurrency limit reached");
      const type = req.headers["content-type"]?.split(";")[0].trim();
      if (type !== "application/json") throw new GatewayError(415, "json_required", "Content-Type application/json required");
      inFlight++; counted = true;
      const body = await readBody(req, config.maxBodyBytes);
      await generate(req, res, protocol, body, requestId);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else json(res, error instanceof GatewayError ? error.status : 500, { error: { type: error instanceof GatewayError ? error.code : "gateway_error", message: error instanceof GatewayError ? error.message : "Gateway request failed", request_id: requestId } });
    } finally { if (counted) inFlight--; }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return {
    server, config, status, pricing,
    async listen() { server.listen(config.port, config.host); await once(server, "listening"); return server.address(); },
    async close() {
      for (const controller of activeControllers) controller.abort();
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
