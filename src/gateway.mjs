import { readFile } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { GatewayError, PROTOCOL_PATHS, isLoopback, validateConfig } from "./config.mjs";
import { FreeCatalog } from "./catalog.mjs";
import { UsageStore, sameToken } from "./state.mjs";
import { StreamObserver } from "./observe.mjs";
import { compactToolOutputs, validateToolShapes } from "./compact.mjs";
import { anthropicHeaders, requiredCapabilities, skipReason, supports } from "./routing.mjs";
import { CATEGORIES, RequestLog, classifyUpstream, readErrorInfo } from "./diagnostics.mjs";

const VERSION = "0.3.0";
const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/app.css", ["app.css", "text/css"]],
]);
const ENDPOINTS = new Map(Object.entries(PROTOCOL_PATHS).map(([protocol, path]) => [`/v1${path}`, protocol]));
const COMMON_FIELDS = ["model", "stream", "temperature", "top_p", "tools", "tool_choice", "metadata"];
const FIELDS = {
  chat: new Set([...COMMON_FIELDS, "messages", "max_tokens", "max_completion_tokens", "stop", "presence_penalty", "frequency_penalty", "seed", "response_format", "parallel_tool_calls", "stream_options", "logprobs", "top_logprobs", "reasoning_effort"]),
  responses: new Set([...COMMON_FIELDS, "input", "instructions", "max_output_tokens", "parallel_tool_calls", "reasoning", "text", "truncation", "include", "store", "previous_response_id", "prompt_cache_key", "stream_options"]),
  messages: new Set([...COMMON_FIELDS, "messages", "system", "max_tokens", "stop_sequences", "top_k", "thinking", "output_config", "cache_control", "context_management"]),
};
const DEFAULT_COOLDOWN_MS = 30000;
const MAX_RESPONSE_OWNERS = 2000;
const STATUS_FOR = {
  upstream_rate_limited: 429, upstream_overloaded: 529, upstream_unavailable: 503, first_byte_timeout: 504,
  deadline_exceeded: 504, attempt_limit: 503, no_eligible_candidate: 503, all_candidates_cooling: 503,
};

// Validates the caller's request. Runs once, before any pricing or inference traffic.
export function validateRequest(body, protocol) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new GatewayError(400, "invalid_request", "JSON body must be an object");
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new GatewayError(400, "invalid_stream", "stream must be boolean");
  const unsupported = Object.keys(body).filter(k => !FIELDS[protocol].has(k));
  if (unsupported.length) throw new GatewayError(400, "unsupported_parameter", `Unsupported or routing/add-on parameters: ${unsupported.slice(0, 5).map(k => k.slice(0, 40)).join(", ")}`);
  if (protocol !== "responses" && !Array.isArray(body.messages)) throw new GatewayError(400, "invalid_messages", "messages must be an array");
  if (protocol === "responses" && body.input === undefined && !body.previous_response_id) throw new GatewayError(400, "invalid_input", "input or previous_response_id required");
  if (body.previous_response_id !== undefined && (typeof body.previous_response_id !== "string" || body.previous_response_id.length > 255)) throw new GatewayError(400, "invalid_previous_response_id", "previous_response_id must be a string");
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.some(t => !t || typeof t !== "object" || Array.isArray(t) || !((protocol === "messages" && t.type === undefined) || ["function", "custom"].includes(t.type)))) {
      throw new GatewayError(400, "unsupported_tool", "Only caller-executed function/custom tools are supported; hosted paid tools are disabled");
    }
  }
  if (body.context_management !== undefined && (typeof body.context_management !== "object" || body.context_management === null || Array.isArray(body.context_management))) throw new GatewayError(400, "invalid_context_management", "context_management must be an object");
  if (body.cache_control !== undefined && (typeof body.cache_control !== "object" || body.cache_control === null || body.cache_control.type !== "ephemeral")) throw new GatewayError(400, "invalid_cache_control", "cache_control must be {\"type\":\"ephemeral\"} with an optional ttl");
  if (body.stream_options && (typeof body.stream_options !== "object" || Array.isArray(body.stream_options) || Object.keys(body.stream_options).some(k => k !== "include_usage"))) throw new GatewayError(400, "invalid_stream_options", "Only stream_options.include_usage is supported");
  if (body.store !== undefined && typeof body.store !== "boolean") throw new GatewayError(400, "invalid_store", "store must be boolean");
}

// Builds the upstream body. Key order and every unmodified value are preserved so
// the forwarded prefix stays byte-stable across turns (prompt-cache friendly).
export function buildPayload(body, protocol, candidate, provider) {
  const result = { ...body, model: candidate.model };
  if (protocol === "responses") result.store = body.store === true && supports(provider, "response_storage");
  if (protocol === "chat" && body.stream) result.stream_options = { include_usage: true };
  if (provider.kind === "openrouter") {
    // The client cannot override these fields through the allowlisted body.
    result.provider = { allow_fallbacks: false, data_collection: "deny", max_price: { prompt: 0, completion: 0 } };
  }
  return result;
}

export function preparePayload(body, protocol, candidate, provider) {
  validateRequest(body, protocol);
  return buildPayload(body, protocol, candidate, provider);
}

function errorBody(error, requestId) {
  const known = error instanceof GatewayError;
  return { type: "error", error: {
    type: known ? error.code : "gateway_error",
    message: known ? error.message : "Gateway request failed",
    request_id: requestId,
    category: error.category ?? (known ? undefined : "unknown"),
    provider: error.provider ?? undefined,
    retry_at: error.retryAt ? new Date(error.retryAt).toISOString() : undefined,
  } };
}
function json(res, status, body, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(JSON.stringify(body));
}
async function readBody(req, limit) {
  const tooLarge = size => new GatewayError(413, "body_too_large", `Request body${size ? ` (${size} bytes)` : ""} exceeds maxBodyBytes (${limit} bytes) and was rejected before compaction or routing. Raise maxBodyBytes in config.json (up to 16777216) and restart Harbor, or send less tool output in this turn.`);
  let size = 0;
  const chunks = [];
  const declared = Number(req.headers["content-length"]);
  if (declared > limit) { req.resume(); throw tooLarge(declared); }
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw tooLarge(); }
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
function failure(status, code, category, message, extra = {}) {
  return Object.assign(new GatewayError(status, code, message), { category, ...extra });
}
const iso = ms => ms ? new Date(ms).toISOString() : null;

export function createGateway({ config: rawConfig, token, env = process.env, fetchImpl = fetch, now = Date.now, usage = new UsageStore(), catalog, log = () => {} }) {
  const config = validateConfig(rawConfig);
  if (typeof token !== "string" || token.length < 32) throw new Error("Gateway authentication token must contain at least 32 characters");
  const providers = new Map(config.providers.map(p => [p.id, p]));
  const pricing = catalog ?? new FreeCatalog({ fetchImpl, now, ttlMs: config.catalogTtlMs });
  const cooldowns = new Map();
  const evidence = new Map();
  const owners = new Map();
  const activeControllers = new Set();
  const requests = new RequestLog();
  let inFlight = 0;

  const coolingFor = id => { const c = cooldowns.get(id); return c && c.until > now() ? c : null; };
  const status = () => ({
    name: "nikhil-code-harbor", version: VERSION, inFlight, maxConcurrentRequests: config.maxConcurrentRequests,
    policy: { directPaidFallback: false, linkedGatewayBilling: "upstream-managed", declaredFreeTiersAllowed: config.allowDeclaredFreeTiers, providerDataCollection: "deny-for-openrouter", storedPrompts: false, toolOutputLimitChars: config.toolOutputLimitChars, toolOutputBudgetChars: config.toolOutputBudgetChars },
    providers: config.providers.map(p => {
      const c = coolingFor(p.id);
      return { id: p.id, kind: p.kind, enabled: p.enabled, credentialConfigured: !p.apiKeyEnv || Boolean(env[p.apiKeyEnv]), protocols: p.protocols, capabilities: p.capabilities ?? "undeclared", cooldownUntil: c?.until ?? null, cooldown: c ? { until: iso(c.until), category: c.category, retryAfterKnown: c.retryKnown, since: iso(c.since) } : null };
    }),
    routes: Object.fromEntries(Object.entries(config.routes).map(([alias, entries]) => [alias, entries.map(c => ({ ...c, evidence: evidence.get(`${c.provider}:${c.model}`) ?? { status: "not-checked", monthlyTokens: null } }))])),
    requests: requests.snapshot(),
    usage: usage.snapshot(),
  });

  function setCooldown(provider, category, retryMs) {
    const known = Number.isFinite(retryMs);
    // A provider's own Retry-After is honored in full (already bounded by MAX_RETRY_AFTER_MS).
    const until = now() + Math.max(1000, known ? retryMs : DEFAULT_COOLDOWN_MS);
    cooldowns.set(provider.id, { until, category, retryKnown: known, since: now() });
    return { until, known };
  }

  // One upstream attempt. Resolves to { done: true } once the client has a
  // response (or has gone), or { done: false } to try the next candidate.
  // Throws a GatewayError to stop the route without fallback.
  async function attempt({ req, res, protocol, body, entry, provider, candidate, payload, anthropic, deadline, fallback }) {
    const controller = new AbortController();
    let abortReason = null, reader = null;
    // Cancelling the reader as well as the signal makes every body source stop promptly.
    const abort = reason => { if (!abortReason) abortReason = reason; controller.abort(); reader?.cancel().catch(() => {}); };
    activeControllers.add(controller);
    // Three independent timers: first byte, idle gap after output, and the request's overall deadline.
    let timer = setTimeout(() => abort("first_byte_timeout"), config.firstByteTimeoutMs);
    const deadlineTimer = setTimeout(() => abort("deadline_exceeded"), Math.max(1, deadline - now()));
    const disconnected = () => { if (!res.writableFinished) abort("client_cancelled"); };
    res.on("close", disconnected);
    const started = now();
    const record = { provider: provider.id, model: candidate.model, startedAt: iso(started) };
    entry.attempts.push(record);
    const observe = new StreamObserver(protocol);
    const finish = async (outcome, category, extra = {}) => {
      Object.assign(record, { outcome, category: category ?? null, ms: now() - started, ...extra });
      await usage.record(provider.id, { success: outcome === "completed", status: record.status ?? 0, outcome, category, fallback, ...observe.result() });
    };
    try {
      const headers = { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" };
      if (protocol === "messages") Object.assign(headers, anthropic);
      if (provider.apiKeyEnv) {
        const key = env[provider.apiKeyEnv];
        if (/[\r\n]/.test(key)) throw failure(503, "invalid_credential", "upstream_rejected", "Configured provider credential is invalid", { provider: provider.id });
        headers[provider.authHeader ?? "authorization"] = provider.authHeader === "x-api-key" ? key : `Bearer ${key}`;
      }
      let upstream;
      try {
        upstream = await fetchImpl(`${provider.baseUrl}${PROTOCOL_PATHS[protocol]}`, { method: "POST", headers, body: JSON.stringify(payload), redirect: "error", signal: controller.signal });
      } catch {
        if (abortReason === "client_cancelled") { await finish("client_cancelled", "client_cancelled"); return { done: true, cancelled: true }; }
        if (abortReason === "deadline_exceeded") { await finish("failed", "deadline_exceeded"); return { done: false, category: "deadline_exceeded", stop: true }; }
        const category = abortReason === "first_byte_timeout" ? "first_byte_timeout" : "upstream_unavailable";
        const cd = setCooldown(provider, category, null);
        await finish("failed", category, { cooldownUntil: iso(cd.until) });
        return { done: false, category };
      }
      record.status = upstream.status;
      if (!upstream.ok) {
        const info = await readErrorInfo(upstream);
        const cls = classifyUpstream(upstream.status, upstream.headers, info, now());
        if (cls.temporary) {
          const cd = setCooldown(provider, cls.category, cls.retryMs);
          await finish("failed", cls.category, { cooldownUntil: iso(cd.until), retryAfterKnown: cd.known });
          return { done: false, category: cls.category };
        }
        if (cls.retryMs !== null) setCooldown(provider, cls.category, cls.retryMs);
        await finish("failed", cls.category);
        const retryAt = cls.retryMs !== null ? now() + cls.retryMs : undefined;
        if (cls.category === "upstream_billing") throw failure(402, "upstream_billing", "upstream_billing", `Provider ${provider.id} reported a spend cap, credit, quota, or billing restriction (HTTP ${upstream.status}). Harbor stopped instead of sending the conversation to another provider. Resolve it in that provider's account.`, { provider: provider.id, retryAt, noRetry: true });
        if (cls.category === "upstream_no_retry") throw failure(upstream.status, "upstream_no_retry", "upstream_no_retry", `Provider ${provider.id} returned HTTP ${upstream.status} with x-should-retry: false. Harbor stopped without fallback.`, { provider: provider.id, retryAt, noRetry: true });
        throw failure(upstream.status === 400 || upstream.status === 422 ? 400 : 502, "upstream_rejected", "upstream_rejected", `Provider ${provider.id} rejected the request (HTTP ${upstream.status}); credentials and upstream error bodies are not exposed`, { provider: provider.id, noRetry: true });
      }
      const streaming = upstream.headers.get("content-type")?.includes("text/event-stream");
      if (!upstream.body) { await finish("failed", "upstream_unavailable"); setCooldown(provider, "upstream_unavailable", null); return { done: false, category: "upstream_unavailable" }; }
      reader = upstream.body.getReader();
      const read = async () => {
        try { return await reader.read(); }
        catch (error) { return { error }; }
      };
      // Pre-output: wait for the first body byte under the first-byte timer.
      // Nothing has reached the client yet, so failure here may still fall back.
      const first = await read();
      clearTimeout(timer);
      if (first.error || first.done || abortReason) {
        if (abortReason === "client_cancelled") { await finish("client_cancelled", "client_cancelled"); return { done: true, cancelled: true }; }
        if (abortReason === "deadline_exceeded") { await finish("failed", "deadline_exceeded"); return { done: false, category: "deadline_exceeded", stop: true }; }
        const category = abortReason === "first_byte_timeout" ? "first_byte_timeout" : "upstream_unavailable";
        setCooldown(provider, category, null);
        await finish("failed", category);
        return { done: false, category };
      }
      const idle = () => { clearTimeout(timer); timer = setTimeout(() => abort("stream_idle_timeout"), config.streamIdleTimeoutMs); };
      entry.provider = provider.id; entry.model = candidate.model; entry.fallback = fallback;
      const responseHeaders = { "content-type": streaming ? "text/event-stream" : "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-harbor-provider": provider.id, "x-harbor-model": candidate.model, "x-harbor-request-id": entry.id, "x-harbor-fallback": String(fallback), "x-harbor-omitted-tool-chars": String(entry.omittedToolChars) };
      let outcome, category = null;
      if (streaming) {
        res.writeHead(200, responseHeaders);
        // From here on, output has begun: never retry or replay to another provider.
        let chunk = first;
        while (true) {
          observe.push(chunk.value);
          if (!res.write(chunk.value)) {
            idle();
            try { await once(res, "drain", { signal: controller.signal }); } catch { /* handled below */ }
            if (abortReason) break;
          }
          idle();
          chunk = await read();
          if (chunk.error || chunk.done || abortReason) break;
        }
        clearTimeout(timer);
        if (abortReason === "client_cancelled") { outcome = "client_cancelled"; category = "client_cancelled"; }
        else if (abortReason === "stream_idle_timeout") { outcome = "interrupted"; category = "stream_idle_timeout"; }
        else if (abortReason === "deadline_exceeded") {
          outcome = "interrupted"; category = "deadline_exceeded";
          entry.detail = `requestDeadlineMs (${config.requestDeadlineMs} ms) was reached after ${provider.id} had started streaming; the response was cut off and was not replayed to another provider.`;
        }
        else if (chunk?.error) { outcome = "interrupted"; category = "stream_interrupted"; }
        else if (observe.failed) { outcome = "failed"; category = "stream_error_event"; }
        else if (observe.completed) outcome = "completed";
        else { outcome = "interrupted"; category = "stream_incomplete"; }
        if (outcome === "completed" || (outcome === "failed" && !chunk?.error) || category === "stream_incomplete") res.end();
        else res.destroy();
      } else {
        const chunks = [Buffer.from(first.value)];
        let size = first.value.byteLength;
        let chunk;
        while (true) {
          idle();
          chunk = await read();
          if (chunk.error || chunk.done || abortReason) break;
          size += chunk.value.byteLength;
          if (size > 16 * 1024 * 1024) { abort("too_large"); await finish("failed", "upstream_unavailable"); throw failure(502, "upstream_response_too_large", "upstream_unavailable", "Upstream response exceeded the configured limit", { provider: provider.id }); }
          chunks.push(Buffer.from(chunk.value));
        }
        clearTimeout(timer);
        if (chunk.error || abortReason) {
          if (abortReason === "client_cancelled") { await finish("client_cancelled", "client_cancelled"); return { done: true, cancelled: true }; }
          // Nothing was sent to the client, but the provider has already done the work; do not replay it.
          const cat = ["stream_idle_timeout", "deadline_exceeded"].includes(abortReason) ? abortReason : "stream_interrupted";
          if (cat === "deadline_exceeded") {
            await finish("interrupted", cat);
            throw failure(504, "deadline_exceeded", cat, `requestDeadlineMs (${config.requestDeadlineMs} ms) was reached while reading ${provider.id}'s response; nothing was sent to the client and the request was not replayed to another provider.`, { provider: provider.id });
          }
          await finish("interrupted", cat);
          throw failure(502, "upstream_interrupted", cat, `Provider ${provider.id} response was interrupted; the request was not replayed`, { provider: provider.id });
        }
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(text); } catch {
          await finish("failed", "unknown");
          throw failure(502, "invalid_upstream_json", "unknown", "Provider returned invalid JSON", { provider: provider.id });
        }
        observe.observe(parsed);
        res.writeHead(200, responseHeaders);
        res.end(text);
        // A fully received, parseable JSON body is complete unless it reports an error.
        if (observe.failed) { outcome = "failed"; category = "stream_error_event"; }
        else { outcome = "completed"; observe.completed = true; }
      }
      if (outcome === "completed" && protocol === "responses" && payload.store === true && observe.responseId) {
        owners.delete(observe.responseId);
        owners.set(observe.responseId, { provider: provider.id, model: candidate.model, route: body.model });
        if (owners.size > MAX_RESPONSE_OWNERS) owners.delete(owners.keys().next().value);
      }
      await finish(outcome, category, observe.partialToolCall ? { partialToolCall: true } : {});
      Object.assign(entry, { outcome, category, usage: { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, ...observe.result() } });
      if (observe.partialToolCall) entry.partialToolCall = true;
      log({ requestId: entry.id, provider: provider.id, outcome, category });
      return { done: true };
    } finally {
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      res.off("close", disconnected);
      activeControllers.delete(controller);
    }
  }

  async function generate(req, res, protocol, body, entry) {
    if (typeof body?.model !== "string" || !Object.hasOwn(config.routes, body.model)) throw failure(400, "unknown_route", "upstream_rejected", "Choose a configured model alias from /v1/models");
    entry.route = body.model;
    validateRequest(body, protocol);
    validateToolShapes(body, protocol);
    const anthropic = protocol === "messages" ? anthropicHeaders(req.headers) : null;
    const required = requiredCapabilities(body, protocol, anthropic ?? {});
    let route = config.routes[body.model];
    if (body.previous_response_id !== undefined) {
      // Provider-side state exists only at the provider that issued it.
      const owner = owners.get(body.previous_response_id);
      if (!owner) throw failure(409, "continuation_owner_unknown", "no_eligible_candidate", "Harbor has no record of which provider stored this response (it was not stored through this Harbor process, or Harbor restarted). Resend the full conversation without previous_response_id.");
      route = route.filter(c => c.provider === owner.provider && c.model === owner.model);
      if (!route.length) throw failure(409, "continuation_route_mismatch", "no_eligible_candidate", `The response was issued by ${owner.provider} on route ${owner.route}; continue it on that route.`);
    }
    if (protocol === "responses" && body.store === true && !route.some(c => supports(providers.get(c.provider), "response_storage"))) {
      throw failure(400, "response_storage_unsupported", "no_eligible_candidate", "No provider on this route declares the response_storage capability; send store: false (or omit it) and resend full input each turn.");
    }
    const compacted = compactToolOutputs(body, protocol, config.toolOutputLimitChars, config.toolOutputBudgetChars);
    entry.omittedToolChars = compacted.removedChars;
    // The deadline covers the whole request: provider selection, attempts and streaming.
    const deadline = entry.startedMs + config.requestDeadlineMs;
    let lastError = null, lastCategory = null, lastProvider = null, failedAttempts = 0, cooledSkips = 0, stop = null;
    for (const candidate of route) {
      const provider = providers.get(candidate.provider);
      const reason = skipReason(provider, protocol, required, env);
      if (reason) { entry.skipped.push({ provider: provider.id, model: candidate.model, reason }); continue; }
      const cooling = coolingFor(provider.id);
      if (cooling) { cooledSkips++; entry.skipped.push({ provider: provider.id, model: candidate.model, reason: `cooling down after ${cooling.category}`, retryAt: iso(cooling.until), retryAfterKnown: cooling.retryKnown }); continue; }
      if (entry.attempts.length >= config.maxAttempts) { stop = "attempt_limit"; break; }
      if (now() >= deadline) { stop = "deadline_exceeded"; break; }
      const payload = buildPayload(compacted.body, protocol, candidate, provider);
      try {
        evidence.set(`${provider.id}:${candidate.model}`, await pricing.verify(provider, candidate.model, config));
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        entry.skipped.push({ provider: provider.id, model: candidate.model, reason: error.code });
        lastError = error;
        continue;
      }
      if (res.destroyed) { entry.outcome = "client_cancelled"; entry.category = "client_cancelled"; return; }
      const result = await attempt({ req, res, protocol, body, entry, provider, candidate, payload, anthropic, deadline, fallback: failedAttempts + cooledSkips > 0 });
      if (result.stop) { stop = result.category; lastProvider = provider.id; break; }
      if (result.done) {
        if (result.cancelled) { entry.outcome = "client_cancelled"; entry.category = "client_cancelled"; }
        return;
      }
      failedAttempts++; lastCategory = result.category; lastProvider = provider.id;
    }
    // No provider produced output. Report the most specific known cause.
    const retryTimes = route.map(c => coolingFor(c.provider)).filter(c => c?.retryKnown).map(c => c.until);
    const retryAt = retryTimes.length ? Math.min(...retryTimes) : undefined;
    const skippedText = entry.skipped.map(s => `${s.provider}: ${s.reason}`).join("; ");
    if (stop === "deadline_exceeded") throw failure(504, stop, stop, `requestDeadlineMs (${config.requestDeadlineMs} ms) was reached before any provider produced output; no further provider was tried. Last provider attempted: ${lastProvider ?? "none"}.${skippedText ? ` Skipped: ${skippedText}.` : ""}`, { provider: lastProvider, retryAt });
    if (stop) throw failure(STATUS_FOR[stop], stop, stop, `${CATEGORIES[stop]}. Last provider: ${lastProvider ?? "none"}.${skippedText ? ` Skipped: ${skippedText}.` : ""}`, { provider: lastProvider, retryAt });
    if (lastCategory) throw failure(STATUS_FOR[lastCategory] ?? 503, "providers_exhausted", lastCategory, `${CATEGORIES[lastCategory]} (${lastProvider}); no other eligible provider succeeded.${skippedText ? ` Skipped: ${skippedText}.` : ""}`, { provider: lastProvider, retryAt });
    if (cooledSkips) {
      const cats = route.map(c => coolingFor(c.provider)?.category).filter(Boolean);
      throw failure(cats.includes("upstream_rate_limited") ? 429 : 503, "providers_exhausted", "all_candidates_cooling", `${CATEGORIES.all_candidates_cooling}: ${skippedText}.${retryAt ? "" : " The earliest retry time is unknown."}`, { retryAt });
    }
    if (lastError) throw Object.assign(lastError, { category: "no_eligible_candidate" });
    throw failure(503, "no_eligible_provider", "no_eligible_candidate", `${CATEGORIES.no_eligible_candidate}. ${skippedText || "The route has no candidates."}`);
  }

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    let counted = false, entry = null;
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
      entry = requests.start({ startedMs: now(), id: requestId, receivedAt: iso(now()), protocol, route: null, outcome: "pending", category: null, provider: null, model: null, fallback: false, attempts: [], skipped: [], omittedToolChars: 0 });
      if (inFlight >= config.maxConcurrentRequests) {
        req.resume();
        throw failure(429, "gateway_busy", "harbor_concurrency_limit", `Harbor's concurrency limit (${config.maxConcurrentRequests} in flight) was reached, so no upstream request was made. Retry shortly or raise maxConcurrentRequests.`, { retryAt: now() + 1000 });
      }
      const type = req.headers["content-type"]?.split(";")[0].trim();
      if (type !== "application/json") throw new GatewayError(415, "json_required", "Content-Type application/json required");
      inFlight++; counted = true;
      const body = await readBody(req, config.maxBodyBytes);
      await generate(req, res, protocol, body, entry);
    } catch (error) {
      if (entry && entry.outcome === "pending") {
        entry.outcome = error.category && error.category !== "upstream_rejected" ? "failed" : "rejected";
        entry.category = error.category ?? (error instanceof GatewayError ? error.code : "unknown");
        entry.provider ??= error.provider ?? null;
        if (error.retryAt) entry.retryAt = iso(error.retryAt);
        if (error instanceof GatewayError) entry.detail ??= error.message;
      }
      if (res.headersSent) res.destroy();
      else {
        const temporary = !error.noRetry && error.category && !["upstream_rejected", "upstream_billing", "upstream_no_retry", "no_eligible_candidate"].includes(error.category);
        const headers = { "x-harbor-request-id": requestId, ...(error.category ? { "x-should-retry": String(temporary) } : {}) };
        if (error.retryAt) headers["retry-after"] = String(Math.max(1, Math.ceil((error.retryAt - now()) / 1000)));
        json(res, error instanceof GatewayError ? error.status : 500, errorBody(error, requestId), headers);
      }
    } finally {
      if (counted) inFlight--;
      if (entry) {
        if (entry.outcome === "pending") entry.outcome = res.destroyed && !res.writableFinished ? "client_cancelled" : "unknown";
        entry.finishedAt = iso(now());
        requests.finish(entry);
      }
    }
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
