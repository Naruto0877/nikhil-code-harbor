// Reads provider output alongside forwarding. It never modifies the bytes sent
// to the client; it only extracts usage counters and protocol completion signals.
const USAGE_FIELDS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];
const count = x => Number.isSafeInteger(x) && x >= 0 ? x : undefined;

export function usageFrom(usage, protocol) {
  if (!usage || typeof usage !== "object") return {};
  const out = {};
  if (protocol === "messages") {
    // Anthropic Messages: input_tokens already excludes cache reads and writes.
    out.inputTokens = count(usage.input_tokens);
    out.cacheReadTokens = count(usage.cache_read_input_tokens);
    out.cacheWriteTokens = count(usage.cache_creation_input_tokens);
    out.outputTokens = count(usage.output_tokens);
  } else {
    // OpenAI Chat / Responses: the prompt total includes cached tokens.
    const total = count(usage.prompt_tokens ?? usage.input_tokens);
    const cached = count((usage.prompt_tokens_details ?? usage.input_tokens_details)?.cached_tokens);
    out.cacheReadTokens = cached;
    out.inputTokens = total !== undefined && cached !== undefined ? Math.max(0, total - cached) : total;
    out.outputTokens = count(usage.completion_tokens ?? usage.output_tokens);
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export class StreamObserver {
  constructor(protocol) {
    this.protocol = protocol;
    this.pending = "";
    this.decoder = new TextDecoder();
    this.values = {};
    this.failed = false;
    this.completed = false;
    this.openToolCalls = new Set();
    this.responseId = null;
  }
  #usage(usage) {
    // Streaming usage is cumulative; repeated or later events never add to earlier ones.
    for (const [k, v] of Object.entries(usageFrom(usage, this.protocol))) this.values[k] = Math.max(this.values[k] ?? 0, v);
  }
  observe(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.error || payload.type === "error" || payload.type === "response.failed" || payload.response?.error) this.failed = true;
    const type = payload.type;
    if (this.protocol === "messages") {
      if (type === "message_stop") this.completed = true;
      if (type === "content_block_start" && payload.content_block?.type === "tool_use") this.openToolCalls.add(payload.index);
      if (type === "content_block_stop") this.openToolCalls.delete(payload.index);
      // Non-streaming message object.
      if (type === "message" && payload.stop_reason !== undefined && payload.stop_reason !== null) this.completed = true;
    } else if (this.protocol === "responses") {
      if (type === "response.completed" || type === "response.incomplete") this.completed = true;
      if (type === "response.output_item.added" && payload.item?.type === "function_call") this.openToolCalls.add(payload.output_index);
      if (type === "response.output_item.done") this.openToolCalls.delete(payload.output_index);
      const id = payload.response?.id ?? (payload.object === "response" ? payload.id : undefined);
      if (typeof id === "string" && id.length < 256) this.responseId = id;
      if (payload.object === "response" && ["completed", "incomplete"].includes(payload.status)) this.completed = true;
    } else {
      for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
        for (const call of choice?.delta?.tool_calls ?? []) this.openToolCalls.add(call?.index ?? 0);
        if (choice?.finish_reason) { this.completed = true; this.openToolCalls.clear(); }
      }
    }
    this.#usage(payload.usage ?? payload.message?.usage ?? payload.response?.usage);
  }
  push(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { this.completed = true; continue; }
      try { this.observe(JSON.parse(data)); } catch { /* SSE comments or non-JSON data */ }
    }
    // Oversized events simply leave usage unknown.
    if (this.pending.length > 262144) this.pending = "";
  }
  get partialToolCall() { return !this.completed && this.openToolCalls.size > 0; }
  // Unknown counters stay absent, never zero.
  result() { return Object.fromEntries(USAGE_FIELDS.filter(k => k in this.values).map(k => [k, this.values[k]])); }
}
