// Optional, deterministic, lossy compaction of tool-result text only. Disabled by default.
//
// - Shapes are validated first; malformed content is a 400, never a 500.
// - Each turn's tool results share a combined budget (toolOutputBudgetChars),
//   and no single segment exceeds toolOutputLimitChars.
// - Test logs keep failing test names, assertions, file:line references and the
//   final summary. Diffs keep file headers and hunk headers.
// - The output depends only on that turn's tool results, so history that was
//   compacted in an earlier request is reproduced byte-for-byte in later ones.
// - User text, tool-call IDs, tool arguments, images, and thinking blocks are
//   never modified.
import { GatewayError } from "./config.mjs";

const isObject = x => x !== null && typeof x === "object" && !Array.isArray(x);
function invalid(path, expected) {
  throw new GatewayError(400, "invalid_tool_result", `Malformed request content at ${path}: expected ${expected}`);
}
function checkParts(parts, path) {
  if (typeof parts === "string" || parts === undefined) return;
  if (!Array.isArray(parts)) invalid(path, "a string or an array of content parts");
  parts.forEach((part, i) => {
    if (!isObject(part) || typeof part.type !== "string") invalid(`${path}[${i}]`, "an object with a string type");
    if (/^(input_|output_)?text$/.test(part.type) && typeof part.text !== "string") invalid(`${path}[${i}].text`, "a string");
  });
}

export function validateToolShapes(body, protocol) {
  if (protocol === "responses") {
    if (typeof body.input === "string" || body.input === undefined) return;
    if (!Array.isArray(body.input)) invalid("input", "a string or an array");
    body.input.forEach((item, i) => {
      if (!isObject(item)) invalid(`input[${i}]`, "an object");
      if (item.type === "function_call_output") {
        if (typeof item.call_id !== "string") invalid(`input[${i}].call_id`, "a string");
        if (item.output === undefined) invalid(`input[${i}].output`, "a string or an array of content parts");
        checkParts(item.output, `input[${i}].output`);
      }
    });
    return;
  }
  body.messages.forEach((message, i) => {
    if (!isObject(message) || typeof message.role !== "string") invalid(`messages[${i}]`, "an object with a string role");
    if (protocol === "chat") {
      if (message.role === "tool") {
        if (typeof message.tool_call_id !== "string") invalid(`messages[${i}].tool_call_id`, "a string");
        checkParts(message.content, `messages[${i}].content`);
      }
      return;
    }
    if (typeof message.content === "string") return;
    if (!Array.isArray(message.content)) invalid(`messages[${i}].content`, "a string or an array of content blocks");
    message.content.forEach((block, j) => {
      if (!isObject(block) || typeof block.type !== "string") invalid(`messages[${i}].content[${j}]`, "an object with a string type");
      if (block.type === "tool_result") {
        if (typeof block.tool_use_id !== "string") invalid(`messages[${i}].content[${j}].tool_use_id`, "a string");
        checkParts(block.content, `messages[${i}].content[${j}].content`);
      }
    });
  });
}

const DIFF_HEADER = /^(diff --git |--- |\+\+\+ |@@ |index [0-9a-f]+\.\.|new file mode|deleted file mode|rename (from|to) |similarity index|Binary files )/;
const FAILURE = /(\bFAIL(ED|URE|S)?\b|\bnot ok\b|✗|✖|×|\bError\b|Error:|AssertionError|\bassert|\bexpected\b|\breceived\b|\bactual\b|panicked|Traceback|Exception|\bfailing\b|\bfailed\b)/i;
const LOCATION = /([\w.@/\\-]+\.[A-Za-z0-9]+):(\d+)(:\d+)?/;
const SUMMARY = /^\s*(#\s*)?(tests?|suites?|pass(ed)?|fail(ed)?|ok|FAILED|PASSED|Ran \d+|\d+ (passing|failing|passed|failed)|=+ .*(passed|failed)|Test Suites:|Tests:|test result:)/i;
const MARKER_COST = 64;
const GAP_COST = 48; // upper bound for one rendered line marker
const MIN_USEFUL = 256; // below this, a result is replaced by a marker instead of shredded
const RESULT_MARKER = 48; // upper bound for a whole-result marker

function kindOf(lines) {
  if (lines.filter(l => DIFF_HEADER.test(l)).length >= 2 && lines.some(l => l.startsWith("@@ ") || l.startsWith("diff --git "))) return "diff";
  if (lines.some(l => FAILURE.test(l)) || lines.some(l => SUMMARY.test(l))) return "log";
  return "text";
}
const marker = (lines, chars) => `[Harbor omitted ${lines} line${lines === 1 ? "" : "s"}, ${chars} chars]`;
const resultMarker = chars => `[Harbor omitted tool output: ${chars} chars]`;
function safeSlice(text, end) {
  let out = text.slice(0, Math.max(0, end));
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

// Reduces one text segment to at most `max` UTF-16 code units (when max >= 64),
// marking every omission.
export function compactText(text, max) {
  if (typeof text !== "string" || text.length <= max) return text;
  if (max < MARKER_COST) return "";
  const lines = text.split("\n");
  const lineCap = Math.max(80, Math.min(500, Math.floor(max / 4)));
  const clip = line => line.length > lineCap ? safeSlice(line, lineCap - 1) + "…" : line;
  const kind = kindOf(lines);
  const priority = new Array(lines.length).fill(0);
  if (kind === "diff") {
    lines.forEach((l, i) => { if (DIFF_HEADER.test(l)) priority[i] = l.startsWith("index ") ? 2 : 3; });
  } else if (kind === "log") {
    lines.forEach((l, i) => {
      if (FAILURE.test(l)) {
        priority[i] = 3;
        for (const j of [i - 1, i + 1, i + 2]) if (j >= 0 && j < lines.length && priority[j] < 1) priority[j] = 1;
      } else if (LOCATION.test(l)) priority[i] = Math.max(priority[i], 2);
    });
    // The final summary block (last non-empty lines) is kept when present.
    let kept = 0;
    for (let i = lines.length - 1; i >= 0 && kept < 8; i--) if (lines[i].trim()) { kept++; if (SUMMARY.test(lines[i]) || kept <= 3) priority[i] = Math.max(priority[i], 3); }
  }
  const keep = new Set();
  // Incremental upper bound on the rendered size: kept lines + one marker per gap + newlines.
  const n = lines.length;
  let keptChars = 0, gaps = 1;
  const cost = () => keptChars + gaps * GAP_COST + (keep.size + gaps - 1);
  const tryAdd = i => {
    if (keep.has(i)) return true;
    const left = i > 0 && !keep.has(i - 1), right = i < n - 1 && !keep.has(i + 1);
    const deltaGaps = (left ? 1 : 0) + (right ? 1 : 0) - 1;
    const len = clip(lines[i]).length;
    if (keptChars + len + (gaps + deltaGaps) * GAP_COST + (keep.size + 1 + gaps + deltaGaps - 1) > max) return false;
    keep.add(i); keptChars += len; gaps += deltaGaps;
    return cost() <= max;
  };
  for (const level of [3, 2, 1]) for (let i = 0; i < lines.length; i++) if (priority[i] === level) tryAdd(i);
  // Fill remaining space with context from the start and end.
  for (let a = 0, b = lines.length - 1; a <= b; a++, b--) {
    const head = tryAdd(a);
    const tail = a === b ? head : tryAdd(b);
    if (!head && !tail) break;
  }
  const out = [];
  let omittedLines = 0, omittedChars = 0;
  const flush = () => { if (omittedLines) { out.push(marker(omittedLines, omittedChars)); omittedLines = 0; omittedChars = 0; } };
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      flush();
      const shown = clip(lines[i]);
      if (shown !== lines[i]) { out.push(shown); continue; }
      out.push(lines[i]);
    } else { omittedLines++; omittedChars += lines[i].length + 1; }
  }
  flush();
  let result = out.join("\n");
  // A single huge line (minified output) degrades to a head/tail cut.
  if (result.length > max || !keep.size || kind === "text" || n < 4) {
    const budget = max - MARKER_COST - 8;
    const head = safeSlice(text, Math.floor(budget * 0.6));
    let tail = text.slice(text.length - Math.floor(budget * 0.4));
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
    result = `${head}\n${marker(text.slice(head.length, text.length - tail.length).split("\n").length, text.length - head.length - tail.length)}\n${tail}`;
  }
  return result;
}

// Allocation for one turn's segments. Returns, per segment, a character
// allowance (>= its length means unchanged) or "marker" / "drop".
// Water-filling keeps small segments whole and shares the rest among large
// ones; when that would leave useless fragments, the smallest results are
// kept whole and the others are replaced by a marker.
function allocate(lengths, limit, budget) {
  const order = lengths.map((len, i) => [len, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const alloc = new Array(lengths.length).fill(0);
  let remaining = budget;
  order.forEach(([len, i], k) => {
    const share = Math.floor(remaining / (order.length - k));
    alloc[i] = Math.min(len, limit, share);
    remaining -= alloc[i];
  });
  if (alloc.every((a, i) => a >= lengths[i] || a >= MIN_USEFUL)) return alloc;
  const plan = new Array(lengths.length).fill("drop");
  const markers = Math.min(lengths.length, Math.floor(budget / RESULT_MARKER));
  remaining = budget - markers * RESULT_MARKER;
  let marked = 0;
  for (const [len, i] of order) {
    const extra = len - RESULT_MARKER;
    if (len <= limit && marked < markers && extra <= remaining) { plan[i] = len; remaining -= Math.max(0, extra); marked++; }
  }
  // Remaining results get a marker while reserved marker space lasts, in original order.
  for (let i = 0; i < plan.length && marked < markers; i++) if (plan[i] === "drop") { plan[i] = "marker"; marked++; }
  return plan;
}

// Collects setter handles for every tool-result text segment, grouped by turn.
function groups(body, protocol) {
  const out = [];
  const textParts = (container, key, parts) => {
    if (typeof container[key] === "string") parts.push({ get: () => container[key], set: v => { container[key] = v; } });
    else if (Array.isArray(container[key])) for (const part of container[key]) if (typeof part.text === "string" && /^(input_|output_)?text$/.test(part.type)) parts.push({ get: () => part.text, set: v => { part.text = v; } });
  };
  if (protocol === "messages") {
    for (const message of body.messages) {
      if (!Array.isArray(message.content)) continue;
      const parts = [];
      for (const block of message.content) if (block.type === "tool_result") textParts(block, "content", parts);
      if (parts.length) out.push(parts);
    }
  } else if (protocol === "chat") {
    let parts = [];
    for (const message of body.messages) {
      if (message.role === "tool") textParts(message, "content", parts);
      else if (parts.length) { out.push(parts); parts = []; }
    }
    if (parts.length) out.push(parts);
  } else if (Array.isArray(body.input)) {
    let parts = [];
    for (const item of body.input) {
      if (item.type === "function_call_output") textParts(item, "output", parts);
      else if (parts.length) { out.push(parts); parts = []; }
    }
    if (parts.length) out.push(parts);
  }
  return out;
}

export function compactToolOutputs(body, protocol, limit, budget = limit * 4) {
  if (!limit) return { body, removedChars: 0 };
  validateToolShapes(body, protocol);
  const result = structuredClone(body);
  let removedChars = 0;
  for (const parts of groups(result, protocol)) {
    const lengths = parts.map(p => p.get().length);
    const alloc = allocate(lengths, limit, Math.max(budget, limit));
    parts.forEach((part, i) => {
      if (typeof alloc[i] === "number" && alloc[i] >= lengths[i]) return;
      const next = alloc[i] === "marker" ? resultMarker(lengths[i]) : alloc[i] === "drop" ? "" : compactText(part.get(), alloc[i]);
      removedChars += lengths[i] - next.length;
      part.set(next);
    });
  }
  return { body: result, removedChars };
}
