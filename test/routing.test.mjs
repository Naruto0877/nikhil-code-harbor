// Regression tests for failure classification (#1), overload and stream outcomes (#4),
// and protocol/capability compatibility (#5). All upstreams are local fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/gateway.mjs";

const TOKEN = "routing-test-token-".repeat(3);
const env = { A_KEY: "key-for-provider-a", B_KEY: "key-for-provider-b", C_KEY: "key-for-chat-only" };
const p = (id, extra = {}) => ({ id, kind: "local", baseUrl: `http://127.0.0.1:${{ a: 41001, b: 41002, c: 41003 }[id]}/v1`, protocols: ["chat", "messages", "responses"], ...extra });
const messagesBody = { model: "coding", max_tokens: 64, messages: [{ role: "user", content: "fix the bug" }] };
const encoder = new TextEncoder();
const sse = (...events) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const completeMessage = sse(
  ["message_start", { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
  ["message_stop", { type: "message_stop" }],
);

async function harbor(t, { providers, routes, handler, extra = {}, clock }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = { url, provider: new URL(url).port, ...options, parsed: JSON.parse(options.body) };
    calls.push(call);
    return handler(call, calls);
  };
  const usageEvents = [];
  const gateway = createGateway({ config: { port: 0, providers, routes, ...extra }, token: TOKEN, env, fetchImpl, ...(clock ? { now: clock } : {}) });
  await gateway.listen();
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const send = (path, body, headers = {}, signal) => fetch(base + path, { method: "POST", signal, headers: Object.fromEntries(Object.entries({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers }).filter(([, v]) => v !== undefined)), body: JSON.stringify(body) });
  return { gateway, calls, base, send, usageEvents, of: port => calls.filter(c => c.provider === port) };
}
const A = "41001", B = "41002", C = "41003";
const stream = (text, { chunked = false, then } = {}) => new Response(new ReadableStream({ start(controller) {
  const bytes = encoder.encode(text);
  if (chunked) for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7)); else controller.enqueue(bytes);
  if (then) then(controller); else controller.close();
} }), { headers: { "content-type": "text/event-stream" } });
async function eventually(check) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), "condition did not become true");
}

test("#1 temporary 429 with Retry-After falls back, and a request during the cooldown skips A", async t => {
  let clock = Date.parse("2026-11-25T10:00:00Z");
  const h = await harbor(t, {
    providers: [p("a"), p("b")], routes: { coding: [{ provider: "a", model: "a-model" }, { provider: "b", model: "b-model" }] }, clock: () => clock,
    handler: call => call.provider === A ? new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "secret detail" } }), { status: 429, headers: { "retry-after": "60" } }) : Response.json({ type: "message", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } }),
  });
  const first = await h.send("/v1/messages", messagesBody);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-harbor-provider"), "b");
  assert.equal(first.headers.get("x-harbor-fallback"), "true");
  const firstId = first.headers.get("x-harbor-request-id");
  await first.text();
  const status = h.gateway.status();
  const a = status.providers.find(x => x.id === "a");
  assert.equal(a.cooldown.category, "upstream_rate_limited");
  assert.equal(a.cooldown.until, new Date(clock + 60000).toISOString());
  assert.equal(a.cooldown.retryAfterKnown, true);
  const entry = status.requests.recent.find(e => e.id === firstId);
  assert.deepEqual(entry.attempts.map(x => [x.provider, x.category]), [["a", "upstream_rate_limited"], ["b", null]]);
  assert.equal(entry.outcome, "completed");
  assert.ok(!JSON.stringify(status).includes("secret detail"));

  clock += 30000; // still inside A's 60 s cooldown
  const second = await h.send("/v1/messages", messagesBody);
  assert.equal(second.headers.get("x-harbor-provider"), "b");
  await second.text();
  assert.equal(h.of(A).length, 1, "A must be skipped while cooling down");
  assert.equal(h.of(B).length, 2);
  const skipped = h.gateway.status().requests.recent[0].skipped;
  assert.match(skipped[0].reason, /cooling down after upstream_rate_limited/);

  clock += 31000; // cooldown over
  await (await h.send("/v1/messages", messagesBody)).text();
  assert.equal(h.of(A).length, 2);
});

test("#1 Harbor's own concurrency limit makes zero upstream calls and is distinguishable", async t => {
  let release;
  const h = await harbor(t, {
    providers: [p("a")], routes: { coding: [{ provider: "a", model: "a-model" }] }, extra: { maxConcurrentRequests: 1 },
    handler: () => new Promise(resolve => { release = () => resolve(Response.json({ type: "message", stop_reason: "end_turn" })); }),
  });
  const pending = h.send("/v1/messages", messagesBody);
  await eventually(() => Boolean(release));
  const busy = await h.send("/v1/messages", messagesBody);
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("x-should-retry"), "true");
  const body = await busy.json();
  assert.equal(body.error.category, "harbor_concurrency_limit");
  assert.match(body.error.message, /no upstream request was made/);
  assert.equal(h.calls.length, 1, "only the first request reached the upstream");
  const lastFailure = h.gateway.status().requests.lastFailure;
  assert.equal(lastFailure.category, "harbor_concurrency_limit");
  assert.equal(lastFailure.provider, null);
  release();
  await (await pending).text();
  assert.equal(h.calls.length, 1);
});

test("#1 every eligible provider cooling down reports the earliest known retry time without upstream calls", async t => {
  let clock = Date.parse("2026-11-25T10:00:00Z");
  const h = await harbor(t, {
    providers: [p("a"), p("b")], routes: { coding: [{ provider: "a", model: "a" }, { provider: "b", model: "b" }] }, clock: () => clock,
    handler: call => new Response("{}", { status: 429, headers: { "retry-after": call.provider === A ? "120" : "45" } }),
  });
  const first = await h.send("/v1/messages", messagesBody);
  assert.equal(first.status, 429);
  assert.equal((await first.json()).error.category, "upstream_rate_limited");
  const second = await h.send("/v1/messages", messagesBody);
  assert.equal(h.calls.length, 2, "no new upstream call while both cool down");
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("retry-after"), "45");
  const body = await second.json();
  assert.equal(body.error.category, "all_candidates_cooling");
  assert.equal(body.error.retry_at, new Date(clock + 45000).toISOString());
});

test("#1 billing restrictions and x-should-retry: false stop without fallback", async t => {
  for (const [label, response, category, status] of [
    ["spend cap", () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "You have reached your specified API usage limits." } }), { status: 400 }), "upstream_billing", 402],
    ["insufficient quota", () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 }), "upstream_billing", 402],
    ["no retry", () => new Response("{}", { status: 429, headers: { "x-should-retry": "false" } }), "upstream_no_retry", 429],
  ]) {
    await t.test(label, async t => {
      const h = await harbor(t, { providers: [p("a"), p("b")], routes: { coding: [{ provider: "a", model: "a" }, { provider: "b", model: "b" }] }, handler: response });
      const res = await h.send("/v1/messages", messagesBody);
      assert.equal(res.status, status);
      assert.equal(res.headers.get("x-should-retry"), "false");
      const body = await res.json();
      assert.equal(body.error.category, category);
      assert.equal(body.error.provider, "a");
      assert.ok(!JSON.stringify(body).includes("usage limits"), "upstream text is not echoed");
      assert.equal(h.of(B).length, 0);
    });
  }
});

test("#1 an unclassifiable upstream failure says the cause is unknown", async t => {
  const h = await harbor(t, { providers: [p("a")], routes: { coding: [{ provider: "a", model: "a" }] }, handler: () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }) });
  const res = await h.send("/v1/messages", messagesBody);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.category, "unknown");
});

test("#4 a 529 from A followed by success from B gives one completed client response", async t => {
  const h = await harbor(t, {
    providers: [p("a"), p("b")], routes: { coding: [{ provider: "a", model: "a" }, { provider: "b", model: "b" }] },
    handler: call => call.provider === A ? new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 }) : stream(completeMessage),
  });
  const res = await h.send("/v1/messages", { ...messagesBody, stream: true });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), completeMessage);
  assert.equal(h.calls.length, 2);
  await eventually(() => h.gateway.status().requests.recent[0]?.outcome === "completed");
  const s = h.gateway.status();
  assert.equal(s.providers[0].cooldown.category, "upstream_overloaded");
  assert.equal(s.usage.providers.b.outcomes.completed, 1);
  assert.equal(s.usage.providers.b.fallbackSuccesses, 1);
});

test("#4 retries are bounded by maxAttempts and requestDeadlineMs", async t => {
  const providers = [p("a"), p("b"), p("c")];
  const routes = { coding: [{ provider: "a", model: "a" }, { provider: "b", model: "b" }, { provider: "c", model: "c" }] };
  const h = await harbor(t, { providers, routes, extra: { maxAttempts: 2 }, handler: () => new Response("{}", { status: 529 }) });
  const res = await h.send("/v1/messages", messagesBody);
  assert.equal(h.calls.length, 2);
  assert.equal((await res.json()).error.category, "attempt_limit");

  const slow = await harbor(t, { providers, routes, extra: { requestDeadlineMs: 150, firstByteTimeoutMs: 100 }, handler: call => new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  const late = await slow.send("/v1/messages", messagesBody);
  assert.ok(slow.calls.length <= 2, "no attempt starts after the deadline");
  const lateError = (await late.json()).error;
  assert.equal(lateError.category, "deadline_exceeded");
  assert.match(lateError.message, /^requestDeadlineMs \(150 ms\) was reached before any provider produced output; no further provider was tried\./);
  assert.equal(slow.gateway.status().requests.lastFailure.detail, lateError.message);
});

test("#4 first-byte timeout is distinguished from a stream that goes idle after output", async t => {
  const h = await harbor(t, {
    providers: [p("a"), p("b")], routes: { coding: [{ provider: "a", model: "a" }, { provider: "b", model: "b" }] }, extra: { firstByteTimeoutMs: 100, streamIdleTimeoutMs: 100 },
    handler: call => call.provider === A
      ? new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(new Error("aborted"))))
      : stream(completeMessage.slice(0, 200), { then: () => {} }), // starts, then goes silent
  });
  const res = await h.send("/v1/messages", { ...messagesBody, stream: true });
  assert.equal(res.headers.get("x-harbor-provider"), "b");
  await assert.rejects(res.text());
  await eventually(() => h.gateway.status().requests.recent[0]?.outcome === "interrupted");
  const entry = h.gateway.status().requests.recent[0];
  assert.deepEqual(entry.attempts.map(x => x.category), ["first_byte_timeout", "stream_idle_timeout"]);
  assert.equal(h.calls.length, 2);
});

test("#4 a half-sent tool call is never replayed: B receives zero calls", async t => {
  const partial = sse(
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 9 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "edit_file", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"src/a." } }],
  );
  const h = await harbor(t, {
    providers: [p("a"), p("b")], routes: { coding: [{ provider: "a", model: "a" }, { provider: "b", model: "b" }] },
    handler: call => call.provider === A ? stream(partial, { then: c => setTimeout(() => c.error(new Error("connection reset")), 20) }) : stream(completeMessage),
  });
  const res = await h.send("/v1/messages", { ...messagesBody, stream: true, tools: [{ name: "edit_file", input_schema: { type: "object" } }] });
  await assert.rejects(res.text());
  await eventually(() => h.gateway.status().requests.recent[0]?.outcome === "interrupted");
  assert.equal(h.of(B).length, 0);
  const entry = h.gateway.status().requests.recent[0];
  assert.equal(entry.category, "stream_interrupted");
  assert.equal(entry.partialToolCall, true);
  assert.equal(h.gateway.status().usage.providers.a.outcomes.interrupted, 1);
});

test("#4 clean EOF without message_stop is interrupted, an error event is failed, cancellation is recorded", async t => {
  const noStop = completeMessage.replace(/event: message_stop[\s\S]*$/, "");
  const errorEvent = sse(["message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } }], ["error", { type: "error", error: { type: "overloaded_error" } }]);
  let aborted = false;
  const h = await harbor(t, {
    providers: [p("a")], routes: { coding: [{ provider: "a", model: "a" }] },
    handler: call => {
      if (call.parsed.metadata?.user_id === "eof") return stream(noStop);
      if (call.parsed.metadata?.user_id === "error") return stream(errorEvent);
      return stream(completeMessage.slice(0, 120), { then: c => call.signal.addEventListener("abort", () => { aborted = true; c.error(new Error("aborted")); }) });
    },
  });
  const eof = await h.send("/v1/messages", { ...messagesBody, stream: true, metadata: { user_id: "eof" } });
  assert.equal(await eof.text(), noStop, "bytes are forwarded unmodified");
  await eventually(() => h.gateway.status().requests.recent[0]?.outcome === "interrupted");
  assert.equal(h.gateway.status().requests.recent[0].category, "stream_incomplete");

  const failed = await h.send("/v1/messages", { ...messagesBody, stream: true, metadata: { user_id: "error" } });
  assert.match(await failed.text(), /overloaded_error/);
  await eventually(() => h.gateway.status().requests.recent[0]?.outcome === "failed");
  assert.equal(h.gateway.status().requests.recent[0].category, "stream_error_event");

  const controller = new AbortController();
  const cancelled = await h.send("/v1/messages", { ...messagesBody, stream: true, metadata: { user_id: "cancel" } }, {}, controller.signal);
  await cancelled.body.getReader().read();
  controller.abort();
  await eventually(() => aborted && h.gateway.status().requests.recent[0]?.outcome === "client_cancelled");
  const outcomes = h.gateway.status().usage.providers.a.outcomes;
  assert.deepEqual(outcomes, { completed: 0, interrupted: 1, failed: 1, client_cancelled: 1 });
  assert.equal(h.calls.length, 3);
});

test("#5 a Messages tool request skips a chat-only candidate; the backup gets headers, schema, and its own key", async t => {
  const tools = [{ name: "read_file", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, cache_control: { type: "ephemeral" } }];
  const h = await harbor(t, {
    providers: [p("c", { protocols: ["chat"], apiKeyEnv: "C_KEY" }), p("b", { apiKeyEnv: "B_KEY", authHeader: "x-api-key" })],
    routes: { coding: [{ provider: "c", model: "chat-model" }, { provider: "b", model: "b-model" }] },
    handler: () => Response.json({ type: "message", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  const res = await h.send("/v1/messages?beta=true", { ...messagesBody, tools, context_management: { edits: [{ type: "clear_tool_uses_20250919" }] }, cache_control: { type: "ephemeral" } }, {
    "x-api-key": TOKEN, authorization: undefined, "anthropic-version": "2023-06-01", "anthropic-beta": "context-management-2025-06-27,oauth-2025-04-20,prompt-caching-2024-07-31",
  });
  assert.equal(res.status, 200);
  assert.equal(h.of(C).length, 0, "chat-only candidate receives nothing");
  const call = h.of(B)[0];
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.headers["anthropic-beta"], "context-management-2025-06-27,prompt-caching-2024-07-31", "credential-related betas are dropped");
  assert.equal(call.headers["x-api-key"], env.B_KEY);
  assert.ok(!JSON.stringify(call.headers).includes(TOKEN), "the Harbor token is never forwarded");
  assert.deepEqual(call.parsed.tools, tools);
  assert.deepEqual(call.parsed.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
  const entry = h.gateway.status().requests.recent[0];
  assert.match(entry.skipped[0].reason, /does not declare the messages protocol/);
  assert.equal(entry.fallback, false, "skipping an incompatible candidate is not a fallback");
});

test("#5 a candidate that declares capabilities without context_management is skipped", async t => {
  const h = await harbor(t, {
    providers: [p("a", { capabilities: ["tools", "streaming"] }), p("b")], routes: { coding: [{ provider: "a", model: "a" }, { provider: "b", model: "b" }] },
    handler: () => Response.json({ type: "message", stop_reason: "end_turn" }),
  });
  await (await h.send("/v1/messages", { ...messagesBody, context_management: { edits: [] } })).text();
  assert.equal(h.of(A).length, 0);
  assert.equal(h.of(B).length, 1);
  assert.match(h.gateway.status().requests.recent[0].skipped[0].reason, /context_management/);
});

test("#5 a stored Responses continuation goes only to the provider that issued it", async t => {
  let clock = Date.parse("2026-11-25T10:00:00Z");
  const storage = { capabilities: ["tools", "streaming", "response_storage"] };
  const h = await harbor(t, {
    providers: [p("a", storage), p("b", storage)], routes: { coding: [{ provider: "a", model: "a" }, { provider: "b", model: "b" }] }, clock: () => clock,
    handler: (call, calls) => {
      if (call.provider === A && calls.length === 1) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
      return Response.json({ object: "response", id: `resp_from_${call.provider}_${calls.length}`, status: "completed", received_store: call.parsed.store, received_prev: call.parsed.previous_response_id ?? null });
    },
  });
  const original = await h.send("/v1/responses", { model: "coding", input: "start", store: true });
  const first = await original.json();
  assert.equal(original.headers.get("x-harbor-provider"), "b");
  assert.equal(first.received_store, true);
  clock += 5000; // A is healthy again and first on the route
  const next = await h.send("/v1/responses", { model: "coding", input: "continue", previous_response_id: first.id, store: true });
  const body = await next.json();
  assert.equal(next.headers.get("x-harbor-provider"), "b");
  assert.equal(body.received_prev, first.id);
  assert.equal(h.of(A).length, 1, "A never sees the continuation");

  const unknown = await h.send("/v1/responses", { model: "coding", input: "x", previous_response_id: "resp_never_seen" });
  assert.equal(unknown.status, 409);
  const noStorage = await harbor(t, { providers: [p("a")], routes: { coding: [{ provider: "a", model: "a" }] }, handler: () => Response.json({}) });
  const refused = await noStorage.send("/v1/responses", { model: "coding", input: "x", store: true });
  assert.equal((await refused.json()).error.type, "response_storage_unsupported");
  assert.equal(noStorage.calls.length, 0);
});

test("#5 invalid anthropic headers are rejected before any upstream call", async t => {
  const h = await harbor(t, { providers: [p("a")], routes: { coding: [{ provider: "a", model: "a" }] }, handler: () => Response.json({}) });
  assert.equal((await h.send("/v1/messages", messagesBody, { "anthropic-version": "latest\r" })).status, 400);
  assert.equal((await h.send("/v1/messages", messagesBody, { "anthropic-beta": "bad value!" })).status, 400);
  assert.equal(h.calls.length, 0);
});
