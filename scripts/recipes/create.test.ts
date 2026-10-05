import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkConsumerFixture } from "../consumer/fixtures.ts";
import { checkConsumer } from "../consumer/runtime.ts";
import { readConsumerViews } from "../consumer/views.ts";
import { RECIPES } from "./catalog.ts";
import { createRecipe } from "./create.ts";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const revision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("recipes produce real pinned wrappers with valid synthetic boards and preserve all edits on rerun", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-recipes-"));
  try {
    for (const name of Object.keys(RECIPES)) {
      const destination = join(root, name);
      assert.equal(createRecipe(name, destination, repository, revision).created, true);
      const config = checkConsumer(destination).config;
      assert.equal(config.local.port, 28787);
      assert.equal(config.upstream.revision, revision);
      const fixture = checkConsumerFixture(destination);
      assert.ok("issues" in fixture);
      assert.equal(fixture.issues, 3);
      assert.equal(readConsumerViews(destination).length, 1);
      const marker = JSON.parse(readFileSync(join(destination, "recipe.json"), "utf8"));
      assert.equal(marker.synthetic, true);
      assert.equal(marker.productionReady, false);
      assert.ok(marker.boundaries.length > 0);
      const file = join(destination, "views/operations.json");
      const edited = JSON.parse(readFileSync(file, "utf8"));
      edited.title = "Customer changes must survive";
      writeFileSync(file, JSON.stringify(edited));
      const notes = join(destination, "RECIPE.md");
      writeFileSync(notes, "Customer SOP\n");
      assert.equal(createRecipe(name, destination, repository, revision, 28788).created, false);
      assert.equal(readFileSync(notes, "utf8"), "Customer SOP\n");
      assert.equal(readConsumerViews(destination)[0].title, edited.title);
      assert.equal(checkConsumer(destination).config.local.port, 28787);
      assert.throws(() => createRecipe(name, destination, repository, "f".repeat(40)), /different upstream pin/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid selections and failed pins do not create a partial recipe or overwrite a destination", () => {
  const root = mkdtempSync(join(tmpdir(), "inferos-recipe-refusal-"));
  const target = join(root, "target");
  try {
    assert.throws(() => createRecipe("unknown", target, repository, revision), /Recipe must/);
    for (const port of [8787, 18787, 0, 1.5, NaN, 65536]) {
      assert.throws(() => createRecipe("it-triage", target, repository, revision, port), /Choose a local port/);
    }
    assert.equal(existsSync(target), false);
    assert.throws(() => createRecipe("it-triage", target, repository, "f".repeat(40)));
    assert.deepEqual(readdirSync(root), []);
    writeFileSync(target, "Existing user file");
    assert.throws(() => createRecipe("it-triage", target, repository, revision), /not this recipe/);
    assert.equal(readFileSync(target, "utf8"), "Existing user file");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
