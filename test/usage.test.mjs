// Regression tests for cache-aware usage diagnostics (#2) and tool-output compaction (#3).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../src/gateway.mjs";
import { StreamObserver } from "../src/observe.mjs";
import { UsageStore } from "../src/state.mjs";
import { compactToolOutputs, compactText } from "../src/compact.mjs";

const TOKEN = "usage-test-token-".repeat(3);
const sse = (...events) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
async function harbor(t, { providers, routes, handler, extra = {} }) {
  const calls = [];
  const gateway = createGateway({ config: { port: 0, providers, routes, ...extra }, token: TOKEN, env: {}, fetchImpl: async (url, options) => {
    const call = { url, port: new URL(url).port, ...options, raw: options.body, parsed: JSON.parse(options.body) };
    calls.push(call);
    return handler(call, calls);
  } });
  await gateway.listen();
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const send = (path, body) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { gateway, calls, send };
}
const local = (id, port, protocols = ["messages", "chat", "responses"]) => ({ id, kind: "local", baseUrl: `http://127.0.0.1:${port}/v1`, protocols });
const chunked = text => new Response(new ReadableStream({ start(c) { const b = new TextEncoder().encode(text); for (let i = 0; i < b.length; i += 5) c.enqueue(b.subarray(i, i + 5)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });

test("#2 two turns with identical history: forwarded prefix is unchanged and repeated usage events do not inflate totals", async t => {
  const usageStream = sse(
    { type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 4 } },
    // Repeated cumulative updates, as some providers send.
    { type: "message_delta", usage: { input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, output_tokens: 7 } },
    { type: "message_delta", usage: { output_tokens: 7 } },
    { type: "message_stop" },
  );
  const secondStream = usageStream.replace('"cache_read_input_tokens":0,"cache_creation_input_tokens":900', '"cache_read_input_tokens":900,"cache_creation_input_tokens":30').replace('"cache_read_input_tokens":0,"cache_creation_input_tokens":900', '"cache_read_input_tokens":900,"cache_creation_input_tokens":30');
  const h = await harbor(t, {
    providers: [local("a", 42001)], routes: { coding: [{ provider: "a", model: "m" }] }, extra: { toolOutputLimitChars: 2000 },
    handler: (call, calls) => chunked(calls.length === 1 ? usageStream : secondStream),
  });
  const tools = [{ name: "run_tests", input_schema: { type: "object" } }, { name: "read_file", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }];
  const history = [
    { role: "user", content: [{ type: "text", text: "Fix the failing test", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "sig-abc" }, { type: "tool_use", id: "toolu_1", name: "run_tests", input: { args: ["--grep", "invoice"] } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok 1\n".repeat(2000) + "not ok 2 - totals\n  AssertionError: expected 3\n# fail 1" }] },
  ];
  const turn1 = { model: "coding", max_tokens: 100, stream: true, cache_control: { type: "ephemeral" }, tools, system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], messages: history };
  await (await h.send("/v1/messages", turn1)).text();
  const turn2 = { ...turn1, messages: [...history,
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "src/invoice.mjs" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "export const total = 3;" }] },
  ] };
  await (await h.send("/v1/messages", turn2)).text();

  const [first, second] = h.calls.map(c => c.parsed);
  assert.deepEqual(second.tools, first.tools, "tool order and schemas unchanged");
  assert.deepEqual(second.messages.slice(0, history.length), first.messages, "previously forwarded content (including compacted history) is byte-stable");
  assert.equal(JSON.stringify(second.system), JSON.stringify(first.system));
  assert.deepEqual(second.messages[1].content[0], history[1].content[0], "signed thinking untouched");

  await new Promise(r => setTimeout(r, 20));
  const u = h.gateway.status().usage.providers.a;
  assert.equal(u.inputTokens, 24);
  assert.equal(u.cacheReadTokens, 900);
  assert.equal(u.cacheWriteTokens, 930);
  assert.equal(u.outputTokens, 14);
  const recent = h.gateway.status().requests.recent;
  assert.deepEqual(recent[0].usage, { inputTokens: 12, cacheReadTokens: 900, cacheWriteTokens: 30, outputTokens: 7 });
});

test("#2 a provider reporting partial usage keeps missing counters unknown; fallback is marked", async t => {
  const h = await harbor(t, {
    providers: [local("a", 42002), local("b", 42003)], routes: { coding: [{ provider: "a", model: "m" }, { provider: "b", model: "m" }] },
    handler: call => call.port === "42002" ? new Response("{}", { status: 503 }) : Response.json({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { completion_tokens: 5 } }),
  });
  await (await h.send("/v1/chat/completions", { model: "coding", messages: [{ role: "user", content: "hi" }] })).text();
  await new Promise(r => setTimeout(r, 20));
  const s = h.gateway.status();
  const b = s.usage.providers.b;
  assert.equal(b.outputTokens, 5);
  assert.equal(b.inputTokens, 0);
  assert.equal(b.unknownUsageRequests, 1);
  assert.equal(b.unknownCacheUsageRequests, 1);
  assert.equal(b.fallbackSuccesses, 1);
  assert.deepEqual(s.requests.recent[0].usage, { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 5 });
  assert.equal(s.requests.recent[0].fallback, true);
});

test("#2 OpenAI cached tokens are split from ordinary input; JSON Messages cache fields are recorded", () => {
  const chat = new StreamObserver("chat");
  chat.push(new TextEncoder().encode('data: {"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":80}}}\n\ndata: [DONE]\n\n'));
  assert.deepEqual(chat.result(), { inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 });
  assert.equal(chat.completed, true);
  const msg = new StreamObserver("messages");
  msg.observe({ type: "message", stop_reason: "end_turn", usage: { input_tokens: 3, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 2 } });
  assert.deepEqual(msg.result(), { inputTokens: 3, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 2 });
});

test("#2 version 1 usage files load with cache counters starting at zero", async t => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-usage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "usage.json");
  await writeFile(file, JSON.stringify({ version: 1, providers: { a: { attempts: 2, successes: 2, failures: 0, inputTokens: 10, outputTokens: 4, unknownUsageRequests: 0, lastStatus: 200 } } }));
  const store = new UsageStore({ file });
  await store.load();
  await store.record("a", { success: true, status: 200, outcome: "completed", inputTokens: 1, outputTokens: 1, cacheReadTokens: 7 });
  const a = store.snapshot().providers.a;
  assert.equal(a.inputTokens, 11);
  assert.equal(a.cacheReadTokens, 7);
  assert.equal(a.cacheWriteTokens, 0);
  assert.equal(a.unknownCacheUsageRequests, 1);
  assert.equal(store.snapshot().version, 2);
});

const middleFailureLog = () => {
  const lines = [];
  for (let i = 1; i <= 4000; i++) lines.push(`ok ${i} - billing suite case ${i} completes within budget`);
  lines.splice(2000, 0, "not ok 2001 - rounds invoice totals to cents", "  ---", "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 10.05 !== 10.04", "  at test/invoice.test.mjs:118:12", "  ...");
  lines.push("1..4001", "# tests 4001", "# pass 4000", "# fail 1");
  return lines.join("\n");
};
const multiFileDiff = () => {
  const parts = [];
  for (const file of ["src/invoice.mjs", "src/tax.mjs", "test/invoice.test.mjs"]) {
    parts.push(`diff --git a/${file} b/${file}`, "index 1111111..2222222 100644", `--- a/${file}`, `+++ b/${file}`);
    for (let h = 0; h < 6; h++) {
      parts.push(`@@ -${h * 100 + 1},40 +${h * 100 + 1},41 @@ function section${h}()`);
      for (let i = 0; i < 40; i++) parts.push(`${i % 3 ? " " : "+"} const value${i} = compute(${i}); // context line in ${file}`);
    }
  }
  return parts.join("\n");
};

test("#3 a test log whose only failure is in the middle keeps its evidence within the bound", () => {
  const log = middleFailureLog();
  const out = compactText(log, 3000);
  assert.ok(out.length <= 3000);
  for (const evidence of ["not ok 2001 - rounds invoice totals to cents", "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 10.05 !== 10.04", "test/invoice.test.mjs:118:12", "# tests 4001", "# fail 1"]) assert.ok(out.includes(evidence), evidence);
  assert.match(out, /\[Harbor omitted \d+ lines, \d+ chars\]/);
  assert.equal(compactText(log, 3000), out, "deterministic");
});

test("#3 a multi-file diff keeps every file path and hunk header", () => {
  const diff = multiFileDiff();
  const out = compactText(diff, 4000);
  assert.ok(out.length <= 4000);
  for (const file of ["src/invoice.mjs", "src/tax.mjs", "test/invoice.test.mjs"]) {
    assert.ok(out.includes(`diff --git a/${file} b/${file}`));
    assert.ok(out.includes(`+++ b/${file}`));
  }
  assert.equal((out.match(/^@@ /gm) ?? []).length, 18);
});

test("#3 the combined bound holds for a turn with many small results and a mixed turn", () => {
  const limit = 2000, budget = 6000;
  const many = { messages: [{ role: "user", content: Array.from({ length: 80 }, (_, i) => ({ type: "tool_result", tool_use_id: `toolu_${i}`, content: `result ${i}: ` + "x".repeat(180) })) }] };
  const result = compactToolOutputs(many, "messages", limit, budget);
  const texts = result.body.messages[0].content.map(b => b.content);
  assert.ok(texts.reduce((n, s) => n + s.length, 0) <= budget);
  assert.ok(texts.some(s => s.startsWith("[Harbor omitted tool output:")), "omissions are marked");
  assert.deepEqual(result.body.messages[0].content.map(b => b.tool_use_id), many.messages[0].content.map(b => b.tool_use_id));

  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  const mixed = { messages: [
    { role: "user", content: "Keep this instruction " + "verbatim ".repeat(2000) },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "npm test " + "--flag ".repeat(500) } }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: middleFailureLog() }, image] },
      { type: "tool_result", tool_use_id: "t2", content: multiFileDiff() },
      { type: "tool_result", tool_use_id: "t3", content: "small output" },
    ] },
  ] };
  const m = compactToolOutputs(mixed, "messages", limit, budget);
  const [logBlock, diffBlock, small] = m.body.messages[2].content;
  const total = logBlock.content[0].text.length + diffBlock.content.length + small.content.length;
  assert.ok(total <= budget, `combined ${total} <= ${budget}`);
  assert.ok(logBlock.content[0].text.includes("AssertionError [ERR_ASSERTION]"));
  assert.ok(diffBlock.content.includes("diff --git a/src/tax.mjs b/src/tax.mjs"));
  assert.equal(small.content, "small output");
  assert.deepEqual(logBlock.content[1], image);
  assert.deepEqual(m.body.messages.slice(0, 2), mixed.messages.slice(0, 2), "instructions and tool arguments unchanged");
});

test("#3 malformed tool results return 400, oversize bodies return an actionable 413", async t => {
  const h = await harbor(t, { providers: [local("a", 42004)], routes: { coding: [{ provider: "a", model: "m" }] }, extra: { toolOutputLimitChars: 1000, maxBodyBytes: 4096 }, handler: () => Response.json({}) });
  for (const content of [[null], [{ type: "tool_result", tool_use_id: "x", content: [null] }], [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: 5 }] }], [{ type: "tool_result", content: "missing id" }], "x"]) {
    const messages = typeof content === "string" ? [null] : [{ role: "user", content }];
    const res = await h.send("/v1/messages", { model: "coding", max_tokens: 5, messages });
    assert.equal(res.status, 400, JSON.stringify(content));
    assert.match((await res.json()).error.type, /invalid_tool_result/);
  }
  const chat = await h.send("/v1/chat/completions", { model: "coding", messages: [{ role: "tool", tool_call_id: "c", content: { nested: true } }] });
  assert.equal(chat.status, 400);
  const big = await h.send("/v1/messages", { model: "coding", max_tokens: 5, messages: [{ role: "user", content: "x".repeat(5000) }] });
  assert.equal(big.status, 413);
  assert.match((await big.json()).error.message, /maxBodyBytes \(4096 bytes\).*before compaction.*Raise maxBodyBytes/);
  assert.equal(h.calls.length, 0);
});
