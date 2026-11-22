#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, copyFile, constants } from "node:fs/promises";
import { gatewayToken, UsageStore } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";
import { boundedText, FreeCatalog } from "../src/catalog.mjs";
import { createGateway } from "../src/gateway.mjs";

import { addLink, checkEndpoint, gatewayModels, gatewayPreset, SetupError } from "../src/links.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args.shift() ?? "help";
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
    console.log(`Configuration: ${configPath}\nGateway token file: ${join(stateDir, "gateway.token")}\nSet OPENROUTER_API_KEY for the default route, or link a running gateway. Then run: node bin/harbor.mjs serve`);
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
    console.log(`VS Code / Coding Client Setup:
Plan name: Nikhil Code Harbor
Base URL: http://${host}:${config.port}/v1
API key: your Harbor token (HARBOR_GATEWAY_TOKEN or ${join(stateDir, "gateway.token")})
Fetch models → enable ${alias} → Save.
Browser harbor: http://${host}:${config.port}/`);
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
        results.push({ alias, provider: p.id, model: c.model, credentialConfigured: !p.apiKeyEnv || Boolean(process.env[p.apiKeyEnv]), ...verification });
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
      const response = await fetch(origin + "/v1/status", { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new SetupError(`Status request failed (HTTP ${response.status}).`);
      console.log(JSON.stringify(await response.json(), null, 2));
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
  } else {
    console.log("Nikhil Code Harbor\n\nCommands: init, serve, doctor, discover, status, client\nPrompt: ask --prompt TEXT [--stdin] [--route NAME]\nGateway setup: models <catalog-router|provider-router|coding-proxy> [--port N]\n               link <gateway> --model ID [--route coding] [--protocols chat,messages,responses] [--port N]\nOptions: --config PATH --state DIRECTORY\nNode.js 22+. No npm dependencies required.");
    if (command !== "help" && command !== "--help") process.exitCode = 1;
  }
} catch (error) {
  // Never print upstream response bodies or an error stack containing request configuration.
  console.error(error instanceof SetupError ? error.message : error.code === "ENOENT" ? "Configuration not found. Run: node bin/harbor.mjs init" : error.message.startsWith("Invalid configuration:") ? error.message : "Command failed. Check configuration, connectivity, and local file permissions.");
  process.exitCode = 1;
}
