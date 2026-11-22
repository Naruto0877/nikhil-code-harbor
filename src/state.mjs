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

export class UsageStore {
  #queue = Promise.resolve();
  constructor({ file, warn = () => {} } = {}) {
    this.file = file;
    this.warn = warn;
    this.data = { version: 1, providers: {} };
  }
  async load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed.version !== 1 || !parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) throw new Error("Invalid usage file");
      this.data = parsed;
    } catch (error) { if (error.code !== "ENOENT") throw new Error("Usage state could not be loaded; preserve and inspect the existing file"); }
  }
  async record(provider, { success, inputTokens, outputTokens, status }) {
    if (!Object.hasOwn(this.data.providers, provider)) Object.defineProperty(this.data.providers, provider, { value: { attempts: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0 }, enumerable: true, writable: true, configurable: true });
    const p = this.data.providers[provider];
    p.attempts++;
    p[success ? "successes" : "failures"]++;
    const valid = x => Number.isSafeInteger(x) && x >= 0;
    if (valid(inputTokens)) p.inputTokens += inputTokens;
    if (valid(outputTokens)) p.outputTokens += outputTokens;
    if (success && (!valid(inputTokens) || !valid(outputTokens))) p.unknownUsageRequests++;
    p.lastStatus = status;
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

export class UsageObserver {
  constructor() { this.pending = ""; this.decoder = new TextDecoder(); this.values = {}; this.failed = false; }
  observe(payload) {
    if (payload?.error || payload?.type === "error" || payload?.type === "response.failed" || payload?.response?.error) this.failed = true;
    const usage = payload?.usage ?? payload?.message?.usage ?? payload?.response?.usage;
    if (!usage) return;
    for (const [target, value] of [["inputTokens", usage.input_tokens ?? usage.prompt_tokens], ["outputTokens", usage.output_tokens ?? usage.completion_tokens]]) {
      if (Number.isSafeInteger(value) && value >= 0) this.values[target] = Math.max(this.values[target] ?? 0, value);
    }
  }
  push(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      if (line.startsWith("data:")) {
        try { this.observe(JSON.parse(line.slice(5).trim())); } catch { /* SSE comments / [DONE] */ }
      }
    }
    // This observer never modifies forwarded bytes; oversized events simply have unknown usage.
    if (this.pending.length > 262144) this.pending = "";
  }
  result() { return { ...this.values }; }
}
