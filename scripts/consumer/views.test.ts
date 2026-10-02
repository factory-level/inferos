import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConsumerViews } from "./views.ts";

const view = { schemaVersion: 1, id: "operations", title: "Operations", revision: "0", sections: [] };

test("starter validation rejects duplicated identities and unauthorized schema extensions", t => {
  const root = mkdtempSync(join(tmpdir(), "inferos-views-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "views"));
  const save = (name: string, value: unknown) => writeFileSync(join(root, "views", name), JSON.stringify(value));
  save("a.json", view);
  assert.deepEqual(readConsumerViews(root), [view]);
  save("b.json", view);
  assert.throws(() => readConsumerViews(root), /unique view IDs/);
  save("b.json", { ...view, id: "other", owner: "someone-else" });
  assert.throws(() => readConsumerViews(root), /Invalid canvas/);
  save("b.json", { ...view, id: "other", revision: "00" });
  assert.throws(() => readConsumerViews(root), /revision/);
  save("b.json", { ...view, id: "other", sections: [{ id: "s", title: "Gadgets", columns: 1, widgets: [
    { id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:7", size: "normal", params: {} }] }] });
  assert.throws(() => readConsumerViews(root), /only contain InferOps project boards/);
});

test("starter validation refuses linked, executable and oversized source files", t => {
  const root = mkdtempSync(join(tmpdir(), "inferos-view-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "views"));
  const path = join(root, "views/a.json");
  writeFileSync(join(root, "outside.json"), JSON.stringify(view));
  symlinkSync(join(root, "outside.json"), path);
  assert.throws(() => readConsumerViews(root), /regular JSON/);
  rmSync(path);
  writeFileSync(path, " ".repeat(128 * 1024 + 1));
  assert.throws(() => readConsumerViews(root), /128 KiB/);
  rmSync(path);
  writeFileSync(join(root, "views/run.ts"), "throw new Error('never execute')");
  assert.throws(() => readConsumerViews(root), /regular JSON/);
  rmSync(join(root, "views"), { recursive: true });
  symlinkSync(root, join(root, "views"));
  assert.throws(() => readConsumerViews(root), /symbolic link/);
});
