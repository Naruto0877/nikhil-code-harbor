import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { boundedText } from "./catalog.mjs";
import { CAPABILITIES, isLoopback, safeModelId, validateConfig } from "./config.mjs";

const presets = new Map([
  ["catalog-router", { port: 20128, key: "HARBOR_CATALOG_KEY" }],
  ["provider-router", { port: 20128, key: "HARBOR_PROVIDER_KEY" }],
  ["coding-proxy", { port: 8082, key: "HARBOR_CODING_KEY" }],
]);

export class SetupError extends Error {}

export function gatewayPreset(name, portOverride) {
  const preset = presets.get(name);
  if (!preset) throw new SetupError("Choose catalog-router, provider-router or coding-proxy.");
  const port = Number(portOverride ?? preset.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SetupError("Choose a port between 1 and 65535.");
  return {
    id: name, kind: "linked-gateway",
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: preset.key,
    protocols: ["chat"], enabled: true,
  };
}

export async function gatewayModels(provider, env = process.env, request = fetch) {
  const key = env[provider.apiKeyEnv];
  if (!key || /[\r\n]/.test(key)) throw new SetupError(`Set ${provider.apiKeyEnv} to the gateway's API key first.`);
  let response;
  try {
    response = await request(provider.baseUrl + "/models", {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new SetupError(`${provider.id} returned HTTP ${response.status} on /models. Check the port and key.`);
    const body = JSON.parse(await boundedText(response, 4 * 1024 * 1024));
    if (!Array.isArray(body.data)) throw new SetupError("The gateway returned an invalid model catalog.");
    return [...new Set(body.data.map(m => m?.id).filter(safeModelId))].sort();
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(`Could not read ${provider.id}'s models at ${provider.baseUrl}. Check that the gateway is running.`);
  } finally {
    if (response?.body && !response.bodyUsed) await response.body.cancel();
  }
}

export function checkEndpoint(config, provider) {
  if (Number(new URL(provider.baseUrl).port) === config.port) throw new SetupError("Choose the upstream port, different from the Harbor port.");
  const collision = config.providers.find(p => p.baseUrl === provider.baseUrl && p.id !== provider.id);
  if (collision) throw new SetupError(`This endpoint is already assigned to ${collision.id}. Run the two services on different ports.`);
  const existing = config.providers.find(p => p.id === provider.id);
  if (existing && (existing.baseUrl !== provider.baseUrl || existing.kind !== provider.kind || existing.apiKeyEnv !== provider.apiKeyEnv)) {
    throw new SetupError("This gateway ID already has another configuration. Review config.json before reconnecting.");
  }
}

function checkAlias(model, alias) {
  if (!safeModelId(model) || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(alias) || ["constructor", "prototype", "__proto__"].includes(alias)) {
    throw new SetupError("Choose a valid model and route alias.");
  }
}

// Validated, locked, atomic edit of config.json.
async function editConfig(path, mutate) {
  const lock = path + ".lock";
  const temporary = path + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
    const config = JSON.parse(await readFile(path, "utf8"));
    validateConfig(config);
    mutate(config);
    validateConfig(config);
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    if (!handle && error.code === "EEXIST") throw new SetupError("A configuration edit is in progress. Retry after it finishes.");
    if (error.message?.startsWith("Invalid configuration:")) throw new SetupError(error.message);
    throw error;
  } finally {
    if (handle) {
      await handle.close();
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
      await unlink(lock);
    }
  }
}

export async function addLink(path, provider, model, alias, protocols) {
  checkAlias(model, alias);
  await editConfig(path, config => {
    checkEndpoint(config, provider);
    const previous = config.providers.find(p => p.id === provider.id);
    if (previous?.enabled === false) throw new SetupError("Enable this gateway in config.json before linking it.");
    if (previous && protocols && protocols.some(p => !previous.protocols.includes(p))) throw new SetupError("Edit the existing gateway's protocols in config.json before using a new wire format.");
    if (!previous) config.providers.push({ ...provider, protocols: protocols ?? provider.protocols });
    const route = Object.hasOwn(config.routes, alias) ? config.routes[alias] : [];
    if (route.some(c => config.providers.find(p => p.id === c.provider).kind !== "linked-gateway")) {
      throw new SetupError("Choose a separate alias for upstream-managed billing, such as coding.");
    }
    if (!route.some(c => c.provider === provider.id && c.model === model)) route.push({ provider: provider.id, model });
    config.routes[alias] = route;
  });
}

// Lists model IDs from a developer-run local server (no credential is sent).
export async function localModels(baseUrl, request = fetch) {
  let response;
  try {
    response = await request(baseUrl + "/models", { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new SetupError(`The local server returned HTTP ${response.status} on /models.`);
    const body = JSON.parse(await boundedText(response, 4 * 1024 * 1024));
    const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null;
    if (!list) throw new SetupError("The local server returned an invalid model list.");
    return [...new Set(list.map(m => m?.id ?? m?.name ?? m?.model).filter(safeModelId))].sort();
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(`Could not read models at ${baseUrl}/models. Start the local server first.`);
  } finally {
    if (response?.body && !response.bodyUsed) await response.body.cancel();
  }
}

// Enables the built-in `local` provider at a developer-chosen loopback endpoint
// and appends it to a route. Billing: local compute only; no hosted provider is added.
export async function configureLocal(path, { baseUrl, model, alias, protocols, capabilities }) {
  checkAlias(model, alias);
  let url;
  try { url = new URL(baseUrl); } catch { throw new SetupError("Choose a base URL such as http://127.0.0.1:11434/v1."); }
  if (url.protocol !== "http:" || !isLoopback(url.hostname)) throw new SetupError("The local endpoint must be http:// on 127.0.0.1 or [::1].");
  if (!protocols?.length || protocols.some(p => !["chat", "messages", "responses"].includes(p))) throw new SetupError("Choose --protocols from chat, messages, responses.");
  if (capabilities?.some(c => !CAPABILITIES.includes(c))) throw new SetupError(`Choose --capabilities from ${CAPABILITIES.join(", ")}.`);
  await editConfig(path, config => {
    let local = config.providers.find(p => p.id === "local");
    if (local && local.kind !== "local") throw new SetupError("Provider ID local is used by another kind. Review config.json.");
    if (!local) { local = { id: "local", kind: "local" }; config.providers.push(local); }
    const normalized = url.href.replace(/\/$/, "");
    if (Number(url.port || 80) === config.port) throw new SetupError("Choose the local server's port, different from the Harbor port.");
    Object.assign(local, { baseUrl: normalized, protocols, enabled: true });
    if (capabilities) local.capabilities = capabilities;
    const route = Object.hasOwn(config.routes, alias) ? config.routes[alias] : [];
    if (route.some(c => config.providers.find(p => p.id === c.provider)?.kind === "linked-gateway")) throw new SetupError("That alias holds linked gateways with upstream-managed billing. Choose another --route.");
    if (!route.some(c => c.provider === "local" && c.model === model)) route.push({ provider: "local", model });
    config.routes[alias] = route;
  });
}
