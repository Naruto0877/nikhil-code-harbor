// Explicit, lossy compaction of tool results only. Conversation and source text
// outside tool-result fields is left untouched. Disabled in the default config.
export function compactToolOutputs(body, protocol, limit) {
  if (!limit) return { body, removedChars: 0 };
  const result = structuredClone(body);
  let removedChars = 0;
  const shorten = text => {
    if (typeof text !== "string" || text.length <= limit) return text;
    const budget = limit - 128;
    let head = text.slice(0, Math.floor(budget * 0.6));
    let tail = text.slice(-Math.floor(budget * 0.4));
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
    const omitted = text.length - head.length - tail.length;
    removedChars += omitted;
    return `${head}\n[Nikhil Code Harbor omitted ${omitted} UTF-16 characters from this tool output]\n${tail}`;
  };
  if (protocol === "chat" && Array.isArray(result.messages)) {
    for (const message of result.messages) if (message.role === "tool") message.content = shorten(message.content);
  } else if (protocol === "responses" && Array.isArray(result.input)) {
    for (const item of result.input) if (item.type === "function_call_output") item.output = shorten(item.output);
  } else if (protocol === "messages" && Array.isArray(result.messages)) {
    for (const message of result.messages) if (Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === "tool_result") {
        if (typeof block.content === "string") block.content = shorten(block.content);
        else if (Array.isArray(block.content)) for (const part of block.content) if (part.type === "text") part.text = shorten(part.text);
      }
    }
  }
  return { body: result, removedChars };
}
