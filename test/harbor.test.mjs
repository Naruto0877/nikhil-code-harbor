import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGateway } from "../src/gateway.mjs";
import { loadConfig } from "../src/config.mjs";
import { gatewayPreset, gatewayModels } from "../src/links.mjs";

const env = { HARBOR_CATALOG_KEY: "fixture-catalog", HARBOR_PROVIDER_KEY: "fixture-provider", HARBOR_CODING_KEY: "fixture-coding-proxy", HARBOR_GATEWAY_TOKEN: "a-local-only-fixture-token-for-harbor" };
async function command(dir, args, input = "") {
  const child = spawn(process.execPath, ["bin/harbor.mjs", ...args, "--state", dir], {
    env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = once(child, "close");
  child.stdin.end(input);
  const [code] = await exit;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}
async function upstream(t, name, outcome) {
  const descriptor = gatewayPreset(name);
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + env[descriptor.apiKeyEnv]) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: name + "-coding" }] }));
    if (req.url !== "/v1/chat/completions") return res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body));
    res.writeHead(outcome).end(JSON.stringify({ model: name + "-coding", choices: [{ message: { content: "Fixture review" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: String(server.address().port), calls, name };
}

test("one catalog-to-editor workflow uses the three linked services in configured order", async t => {
  const dir = await mkdtemp(join(tmpdir(), "harbor-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const engines = [await upstream(t, "catalog-router", 429), await upstream(t, "provider-router", 503), await upstream(t, "coding-proxy", 200)];
  assert.equal((await command(dir, ["init"])).code, 0);
  const configPath = join(dir, "config.json");
  const original = await readFile(configPath, "utf8");
  const bad = await command(dir, ["link", "catalog-router", "--port", engines[0].port, "--model", "absent"]);
  assert.equal(bad.code, 1);
  assert.equal(await readFile(configPath, "utf8"), original);
  for (const { name, port } of engines) {
    const listed = await command(dir, ["models", name, "--port", port]);
    assert.deepEqual(JSON.parse(listed.stdout), [name + "-coding"]);
    const args = ["link", name, "--port", port, "--model", name + "-coding", "--route", "coding"];
    for (let i = 0; i < 2; i++) assert.equal((await command(dir, args)).code, 0);
  }
  const config = await loadConfig(configPath);
  assert.deepEqual(config.routes.coding.map(c => c.provider), ["catalog-router", "provider-router", "coding-proxy"]);
  assert.deepEqual(config.routes["harbor-auto"], [{ provider: "openrouter", model: "openrouter/free" }]);
  for (const value of Object.values(env)) assert.ok(!JSON.stringify(config).includes(value));
  const collision = await command(dir, ["models", "provider-router", "--port", engines[0].port]);
  assert.match(collision.stderr, /already assigned/);
  const mixed = await command(dir, ["link", "coding-proxy", "--port", engines[2].port, "--route", "harbor-auto", "--model", "coding-proxy-coding"]);
  assert.match(mixed.stderr, /separate alias/);

  const gateway = createGateway({ config: { ...config, port: 0 }, env, token: env.HARBOR_GATEWAY_TOKEN });
  const { port } = await gateway.listen();
  t.after(() => gateway.close());
  const base = "http://127.0.0.1:" + port;
  await writeFile(configPath, JSON.stringify({ ...config, port }));
  const profile = await command(dir, ["client", "--route", "coding"]);
  assert.ok(profile.stdout.includes(base + "/v1"));
  assert.ok(!profile.stdout.includes(env.HARBOR_GATEWAY_TOKEN));

  const page = await fetch(base);
  assert.match(await page.text(), /Prompt workspace/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + "/v1/models")).status, 401);
  const models = await fetch(base + "/v1/models", { headers: { authorization: "Bearer " + env.HARBOR_GATEWAY_TOKEN } });
  assert.ok((await models.json()).data.some(m => m.id === "coding"));

  const review = await command(dir, ["ask", "--route", "coding", "--prompt", "Review this", "--stdin"], "demo diff");
  assert.equal(review.code, 0, review.stderr);
  assert.equal(review.stdout, "Fixture review");
  assert.match(review.stderr, /coding-proxy \/ coding-proxy-coding/);
  for (const engine of engines) {
    assert.equal(engine.calls.length, 1);
    assert.equal(engine.calls[0].model, engine.name + "-coding");
    assert.equal(engine.calls[0].messages[0].content, "Review this\n\ndemo diff");
  }
  const status = gateway.status();
  assert.equal(status.routes.coding[2].evidence.status, "upstream-managed");
  assert.equal(status.usage.providers["coding-proxy"].successes, 1);
});

test("gateway discovery rejects bad ports, missing keys and redirects", async () => {
  assert.throws(() => gatewayPreset("coding-proxy", "-1"), /port/);
  assert.throws(() => gatewayPreset("unknown"), /Choose/);
  const p = gatewayPreset("coding-proxy");
  await assert.rejects(gatewayModels(p, {}), /HARBOR_CODING_KEY/);
  await assert.rejects(gatewayModels(p, env, async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8082/v1/models");
    assert.equal(options.redirect, "error");
    return new Response("do not print this", { status: 401 });
  }), /HTTP 401/);
});
