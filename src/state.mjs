import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat, chmod } from "node:fs/promises";
import { join } from "node:path";

export function sameToken(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(received), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function gatewayToken(stateDir, env = process.env) {
  if (env.HARBOR_GATEWAY_TOKEN) {
    if (env.HARBOR_GATEWAY_TOKEN.length < 32 || /[\r\n]/.test(env.HARBOR_GATEWAY_TOKEN)) throw new Error("HARBOR_GATEWAY_TOKEN must contain at least 32 characters and no newlines");
    return env.HARBOR_GATEWAY_TOKEN;
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "gateway.token");
  try { await writeFile(path, randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Gateway token must be a regular file");
  await chmod(path, 0o600);
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 32 || /[\r\n]/.test(token)) throw new Error("Invalid gateway token file");
  return token;
}

const COUNTERS = ["attempts", "successes", "failures", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "unknownUsageRequests", "unknownCacheUsageRequests", "fallbackSuccesses"];
const OUTCOMES = ["completed", "interrupted", "failed", "client_cancelled"];
function emptyProvider() {
  return { ...Object.fromEntries(COUNTERS.map(k => [k, 0])), outcomes: Object.fromEntries(OUTCOMES.map(k => [k, 0])) };
}

export class UsageStore {
  #queue = Promise.resolve();
  constructor({ file, warn = () => {} } = {}) {
    this.file = file;
    this.warn = warn;
    this.data = { version: 2, providers: {} };
  }
  async load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (![1, 2].includes(parsed.version) || !parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) throw new Error("Invalid usage file");
      // Version 1 files lack cache and outcome counters; those start at zero.
      const providers = {};
      for (const [id, value] of Object.entries(parsed.providers)) {
        const p = emptyProvider();
        for (const k of COUNTERS) if (Number.isSafeInteger(value?.[k]) && value[k] >= 0) p[k] = value[k];
        for (const k of OUTCOMES) if (Number.isSafeInteger(value?.outcomes?.[k]) && value.outcomes[k] >= 0) p.outcomes[k] = value.outcomes[k];
        if (Number.isInteger(value?.lastStatus)) p.lastStatus = value.lastStatus;
        if (typeof value?.lastCategory === "string") p.lastCategory = value.lastCategory;
        Object.defineProperty(providers, id, { value: p, enumerable: true, writable: true, configurable: true });
      }
      this.data = { version: 2, providers };
    } catch (error) { if (error.code !== "ENOENT") throw new Error("Usage state could not be loaded; preserve and inspect the existing file"); }
  }
  // Records one upstream attempt. Missing token counts stay unknown rather than zero.
  async record(provider, { success, status, outcome, category, fallback, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }) {
    if (!Object.hasOwn(this.data.providers, provider)) Object.defineProperty(this.data.providers, provider, { value: emptyProvider(), enumerable: true, writable: true, configurable: true });
    const p = this.data.providers[provider];
    p.attempts++;
    p[success ? "successes" : "failures"]++;
    const valid = x => Number.isSafeInteger(x) && x >= 0;
    for (const [k, v] of [["inputTokens", inputTokens], ["cacheReadTokens", cacheReadTokens], ["cacheWriteTokens", cacheWriteTokens], ["outputTokens", outputTokens]]) if (valid(v)) p[k] += v;
    if (success && (!valid(inputTokens) || !valid(outputTokens))) p.unknownUsageRequests++;
    if (success && (!valid(cacheReadTokens) || !valid(cacheWriteTokens))) p.unknownCacheUsageRequests++;
    if (success && fallback) p.fallbackSuccesses++;
    if (OUTCOMES.includes(outcome)) p.outcomes[outcome]++;
    p.lastStatus = status;
    if (category) p.lastCategory = category; else delete p.lastCategory;
    const snapshot = JSON.stringify(this.data, null, 2) + "\n";
    this.#queue = this.#queue.then(async () => {
      if (!this.file) return;
      const temp = this.file + ".tmp";
      await writeFile(temp, snapshot, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, this.file);
    }).catch(() => this.warn("Usage persistence failed; totals remain available in memory"));
    await this.#queue;
  }
  snapshot() { return structuredClone(this.data); }
}

export { StreamObserver as UsageObserver } from "./observe.mjs";
