"use strict";
const el = id => document.getElementById(id);
let token = "";
let conversation = [];
let routes = {};
let providers = new Map();
let busy = false;
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options, redirect: "error", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  });
  const data = await response.json();
  if (!response.ok) throw new Error((data.error?.category ? "[" + data.error.category + "] " : "") + (data.error?.message || "Request failed (HTTP " + response.status + ")") + (data.error?.retry_at ? " Earliest retry: " + time(data.error.retry_at) + "." : "") + (data.error?.request_id ? " Request " + data.error.request_id : ""));
  return { response, data };
}
function row(label, text) {
  const item = document.createElement("div");
  const heading = document.createElement("b");
  const content = document.createElement("p");
  heading.textContent = label;
  content.textContent = text;
  item.append(heading, content);
  el("history").append(item);
}
function time(value) { return value ? new Date(value).toLocaleTimeString() : "unknown"; }
function item(list, label, details) {
  const entry = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = label;
  entry.append(title);
  for (const text of details) { const info = document.createElement("small"); info.textContent = text; entry.append(document.createElement("br"), info); }
  el(list).append(entry);
}
function routeInfo() {
  const candidates = (routes[el("route").value] || []).filter(c => providers.get(c.provider)?.enabled && providers.get(c.provider).protocols.includes("chat"));
  const names = candidates.map(c => c.provider + " / " + c.model);
  const linked = candidates.some(c => providers.get(c.provider).kind === "linked-gateway");
  el("path").textContent = names.join(" → ") + (linked ? " · Each linked gateway controls its own prices and fallback." : "");
}
function controls() {
  el("route").disabled = busy || !el("route").options.length;
  el("send").disabled = busy || !el("route").value;
  el("reset").disabled = busy || !conversation.length;
  el("refresh").disabled = busy;
}
async function refresh() {
  const { data } = await api("/v1/status");
  const selected = el("route").value;
  providers = new Map(data.providers.map(p => [p.id, p]));
  routes = data.routes;
  el("route").replaceChildren();
  for (const [alias, candidates] of Object.entries(routes)) {
    if (candidates.some(c => providers.get(c.provider)?.enabled && providers.get(c.provider).protocols.includes("chat"))) {
      el("route").add(new Option(alias, alias));
    }
  }
  if ([...el("route").options].some(o => o.value === selected)) el("route").value = selected;
  el("activity").replaceChildren();
  for (const p of data.providers.filter(p => p.enabled)) {
    const stats = data.usage.providers[p.id];
    const state = !p.credentialConfigured ? "key missing"
      : p.cooldown ? "cooling down (" + p.cooldown.category + ") until " + time(p.cooldown.until) + (p.cooldown.retryAfterKnown ? "" : " — no retry time from provider")
      : "configured";
    const counts = stats ? (stats.outcomes?.completed ?? stats.successes) + " completed · " + (stats.outcomes?.interrupted ?? 0) + " interrupted · " + stats.failures + " failed · " + (stats.fallbackSuccesses ?? 0) + " after fallback" : "no requests yet";
    const tokens = stats ? "input " + stats.inputTokens + " · cache read " + (stats.cacheReadTokens ?? 0) + " · cache write " + (stats.cacheWriteTokens ?? 0) + " · output " + stats.outputTokens + (stats.unknownUsageRequests || stats.unknownCacheUsageRequests ? " · some usage unknown" : "") : "";
    item("activity", p.id, [state, counts, tokens].filter(Boolean));
  }
  const r = data.requests;
  const f = r.lastFailure;
  el("lastRequest").textContent = (r.lastRequestAt ? "Received " + time(r.lastRequestAt) : "No request has reached Harbor since it started. A limit shown by your client happened before Harbor.")
    + (f ? ". Last failure: " + (f.category || "unknown") + (f.provider ? " at " + f.provider : "") + ", " + time(f.at) + "; earliest retry " + (f.retryAt ? time(f.retryAt) : "unknown") + " (request " + f.id + ")" + (f.detail ? ". " + f.detail : "") : "");
  el("recent").replaceChildren();
  for (const e of r.recent.slice(0, 8)) {
    const u = e.usage;
    item("recent", e.outcome + (e.category ? " · " + e.category : ""), [
      time(e.receivedAt) + " · " + (e.route || "-") + (e.provider ? " via " + e.provider : "") + (e.fallback ? " (fallback)" : ""),
      (e.attempts || []).map(x => x.provider + ": " + (x.category ? x.category + (x.status ? " (HTTP " + x.status + ")" : "") : x.outcome || "pending")).join(" → "),
      (e.skipped || []).map(x => "skipped " + x.provider + ": " + x.reason).join("; "),
      u ? "in " + (u.inputTokens ?? "?") + " · cache read " + (u.cacheReadTokens ?? "?") + " · cache write " + (u.cacheWriteTokens ?? "?") + " · out " + (u.outputTokens ?? "?") : "",
    ].filter(Boolean));
  }
  routeInfo();
  controls();
}
el("login").onsubmit = async event => {
  event.preventDefault();
  token = el("token").value.trim();
  try {
    await refresh();
    el("token").value = "";
    el("login").hidden = true;
    el("providers").hidden = false;
    el("connection").textContent = "Connected";
    el("notice").textContent = "";
  } catch (error) { token = ""; el("notice").textContent = error.message; }
};
function reset() {
  conversation = [];
  el("history").replaceChildren();
  el("notice").textContent = "";
  controls();
}
el("reset").onclick = reset;
el("route").onchange = () => { reset(); routeInfo(); };
el("refresh").onclick = () => refresh().catch(error => { el("notice").textContent = error.message; });
el("composer").onsubmit = async event => {
  event.preventDefault();
  const prompt = el("prompt").value.trim();
  if (!prompt || busy || !el("route").value) return;
  const messages = [...conversation, { role: "user", content: prompt }];
  busy = true;
  controls();
  el("notice").textContent = "Waiting for the gateway…";
  try {
    const { data, response } = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: el("route").value, messages }) });
    const answer = data.choices?.[0]?.message?.content;
    if (typeof answer !== "string") throw new Error("The gateway returned no text response.");
    row("You", prompt);
    const provider = response.headers.get("x-harbor-provider");
    row([provider, data.model || response.headers.get("x-harbor-model")].filter(Boolean).join(" / "), answer);
    conversation = [...messages, { role: "assistant", content: answer }];
    if (el("prompt").value.trim() === prompt) el("prompt").value = "";
    el("notice").textContent = "";
    await refresh();
  } catch (error) { el("notice").textContent = error.message; }
  finally { busy = false; controls(); }
};
