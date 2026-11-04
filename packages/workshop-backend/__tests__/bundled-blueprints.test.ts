import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DEFAULT_WORKSPACE_KIND } from "@gadgets/workshop-shared/api";
import { parseWidgetStates } from "@gadgets/workshop-shared/widget-state";
import { blueprintPublishRefusals, classifyGadgetFiles } from "@gadgets/workshop-shared/workspace-kind";
import {
  parseBlueprintArchive, parseBlueprintKvRecord, sanitizeBlueprintOutput, sanitizeWorkspaceKind,
} from "../src/blueprint-archive.js";
import {
  bundledBlueprintsManifestVersion, installBundledBlueprints, isBundledFormat,
} from "../src/bundled-blueprints.js";
import { BUNDLED_BLUEPRINTS } from "../src/generated/bundled-blueprints.js";

async function readBlueprintFile(
  entry: (typeof BUNDLED_BLUEPRINTS)[number],
  filename: string,
): Promise<string> {
  let archive = new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!;
  let {content} = await parseBlueprintArchive(archive);
  let decompressed = content.pipeThrough(new DecompressionStream("gzip"));
  let update = new Uint8Array(await new Response(decompressed).arrayBuffer());
  let doc = new Y.Doc();
  Y.applyUpdateV2(doc, update);
  return doc.getMap<Y.Text>().get(filename)?.toString() ?? "";
}

/**
 * Whether `code` exports `name`, in either shape a blueprint's installed JavaScript can have: hand
 * written (`export class Foo`), or produced by the TypeScript build, which rewrites the declaration
 * to a `var` and gathers every export into one trailing `export { ... }` list.
 */
function exportsName(code: string, name: string): boolean {
  return new RegExp(`export\\s+(?:class|function|const|let|var)\\s+${name}\\b`, "u").test(code) ||
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, "su").test(code);
}

// Minimal in-memory stand-ins for the two bindings the installer writes to. They record what was
// written so the test can assert on the installed blueprint the way a reader would see it.
function makeEnv() {
  let kv = new Map<string, string>();
  let r2 = new Map<string, Uint8Array>();
  let r2Metadata = new Map<string, Record<string, string> | undefined>();
  return {
    kv,
    r2,
    r2Metadata,
    env: {
      BLUEPRINTS: {
        put: async (key: string, value: string) => { kv.set(key, value); },
      },
      BLUEPRINT_CONTENT: {
        // Deliberately strict: real R2 rejects a stream of unknown length, so accepting one here
        // would hide exactly the bug this stands in for.
        put: async (key: string, value: unknown, options?: {customMetadata?: Record<string, string>}) => {
          r2Metadata.set(key, options?.customMetadata);
          if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
            throw new TypeError(
                "Provided readable stream must have a known length " +
                "(request/response body or readable half of FixedLengthStream)");
          }
          r2.set(key, new Uint8Array(ArrayBuffer.isView(value)
              ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
              : value));
        },
      },
    } as unknown as Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">,
  };
}

describe("bundled blueprints", () => {
  it("installs every manifest entry as an ordinary blueprint", async () => {
    let {kv, r2, env} = makeEnv();

    let installed = await installBundledBlueprints(env);

    expect(installed).toHaveLength(BUNDLED_BLUEPRINTS.length);
    for (let entry of BUNDLED_BLUEPRINTS) {
      let raw = kv.get(entry.blueprintId);
      expect(raw, `${entry.blueprintId} metadata`).toBeDefined();

      let record = parseBlueprintKvRecord(raw!);
      // No owning user: these belong to the deployment, so the owner-anchored featured toggle
      // must not apply to them.
      expect(record.ownerId).toBeUndefined();
      // Presentation comes from the source manifest, not from whatever the archive was called in the
      // workspace it was exported from.
      expect(record.metadata.title).toBe(entry.title);
      expect(record.metadata.description).toBe(entry.description);
      expect(record.metadata.author).toEqual(entry.author);
      // The manifest's declaration is written into the installed blueprint, so from here on the
      // blueprint declares its own format like any other.
      expect(record.metadata.output).toEqual(entry.output);
      // ...and it survives the same validation an uploaded archive's would.
      expect(sanitizeBlueprintOutput(record.metadata.output)).toEqual(entry.output);

      // Content lands where readBlueprintContent() looks for it.
      let content = r2.get(`${entry.blueprintId}/${record.metadata.version}`);
      expect(content, `${entry.blueprintId} content`).toBeDefined();
      expect(content!.byteLength).toBeGreaterThan(0);
    }
  });

  // FAC-86: a bundled blueprint declares its kind, and every install of it takes that kind. The
  // install reads the kind from the version's stored content (readBlueprintContent), so it is
  // written there, as publishing writes it; content stored without one reads as an app.
  it("stores each entry's kind with its content, so a bundled widget installs as a widget", async () => {
    let base = BUNDLED_BLUEPRINTS[0]!;
    let widget = {...base, blueprintId: "test.widget", kind: "widget" as const};
    let app = {...base, blueprintId: "test.app"};
    let {kv, r2Metadata, env} = makeEnv();

    let installed = await installBundledBlueprints(env, [widget, app]);

    expect(installed.map(info => [info.id, info.metadata.kind])).toEqual([["test.widget", "widget"], ["test.app", undefined]]);
    let widgetRecord = parseBlueprintKvRecord(kv.get("test.widget")!);
    expect(widgetRecord.metadata.kind).toBe("widget");
    expect(r2Metadata.get(`test.widget/${widgetRecord.metadata.version}`)?.kind).toBe("widget");
    // An app's record is what it always was; its content is stored as an app.
    let appRecord = parseBlueprintKvRecord(kv.get("test.app")!);
    expect(appRecord.metadata.kind).toBeUndefined();
    expect(r2Metadata.get(`test.app/${appRecord.metadata.version}`)?.kind).toBe(DEFAULT_WORKSPACE_KIND);
  });

  // FAC-86 part 3: the sample stateful widget is bundled as a widget, so installing it makes a
  // widget workspace, and its states and its mark travel in its archive.
  it("installs the sample status widget as a widget, with its states and its bundled mark", async () => {
    let entry = BUNDLED_BLUEPRINTS.find(candidate => candidate.blueprintId === "inferos.status-widget");
    expect(entry?.kind).toBe("widget");
    expect(isBundledFormat(entry!)).toBe(false);
    let {kv, r2Metadata, env} = makeEnv();
    await installBundledBlueprints(env, [entry!]);
    let record = parseBlueprintKvRecord(kv.get(entry!.blueprintId)!);
    expect(record.metadata.kind).toBe("widget");
    expect(r2Metadata.get(`${entry!.blueprintId}/${record.metadata.version}`)?.kind).toBe("widget");

    let states = parseWidgetStates(await readBlueprintFile(entry!, "states.json"));
    expect(states.states).toEqual(["idle", "working", "done", "failed"]);
    expect(states.transitions).toContainEqual({event: "retry", from: "failed", to: "working"});
    // The mark is inlined into the bundle as the logo's own path, never fetched.
    let client = await readBlueprintFile(entry!, "client.js");
    expect(client).toContain("M32 8 52.8 20v24L32 56 11.2 44V20L32 8Z");
    // Its one URL is the SVG namespace, which names and loads nothing.
    expect(client.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/favicon\.svg|https?:\/\//u);
  });

  it("offers only an app as a standard format, and reinstalls when an entry's kind changes", () => {
    expect(isBundledFormat({})).toBe(true);
    expect(isBundledFormat({kind: "app"})).toBe(true);
    expect(isBundledFormat({kind: "widget"})).toBe(false);
    expect(isBundledFormat({kind: "workflow"})).toBe(false);

    let base = BUNDLED_BLUEPRINTS[0]!;
    let before = bundledBlueprintsManifestVersion([base]);
    expect(bundledBlueprintsManifestVersion([{...base, kind: "widget"}])).not.toBe(before);
    // Existing app entries keep the version they had, so a deployment does not reinstall them.
    expect(bundledBlueprintsManifestVersion([{...base}])).toBe(before);
  });

  it("still republishes every bundled blueprint under the kind check", async () => {
    for (let entry of BUNDLED_BLUEPRINTS) {
      let archive = new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!;
      let {metadata, content} = await parseBlueprintArchive(archive);
      let decompressed = content.pipeThrough(new DecompressionStream("gzip"));
      let doc = new Y.Doc();
      Y.applyUpdateV2(doc, new Uint8Array(await new Response(decompressed).arrayBuffer()));
      // Content stored without a kind installs as an app, which is what a republish checks.
      let kind = sanitizeWorkspaceKind(metadata.kind) ?? DEFAULT_WORKSPACE_KIND;
      let files = new Map([...doc.getMap<Y.Text>().keys()].map(path => [path, null]));
      expect(files.has("client.js"), entry.blueprintId).toBe(true);
      expect(blueprintPublishRefusals(kind, classifyGadgetFiles(kind, files).violations),
        entry.blueprintId).toEqual([]);
    }
  });

  it("ships print layouts for every standard output format", async () => {
    for (let entry of BUNDLED_BLUEPRINTS.filter(isBundledFormat)) {
      expect(await readBlueprintFile(entry, "client.js"), entry.blueprintId)
        .toContain("@media print");
    }
  });

  it("renders document HTML and PDF exports without the editor chrome", async () => {
    let entry = BUNDLED_BLUEPRINTS.find(blueprint => blueprint.blueprintId === "format.document")!;
    let client = await readBlueprintFile(entry, "client.js");

    // The TypeScript build rewrites the source; what survives is the export-mode check itself.
    expect(client).toContain('["html", "pdf"].includes(');
    expect(client).toContain("gadgetExportFormatId");
    expect(client).toContain('document.documentElement.classList.add("document-export")');
    expect(client).toContain("app.replaceChildren(canvas)");
  });

  it("declares the intended export formats for every standard output format", async () => {
    let expectedFormats: Record<string, string[]> = {
      "format.document": [
        'id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown"',
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.slides": [
        'id: "html", label: "HTML", mode: "browser", contentType: "text/html"',
        'id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf"',
      ],
      "format.spreadsheet": [
        // `const` in the source; the TypeScript build emits `var`.
        'CSV_FORMAT_PREFIX = "csv:"',
        'id: "xlsx"',
        'label: "Excel Workbook"',
        'contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"',
        'mode: "server"',
        'contentType: "text/csv"',
      ],
    };

    for (let entry of BUNDLED_BLUEPRINTS.filter(isBundledFormat)) {
      let serverCode = await readBlueprintFile(entry, "server.js");
      expect(exportsName(serverCode, "ExportHandler"),
        `${entry.blueprintId}: server.js exports ExportHandler`).toBe(true);
      for (let declaration of expectedFormats[entry.blueprintId] ?? []) {
        expect(serverCode, `${entry.blueprintId}: ${declaration}`).toContain(declaration);
      }
    }
  });

  // The export assertion above is only as good as its shape matching, and its two shapes come from
  // two different producers (a hand-written blueprint, and esbuild), so neither the suite nor a
  // reader can see them side by side anywhere else.
  it.each<[string, boolean]>([
    ["export class ExportHandler {}\n", true],
    ["var ExportHandler = class {\n};\nexport {\n  ExportHandler,\n  Gadget\n};\n", true],
    ["class ExportHandler {}\nnew ExportHandler();\n", false],
    ["export {\n  Gadget\n};\n// ExportHandler moved out.\n", false],
  ])("recognizes an ExportHandler export in %j", (code, expected) => {
    expect(exportsName(code, "ExportHandler")).toBe(expected);
  });

  // Skipped when the deployment bundles nothing, which BUNDLED_BLUEPRINTS_DIR makes a supported
  // configuration rather than a broken checkout.
  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "changes the manifest version when an entry's revision changes", () => {
    let entry = BUNDLED_BLUEPRINTS[0];
    let before = bundledBlueprintsManifestVersion();
    expect(before).toContain(entry.blueprintId);

    let original = entry.revision;
    try {
      entry.revision = original + 1;
      expect(bundledBlueprintsManifestVersion()).not.toBe(before);
    } finally {
      entry.revision = original;
    }
  });

  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "changes the manifest version when bundled source changes", () => {
    let entry = BUNDLED_BLUEPRINTS[0];
    let before = bundledBlueprintsManifestVersion();
    let original = entry.contentHash;
    try {
      entry.contentHash = `${original}-changed`;
      expect(bundledBlueprintsManifestVersion()).not.toBe(before);
    } finally {
      entry.contentHash = original;
    }
  });

  // Curated text is the input most likely to be edited -- it is the whole point of keeping it in a
  // text file -- and an edit that doesn't reach deployments which already installed would be
  // invisible: the build succeeds and the old wording stays put.
  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "changes the manifest version when curated presentation changes, with no revision bump", () => {
    let entry = BUNDLED_BLUEPRINTS[0];
    let before = bundledBlueprintsManifestVersion();

    for (let mutate of [
      () => { entry.description += " Now with more detail."; },
      () => { entry.title += " (Beta)"; },
      () => { entry.output = {...entry.output, noun: "Document"}; },
    ]) {
      let restore = {...entry};
      try {
        mutate();
        expect(bundledBlueprintsManifestVersion()).not.toBe(before);
        expect(entry.revision).toBe(restore.revision);
      } finally {
        Object.assign(entry, restore);
      }
    }

    expect(bundledBlueprintsManifestVersion()).toBe(before);
  });
});
