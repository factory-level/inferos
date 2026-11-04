// FAC-86: a bundled blueprint may declare the kind every install of it takes. The manifest names
// it, the archive's metadata carries it (as a published version's does), and the generated entry
// hands it to the installer, which stores it with the content. Absent still means an app.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArchive } from "../src/files.ts";
import { generateBundledBlueprintsModule } from "../src/generate.ts";
import { parseBundledBlueprintManifest } from "../src/manifest.ts";

const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({
  blueprintId: "test.status",
  title: "Status",
  description: "Shows where one piece of work stands.",
  output: { id: "status", noun: "Status", plural: "Statuses", icon: "listChecks" },
  author: { type: "user", name: "Test", id: "test@example.com" },
  revision: 1,
  created: "2026-11-04T00:00:00.000Z",
  version: 1,
  lastUpdated: "2026-11-04T00:00:00.000Z",
  bindings: {},
  ...extra,
});

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe("a bundled blueprint's kind", () => {
  it("is read from blueprint.json, absent meaning an app, and refused when unknown", () => {
    expect(parseBundledBlueprintManifest("status", manifest({ kind: "widget" })).kind).toBe("widget");
    expect(parseBundledBlueprintManifest("status", manifest({ kind: "workflow" })).kind).toBe("workflow");
    expect("kind" in parseBundledBlueprintManifest("status", manifest())).toBe(false);
    expect(() => parseBundledBlueprintManifest("status", manifest({ kind: "tile" })))
      .toThrow("status/blueprint.json: kind must be one of: app, widget, workflow");
  });

  it("reaches the generated entry and the archive's metadata", async () => {
    let root = await mkdtemp(join(tmpdir(), "bundled-kind-"));
    dirs.push(root);
    for (let [name, extra] of [["status", { kind: "widget" }], ["plain", { blueprintId: "test.plain" }]] as const) {
      await mkdir(join(root, name, "files"), { recursive: true });
      await writeFile(join(root, name, "blueprint.json"), manifest(extra));
      await writeFile(join(root, name, "files", "client.js"), "document.body.textContent = 'ok';\n");
      await writeFile(join(root, name, "files", "server.js"),
        "import { DurableObject } from \"cloudflare:workers\";\nexport class Gadget extends DurableObject {}\n");
    }

    let { text } = await generateBundledBlueprintsModule(root, { builtFrom: "test" });
    let entries = JSON.parse(text.slice(text.indexOf("= [") + 2, text.lastIndexOf("];") + 1)) as
      Array<{ blueprintId: string; kind?: string; archive: string }>;
    let byId = new Map(entries.map(entry => [entry.blueprintId, entry]));

    let widget = byId.get("test.status")!;
    expect(widget.kind).toBe("widget");
    expect(parseArchive(Buffer.from(widget.archive, "base64"), "status").metadata.kind).toBe("widget");
    // An app's entry and archive are what they were before kinds.
    let plain = byId.get("test.plain")!;
    expect("kind" in plain).toBe(false);
    expect("kind" in parseArchive(Buffer.from(plain.archive, "base64"), "plain").metadata).toBe(false);
  });
});
