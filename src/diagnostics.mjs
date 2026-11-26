// Failure classification and a bounded in-memory request log. Entries contain
// identifiers, timings, categories, and counters only: never prompts,
// credentials, upstream error bodies, or tool output.

export const CATEGORIES = Object.freeze({
  harbor_concurrency_limit: "Harbor's own maxConcurrentRequests limit was reached; no upstream request was made",
  upstream_rate_limited: "The provider returned HTTP 429 (temporary rate limit)",
  upstream_overloaded: "The provider returned HTTP 529 (overloaded; an availability problem, not a quota charge)",
  upstream_unavailable: "The provider failed or returned a 5xx before any output",
  upstream_billing: "The provider reported a spend cap, credit, quota, or billing restriction",
  upstream_no_retry: "The provider asked clients not to retry (x-should-retry: false)",
  upstream_rejected: "The provider rejected the request as invalid or unauthorized",
  all_candidates_cooling: "Every eligible provider on this route is cooling down",
  no_eligible_candidate: "No provider on this route supports this request's protocol, credentials, or capabilities",
  first_byte_timeout: "The provider sent no response before firstByteTimeoutMs",
  stream_idle_timeout: "The provider stopped sending data for streamIdleTimeoutMs after output began",
  stream_incomplete: "The stream ended without its protocol completion event",
  stream_interrupted: "The provider connection failed after output began; Harbor did not replay it",
  stream_error_event: "The provider sent an error event inside a successful stream",
  deadline_exceeded: "requestDeadlineMs elapsed: before output, no further provider is tried; during a stream, the stream is cut off and not replayed",
  attempt_limit: "maxAttempts upstream attempts were used without success",
  client_cancelled: "The client disconnected before the response completed",
  unknown: "The cause could not be determined",
});

const BILLING_TEXT = /credit balance|spend(ing)? (cap|limit)|billing|insufficient[ _](credits|funds|quota|balance)|payment required|usage limits?|quota (exceeded|exhausted)/i;
const BILLING_CODES = new Set(["insufficient_quota", "billing_error", "billing_hard_limit_reached", "payment_required", "insufficient_credits", "enforced_spend_limit_reached", "spend_limit_reached", "credit_balance_too_low"]);
const BILLING_CODE_PATTERN = /spend_limit|spend_cap|billing|quota_exceeded|insufficient_(quota|credit|funds|balance)|credit_balance/;
// Longest cooldown Harbor accepts from a provider; longer values are treated as this.
export const MAX_RETRY_AFTER_MS = 7 * 86400000;

// Parses Retry-After (delay-seconds or HTTP date) and retry-after-ms. Returns null
// when absent or invalid; valid values are honored in full up to MAX_RETRY_AFTER_MS.
export function retryAfterMs(headers, now) {
  const bound = ms => Math.min(MAX_RETRY_AFTER_MS, ms);
  const rawMs = headers.get("retry-after-ms")?.trim();
  if (rawMs && /^\d+(\.\d+)?$/.test(rawMs)) return bound(Number(rawMs));
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return bound(Number(raw) * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) && /[a-z]/i.test(raw) ? bound(Math.max(0, date - now)) : null;
}

// `errorInfo` holds only the parsed `error.type`, `error.code` and message text,
// which are examined here and never stored or returned.
export function classifyUpstream(status, headers, errorInfo, now) {
  const retryMs = retryAfterMs(headers, now);
  const noRetry = headers.get("x-should-retry")?.trim().toLowerCase() === "false";
  // Structured codes are read first; message wording is only a fallback when no specific code is present.
  const specific = [errorInfo?.detailCode, errorInfo?.code].filter(x => typeof x === "string").map(x => x.toLowerCase());
  const codes = [...specific, ...(typeof errorInfo?.type === "string" ? [errorInfo.type.toLowerCase()] : [])];
  const structuredBilling = codes.some(c => BILLING_CODES.has(c) || BILLING_CODE_PATTERN.test(c));
  const messageBilling = !specific.length && typeof errorInfo?.message === "string" && BILLING_TEXT.test(errorInfo.message) && !/rate limit/i.test(errorInfo.message);
  const billing = status === 402 || structuredBilling || messageBilling;
  let category;
  if (billing) category = "upstream_billing";
  else if (status === 429) category = noRetry ? "upstream_no_retry" : "upstream_rate_limited";
  else if (status === 529) category = noRetry ? "upstream_no_retry" : "upstream_overloaded";
  else if (status >= 500) category = noRetry ? "upstream_no_retry" : "upstream_unavailable";
  else if (status >= 400) category = "upstream_rejected";
  else category = "unknown";
  const temporary = ["upstream_rate_limited", "upstream_overloaded", "upstream_unavailable"].includes(category);
  return { category, temporary, retryMs, noRetry };
}

export async function readErrorInfo(response, limit = 65536) {
  if (!response.body) return null;
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > limit) break;
      chunks.push(Buffer.from(chunk));
    }
  } catch { return null; }
  finally { await response.body.cancel().catch(() => {}); }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const error = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
    const details = error?.details && typeof error.details === "object" ? error.details : null;
    return { type: error?.type, code: error?.code, detailCode: details?.error_code ?? details?.code, message: error?.message };
  } catch { return null; }
}

export class RequestLog {
  constructor(limit = 50) { this.limit = limit; this.entries = []; this.lastRequestAt = null; this.lastFailure = null; }
  start(entry) {
    this.lastRequestAt = entry.receivedAt;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    return entry;
  }
  finish(entry) {
    if (entry.outcome !== "completed") this.lastFailure = { id: entry.id, at: entry.finishedAt, outcome: entry.outcome, category: entry.category, provider: entry.provider, retryAt: entry.retryAt ?? null, detail: entry.detail ?? null };
  }
  snapshot() {
    return { lastRequestAt: this.lastRequestAt, lastFailure: this.lastFailure, recent: structuredClone(this.entries.slice(-20).reverse()) };
  }
}
