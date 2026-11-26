import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { request as rawRequest } from "node:http";
import { validateConfig } from "../src/config.mjs";
import { FreeCatalog, hasZeroPricing } from "../src/catalog.mjs";
import { createGateway } from "../src/gateway.mjs";
import { gatewayToken, UsageStore } from "../src/state.mjs";
import { compactToolOutputs } from "../src/compact.mjs";

const TOKEN = "local-test-token-".repeat(3);
const KEY = "provider-secret-not-for-client";
const catalogResponse = () => Response.json({ data: [{ id: "openrouter/free", pricing: { prompt: "0", completion: "0", request: "0" } }] });
const basicRequest = { model: "harbor-auto", messages: [{ role: "user", content: "fixture task" }] };
function config(extra = {}) {
  return {
    port: 0, requestTimeoutMs: 2000,
    providers: [
      { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", protocols: ["chat", "responses", "messages"] },
      { id: "local", kind: "local", baseUrl: "http://127.0.0.1:11434/v1", protocols: ["chat", "responses", "messages"] },
    ],
    routes: { "harbor-auto": [{ provider: "openrouter", model: "openrouter/free" }, { provider: "local", model: "fixture-local-model" }] },
    ...extra,
  };
}
async function fixture(t, handler, extra = {}) {
  const calls = [];
  const upstream = async (url, options = {}) => {
    if (url.endsWith("/models")) return catalogResponse();
    const call = { url, ...options, parsed: JSON.parse(options.body) };
    calls.push(call);
    return handler(call, calls);
  };
  const gateway = createGateway({ config: config(extra), token: TOKEN, env: { OPENROUTER_API_KEY: KEY }, fetchImpl: upstream });
  await gateway.listen();
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const request = (path = "/v1/chat/completions", body = basicRequest, headers = {}) => fetch(base + path, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { gateway, calls, base, request };
}
async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(check(), "condition did not become true");
}

test("configuration rejects public binds, inline credentials, and endpoint substitution", () => {
  assert.throws(() => validateConfig(config({ host: "0.0.0.0" })), /loopback/);
  assert.throws(() => validateConfig(config({ maxConcurrentRequests: 0 })), /maxConcurrent/);
  const c = config(); c.providers[0].baseUrl = "https://attacker.example/api/v1";
  assert.throws(() => validateConfig(c), /endpoint is fixed/);
  const d = config(); d.providers[0].apiKey = "do-not-store-me";
  assert.throws(() => validateConfig(d), /environment/);
  const e = config(); e.providers[1].baseUrl = "http://localhost:11434/v1";
  assert.throws(() => validateConfig(e), /HTTPS|numeric loopback/);
  assert.throws(() => validateConfig(config({ routes: { route: [{ provider: "missing", model: "m" }] } })), /candidate/);
});

test("zero-price validation requires explicit zeroes, including add-on prices", () => {
  for (const pricing of [undefined, {}, { prompt: null, completion: "0" }, { prompt: "", completion: "0" }, { prompt: "0", completion: "1" }, { prompt: "0", completion: "0", web_search: "0.01" }, { prompt: "0", completion: "0", request: false }]) {
    assert.equal(hasZeroPricing({ pricing }), false);
  }
  assert.equal(hasZeroPricing({ pricing: { prompt: "0", completion: 0, request: "0.000" } }), true);
});

test("catalog evidence expires and fails closed on refresh failure", async () => {
  let time = 0, requests = 0;
  const p = validateConfig(config()).providers[0];
  const catalog = new FreeCatalog({ now: () => time, ttlMs: 100, fetchImpl: async () => {
    requests++;
    if (requests > 1) throw new Error("secret upstream details");
    return catalogResponse();
  } });
  await catalog.verify(p, "openrouter/free", {});
  time = 50;
  await catalog.verify(p, "openrouter/free", {});
  assert.equal(requests, 1);
  time = 101;
  await assert.rejects(catalog.verify(p, "openrouter/free", {}), e => e.code === "pricing_unavailable" && !e.message.includes("secret"));
  await assert.rejects(catalog.verify(p, "paid-model", {}), e => e.code === "paid_model_blocked");
});

test("declared free tiers need opt-in, a hard stop, and fresh dated evidence", async () => {
  const now = Date.parse("2026-11-23T00:00:00Z");
  const catalog = new FreeCatalog({ now: () => now });
  const p = { id: "groq", kind: "declared-free-tier", freeTier: { verifiedAt: "2026-11-22T00:00:00Z", expiresAt: "2026-11-24T00:00:00Z", source: "https://console.groq.com/docs/rate-limits", hardStop: true } };
  await assert.rejects(catalog.verify(p, "model", { allowDeclaredFreeTiers: false }), /opt-in/);
  assert.equal((await catalog.verify(p, "model", { allowDeclaredFreeTiers: true })).status, "declared-free-tier");
  p.freeTier.expiresAt = "2026-11-22T12:00:00Z";
  await assert.rejects(catalog.verify(p, "model", { allowDeclaredFreeTiers: true }), /current/);
});

test("health is minimal; all useful endpoints require authentication and local origin", async t => {
  const f = await fixture(t, () => Response.json({ ok: true }));
  assert.deepEqual(await (await fetch(f.base + "/healthz")).json(), { ok: true });
  for (const path of ["/v1/models", "/v1/status"]) assert.equal((await fetch(f.base + path)).status, 401);
  const unauthorized = await f.request(undefined, undefined, { authorization: "Bearer wrong" });
  assert.equal(unauthorized.status, 401);
  assert.equal((await f.request(undefined, undefined, { origin: "https://attacker.example" })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = rawRequest(f.base + "/v1/models", { headers: { host: "attacker.example", authorization: `Bearer ${TOKEN}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal(f.calls.length, 0);
});

test("chat forwarding pins the model, protects routing, and never forwards client credentials", async t => {
  const f = await fixture(t, () => Response.json({ model: "actual-free-model", choices: [], usage: { prompt_tokens: 7, completion_tokens: 9 } }));
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-harbor-provider"), "openrouter");
  assert.equal((await response.json()).model, "actual-free-model");
  assert.equal(f.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.notEqual(f.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(f.calls[0].parsed.provider, { allow_fallbacks: false, data_collection: "deny", max_price: { prompt: 0, completion: 0 } });
  assert.equal(f.calls[0].parsed.model, "openrouter/free");
  assert.equal(f.calls[0].redirect, "error");
  await eventually(() => f.gateway.status().usage.providers.openrouter?.successes === 1);
  assert.equal(f.gateway.status().usage.providers.openrouter.inputTokens, 7);
});

test("client cannot select arbitrary paid models, routing overrides, or hosted tools", async t => {
  const f = await fixture(t, () => Response.json({}));
  const invalid = [
    { ...basicRequest, model: "anthropic/paid-model" },
    { ...basicRequest, provider: { allow_fallbacks: true } },
    { ...basicRequest, models: ["paid-model"] },
    { ...basicRequest, plugins: [{ id: "web" }] },
    { ...basicRequest, tools: [{ type: "web_search" }] },
    { ...basicRequest, stream: "yes" },
  ];
  for (const body of invalid) assert.equal((await f.request(undefined, body)).status, 400);
  assert.equal(f.calls.length, 0);
});

test("rate-limit fallback moves to an independent provider and applies cooldown", async t => {
  const f = await fixture(t, call => call.url.includes("openrouter.ai") ? new Response("sensitive upstream error", { status: 429, headers: { "retry-after": "60" } }) : Response.json({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
  const a = await f.request(); assert.equal(a.status, 200); await a.text();
  assert.equal(a.headers.get("x-harbor-provider"), "local");
  assert.equal(f.calls.length, 2);
  const b = await f.request(); assert.equal(b.status, 200); await b.text();
  assert.equal(f.calls.length, 3);
  await eventually(() => f.gateway.status().usage.providers.local?.successes === 2);
  assert.equal(f.gateway.status().usage.providers.openrouter.failures, 1);
});

test("invalid upstream requests are not replayed, and errors do not leak secrets", async t => {
  const f = await fixture(t, () => new Response(`private-error ${KEY}`, { status: 400 }));
  const response = await f.request();
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 1);
  assert.ok(!(await response.text()).includes(KEY));
});

test("pre-response network failure falls back without exposing transport errors", async t => {
  const f = await fixture(t, call => {
    if (call.url.includes("openrouter.ai")) throw new Error(`credential ${KEY}`);
    return Response.json({ choices: [] });
  });
  const response = await f.request(); assert.equal(response.status, 200); await response.text();
  assert.equal(f.calls.length, 2);
  await eventually(() => f.gateway.status().usage.providers.local?.unknownUsageRequests === 1);
});

test("native Responses and Messages preserve tools and use upstream protocol endpoints", async t => {
  const f = await fixture(t, call => Response.json({ id: "fixture", usage: { input_tokens: 4, output_tokens: 5 }, received: call.parsed }));
  const responses = await f.request("/v1/responses", { model: "harbor-auto", input: "task", tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }] });
  assert.equal(responses.status, 200);
  assert.equal((await responses.json()).received.store, false);
  assert.ok(f.calls[0].url.endsWith("/responses"));
  const actual = await fetch(f.base + "/v1/messages?beta=true", { method: "POST", headers: { "content-type": "application/json", "x-api-key": TOKEN }, body: JSON.stringify({ model: "harbor-auto", messages: [{ role: "user", content: "task" }], max_tokens: 50, tools: [{ name: "read_file", input_schema: { type: "object" } }] }) });
  assert.equal(actual.status, 200);
  assert.equal((await actual.json()).received.tools[0].name, "read_file");
  assert.equal(f.calls.at(-1).headers["anthropic-version"], "2023-06-01");
});

for (const [protocol, endpoint, body, events] of [
  ["chat", "/v1/chat/completions", basicRequest, 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"café\\"}"}}]}}]}\n\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":5}}\n\ndata: [DONE]\n\n'],
  ["responses", "/v1/responses", { model: "harbor-auto", input: "task" }, 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"café"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":5}}}\n\n'],
  ["messages", "/v1/messages", { ...basicRequest, max_tokens: 50 }, 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"café"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'],
]) test(`${protocol} streaming preserves exact bytes, tool deltas, and usage across chunk boundaries`, async t => {
  const bytes = Buffer.from(events);
  const f = await fixture(t, () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } }));
  const response = await f.request(endpoint, { ...body, stream: true });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await eventually(() => f.gateway.status().usage.providers.openrouter?.successes === 1);
  assert.equal(f.gateway.status().usage.providers.openrouter.inputTokens, 4);
  assert.equal(f.gateway.status().usage.providers.openrouter.outputTokens, 5);
});

test("mid-stream interruption is never replayed to a fallback provider", async t => {
  const f = await fixture(t, () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"started"}}]}\n\n'));
      setTimeout(() => controller.error(new Error("stream interrupted")), 20);
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const response = await f.request(undefined, { ...basicRequest, stream: true });
  await assert.rejects(response.text());
  assert.equal(f.calls.length, 1);
  await eventually(() => f.gateway.status().usage.providers.openrouter?.failures === 1);
});

test("SSE errors remain visible to the client and are counted as failures without replay", async t => {
  const f = await fixture(t, () => new Response('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n', { headers: { "content-type": "text/event-stream" } }));
  const response = await f.request(undefined, { ...basicRequest, stream: true });
  assert.ok((await response.text()).includes("overloaded_error"));
  await eventually(() => f.gateway.status().usage.providers.openrouter?.failures === 1);
  assert.equal(f.calls.length, 1);
});

test("provider timeouts abort the request before falling back", async t => {
  let aborted = false;
  const f = await fixture(t, call => {
    if (!call.url.includes("openrouter.ai")) return Response.json({ choices: [] });
    return new Promise((resolve, reject) => call.signal.addEventListener("abort", () => { aborted = true; reject(new Error("timeout")); }, { once: true }));
  }, { requestTimeoutMs: 100 });
  const response = await f.request(); assert.equal(response.status, 200); await response.text();
  assert.equal(aborted, true);
  assert.equal(f.calls.length, 2);
});

test("a continuation whose owner Harbor did not record fails explicitly without upstream calls", async t => {
  const f = await fixture(t, () => new Response("rate-limited", { status: 429 }));
  const response = await f.request("/v1/responses", { model: "harbor-auto", previous_response_id: "existing-id", input: "continue" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.type, "continuation_owner_unknown");
  assert.equal(f.calls.length, 0);
});

test("large bodies are rejected before inference", async t => {
  const f = await fixture(t, () => Response.json({}), { maxBodyBytes: 1024 });
  const response = await f.request(undefined, { ...basicRequest, messages: [{ role: "user", content: "x".repeat(2000) }] });
  assert.equal(response.status, 413);
  assert.equal(f.calls.length, 0);
});

test("concurrency is bounded while an upstream request is pending", async t => {
  let release;
  const f = await fixture(t, () => new Promise(resolve => { release = () => resolve(Response.json({ choices: [] })); }), { maxConcurrentRequests: 1 });
  const first = f.request();
  await eventually(() => Boolean(release));
  assert.equal((await f.request()).status, 429);
  release();
  const response = await first; assert.equal(response.status, 200); await response.text();
  assert.equal(f.calls.length, 1);
});

test("client disconnection cancels the upstream stream without fallback", async t => {
  let aborted = false;
  const f = await fixture(t, call => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
    call.signal.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")); }, { once: true });
  } }), { headers: { "content-type": "text/event-stream" } }));
  const controller = new AbortController();
  const response = await fetch(f.base + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ ...basicRequest, stream: true }), signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  await eventually(() => aborted);
  assert.equal(f.calls.length, 1);
});

test("usage persistence is private, distinguishes unknown usage, and contains no prompt text", async t => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "usage.json");
  const store = new UsageStore({ file });
  await store.load();
  await Promise.all([
    store.record("constructor", { success: true, status: 200, inputTokens: 10, outputTokens: 20 }),
    store.record("openrouter", { success: true, status: 200 }),
    store.record("openrouter", { success: false, status: 429 }),
  ]);
  const loaded = new UsageStore({ file }); await loaded.load();
  assert.equal(loaded.snapshot().providers.openrouter.unknownUsageRequests, 1);
  assert.equal(loaded.snapshot().providers.constructor.outputTokens, 20);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, "utf8");
  assert.ok(!text.includes(KEY) && !text.includes("fixture task"));
});

test("init preserves existing configuration and creates a private stable token", async t => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, ["bin/harbor.mjs", "init", "--state", dir], { cwd: new URL("..", import.meta.url), env: { PATH: process.env.PATH } });
  const first = await gatewayToken(dir, {});
  assert.ok(first.length >= 32);
  assert.equal((await stat(join(dir, "gateway.token"))).mode & 0o777, 0o600);
  await writeFile(join(dir, "config.json"), '{"preserved":true}\n');
  execFileSync(process.execPath, ["bin/harbor.mjs", "init", "--state", dir], { cwd: new URL("..", import.meta.url), env: { PATH: process.env.PATH } });
  assert.equal(await gatewayToken(dir, {}), first);
  assert.equal(await readFile(join(dir, "config.json"), "utf8"), '{"preserved":true}\n');
});

test("optional tool compaction preserves prompts and tool IDs across all three protocols", () => {
  const large = "head-" + "🧪".repeat(1000) + "-tail";
  const cases = [
    ["chat", { messages: [{ role: "user", content: large }, { role: "tool", tool_call_id: "call-1", content: large }] }, b => b.messages[1].content],
    ["responses", { input: [{ type: "function_call_output", call_id: "call-1", output: large }] }, b => b.input[0].output],
    ["messages", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: large }] }] }] }, b => b.messages[0].content[0].content[0].text],
  ];
  for (const [protocol, original, get] of cases) {
    const disabled = compactToolOutputs(original, protocol, 0);
    assert.equal(get(disabled.body), large);
    const result = compactToolOutputs(original, protocol, 256);
    const text = get(result.body);
    assert.ok(text.length <= 256);
    assert.ok(text.includes("omitted") && text.startsWith("head-") && text.endsWith("-tail"));
    assert.equal(text.isWellFormed(), true);
    assert.equal(get(original), large);
    assert.ok(JSON.stringify(result.body).includes("call-1"));
    if (protocol === "chat") assert.equal(result.body.messages[0].content, large);
    assert.ok(result.removedChars > 0);
  }
});

test("configured compaction is visible in response headers and only changes tool outputs", async t => {
  const f = await fixture(t, () => Response.json({ choices: [] }), { toolOutputLimitChars: 256 });
  const long = "x".repeat(2000);
  const response = await f.request(undefined, { ...basicRequest, messages: [{ role: "user", content: long }, { role: "tool", tool_call_id: "call-1", content: long }] });
  assert.equal(response.status, 200); await response.text();
  assert.ok(Number(response.headers.get("x-harbor-omitted-tool-chars")) > 0);
  assert.equal(f.calls[0].parsed.messages[0].content, long);
  assert.ok(f.calls[0].parsed.messages[1].content.length <= 256);
});
