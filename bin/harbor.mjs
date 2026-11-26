#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, copyFile, constants } from "node:fs/promises";
import { gatewayToken, UsageStore } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";
import { boundedText, FreeCatalog } from "../src/catalog.mjs";
import { createGateway } from "../src/gateway.mjs";

import { addLink, checkEndpoint, configureLocal, gatewayModels, gatewayPreset, localModels, SetupError } from "../src/links.mjs";
import { skipReason } from "../src/routing.mjs";
import { CATEGORIES } from "../src/diagnostics.mjs";
import { buildHandoff, formatHandoff, handleHook, HandoffError, hookSettings, setTask } from "../src/handoff.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args.shift() ?? "help";
const flag = name => args.includes(name);
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith("--")) throw new Error(`Value required for ${name}`);
  return args[at + 1];
}

try {
  const stateDir = resolve(option("--state", process.env.HARBOR_STATE_DIR ?? join(homedir(), ".nikhil-code-harbor")));
  const configPath = resolve(option("--config", join(stateDir, "config.json")));
  if (command === "init") {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    try { await copyFile(join(root, "config.example.json"), configPath, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await gatewayToken(stateDir);
    console.log(`Configuration: ${configPath}\nGateway token file: ${join(stateDir, "gateway.token")}\nNext: add a route (node bin/harbor.mjs local --base-url http://127.0.0.1:PORT/v1 --model ID --protocols messages --route coding), check it with: node bin/harbor.mjs doctor, then run: node bin/harbor.mjs serve`);
  } else if (command === "local") {
    const baseUrl = option("--base-url");
    const model = option("--model");
    if (!baseUrl || !model) throw new SetupError("Usage: local --base-url http://127.0.0.1:PORT/v1 --model ID [--protocols messages,chat] [--route coding] [--capabilities tools,streaming,...]");
    const protocols = option("--protocols", "messages").split(",").map(x => x.trim()).filter(Boolean);
    const capabilities = option("--capabilities")?.split(",").map(x => x.trim()).filter(Boolean);
    const alias = option("--route", "coding");
    const models = await localModels(baseUrl.replace(/\/$/, ""));
    if (!models.includes(model)) throw new SetupError(`Model ${model} is not listed by ${baseUrl}/models. Available: ${models.slice(0, 20).join(", ") || "(none)"}`);
    await configureLocal(configPath, { baseUrl, model, alias, protocols, capabilities });
    console.log(`Route ${alias} -> local/${model} (${protocols.join(", ")}). Billing: your local server's compute only; Harbor adds no hosted provider. Restart Harbor to load the route.`);
  } else if (command === "models" || command === "link") {
    const provider = gatewayPreset(args[0], option("--port"));
    const config = await loadConfig(configPath);
    checkEndpoint(config, provider);
    const models = await gatewayModels(provider);
    if (command === "models") {
      console.log(JSON.stringify(models, null, 2));
    } else {
      const model = option("--model");
      const alias = option("--route", "coding");
      const protocols = option("--protocols")?.split(",");
      if (protocols?.some(p => !["chat", "messages", "responses"].includes(p))) throw new SetupError("Choose chat, messages or responses for --protocols.");
      if (!models.includes(model)) throw new SetupError("Choose a model ID returned by the models command.");
      await addLink(configPath, provider, model, alias, protocols);
      console.log(`Linked ${alias} to ${provider.id}/${model}. Billing follows that gateway. Restart Harbor to load the route.`);
    }
  } else if (command === "client") {
    const config = await loadConfig(configPath);
    const alias = option("--route", "harbor-auto");
    if (!Object.hasOwn(config.routes, alias)) throw new SetupError("Unknown alias. Choose a route from config.json.");
    const host = config.host.includes(":") ? `[${config.host}]` : config.host;
    const tokenFile = join(stateDir, "gateway.token");
    console.log(`VS Code / Coding Client Setup:
Plan name: Nikhil Code Harbor
Base URL: http://${host}:${config.port}/v1
API key: your Harbor token (HARBOR_GATEWAY_TOKEN or ${tokenFile})
Fetch models → enable ${alias} → Save.
Browser harbor: http://${host}:${config.port}/

Claude Code (route must declare the messages protocol; check with: node bin/harbor.mjs doctor):
  export ANTHROPIC_BASE_URL="http://${host}:${config.port}"
  export ANTHROPIC_AUTH_TOKEN="$(cat ${JSON.stringify(tokenFile)})"
  export ANTHROPIC_MODEL="${alias}" ANTHROPIC_DEFAULT_HAIKU_MODEL="${alias}" ANTHROPIC_DEFAULT_SONNET_MODEL="${alias}" ANTHROPIC_DEFAULT_OPUS_MODEL="${alias}"
  claude`);
  } else if (command === "serve") {
    const config = await loadConfig(configPath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const token = await gatewayToken(stateDir);
    const usage = new UsageStore({ file: join(stateDir, "usage.json"), warn: message => console.error(message) });
    await usage.load();
    const gateway = createGateway({ config, token, usage });
    const address = await gateway.listen();
    console.log(`Nikhil Code Harbor: http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${address.port}\nAuthentication required. No provider requests are made until a client sends a task.`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await gateway.close(); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  } else if (command === "doctor" || command === "discover") {
    const config = await loadConfig(configPath);
    const catalog = new FreeCatalog({ ttlMs: config.catalogTtlMs });
    const results = [];
    if (command === "discover") {
      for (const p of config.providers.filter(x => x.enabled && x.kind === "openrouter")) {
        const data = await catalog.models(p);
        const { hasZeroPricing } = await import("../src/catalog.mjs");
        results.push({ provider: p.id, checkedAt: new Date(data.checkedAt).toISOString(), models: data.models.filter(m => (m.id === "openrouter/free" || m.id?.endsWith(":free")) && hasZeroPricing(m)).map(m => ({ id: m.id, contextLength: m.context_length ?? null, supportedParameters: m.supported_parameters ?? [] })) });
      }
    } else {
      for (const [alias, candidates] of Object.entries(config.routes)) for (const c of candidates) {
        const p = config.providers.find(x => x.id === c.provider);
        let verification;
        try { verification = p.enabled ? await catalog.verify(p, c.model, config) : { status: "disabled" }; }
        catch (error) { verification = { status: "blocked", reason: error.code ?? "verification_failed" }; }
        // Explains, per wire protocol, whether this candidate would be tried or skipped.
        const eligibility = Object.fromEntries(["messages", "chat", "responses"].map(protocol => [protocol, skipReason(p, protocol, new Set(), process.env) ?? "eligible"]));
        const claudeCode = skipReason(p, "messages", new Set(["tools", "streaming"]), process.env) ?? "eligible";
        let reachable;
        if (p.enabled && p.kind === "local") {
          try { reachable = (await localModels(p.baseUrl)).includes(c.model) ? "model listed" : "server reachable, model not listed"; }
          catch { reachable = "not reachable"; }
        }
        results.push({ alias, provider: p.id, model: c.model, credentialConfigured: !p.apiKeyEnv || Boolean(process.env[p.apiKeyEnv]), capabilities: p.capabilities ?? "undeclared (all except response_storage assumed)", eligibility, claudeCode, ...(reachable ? { reachable } : {}), ...verification });
      }
    }
    console.log(JSON.stringify(results, null, 2));
    if (command === "doctor" && !results.some(x => x.credentialConfigured && ["verified-zero-price", "local", "declared-free-tier", "upstream-managed"].includes(x.status))) process.exitCode = 1;
  } else if (command === "status" || command === "ask") {
    const config = await loadConfig(configPath);
    const token = await gatewayToken(stateDir);
    const host = config.host.includes(":") ? `[${config.host}]` : config.host;
    const origin = `http://${host}:${config.port}`;
    const headers = { authorization: `Bearer ${token}` };
    if (command === "status") {
      let response;
      try { response = await fetch(origin + "/v1/status", { headers, redirect: "error", signal: AbortSignal.timeout(5000) }); }
      catch { throw new SetupError(`Harbor is not reachable at ${origin}. If Claude Code reported a rate limit, it did not come from this Harbor (start it with: node bin/harbor.mjs serve).`); }
      if (!response.ok) throw new SetupError(`Status request failed (HTTP ${response.status}).`);
      const data = await response.json();
      console.log(flag("--json") ? JSON.stringify(data, null, 2) : formatStatus(data));
    } else {
      const alias = option("--route", "harbor-auto");
      let prompt = option("--prompt", "");
      if (args.includes("--stdin")) {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of process.stdin) {
          bytes += chunk.length;
          if (bytes > config.maxBodyBytes) throw new SetupError("Input exceeds the configured request size.");
          chunks.push(chunk);
        }
        prompt = [prompt, Buffer.concat(chunks).toString("utf8")].filter(Boolean).join("\n\n");
      }
      if (!prompt.trim()) throw new SetupError("Provide --prompt TEXT, --stdin, or both.");
      const body = JSON.stringify({ model: alias, messages: [{ role: "user", content: prompt }] });
      if (Buffer.byteLength(body) > config.maxBodyBytes) throw new SetupError("Prompt exceeds the configured request size.");
      const response = await fetch(origin + "/v1/chat/completions", {
        method: "POST", redirect: "error", headers: { ...headers, "content-type": "application/json" }, body,
      });
      const result = JSON.parse(await boundedText(response, 16 * 1024 * 1024));
      if (!response.ok) throw new SetupError(`Harbor returned HTTP ${response.status} (${result.error?.type ?? "request_failed"}).`);
      const answer = result.choices?.[0]?.message?.content;
      if (typeof answer !== "string") throw new SetupError("The selected model returned no text answer.");
      console.log(answer);
      console.error(`Answered by ${response.headers.get("x-harbor-provider")} / ${response.headers.get("x-harbor-model")}`);
    }
  } else if (command === "handoff") {
    const sub = args[0];
    const cwd = resolve(option("--cwd", process.cwd()));
    if (sub === "hook") {
      // Hooks must never block Claude Code: read stdin, record, always exit 0.
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) break; chunks.push(chunk); }
        const notice = await handleHook(JSON.parse(Buffer.concat(chunks).toString("utf8")), { stateDir });
        if (notice) console.log(notice);
      } catch { process.stderr.write("harbor handoff: record not updated\n"); }
      process.exitCode = 0;
    } else if (sub === "task") {
      const summary = option("--summary");
      if (!summary?.trim()) throw new SetupError("Usage: handoff task --summary TEXT");
      await setTask(stateDir, cwd, summary);
      console.log("Task summary recorded.");
    } else if (sub === "show") {
      const session = option("--session");
      const handoff = await buildHandoff(stateDir, cwd, { previous: flag("--previous"), session });
      if (!handoff) throw new SetupError(session ? `No handoff record for session ${session} in this worktree.` : flag("--previous") ? "No other unfinished session is recorded for this worktree." : "No handoff record for this worktree. Install the hooks with: node bin/harbor.mjs handoff install");
      console.log(flag("--json") ? JSON.stringify(handoff, null, 2) : formatHandoff(handoff));
    } else if (sub === "install") {
      console.log("Add these hooks to .claude/settings.local.json (this project only) or ~/.claude/settings.json (all projects). Harbor does not edit Claude Code settings itself.\n");
      console.log(JSON.stringify(hookSettings(join(root, "bin", "harbor.mjs")), null, 2));
    } else throw new SetupError("Usage: handoff install | handoff task --summary TEXT | handoff show [--session ID | --previous] [--json] [--cwd DIR] | handoff hook");
  } else {
    console.log("Nikhil Code Harbor\n\nCommands: init, serve, doctor, discover, status [--json], client\nLocal route: local --base-url http://127.0.0.1:PORT/v1 --model ID [--protocols messages,chat] [--route coding] [--capabilities LIST]\nCrash handoff: handoff install | handoff task --summary TEXT | handoff show [--session ID | --previous] [--json]\nPrompt: ask --prompt TEXT [--stdin] [--route NAME]\nGateway setup: models <catalog-router|provider-router|coding-proxy> [--port N]\n               link <gateway> --model ID [--route coding] [--protocols chat,messages,responses] [--port N]\nOptions: --config PATH --state DIRECTORY\nNode.js 22+. No npm dependencies required.");
    if (command !== "help" && command !== "--help") process.exitCode = 1;
  }
} catch (error) {
  // Never print upstream response bodies or an error stack containing request configuration.
  console.error(error instanceof SetupError || error instanceof HandoffError ? error.message : error.code === "ENOENT" ? "Configuration not found. Run: node bin/harbor.mjs init" : error.message.startsWith("Invalid configuration:") ? error.message : "Command failed. Check configuration, connectivity, and local file permissions.");
  process.exitCode = 1;
}

function formatStatus(data) {
  const lines = [`Nikhil Code Harbor ${data.version}: ${data.inFlight}/${data.maxConcurrentRequests} requests in flight`];
  const r = data.requests;
  lines.push(`Last request received: ${r.lastRequestAt ?? "none since Harbor started (a client-side limit in Claude Code would not reach Harbor)"}`);
  if (r.lastFailure) {
    const f = r.lastFailure;
    lines.push(`Last failure: ${f.category ?? "unknown"} at ${f.at} (request ${f.id})${f.provider ? `, provider ${f.provider}` : ""}`);
    lines.push(`  ${f.detail ?? CATEGORIES[f.category] ?? "Cause unknown"}`);
    lines.push(`  Earliest known retry: ${f.retryAt ?? "unknown"}`);
  }
  lines.push("", "Providers:");
  for (const p of data.providers) {
    const u = data.usage.providers[p.id];
    const state = !p.enabled ? "disabled" : !p.credentialConfigured ? "credential missing" : p.cooldown ? `cooling down (${p.cooldown.category}) until ${p.cooldown.until}${p.cooldown.retryAfterKnown ? "" : " (provider gave no retry time; Harbor default)"}` : "ready";
    lines.push(`  ${p.id} [${p.protocols.join(",")}]: ${state}`);
    if (u) {
      lines.push(`    attempts ${u.attempts}, completed ${u.outcomes?.completed ?? u.successes}, interrupted ${u.outcomes?.interrupted ?? 0}, failed ${u.failures}, cancelled ${u.outcomes?.client_cancelled ?? 0}, served after fallback ${u.fallbackSuccesses ?? 0}`);
      lines.push(`    tokens: input ${u.inputTokens}, cache read ${u.cacheReadTokens ?? 0}, cache write ${u.cacheWriteTokens ?? 0}, output ${u.outputTokens} (requests with unknown input/output: ${u.unknownUsageRequests}, unknown cache: ${u.unknownCacheUsageRequests ?? 0})`);
    }
  }
  if (r.recent.length) {
    lines.push("", "Recent requests (newest first):");
    for (const e of r.recent.slice(0, 10)) {
      const usage = e.usage ? ` in=${e.usage.inputTokens ?? "?"} cacheR=${e.usage.cacheReadTokens ?? "?"} cacheW=${e.usage.cacheWriteTokens ?? "?"} out=${e.usage.outputTokens ?? "?"}` : "";
      lines.push(`  ${e.receivedAt} ${e.id} ${e.protocol} ${e.route ?? "-"} -> ${e.outcome}${e.category ? ` (${e.category})` : ""}${e.provider ? ` via ${e.provider}` : ""}${e.fallback ? " [fallback]" : ""}${usage}`);
    }
  }
  return lines.join("\n");
}
