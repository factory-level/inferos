import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_CONFIG_FILE, resolveCanvasConfig, runCanvasCommand, selectedCustomGatekeepers, type CanvasInventory } from "./canvas.ts";

const inventory: CanvasInventory = {
  kinds: ["inferops.project-board", "inferos.gadget"],
  blueprints: [{ blueprintId: "inferops.kanban", title: "InferOps Kanban", description: "Project board." }],
  customGatekeepers: ["gatekeeper-inferops"],
};
const base = { schemaVersion: 1, widgets: { kinds: ["inferos.gadget"], blueprints: [] }, screens: [], customGatekeepers: "all" };

/** A throwaway upstream checkout with one blueprint and one custom gatekeeper, and a config root. */
function fixture(t: { after(fn: () => void): void }) {
  const upstream = mkdtempSync(join(tmpdir(), "inferos-canvas-upstream-"));
  const root = mkdtempSync(join(tmpdir(), "inferos-canvas-root-"));
  t.after(() => { rmSync(upstream, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  const blueprint = join(upstream, "packages/bundled-blueprints/blueprints/inferops-kanban");
  mkdirSync(blueprint, { recursive: true });
  writeFileSync(join(blueprint, "blueprint.json"), JSON.stringify({ blueprintId: "inferops.kanban", title: "InferOps Kanban", description: "Project board." }));
  const gatekeeper = join(upstream, "custom-gatekeepers/gatekeeper-inferops");
  mkdirSync(gatekeeper, { recursive: true });
  writeFileSync(join(gatekeeper, "wrangler.jsonc"), "{}");
  return { upstream, root, run: (...args: string[]) => runCanvasCommand(root, args, upstream) as { enabled: Record<string, unknown> } };
}

test("a config resolves to the catalog the Workshop enforces, labelled from the shipped blueprint", () => {
  const { catalog } = resolveCanvasConfig({ ...base, widgets: { kinds: ["inferos.gadget"], blueprints: ["inferops.kanban"] } }, inventory);
  assert.deepEqual(catalog, {
    widgetKinds: ["inferos.gadget"],
    blueprints: [{ blueprintId: "inferops.kanban", label: "InferOps Kanban", description: "Project board." }],
    screens: [],
  });
});

test("names the checkout does not build are errors, not silently dropped", () => {
  assert.throws(() => resolveCanvasConfig({ ...base, widgets: { kinds: ["custom.chart"], blueprints: [] } }, inventory), /unknown widget kind/);
  assert.throws(() => resolveCanvasConfig({ ...base, widgets: { kinds: ["inferos.gadget"], blueprints: ["nope"] } }, inventory), /no blueprint "nope"/);
  assert.throws(() => resolveCanvasConfig({ ...base, customGatekeepers: ["gatekeeper-nope"] }, inventory), /no custom gatekeeper/);
  assert.throws(() => resolveCanvasConfig({ ...base, extra: true }, inventory), /expected exactly/);
});

test("blueprint widgets require the gadget kind they are placed as", () => {
  assert.throws(() => resolveCanvasConfig({ ...base, widgets: { kinds: ["inferops.project-board"], blueprints: ["inferops.kanban"] } }, inventory),
    /enable the inferos.gadget kind/);
});

test("screen templates are validated by the Workshop's own parser", () => {
  const gadgetScreen = { id: "ops", title: "Ops", sections: [{ id: "s", title: "S", columns: 1, widgets: [
    { id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:1", size: "normal", params: {} }] }] };
  assert.throws(() => resolveCanvasConfig({ ...base, screens: [gadgetScreen] }, inventory), /screen template widget/);
});

test("custom gatekeepers default to all built ones and can be narrowed", () => {
  assert.deepEqual(selectedCustomGatekeepers(undefined, inventory), ["gatekeeper-inferops"]);
  assert.deepEqual(selectedCustomGatekeepers({ ...base, customGatekeepers: [] } as never, inventory), []);
});

test("the CLI edits the config file and only ever writes valid configurations", t => {
  const { root, run } = fixture(t);
  assert.deepEqual(run("list").enabled.customGatekeepers, ["gatekeeper-inferops"]);
  run("init");
  assert.throws(() => run("init"), /already exists/);
  run("disable", "inferos.gadget");
  run("enable", "inferops.kanban");
  let written = JSON.parse(readFileSync(join(root, CANVAS_CONFIG_FILE), "utf8"));
  assert.deepEqual(written.widgets, { kinds: ["inferops.project-board", "inferops.wiki", "inferos.gadget"], blueprints: ["inferops.kanban"] });
  run("add-screen", "ops", "Operations", "inferops://demo.local/project/board/ENG");
  assert.throws(() => run("add-screen", "ops", "Again"), /already exists/);
  assert.throws(() => run("add-screen", "bad", "Bad", "https://example.com"), /target reference/);
  run("gatekeeper", "disable", "gatekeeper-inferops");
  written = JSON.parse(readFileSync(join(root, CANVAS_CONFIG_FILE), "utf8"));
  assert.equal(written.screens[0].sections[0].widgets[0].targetRef, "inferops://demo.local/project/board/ENG");
  assert.deepEqual(written.customGatekeepers, []);
  run("remove-screen", "ops");
  assert.throws(() => run("enable", "nonsense"), /neither a widget kind nor a blueprint/);
  assert.throws(() => run("frobnicate"), /Usage/);
});

test("a malformed config file is reported rather than overwritten", t => {
  const { root, run } = fixture(t);
  writeFileSync(join(root, CANVAS_CONFIG_FILE), JSON.stringify({ ...base, widgets: { kinds: ["bad"], blueprints: [] } }));
  assert.throws(() => run("enable", "inferops.kanban"), /unknown widget kind/);
  assert.match(readFileSync(join(root, CANVAS_CONFIG_FILE), "utf8"), /"bad"/);
});
