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
  if (!response.ok) throw new Error(data.error?.message || "Request failed (HTTP " + response.status + ")");
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
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const info = document.createElement("small");
    title.textContent = p.id;
    const state = !p.credentialConfigured ? "key missing" : p.cooldownUntil > Date.now() ? "cooling down" : "configured";
    info.textContent = state + " · " + (stats?.successes ?? 0) + " succeeded · " + (stats?.failures ?? 0) + " failed";
    item.append(title, document.createElement("br"), info);
    el("activity").append(item);
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
