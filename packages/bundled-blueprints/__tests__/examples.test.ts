// Examples are reviewable source, never bundled: the bundled set the backend builds from
// BUNDLED_BLUEPRINTS_DIR does not contain them (so no deployment installs or promotes one), and each
// example still builds to a valid archive with the same reader, checks and codec.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildExampleArchive, EXAMPLES_DIR } from "../src/example-archive.ts";
import { extractFiles, parseArchive } from "../src/files.ts";
import { BUNDLED_BLUEPRINTS_DIR, generateBundledBlueprintsModule } from "../src/generate.ts";

const examples = async () =>
  (await readdir(EXAMPLES_DIR, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);

describe("example blueprints", () => {
  it("live outside the bundled directory", () => {
    expect(EXAMPLES_DIR).not.toBe(BUNDLED_BLUEPRINTS_DIR);
    expect(EXAMPLES_DIR.startsWith(`${BUNDLED_BLUEPRINTS_DIR}/`)).toBe(false);
  });

  it("are absent from the bundled module, so no deployment installs or promotes them", async () => {
    const generated = await generateBundledBlueprintsModule(BUNDLED_BLUEPRINTS_DIR, { builtFrom: "test" });
    for (const name of await examples()) {
      const { manifest } = await buildExampleArchive(join(EXAMPLES_DIR, name));
      expect(generated.text).not.toContain(`"blueprintId": "${manifest.blueprintId}"`);
    }
  }, 120_000);

  it("each build to an archive whose metadata and files match their source", async () => {
    const names = await examples();
    expect(names).toContain("model-usage");
    expect(names).toContain("system-metrics");
    for (const name of names) {
      const { manifest, bytes } = await buildExampleArchive(join(EXAMPLES_DIR, name));
      const archive = parseArchive(bytes, name);
      expect(archive.metadata).toMatchObject({
        title: manifest.title, version: manifest.version, bindings: manifest.bindings,
      });
      const files = [...extractFiles(archive.content, name).keys()].toSorted();
      expect(files).toEqual(["README.md", "client.js", "server.js"]);
    }
  }, 120_000);

  it("the model-usage example has no bindings: it reaches no gatekeeper, provider or account", async () => {
    const { manifest } = await buildExampleArchive(join(EXAMPLES_DIR, "model-usage"));
    expect(manifest.blueprintId).toBe("example.model-usage");
    expect(manifest.bindings).toEqual({});
  });

  it("the system-metrics example has no bindings: it reaches no gatekeeper, metrics source or account", async () => {
    const { manifest } = await buildExampleArchive(join(EXAMPLES_DIR, "system-metrics"));
    expect(manifest.blueprintId).toBe("example.system-metrics");
    expect(manifest.bindings).toEqual({});
  });
});
