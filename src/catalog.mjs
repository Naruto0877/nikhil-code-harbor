import { GatewayError } from "./config.mjs";

export function hasZeroPricing(model) {
  const pricing = model?.pricing;
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return false;
  if (!Object.hasOwn(pricing, "prompt") || !Object.hasOwn(pricing, "completion")) return false;
  return Object.values(pricing).every(value =>
    (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value)) && Number(value) === 0
  );
}

export class FreeCatalog {
  #cache = new Map();
  #pending = new Map();
  constructor({ fetchImpl = fetch, now = Date.now, ttlMs = 300000 } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.ttlMs = ttlMs;
  }
  async models(provider) {
    const cached = this.#cache.get(provider.baseUrl);
    if (cached && this.now() - cached.checkedAt < this.ttlMs) return cached;
    if (this.#pending.has(provider.baseUrl)) return this.#pending.get(provider.baseUrl);
    const pending = this.#load(provider).finally(() => this.#pending.delete(provider.baseUrl));
    this.#pending.set(provider.baseUrl, pending);
    return pending;
  }
  async #load(provider) {
    try {
      const response = await this.fetch(`${provider.baseUrl}/models`, {
        headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("catalog unavailable");
      const text = await boundedText(response, 8 * 1024 * 1024);
      const data = JSON.parse(text);
      if (!Array.isArray(data.data)) throw new Error("invalid catalog");
      const result = { checkedAt: this.now(), models: data.data };
      this.#cache.set(provider.baseUrl, result);
      return result;
    } catch {
      // Expired evidence is never used when refresh fails.
      throw new GatewayError(503, "pricing_unavailable", `Current pricing could not be verified for ${provider.id}`);
    }
  }
  async verify(provider, model, config) {
    if (provider.kind === "linked-gateway") return { status: "upstream-managed", source: provider.id, checkedAt: this.now(), monthlyTokens: null };
    if (provider.kind === "local") return { status: "local", source: "local-compute", checkedAt: this.now(), monthlyTokens: null };
    if (provider.kind === "openrouter") {
      if (model !== "openrouter/free" && !model.endsWith(":free")) throw new GatewayError(403, "paid_model_blocked", "Only explicitly free OpenRouter models are allowed");
      const catalog = await this.models(provider);
      const entry = catalog.models.find(x => x.id === model);
      if (!hasZeroPricing(entry)) throw new GatewayError(403, "unverified_price", `Model ${model} has missing or nonzero pricing`);
      return { status: "verified-zero-price", source: `${provider.baseUrl}/models`, checkedAt: catalog.checkedAt, monthlyTokens: null };
    }
    const tier = provider.freeTier;
    const verified = Date.parse(tier?.verifiedAt);
    const expiry = Date.parse(tier?.expiresAt);
    const source = (() => { try { return new URL(tier?.source); } catch { return null; } })();
    if (!config.allowDeclaredFreeTiers || !tier || tier.hardStop !== true || !Number.isFinite(verified) || verified > this.now() || !Number.isFinite(expiry) || expiry <= this.now() || expiry - verified > 31 * 86400000 || !source || source.protocol !== "https:" || source.username || source.password) {
      throw new GatewayError(403, "unverified_free_tier", `Provider ${provider.id} requires an explicit, current free-tier declaration and opt-in`);
    }
    return { status: "declared-free-tier", source: source.href, checkedAt: verified, expiresAt: expiry, monthlyTokens: null };
  }
}

export async function boundedText(response, limit) {
  if (!response.body) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new GatewayError(502, "upstream_response_too_large", "Upstream response exceeded the configured limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
