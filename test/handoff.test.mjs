// Regression tests for the crash handoff companion (#6) and the documented
// init-to-first-request setup (#5). Uses real Git worktrees and local fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactCommand, isTestCommand } from "../src/handoff.mjs";

const repoRoot = new URL("..", import.meta.url);
function run(args, { input = "", env = {}, cwd } = {}) {
  const child = spawn(process.execPath, [new URL("../bin/harbor.mjs", import.meta.url).pathname, ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", c => { stdout += c; });
  child.stderr.on("data", c => { stderr += c; });
  child.stdin.end(input);
  return { child, done: once(child, "close").then(([code]) => ({ code, stdout: stdout.trim(), stderr: stderr.trim() })) };
}
const cli = (args, opts) => run(args, opts).done;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });

test("#6 handoff distinguishes a pre-existing edit, a session edit, and a test interrupted mid-run, without touching files", async t => {
  const work = await mkdtemp(join(tmpdir(), "harbor-handoff-repo-"));
  const state = await mkdtemp(join(tmpdir(), "harbor-handoff-state-"));
  t.after(() => Promise.all([rm(work, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]));
  git(work, "init", "-q");
  await writeFile(join(work, "notes.md"), "original notes\n");
  await writeFile(join(work, "app.mjs"), "export const answer = 41;\n");
  git(work, "add", "."); git(work, "commit", "-qm", "start");
  const startHead = git(work, "rev-parse", "HEAD").trim();
  // The developer's own uncommitted edit, made before Claude Code starts.
  await writeFile(join(work, "notes.md"), "original notes\nuser's unfinished thought\n");

  const hook = (payload, env = {}) => cli(["handoff", "hook", "--state", state], { input: JSON.stringify({ session_id: "sess-1", cwd: work, ...payload }), env });
  assert.equal((await cli(["handoff", "task", "--summary", "Fix the off-by-one answer", "--state", state, "--cwd", work])).code, 0);
  assert.equal((await hook({ hook_event_name: "SessionStart", source: "startup" })).code, 0);
  // Claude edits another file.
  await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "toolu_e", tool_input: { file_path: join(work, "app.mjs") } });
  await writeFile(join(work, "app.mjs"), "export const answer = 42;\n");
  await hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "toolu_e", tool_input: { file_path: join(work, "app.mjs"), old_string: "41", new_string: "42" }, tool_response: { filePath: join(work, "app.mjs") } });
  // A completed check, then a check that starts but whose client is killed.
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_lint", tool_input: { command: "npm run check" } });
  await hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu_lint", tool_input: { command: "npm run check" }, error: "Exit code 2\nlint output that must not be stored" });
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_test", tool_input: { command: "API_TOKEN=abc123secretvalue npm test" } });
  // Simulated client: a long-running hook process terminated with SIGKILL, as when the terminal dies.
  const victim = run(["handoff", "hook", "--state", state], { input: "" });
  victim.child.kill("SIGKILL");
  await victim.done;

  const before = { notes: await readFile(join(work, "notes.md"), "utf8"), app: await readFile(join(work, "app.mjs"), "utf8") };
  const shown = await cli(["handoff", "show", "--json", "--state", state, "--cwd", work]);
  assert.equal(shown.code, 0, shown.stderr);
  const h = JSON.parse(shown.stdout);
  assert.equal(h.task, "Fix the off-by-one answer");
  assert.equal(h.endedCleanly, false);
  assert.equal(h.worktree.startHead, startHead);
  assert.deepEqual(h.preExisting, [{ path: "notes.md", status: " M", state: "unchanged since the session started" }]);
  assert.deepEqual(h.sessionChanges.map(c => [c.path, c.state, c.via]), [["app.mjs", "modified (matches last recorded state)", ["Edit"]]]);
  assert.deepEqual(h.tests.map(x => [x.command, x.outcome]), [["npm run check", "failed"], ["API_TOKEN=*** npm test", "outcome unknown"]]);
  assert.ok(h.inspect.some(x => x.startsWith("app.mjs")));
  assert.ok(h.inspect.some(x => x.includes("outcome unknown")));

  const text = await cli(["handoff", "show", "--state", state, "--cwd", work]);
  assert.match(text.stdout, /Already modified before the session started:\n  notes\.md/);
  assert.match(text.stdout, /OUTCOME UNKNOWN: API_TOKEN=\*\*\* npm test \(interrupted before its exit status was recorded; rerun it\)/);
  assert.match(text.stdout, /read-only/);

  // Recovery is read-only and the record holds no contents, prompts or output.
  assert.equal(await readFile(join(work, "notes.md"), "utf8"), before.notes);
  assert.equal(await readFile(join(work, "app.mjs"), "utf8"), before.app);
  assert.equal(git(work, "status", "--porcelain"), " M app.mjs\n M notes.md\n");
  // Records live under handoff/<worktree>/<session>.json.
  const [worktreeDir] = await readdir(join(state, "handoff"));
  const recordDir = join(state, "handoff", worktreeDir);
  const files = await readdir(recordDir);
  const recordFile = files.find(f => f.endsWith(".json") && f !== "task.json");
  const record = await readFile(join(recordDir, recordFile), "utf8");
  for (const secret of ["unfinished thought", "answer = 42", "abc123secretvalue", "lint output", "old_string"]) assert.ok(!record.includes(secret), secret);
  assert.equal((await stat(join(recordDir, recordFile))).mode & 0o777, 0o600);
  assert.ok(!files.some(f => f.endsWith(".tmp") || f.endsWith(".lock")), "atomic writes leave no temp or lock files");

  // A later edit outside any hook is flagged for inspection.
  await writeFile(join(work, "app.mjs"), "export const answer = 43;\n");
  const later = JSON.parse((await cli(["handoff", "show", "--json", "--state", state, "--cwd", work])).stdout);
  assert.equal(later.sessionChanges[0].state, "modified (changed after the last recorded event)");

  // Restarting Claude Code keeps the interrupted session's record and tells the agent how to view it.
  const restart = await cli(["handoff", "hook", "--state", state], { input: JSON.stringify({ session_id: "sess-2", cwd: work, hook_event_name: "SessionStart", source: "startup" }) });
  assert.match(restart.stdout, /not ended cleanly \(sess-1\)[\s\S]*handoff show --session ID/);
  const previous = JSON.parse((await cli(["handoff", "show", "--previous", "--json", "--state", state, "--cwd", work])).stdout);
  assert.equal(previous.sessionId, "sess-1");
});

test("#6 hook failures never block Claude Code, and command redaction removes likely secrets", async () => {
  const bad = await cli(["handoff", "hook", "--state", "/dev/null/not-a-dir"], { input: "{not json" });
  assert.equal(bad.code, 0);
  assert.equal(redactCommand("GITHUB_TOKEN=ghp_abc npm test --api-key=s3cr3t -H 'Authorization: Bearer xyz'"), "GITHUB_TOKEN=*** npm test --api-key=*** -H 'Authorization: Bearer ***");
  for (const c of ["npm test", "pnpm run test -- --watch=false", "node --test test/", "python -m pytest -q", "go test ./...", "cargo test", "npx vitest run"]) assert.ok(isTestCommand(c), c);
  for (const c of ["npm install", "git status", "ls test/"]) assert.ok(!isTestCommand(c), c);
  const install = await cli(["handoff", "install"]);
  const settings = JSON.parse(install.stdout.slice(install.stdout.indexOf("{")));
  assert.deepEqual(Object.keys(settings.hooks), ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]);
});

test("#5 the documented setup works from init to the first successful Claude Code-style request", async t => {
  const state = await mkdtemp(join(tmpdir(), "harbor-setup-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  // Fixture standing in for a developer-run local server with a native Messages endpoint.
  const received = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "qwen-coder-local" }] }));
    if (req.method === "POST" && req.url === "/v1/messages") {
      let body = ""; for await (const c of req) body += c;
      received.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(r => server.close(r)));
  const upstream = `http://127.0.0.1:${server.address().port}/v1`;

  // 1. init  2. local  3. doctor  4. serve  5. first request (as Claude Code sends it)
  assert.equal((await cli(["init", "--state", state])).code, 0);
  const wrong = await cli(["local", "--base-url", upstream, "--model", "not-installed", "--state", state]);
  assert.match(wrong.stderr, /not listed/);
  const linked = await cli(["local", "--base-url", upstream, "--model", "qwen-coder-local", "--protocols", "messages,chat", "--route", "coding", "--state", state]);
  assert.equal(linked.code, 0, linked.stderr);
  assert.match(linked.stdout, /Billing: your local server's compute only/);
  const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
  config.port = 0; // let the OS choose for the test
  await writeFile(join(state, "config.json"), JSON.stringify(config));
  const doctor = await cli(["doctor", "--state", state]);
  const coding = JSON.parse(doctor.stdout).find(x => x.alias === "coding");
  assert.equal(coding.claudeCode, "eligible");
  assert.equal(coding.reachable, "model listed");
  assert.equal(JSON.parse(doctor.stdout).find(x => x.alias === "harbor-auto").eligibility.messages, "credential environment variable OPENROUTER_API_KEY is not set");

  const serve = run(["serve", "--state", state]);
  t.after(() => serve.child.kill("SIGTERM"));
  let out = "";
  serve.child.stdout.on("data", c => { out += c; });
  for (let i = 0; i < 200 && !/http:\/\/127\.0\.0\.1:\d+/.test(out); i++) await new Promise(r => setTimeout(r, 10));
  const base = out.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const token = (await readFile(join(state, "gateway.token"), "utf8")).trim();
  const res = await fetch(base + "/v1/messages?beta=true", { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219,prompt-caching-scope-2026-01-05",
  }, body: JSON.stringify({ model: "coding", max_tokens: 256, stream: true, system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }], tools: [{ name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }], metadata: { user_id: "fixture" } }) });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /message_stop/);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.model, "qwen-coder-local");
  assert.equal(received[0].headers["anthropic-beta"], "claude-code-20250219,prompt-caching-scope-2026-01-05");
  assert.equal(received[0].headers.authorization, undefined, "the Harbor token stays local");
  // Point the CLI at the port the OS chose, then read status as a developer would.
  await writeFile(join(state, "config.json"), JSON.stringify({ ...config, port: Number(new URL(base).port) }));
  const status = await cli(["status", "--state", state]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Last request received: \d{4}-/);
  assert.match(status.stdout, /local \[messages,chat\]: ready/);
  assert.match(status.stdout, /-> completed via local in=12 cacheR=0 cacheW=0 out=2/);
  const client = await cli(["client", "--route", "coding", "--state", state]);
  assert.match(client.stdout, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(client.stdout, /ANTHROPIC_DEFAULT_HAIKU_MODEL="coding"/);
  assert.ok(!client.stdout.includes(token));
});
