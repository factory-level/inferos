import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "jsonc-parser";
import { gatekeeperBaseUrl, getDevRouterAssets, getDevRouterConfig, getDevServerConfig } from "../dev-server-config.ts";
import { resolveLocalStack } from "../local/stack.ts";
import type { WranglerConfig } from "../release/manifest-lib.ts";
import { consumerGatekeeperDirs, workerPackageDirs } from "../worker-dirs.ts";
import { initialConsumerConfig } from "./config.ts";
import { checkConsumerGatekeepers, prepareConsumerGatekeepers } from "./gatekeepers.ts";
import { devLaunchArgs } from "./runtime.ts";

const UPSTREAM = resolve(import.meta.dirname, "../..");
const factory = new URL("../worker-config.ts", import.meta.url).href;
// The real public router, loaded by URL so the scripts type check does not take in its Workers types.
const routerSource = new URL("../../packages/router/src/index.ts", import.meta.url).href;
const { default: router } = await import(routerSource) as { default: { fetch(req: Request, env: unknown): Promise<Response> } };

const gatekeeperConfig = (name: string, extra = "") =>
  `import { defineGadgetsWorker } from ${JSON.stringify(factory)};\n` +
  `export default defineGadgetsWorker({ name: ${JSON.stringify(name)}, entrypoint: "src/index.ts"${extra} });\n`;

/** A wrapper with its own pinned-checkout directory, `local.port` and gatekeepers. */
function wrapper(t: TestContext, { port = 8787, customCode = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "inferos-gatekeepers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = initialConsumerConfig("https://github.com/factory-level/inferos", "a".repeat(40));
  config.features.customCloudflareCode = customCode;
  config.local.port = port;
  writeFileSync(join(root, "inferos.config.json"), JSON.stringify(config));
  mkdirSync(join(root, "inferos"));
  mkdirSync(join(root, "gatekeepers"));
  writeFileSync(join(root, "gatekeepers/.gitkeep"), "");
  const addGatekeeper = (name: string, source = gatekeeperConfig(name)) => {
    const dir = join(root, "gatekeepers", name);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/index.ts"), "export default { fetch() { return new Response('ok'); } };\n");
    writeFileSync(join(dir, "cloudflare.config.ts"), source);
    return dir;
  };
  return { root, config, addGatekeeper };
}

test("a wrapper without gatekeepers, or with only a library, adds nothing and needs no config", async t => {
  const w = wrapper(t);
  rmSync(join(w.root, "gatekeepers"), { recursive: true });
  assert.deepEqual(consumerGatekeeperDirs(w.root), []);
  assert.deepEqual(await checkConsumerGatekeepers(w.root), { enabled: true, gatekeepers: [], stale: [] });

  mkdirSync(join(w.root, "gatekeepers/acme-shared"), { recursive: true });
  writeFileSync(join(w.root, "gatekeepers/acme-shared/package.json"), "{}\n");
  // Listed as a package (so a name clash is still caught) but never a Worker: it has no wrangler.jsonc.
  assert.ok(workerPackageDirs(UPSTREAM, { consumerRoot: w.root }).includes(join(w.root, "gatekeepers/acme-shared")));
  assert.deepEqual(await checkConsumerGatekeepers(w.root), { enabled: true, gatekeepers: [], stale: [] });
});

test("pinned discovery is unchanged unless a consumer root is passed", t => {
  const w = wrapper(t);
  w.addGatekeeper("gatekeeper-acme");
  const pinned = workerPackageDirs(UPSTREAM);
  assert.ok(!pinned.some(dir => dir.startsWith(w.root)));
  const withWrapper = workerPackageDirs(UPSTREAM, { consumerRoot: w.root });
  assert.deepEqual(withWrapper.filter(dir => !pinned.includes(dir)), [join(w.root, "gatekeepers/gatekeeper-acme")]);
  assert.deepEqual(withWrapper.map(dir => basename(dir)), withWrapper.map(dir => basename(dir)).toSorted());
});

test("a wrapper gatekeeper generates its config in the wrapper and is described by its route", async t => {
  const w = wrapper(t);
  const dir = w.addGatekeeper("gatekeeper-acme");
  const [gatekeeper] = await prepareConsumerGatekeepers(w.root);
  assert.deepEqual({ ...gatekeeper, directory: relative(w.root, gatekeeper.directory) }, {
    name: "gatekeeper-acme", directory: "gatekeepers/gatekeeper-acme", binding: "GATEKEEPER_ACME", route: "/gatekeeper/acme",
  });
  const generated = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  assert.match(generated, /^\/\/ Generated from cloudflare.config.ts/);
  assert.equal(parse(generated).name, "gatekeeper-acme");
});

/** The check CLI `pnpm gatekeepers:check` and `gatekeepers:generate` run, in a fresh process as they always are. */
const cli = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(UPSTREAM, "scripts/consumer/gatekeepers.ts"), root, ...args], { encoding: "utf8" });

test("the check path reports configuration drift without rewriting it", async t => {
  const w = wrapper(t);
  const dir = w.addGatekeeper("gatekeeper-acme");
  // Authored but never generated.
  assert.deepEqual((await checkConsumerGatekeepers(w.root)).stale, ["gatekeepers/gatekeeper-acme/wrangler.jsonc"]);
  await prepareConsumerGatekeepers(w.root);
  assert.deepEqual((await checkConsumerGatekeepers(w.root)).stale, []);

  // The TypeScript source changed; the committed file did not. Checked through the CLI, since this
  // process has the old source cached.
  const before = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  writeFileSync(join(dir, "cloudflare.config.ts"), gatekeeperConfig("gatekeeper-acme", `, compatibilityFlags: ["nodejs_compat"]`));
  const check = cli(w.root);
  assert.equal(check.status, 1, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout).stale, ["gatekeepers/gatekeeper-acme/wrangler.jsonc"]);
  assert.match(check.stderr, /out of date/);
  assert.equal(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), before);
  const fix = cli(w.root, "--write");
  assert.equal(fix.status, 0, fix.stderr);
  assert.deepEqual(parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8")).compatibility_flags, ["nodejs_compat"]);

  // A hand edit of the generated file.
  assert.equal(cli(w.root).status, 0);
  writeFileSync(join(dir, "wrangler.jsonc"), readFileSync(join(dir, "wrangler.jsonc"), "utf8").replace("gatekeeper-acme", "gatekeeper-acme "));
  assert.deepEqual(JSON.parse(cli(w.root).stdout).stale, ["gatekeepers/gatekeeper-acme/wrangler.jsonc"]);

  // A hand-written config with no TypeScript source.
  rmSync(join(dir, "cloudflare.config.ts"));
  await assert.rejects(checkConsumerGatekeepers(w.root), /no cloudflare.config.ts/);
});

test("names that collide with the pinned checkout or cannot round-trip through a binding are rejected", async t => {
  const w = wrapper(t);
  w.addGatekeeper("gatekeeper-github");
  await assert.rejects(checkConsumerGatekeepers(w.root), /gatekeeper-github" collides with a package of the pinned InferOS/);
  rmSync(join(w.root, "gatekeepers/gatekeeper-github"), { recursive: true });
  mkdirSync(join(w.root, "gatekeepers/router"));
  assert.throws(() => workerPackageDirs(UPSTREAM, { consumerRoot: w.root }), /"router" collides/);
  rmSync(join(w.root, "gatekeepers/router"), { recursive: true });

  for (const name of ["acme", "gatekeeper-Acme", "gatekeeper-acme_beta", "gatekeeper-acme--beta"]) {
    const dir = w.addGatekeeper(name);
    await assert.rejects(checkConsumerGatekeepers(w.root), /must be named gatekeeper-<lowercase-slug>/, name);
    rmSync(dir, { recursive: true });
  }
  // The Worker name is the service the bindings target, so it must be the directory name.
  w.addGatekeeper("gatekeeper-acme", gatekeeperConfig("gatekeeper-other"));
  await assert.rejects(checkConsumerGatekeepers(w.root), /Worker name must be "gatekeeper-acme"/);
  // Two Workers on one router binding.
  assert.throws(() => getDevRouterConfig({}, { gatekeepers: ["gatekeeper-acme", "gatekeeper-acme"], consumerWorkers: [] }), /binding collision: GATEKEEPER_ACME/);
});

test("symbolic links and entrypoints outside the gatekeeper directory are rejected", async t => {
  const w = wrapper(t);
  const outside = mkdtempSync(join(tmpdir(), "inferos-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "cloudflare.config.ts"), gatekeeperConfig("gatekeeper-acme"));

  symlinkSync(outside, join(w.root, "gatekeepers/gatekeeper-acme"));
  await assert.rejects(checkConsumerGatekeepers(w.root), /gatekeeper-acme must not be a symbolic link/);
  rmSync(join(w.root, "gatekeepers/gatekeeper-acme"));

  const dir = w.addGatekeeper("gatekeeper-acme");
  rmSync(join(dir, "cloudflare.config.ts"));
  symlinkSync(join(outside, "cloudflare.config.ts"), join(dir, "cloudflare.config.ts"));
  await assert.rejects(checkConsumerGatekeepers(w.root), /cloudflare.config.ts must not be a symbolic link/);
  rmSync(dir, { recursive: true });

  w.addGatekeeper("gatekeeper-acme", gatekeeperConfig("gatekeeper-acme").replace("src/index.ts", "../../outside.ts"));
  await assert.rejects(checkConsumerGatekeepers(w.root), /entrypoint must stay inside its directory/);
  rmSync(join(w.root, "gatekeepers"), { recursive: true });

  symlinkSync(outside, join(w.root, "gatekeepers"));
  assert.throws(() => consumerGatekeeperDirs(w.root), /gatekeepers\/ directory must not be a symbolic link/);
});

test("with custom Cloudflare code off the gatekeepers directory is inert", async t => {
  const w = wrapper(t, { customCode: false });
  w.addGatekeeper("gatekeeper-acme", "throw new Error('must not execute');\n");
  w.addGatekeeper("gatekeeper-github");
  assert.deepEqual(await checkConsumerGatekeepers(w.root), { enabled: false, gatekeepers: [], stale: [] });
  assert.deepEqual(await prepareConsumerGatekeepers(w.root), []);
});

/** The dev router config `run-dev-server.ts` writes for a wrapper, as data. */
function routerFor(port: number, gatekeepers: string[], consumerWorkers: { binding: string; name: string }[]) {
  const base: WranglerConfig = parse(readFileSync(join(UPSTREAM, "wrangler.jsonc"), "utf8"));
  const routerDirectory = join(UPSTREAM, "packages/router");
  const production: WranglerConfig = parse(readFileSync(join(routerDirectory, "wrangler.jsonc"), "utf8"));
  return { config: getDevRouterConfig(base, { gatekeepers, consumerWorkers, assets: getDevRouterAssets(production, routerDirectory) }), port };
}

/** Which Worker the real router hands each path to, with every binding of `config` as a recording stub. */
async function route(config: WranglerConfig, path: string, port: number): Promise<string> {
  const target = (name: string) => ({ fetch: async (req: Request) => new Response(`${name} ${new URL(req.url).origin}`) });
  const env: Record<string, unknown> = { ...config.vars, ASSETS: config.assets ? target("ASSETS") : undefined };
  for (const service of config.services ?? []) env[service.binding] = target(service.binding);
  const response = await router.fetch(new Request(`http://localhost:${port}${path}`), env);
  return response.status === 404 ? "404" : await response.text();
}

test("the router serves assets, /api, gatekeepers and extensions from one origin", async () => {
  const { config, port } = routerFor(8801, ["gatekeeper-github", "gatekeeper-acme"], [{ binding: "CONSUMER_HELLO", name: "consumer-hello" }]);
  assert.ok(["/api/*", "/gatekeeper/*", "/extensions/*"].every(path => config.assets?.run_worker_first?.includes(path)));
  const origin = `http://localhost:${port}`;
  assert.equal(await route(config, "/api/session", port), `WORKSHOP_BACKEND ${origin}`);
  assert.equal(await route(config, "/gatekeeper/acme/oauth/callback", port), `GATEKEEPER_ACME ${origin}`);
  assert.equal(await route(config, "/gatekeeper/github/oauth", port), `GATEKEEPER_GITHUB ${origin}`);
  assert.equal(await route(config, "/extensions/hello", port), `CONSUMER_HELLO ${origin}`);
  assert.equal(await route(config, "/workspaces/1", port), `ASSETS ${origin}`);
  // A gatekeeper's callbacks are built from the same origin the router answers on.
  assert.equal(new URL(gatekeeperBaseUrl(`localhost:${port}`, "gatekeeper-acme")).origin, origin);
  assert.equal(new URL(gatekeeperBaseUrl(`localhost:${port}`, "gatekeeper-acme")).pathname, "/gatekeeper/acme");
});

test("absent optional bindings leave their routes unanswered rather than failing the router", async () => {
  const { config, port } = routerFor(8787, [], []);
  assert.deepEqual(config.services?.map(service => service.binding), ["WORKSHOP_BACKEND"]);
  assert.equal(config.vars?.CUSTOM_CLOUDFLARE_CODE, "false");
  assert.equal(await route(config, "/extensions/hello", port), "404");
  assert.equal(await route(config, "/gatekeeper/acme/oauth", port), "ASSETS http://localhost:8787");
  assert.equal(await route(config, "/api", port), "WORKSHOP_BACKEND http://localhost:8787");
});

test("two wrappers keep separate ports, state, generated configs and gatekeepers", async t => {
  const a = wrapper(t, { port: 8801 });
  const b = wrapper(t, { port: 8802 });
  // Both own a gatekeeper with the same name: each runs in its own Wrangler process.
  const aDir = a.addGatekeeper("gatekeeper-acme");
  const bDir = b.addGatekeeper("gatekeeper-acme", gatekeeperConfig("gatekeeper-acme", `, compatibilityFlags: ["nodejs_compat"]`));
  b.addGatekeeper("gatekeeper-beta");

  const stacks = [a, b].map(w => {
    // What `pnpm dev` passes the pinned run-local, which resolves the port and state as run-dev-server does.
    const args = devLaunchArgs(w.root, w.config);
    assert.deepEqual(args.slice(args.indexOf("--consumer-root")), ["--consumer-root", w.root]);
    const { backendHost } = getDevServerConfig(args);
    return { ...resolveLocalStack(join(w.root, "inferos"), args, {}), backendHost };
  });
  assert.deepEqual(stacks.map(stack => stack.port), [8801, 8802]);
  assert.deepEqual(stacks.map(stack => stack.url), ["http://localhost:8801", "http://localhost:8802"]);
  assert.equal(stacks[0].stateDir, join(a.root, "inferos/.wrangler/state"));
  assert.equal(stacks[1].stateDir, join(b.root, "inferos/.wrangler/state"));
  assert.notEqual(stacks[0].recordPath, stacks[1].recordPath);

  const [aGatekeepers, bGatekeepers] = [await prepareConsumerGatekeepers(a.root), await prepareConsumerGatekeepers(b.root)];
  assert.deepEqual(aGatekeepers.map(gk => gk.directory), [aDir]);
  assert.deepEqual(bGatekeepers.map(gk => gk.directory), [bDir, join(b.root, "gatekeepers/gatekeeper-beta")]);
  // Each wrapper's generated config came from its own source.
  assert.equal(parse(readFileSync(join(aDir, "wrangler.jsonc"), "utf8")).compatibility_flags, undefined);
  assert.deepEqual(parse(readFileSync(join(bDir, "wrangler.jsonc"), "utf8")).compatibility_flags, ["nodejs_compat"]);

  const [aRouter, bRouter] = [routerFor(8801, aGatekeepers.map(gk => gk.name), []), routerFor(8802, bGatekeepers.map(gk => gk.name), [])];
  assert.equal(await route(aRouter.config, "/gatekeeper/beta/oauth", 8801), "ASSETS http://localhost:8801");
  assert.equal(await route(bRouter.config, "/gatekeeper/beta/oauth", 8802), "GATEKEEPER_BETA http://localhost:8802");
});
