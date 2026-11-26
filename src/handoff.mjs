// Opt-in crash handoff for Claude Code sessions, driven by documented hooks.
//
// The record holds: a user-supplied task summary, worktree identity, the
// starting Git revision, files already dirty at session start (path, status,
// content hash), files observed changing, and test commands with outcomes.
// It never holds file contents, prompts, transcripts, reasoning, or tool output.
// Recovery (`show`) only reads the working tree; it never modifies it.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, rename, open, unlink, stat, chmod } from "node:fs/promises";
import { createReadStream, realpathSync } from "node:fs";
import { join, resolve, isAbsolute, relative, sep, dirname, basename } from "node:path";

const TEST_COMMAND = /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?(test|check)\b|node\s+(--\S+\s+)*--test\b|npx\s+(jest|vitest|mocha)\b|pytest\b|python3?\s+-m\s+(pytest|unittest)\b|go\s+test\b|cargo\s+(test|nextest)\b|(jest|vitest|mocha|rspec|phpunit|ctest|tox)\b|\.\/gradlew\s+\S*test|gradle\s+\S*test|mvn\s+(\S+\s+)*(test|verify)\b|make\s+(test|check)\b|dotnet\s+test\b|swift\s+test\b|flutter\s+test\b)/;
export class HandoffError extends Error {}
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const RECORD_VERSION = 1;

export function isTestCommand(command) { return typeof command === "string" && TEST_COMMAND.test(command); }

// Keeps the command recognizable while removing likely secrets.
export function redactCommand(command) {
  return String(command)
    .replace(/\b([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, "$1=***")
    .replace(/(--?[\w-]*(token|key|secret|password|passwd|auth)[\w-]*[= ])("[^"]*"|'[^']*'|\S+)/gi, "$1***")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 ***")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "***")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 200);
}

function git(cwd, args) {
  // GIT_OPTIONAL_LOCKS=0 keeps `git status` from refreshing the index, so reads stay read-only.
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

export function worktreeIdentity(cwd) {
  let top;
  try { top = git(cwd, ["rev-parse", "--show-toplevel"]).toString("utf8").trim(); } catch { return null; }
  const commonDir = resolve(top, git(top, ["rev-parse", "--git-common-dir"]).toString("utf8").trim());
  let head = null, branch = null;
  try { head = git(top, ["rev-parse", "--verify", "-q", "HEAD"]).toString("utf8").trim(); } catch { /* unborn branch */ }
  try { branch = git(top, ["symbolic-ref", "--short", "-q", "HEAD"]).toString("utf8").trim() || null; } catch { /* detached */ }
  return { root: top, gitCommonDir: commonDir, branch, head };
}

async function hashFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return info.isDirectory() ? "directory" : "special";
    if (info.size > MAX_HASH_BYTES) return `size:${info.size}:mtime:${info.mtimeMs}`;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return "sha256:" + hash.digest("hex");
  } catch (error) { return error.code === "ENOENT" ? "deleted" : "unreadable"; }
}

// Current dirty paths (porcelain v1, -z) with content hashes.
export async function dirtyFiles(root) {
  const raw = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]).toString("utf8");
  const files = {};
  for (const entry of raw.split("\0")) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    files[path] = { status: entry.slice(0, 2), hash: await hashFile(join(root, path)) };
  }
  return files;
}

function committedSince(root, from, to) {
  if (!from || !to || from === to) return [];
  try { return git(root, ["diff", "--name-only", "-z", from, to]).toString("utf8").split("\0").filter(Boolean); } catch { return []; }
}

export function recordPath(stateDir, root) {
  return join(stateDir, "handoff", createHash("sha256").update(root).digest("hex").slice(0, 24) + ".json");
}

async function withLock(file, action) {
  const lock = file + ".lock";
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 15000) await unlink(lock); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error("handoff record is locked");
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { return await action(); }
  finally { await handle.close(); await unlink(lock).catch(() => {}); }
}

export async function readRecord(file) {
  try {
    const record = JSON.parse(await readFile(file, "utf8"));
    return record?.version === RECORD_VERSION ? record : null;
  } catch { return null; }
}

async function writeRecord(file, record) {
  record.updatedAt = new Date().toISOString();
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

function relativePath(root, path) {
  if (typeof path !== "string" || !path) return null;
  let absolute = isAbsolute(path) ? path : resolve(root, path);
  // Git reports the real path (e.g. /private/var on macOS); resolve symlinks to compare.
  try { absolute = realpathSync(absolute); }
  catch { try { absolute = join(realpathSync(dirname(absolute)), basename(absolute)); } catch { /* keep as given */ } }
  const rel = relative(root, absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : null;
}

async function rescan(record) {
  const now = new Date().toISOString();
  const dirty = await dirtyFiles(record.worktree.root);
  const identity = worktreeIdentity(record.worktree.root);
  const committed = committedSince(record.worktree.root, record.worktree.startHead, identity?.head);
  for (const [path, info] of Object.entries(dirty)) {
    const start = record.startDirty[path];
    if (start && start.hash === info.hash) continue;
    const change = record.changes[path] ?? { firstSeenAt: now, sources: [] };
    Object.assign(change, { lastSeenAt: now, hash: info.hash, status: info.status, preExisting: Boolean(start) });
    record.changes[path] = change;
  }
  for (const path of committed) {
    const change = record.changes[path] ?? { firstSeenAt: now, sources: [] };
    if (!change.sources.includes("commit")) change.sources.push("commit");
    change.lastSeenAt = now;
    change.preExisting = Boolean(record.startDirty[path]);
    record.changes[path] = change;
  }
  for (const path of Object.keys(record.changes)) {
    if (!dirty[path] && !committed.includes(path)) { record.changes[path].hash = await hashFile(join(record.worktree.root, path)); record.changes[path].status = "clean"; }
  }
  record.worktree.lastHead = identity?.head ?? null;
}

// Layout: handoff/<worktree>/<session>.json, plus handoff/<worktree>/task.json for
// the task summary. Records from the earlier single-record layout
// (handoff/<worktree>.json and .previous.json) are still read.
const hashOf = text => createHash("sha256").update(text).digest("hex").slice(0, 24);
function worktreeDir(stateDir, root) { return join(stateDir, "handoff", hashOf(root)); }
function sessionKey(input) { return typeof input.session_id === "string" && input.session_id ? input.session_id.slice(0, 128) : "unknown-session"; }
function sessionFile(stateDir, root, session) { return join(worktreeDir(stateDir, root), hashOf(session) + ".json"); }

// All readable records for a worktree, newest update first.
async function listRecords(stateDir, root) {
  const files = [];
  try { for (const name of await readdir(worktreeDir(stateDir, root))) if (name.endsWith(".json") && name !== "task.json") files.push(join(worktreeDir(stateDir, root), name)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const legacy = recordPath(stateDir, root);
  files.push(legacy, legacy.replace(/\.json$/, ".previous.json"));
  const records = [];
  const seen = new Set();
  for (const file of files) {
    const record = await readRecord(file);
    if (!record || record.worktree?.root !== root) continue;
    const key = `${record.sessionId}|${record.startedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({ file, record });
  }
  return records.sort((a, b) => String(b.record.updatedAt).localeCompare(String(a.record.updatedAt)));
}

async function readTask(stateDir, root) {
  try { const t = JSON.parse(await readFile(join(worktreeDir(stateDir, root), "task.json"), "utf8")); return typeof t.task === "string" ? t.task : null; }
  catch { return null; }
}

async function startSession(stateDir, input, identity, env) {
  const session = sessionKey(input);
  const others = (await listRecords(stateDir, identity.root)).filter(r => r.record.sessionId !== session && !r.record.endedAt);
  const notice = others.length
    ? `Nikhil Code Harbor handoff: other sessions in this worktree have not ended cleanly (${others.map(r => r.record.sessionId).join(", ")}). They may still be running, or may have crashed. Run \`harbor handoff show --session ID\` to see their recorded changes and unfinished checks before editing.`
    : null;
  const record = {
    version: RECORD_VERSION, sessionId: session,
    task: typeof env.HARBOR_HANDOFF_TASK === "string" ? env.HARBOR_HANDOFF_TASK.slice(0, 500) : await readTask(stateDir, identity.root),
    startedAt: new Date().toISOString(), endedAt: null,
    worktree: { root: identity.root, gitCommonDir: identity.gitCommonDir, branch: identity.branch, startHead: identity.head, lastHead: identity.head },
    startDirty: await dirtyFiles(identity.root), changes: {}, tests: [], events: 0,
  };
  return { record, notice };
}

// Decides a finished test's outcome. Success needs affirmative evidence (exit status 0);
// a missing exit status stays unknown; an explicit nonzero status is a failure.
function testOutcome(event, input) {
  const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : {};
  // PostToolUseFailure carries `error` whose first line may be "Exit code N"; only the number is kept.
  const fromError = typeof input.error === "string" ? /^Exit code (\d+)/.exec(input.error)?.[1] : undefined;
  const code = [response.exit_code, response.exitCode, fromError === undefined ? undefined : Number(fromError)].find(Number.isInteger);
  if (response.interrupted === true || input.is_interrupt === true) return { outcome: "unknown", note: "interrupted before it finished; rerun it", exitCode: code };
  if (code === 0) return { outcome: "passed", exitCode: 0 };
  if (code !== undefined) return { outcome: "failed", exitCode: code };
  return { outcome: "unknown", note: event === "PostToolUseFailure" ? "the tool reported a failure without an exit status; rerun it" : "finished, but no exit status was reported; rerun it to confirm" };
}

// Handles one Claude Code hook invocation, updating only that session's record.
// Never throws to the caller's process: a broken handoff must not interrupt the session.
export async function handleHook(input, { stateDir, env = process.env } = {}) {
  if (!input || typeof input !== "object" || typeof input.cwd !== "string") return null;
  const identity = worktreeIdentity(input.cwd);
  if (!identity) return null;
  await mkdir(worktreeDir(stateDir, identity.root), { recursive: true, mode: 0o700 });
  const file = sessionFile(stateDir, identity.root, sessionKey(input));
  return withLock(file, async () => {
    const event = input.hook_event_name;
    let notice = null;
    let record = await readRecord(file);
    if (!record) ({ record, notice } = await startSession(stateDir, input, identity, env));
    if (event !== "SessionStart") notice = null;
    record.events++;
    const tool = input.tool_name;
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    const now = new Date().toISOString();
    const id = typeof input.tool_use_id === "string" && input.tool_use_id ? input.tool_use_id.slice(0, 128) : null;
    if (event === "PreToolUse" && tool === "Bash" && isTestCommand(toolInput.command)) {
      record.tests.push({ id: id ?? `unidentified-${randomUUID()}`, idFromHook: Boolean(id), command: redactCommand(toolInput.command), startedAt: now, finishedAt: null, outcome: "running" });
    }
    if ((event === "PostToolUse" || event === "PostToolUseFailure") && tool === "Bash" && isTestCommand(toolInput.command)) {
      let test;
      if (id) test = record.tests.find(t => t.id === id && t.outcome === "running"); // never falls back to command text
      else {
        const redacted = redactCommand(toolInput.command);
        const pending = record.tests.filter(t => t.outcome === "running" && t.command === redacted);
        if (pending.length === 1) test = pending[0];
      }
      if (test) {
        const result = testOutcome(event, input);
        test.finishedAt = now;
        test.outcome = result.outcome;
        if (result.exitCode !== undefined) test.exitCode = result.exitCode;
        if (result.note) test.note = result.note;
      }
    }
    if (event === "PostToolUse" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const path = relativePath(record.worktree.root, toolInput.file_path ?? toolInput.notebook_path);
      if (path) {
        const change = record.changes[path] ?? { firstSeenAt: now, sources: [] };
        if (!change.sources.includes(tool)) change.sources.push(tool);
        change.lastSeenAt = now;
        record.changes[path] = change;
      }
    }
    if (event === "SessionEnd") record.endedAt = now;
    if (["SessionStart", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"].includes(event)) await rescan(record);
    await writeRecord(file, record);
    return notice;
  });
}

// Records a task summary for this worktree: applied to the newest unfinished
// session and to sessions started later.
export async function setTask(stateDir, cwd, summary) {
  const identity = worktreeIdentity(cwd);
  if (!identity) throw new HandoffError("Not inside a Git worktree. Run this from the project directory or pass --cwd DIR.");
  const dir = worktreeDir(stateDir, identity.root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const task = String(summary).replace(/[\r\n]+/g, " ").slice(0, 500);
  const taskFile = join(dir, "task.json");
  await withLock(taskFile, async () => {
    const temp = `${taskFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ task }) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, taskFile);
  });
  const active = (await listRecords(stateDir, identity.root)).find(r => !r.record.endedAt && r.file.startsWith(dir));
  if (active) await withLock(active.file, async () => { const record = await readRecord(active.file); if (record) { record.task = task; await writeRecord(active.file, record); } });
}

// Read-only comparison of one session's record with the current working tree.
// Default: the most recently updated session. `session` picks one by ID;
// `previous` picks the newest unfinished session other than the most recent one.
export async function buildHandoff(stateDir, cwd, { previous = false, session } = {}) {
  const identity = worktreeIdentity(cwd);
  if (!identity) throw new HandoffError("Not inside a Git worktree. Run this from the project directory or pass --cwd DIR.");
  const all = await listRecords(stateDir, identity.root);
  const chosen = session !== undefined ? all.find(r => r.record.sessionId === session)
    : previous ? all.slice(1).find(r => !r.record.endedAt)
    : all[0];
  if (!chosen) return null;
  const record = chosen.record;
  const dirty = await dirtyFiles(identity.root);
  const committed = committedSince(identity.root, record.worktree.startHead, identity.head);
  const preExisting = Object.entries(record.startDirty).map(([path, start]) => {
    const now = dirty[path];
    const state = !now ? (committed.includes(path) ? "committed during the session" : "no longer modified") : now.hash === start.hash ? "unchanged since the session started" : "changed again after the session started";
    return { path, status: start.status, state };
  });
  const sessionChanges = Object.entries(record.changes).filter(([path]) => !record.startDirty[path]).map(([path, change]) => {
    const now = dirty[path];
    const state = now ? (now.hash === change.hash ? "modified (matches last recorded state)" : "modified (changed after the last recorded event)") : committed.includes(path) ? "committed" : "no longer modified";
    return { path, status: now?.status ?? "clean", state, via: change.sources };
  });
  const unrecorded = Object.keys(dirty).filter(p => !record.startDirty[p] && !record.changes[p]).map(path => ({ path, status: dirty[path].status, state: "modified but never observed by a hook" }));
  const tests = record.tests.map(t => {
    const known = t.outcome === "passed" || t.outcome === "failed";
    const note = t.outcome === "running" ? "interrupted before its exit status was recorded; rerun it" : t.note;
    return { command: t.command, startedAt: t.startedAt, finishedAt: t.finishedAt, outcome: known ? t.outcome : "outcome unknown", ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}), ...(!known && note ? { note } : {}) };
  });
  const inspect = [
    ...sessionChanges.map(c => `${c.path}: ${c.state}`),
    ...preExisting.filter(c => c.state.startsWith("changed again")).map(c => `${c.path}: pre-existing change that was edited further`),
    ...unrecorded.map(c => `${c.path}: ${c.state}`),
    ...tests.filter(t => t.outcome !== "passed").map(t => `${t.command}: ${t.outcome}`),
  ];
  const otherSessions = all.filter(r => r !== chosen).map(r => ({ sessionId: r.record.sessionId, endedCleanly: Boolean(r.record.endedAt), updatedAt: r.record.updatedAt }));
  return {
    task: record.task, sessionId: record.sessionId, startedAt: record.startedAt, endedCleanly: Boolean(record.endedAt), updatedAt: record.updatedAt,
    worktree: { root: identity.root, branch: identity.branch, startHead: record.worktree.startHead, currentHead: identity.head, headMoved: record.worktree.startHead !== identity.head },
    preExisting, sessionChanges, unrecorded, tests, inspect, otherSessions,
  };
}

export function formatHandoff(h) {
  const lines = [];
  lines.push(`Handoff for ${h.worktree.root}${h.worktree.branch ? ` (${h.worktree.branch})` : ""}`);
  lines.push(`Session: ${h.sessionId ?? "(unknown)"}`);
  lines.push(`Task: ${h.task ?? "(none recorded; set one with: harbor handoff task --summary TEXT)"}`);
  lines.push(`Session started ${h.startedAt}; last recorded ${h.updatedAt}; ${h.endedCleanly ? "ended cleanly" : "did NOT end cleanly (still running, or crashed)"}`);
  lines.push(`Start revision ${h.worktree.startHead ?? "(none)"}${h.worktree.headMoved ? ` -> now ${h.worktree.currentHead}` : " (unchanged)"}`);
  if (h.otherSessions?.length) {
    lines.push(`Other recorded sessions in this worktree: ${h.otherSessions.map(o => `${o.sessionId} (${o.endedCleanly ? "ended cleanly" : "not ended"})`).join(", ")}`);
    lines.push("  Sessions sharing a worktree see each other's file changes; only tool-attributed changes (via ...) are certainly this session's.");
  }
  const section = (title, items, render) => { lines.push("", `${title}:`); if (!items.length) lines.push("  (none)"); for (const item of items) lines.push("  " + render(item)); };
  section("Already modified before the session started", h.preExisting, c => `${c.path} [${c.status.trim()}] ${c.state}`);
  section("Changed during the session", h.sessionChanges, c => `${c.path} ${c.state}${c.via.length ? ` (via ${c.via.join(", ")})` : ""}`);
  if (h.unrecorded.length) section("Modified but not seen by any hook", h.unrecorded, c => `${c.path} [${c.status.trim()}]`);
  section("Checks", h.tests, t => `${t.outcome.toUpperCase()}: ${t.command}${t.exitCode !== undefined ? ` (exit ${t.exitCode})` : ""}${t.note ? ` (${t.note})` : ""}`);
  section("Still needs inspection", h.inspect, x => x);
  lines.push("", "This view is read-only; Harbor has not modified any file.");
  return lines.join("\n");
}

export function hookSettings(harborScript) {
  const command = `node ${JSON.stringify(harborScript)} handoff hook`;
  const entry = matcher => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 30 }] });
  return { hooks: {
    SessionStart: [entry()],
    PreToolUse: [entry("Bash")],
    PostToolUse: [entry("Bash|Edit|Write|MultiEdit|NotebookEdit")],
    PostToolUseFailure: [entry("Bash")],
    Stop: [entry()],
    SessionEnd: [entry()],
  } };
}
