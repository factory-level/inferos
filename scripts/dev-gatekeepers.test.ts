import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { getDevRouterConfig } from "./dev-server-config.ts";
import {
  DEV_GATEKEEPERS_ENV, discoverDevGatekeepers, requestedDevGatekeepers, selectDevGatekeepers,
} from "./dev-gatekeepers.ts";
import { configuredWorkers } from "./local/stack.ts";

const REPO = join(import.meta.dirname, "..");

describe("requestedDevGatekeepers", () => {
  it("means all when neither the flag nor the variable is given", () => {
    assert.equal(requestedDevGatekeepers([], undefined), null);
    assert.equal(requestedDevGatekeepers(["--port", "9000"], "  "), null);
  });

  it("reads both flag spellings and adds the gatekeeper- prefix", () => {
    assert.deepEqual(requestedDevGatekeepers(["--gatekeepers", "inferops,gatekeeper-github"], undefined),
      ["gatekeeper-inferops", "gatekeeper-github"]);
    assert.deepEqual(requestedDevGatekeepers(["--gatekeepers=inferops, inferops"], undefined), ["gatekeeper-inferops"]);
  });

  it("falls back to the environment variable, and the flag wins over it", () => {
    assert.deepEqual(requestedDevGatekeepers([], "context"), ["gatekeeper-context"]);
    assert.deepEqual(requestedDevGatekeepers(["--gatekeepers", "github"], "context"), ["gatekeeper-github"]);
  });

  it("selects no gatekeeper for none", () => {
    assert.deepEqual(requestedDevGatekeepers(["--gatekeepers", "none"], undefined), []);
  });

  it("rejects an empty or repeated flag", () => {
    assert.throws(() => requestedDevGatekeepers(["--gatekeepers"], undefined), /comma-separated/);
    assert.throws(() => requestedDevGatekeepers(["--gatekeepers", "--port"], undefined), /comma-separated/);
    assert.throws(() => requestedDevGatekeepers(["--gatekeepers=a", "--gatekeepers=b"], undefined), /only be specified once/);
  });
});

describe("selectDevGatekeepers", () => {
  const discovered = [{ name: "gatekeeper-a" }, { name: "gatekeeper-b" }, { name: "gatekeeper-c" }];

  it("keeps everything without a selection, in discovery order otherwise", () => {
    assert.deepEqual(selectDevGatekeepers(discovered, null), discovered);
    assert.deepEqual(selectDevGatekeepers(discovered, ["gatekeeper-c", "gatekeeper-a"]).map(({ name }) => name),
      ["gatekeeper-a", "gatekeeper-c"]);
    assert.deepEqual(selectDevGatekeepers(discovered, []), []);
  });

  it("refuses a name it did not discover, listing what exists", () => {
    assert.throws(() => selectDevGatekeepers(discovered, ["gatekeeper-x"]),
      new RegExp(`Unknown gatekeeper gatekeeper-x for --gatekeepers/${DEV_GATEKEEPERS_ENV}. Available: gatekeeper-a, gatekeeper-b, gatekeeper-c`));
  });
});

describe("discoverDevGatekeepers", () => {
  const root = mkdtempSync(join(tmpdir(), "dev-gatekeepers-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = (parent: string, name: string, worker: boolean) => {
    mkdirSync(join(root, parent, name), { recursive: true });
    if (worker) writeFileSync(join(root, parent, name, "wrangler.jsonc"), "{}");
  };
  pkg("packages", "gatekeeper-a", true);
  pkg("packages", "gatekeeper-kit", false);
  pkg("packages", "router", true);
  pkg("custom-gatekeepers", "gatekeeper-c", true);
  pkg("custom-gatekeepers", "gatekeeper-d", true);

  it("finds gatekeeper Workers and gates the fork's own by the enabled set", () => {
    assert.deepEqual(discoverDevGatekeepers(root, new Set(["gatekeeper-c"])).map(({ name }) => name).toSorted(),
      ["gatekeeper-a", "gatekeeper-c"]);
  });
});

describe("one selection for the dev server and pnpm local status", () => {
  it("narrows configuredWorkers but always keeps the router and backend", () => {
    assert.deepEqual(configuredWorkers(REPO, ["gatekeeper-github"]).map(({ name }) => name),
      ["router", "workshop-backend", "gatekeeper-github"]);
    assert.deepEqual(configuredWorkers(REPO, []).map(({ name }) => name), ["router", "workshop-backend"]);
    assert.ok(configuredWorkers(REPO).length > 3);
  });

  it("leaves a deselected gatekeeper without a router binding", () => {
    const config = getDevRouterConfig({ name: "dev-router" }, { gatekeepers: ["gatekeeper-github"], consumerWorkers: [] });
    assert.deepEqual(config.services, [{ binding: "GATEKEEPER_GITHUB", service: "gatekeeper-github" }]);
  });

  // run-dev-server.ts is a top-level script, so it is pinned at the source: both of its binding lists
  // (router and backend) and its Worker list come from the one selected `gatekeepers` array.
  it("run-dev-server discovers through the shared helper", () => {
    const source = readFileSync(join(REPO, "scripts", "run-dev-server.ts"), "utf8");
    assert.match(source, /const gatekeepers = selectDevGatekeepers\(\[\s*\.\.\.discoverDevGatekeepers\(ROOT/);
    assert.doesNotMatch(source, /function findGatekeepers/);
  });
});
