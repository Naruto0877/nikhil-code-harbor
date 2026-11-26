// Regression tests for five cases found by independent review. Local fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../src/gateway.mjs";
import { handleHook, buildHandoff } from "../src/handoff.mjs";

const TOKEN = "review-test-token-".repeat(3);
const A = "43001", B = "43002";
const provider = (id, port) => ({ id, kind: "local", baseUrl: `http://127.0.0.1:${port}/v1`, protocols: ["messages", "chat"] });
const route = { coding: [{ provider: "a", model: "a" }, { provider: "b", model: "b" }] };
const body = { model: "coding", max_tokens: 32, messages: [{ role: "user", content: "task" }] };
const done = () => Response.json({ type: "message", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });

async function harbor(t, handler, { extra = {}, clock } = {}) {
  const calls = [];
  const gateway = createGateway({
    config: { port: 0, providers: [provider("a", A), provider("b", B)], routes: route, ...extra }, token: TOKEN, env: {},
    ...(clock ? { now: clock } : {}),
    fetchImpl: async (url, options) => { const call = { port: new URL(url).port, ...options }; calls.push(call); return handler(call, calls); },
  });
  await gateway.listen();
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const send = extraBody => fetch(base + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, ...extraBody }) });
  return { gateway, calls, send, to: port => calls.filter(c => c.port === port) };
}
async function eventually(check) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), "condition did not become true");
}

test("review 1: a 429 carrying a structured spend-limit code is a billing stop, not a fallback", async t => {
  const spend = await harbor(t, call => call.port === A
    ? new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Request rejected.", details: { error_code: "enforced_spend_limit_reached" } } }), { status: 429, headers: { "retry-after": "30" } })
    : done());
  const res = await spend.send();
  assert.equal(res.status, 402);
  const error = (await res.json()).error;
  assert.equal(error.category, "upstream_billing");
  assert.equal(error.provider, "a");
  assert.equal(spend.to(B).length, 0, "the backup receives nothing");

  const transient = await harbor(t, call => call.port === A
    ? new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Request rejected.", details: { error_code: "request_rate_limit_exceeded" } } }), { status: 429 })
    : done());
  const ok = await transient.send();
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-harbor-provider"), "b");
  await ok.text();
});

test("review 4: a two-hour Retry-After is honored in full, as seconds and as an HTTP date", async t => {
  for (const [label, header] of [["seconds", () => "7200"], ["HTTP date", now => new Date(now + 7200000).toUTCString()]]) {
    await t.test(label, async t => {
      let clock = Date.parse("2026-11-25T10:00:00Z");
      const h = await harbor(t, (call, calls) => call.port === A && calls.length === 1 ? new Response("{}", { status: 429, headers: { "retry-after": header(clock) } }) : done(), { clock: () => clock });
      await (await h.send()).text();
      assert.equal(h.gateway.status().providers[0].cooldown.until, new Date(clock + 7200000).toISOString());
      const start = clock;
      clock = start + 61 * 60000;
      await (await h.send()).text();
      assert.equal(h.to(A).length, 1, "still skipped after 61 minutes");
      clock = start + 120 * 60000;
      await (await h.send()).text();
      assert.equal(h.to(A).length, 2, "eligible again after 120 minutes");
    });
  }
});

test("review 5: requestDeadlineMs also bounds a stream that never goes idle; it is not replayed", async t => {
  const enc = new TextEncoder();
  const h = await harbor(t, call => {
    if (call.port === B) return done();
    let n = 0, timer;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n'));
        timer = setInterval(() => {
          if (++n > 40) { clearInterval(timer); controller.enqueue(enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n')); controller.close(); return; }
          controller.enqueue(enc.encode(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${n}"}}\n\n`));
        }, 40);
        call.signal.addEventListener("abort", () => { clearInterval(timer); try { controller.error(new Error("aborted")); } catch {} });
      },
      cancel() { clearInterval(timer); },
    }), { headers: { "content-type": "text/event-stream" } });
  }, { extra: { requestDeadlineMs: 400, firstByteTimeoutMs: 1000, streamIdleTimeoutMs: 200 } });
  const started = Date.now();
  const res = await h.send({ stream: true });
  assert.equal(res.status, 200);
  await assert.rejects(res.text(), "the client sees the stream cut off");
  assert.ok(Date.now() - started < 1400, "stopped by the deadline, before the 1.6 s stream would finish");
  await eventually(() => h.gateway.status().requests.recent[0]?.outcome === "interrupted");
  const entry = h.gateway.status().requests.recent[0];
  assert.equal(entry.category, "deadline_exceeded");
  assert.equal(entry.attempts.at(-1).category, "deadline_exceeded");
  assert.equal(h.to(B).length, 0, "partial output is never replayed");
  // The message shown in status and the workbench describes a mid-stream deadline, not a pre-output one.
  const midStream = "requestDeadlineMs (400 ms) was reached after a had started streaming; the response was cut off and was not replayed to another provider.";
  assert.equal(entry.detail, midStream);
  assert.equal(h.gateway.status().requests.lastFailure.detail, midStream);
  assert.doesNotMatch(entry.detail, /before any provider/);
});

// ---- handoff ----
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv });
async function repo(t) {
  const work = await mkdtemp(join(tmpdir(), "harbor-review-repo-"));
  const state = await mkdtemp(join(tmpdir(), "harbor-review-state-"));
  t.after(() => Promise.all([rm(work, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]));
  git(work, "init", "-q");
  await writeFile(join(work, "a.txt"), "a\n");
  await writeFile(join(work, "b.txt"), "b\n");
  git(work, "add", "."); git(work, "commit", "-qm", "start");
  return { work, state, root: git(work, "rev-parse", "--show-toplevel").trim() };
}
function cli(args) {
  const child = spawn(process.execPath, [new URL("../bin/harbor.mjs", import.meta.url).pathname, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let stdout = "", stderr = "";
  child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
  child.stdin.end();
  return once(child, "close").then(([code]) => ({ code, stdout, stderr }));
}

test("review 2: test outcomes are matched by tool_use_id and need affirmative evidence", async t => {
  const { work, state } = await repo(t);
  const hook = event => handleHook({ session_id: "s-tests", cwd: work, ...event }, { stateDir: state, env: {} });
  const bash = (event, id, extra = {}) => hook({ hook_event_name: event, tool_name: "Bash", ...(id ? { tool_use_id: id } : {}), tool_input: { command: "npm test" }, ...extra });
  await hook({ hook_event_name: "SessionStart", source: "startup" });
  await bash("PreToolUse", "t1");
  await bash("PreToolUse", "t2");
  // Finished out of order: the second run fails first, then the first passes.
  await bash("PostToolUseFailure", "t2", { error: "Exit code 1\nfailing output" });
  await bash("PostToolUse", "t1", { tool_response: { stdout: "", stderr: "", interrupted: false, exit_code: 0 } });
  // An unknown ID must not be matched by command text.
  await bash("PreToolUse", "t3");
  await bash("PostToolUseFailure", "t-unknown", { error: "Exit code 1" });
  // A success event without an exit status stays unknown.
  await bash("PreToolUse", "t4");
  await bash("PostToolUse", "t4", { tool_response: { stdout: "", stderr: "", interrupted: false } });
  // Without IDs: two identical pending commands are ambiguous; one is matched.
  await bash("PreToolUse", null);
  await bash("PreToolUse", null);
  await bash("PostToolUseFailure", null, { error: "Exit code 3" });
  let h = await buildHandoff(state, work);
  const outcomes = () => h.tests.map(x => x.outcome);
  assert.deepEqual(outcomes(), ["passed", "failed", "outcome unknown", "outcome unknown", "outcome unknown", "outcome unknown"]);
  assert.equal(h.tests[0].exitCode, 0);
  assert.equal(h.tests[1].exitCode, 1);
  assert.equal(h.tests[2].finishedAt, null, "t3 untouched by the unmatched event");
  assert.ok(h.tests[3].finishedAt, "t4 finished");
  assert.match(h.tests[3].note, /exit status/);
  assert.equal(h.tests[4].finishedAt, null);
  assert.equal(h.tests[5].finishedAt, null);
  // Resolve one ID-less run by ID-less matching once it is unambiguous.
  await bash("PostToolUseFailure", null, { error: "Exit code 3" }); // still two pending: ignored
  await handleHook({ session_id: "s-tests", cwd: work, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run check" } }, { stateDir: state, env: {} });
  await handleHook({ session_id: "s-tests", cwd: work, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm run check" }, error: "Exit code 2" }, { stateDir: state, env: {} });
  h = await buildHandoff(state, work);
  assert.deepEqual(h.tests.at(-1), { ...h.tests.at(-1), command: "npm run check", outcome: "failed", exitCode: 2 });
  assert.equal(h.tests[4].finishedAt, null);
});

test("review 3: interleaved sessions in one worktree keep separate records", async t => {
  const { work, state, root } = await repo(t);
  const hook = (session, event) => handleHook({ session_id: session, cwd: work, ...event }, { stateDir: state, env: {} });
  await hook("session-A", { hook_event_name: "SessionStart", source: "startup" });
  await hook("session-B", { hook_event_name: "SessionStart", source: "startup" });
  await writeFile(join(work, "a.txt"), "edited by A\n");
  await hook("session-A", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(work, "a.txt") } });
  await hook("session-B", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b-test", tool_input: { command: "npm test" } });
  await hook("session-A", { hook_event_name: "SessionEnd", reason: "other" });
  await writeFile(join(work, "b.txt"), "edited by B\n");
  await hook("session-B", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(work, "b.txt") } });

  const a = await buildHandoff(state, work, { session: "session-A" });
  const b = await buildHandoff(state, work, { session: "session-B" });
  assert.equal(a.sessionId, "session-A");
  assert.equal(a.endedCleanly, true);
  assert.equal(b.sessionId, "session-B");
  assert.equal(b.endedCleanly, false, "A's SessionEnd must not end B");
  assert.deepEqual(a.sessionChanges.find(c => c.path === "a.txt").via, ["Edit"]);
  assert.deepEqual(b.sessionChanges.find(c => c.path === "b.txt").via, ["Write"]);
  assert.deepEqual(a.tests, []);
  assert.deepEqual(b.tests.map(x => x.outcome), ["outcome unknown"]);

  // Default view: the most recently updated session, named in the output.
  const shown = await cli(["handoff", "show", "--state", state, "--cwd", work]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /Session: session-B/);
  assert.match(shown.stdout, /Other recorded sessions in this worktree: session-A \(ended cleanly\)/);
  const listed = await cli(["handoff", "show", "--session", "session-A", "--state", state, "--cwd", work]);
  assert.match(listed.stdout, /Session: session-A/);

  // Records written by the earlier single-record layout remain readable.
  const legacyDir = join(state, "handoff");
  await mkdir(legacyDir, { recursive: true });
  const legacyName = createHash("sha256").update(root).digest("hex").slice(0, 24);
  const legacy = { version: 1, sessionId: "legacy-session", task: "old task", startedAt: "2026-11-24T00:00:00.000Z", endedAt: null, updatedAt: "2026-11-24T00:00:01.000Z",
    worktree: { root, gitCommonDir: join(root, ".git"), branch: null, startHead: git(work, "rev-parse", "HEAD").trim(), lastHead: null }, startDirty: {}, changes: {}, tests: [{ id: "x", command: "npm test", startedAt: "2026-11-24T00:00:00.500Z", finishedAt: null, outcome: "running" }], events: 2 };
  await writeFile(join(legacyDir, legacyName + ".json"), JSON.stringify(legacy));
  const old = await buildHandoff(state, work, { session: "legacy-session" });
  assert.equal(old.task, "old task");
  assert.deepEqual(old.tests.map(x => x.outcome), ["outcome unknown"]);
  assert.match((await cli(["handoff", "show", "--session", "legacy-session", "--state", state, "--cwd", work])).stdout, /Session: legacy-session/);
  assert.ok((await readFile(join(work, "a.txt"), "utf8")).includes("edited by A"), "show never modifies files");
});
