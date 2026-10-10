import { describe, expect, it } from "vitest";
import { WORKSPACE_KINDS, type WorkspaceKind } from "@gadgets/workshop-shared/api";
import {
  blueprintPublishRefusals, checkWorkspaceKind, classifyGadgetFiles, isGadgetModule,
  workspaceKindAllowsFile, workspaceKindContract, workspaceKindStarter, type GadgetFileClass,
  type GadgetFileParsers, type GadgetFileViolationCode,
} from "@gadgets/workshop-shared/workspace-kind";
import { parseBoundViewSpec } from "@gadgets/workshop-shared/bound-view";

const codes = (...args: Parameters<typeof checkWorkspaceKind>) =>
  checkWorkspaceKind(...args).map(violation => violation.code);

describe("workspace kind contract", () => {
  it("leaves an app as the default build: no contract and no starter", () => {
    expect(workspaceKindContract("app")).toBeNull();
    expect(workspaceKindStarter("app")).toBeNull();
  });

  it("gives every other kind a contract and a starter that fits it", () => {
    for (const kind of WORKSPACE_KINDS.filter(kind => kind !== "app")) {
      expect(workspaceKindContract(kind)).toContain("This workspace's kind is");
      const starter = workspaceKindStarter(kind)!;
      expect(checkWorkspaceKind(kind, Object.keys(starter))).toEqual([]);
      for (const filename of Object.keys(starter)) {
        expect(workspaceKindAllowsFile(kind, filename)).toBe(true);
      }
    }
  });

  it("requires a UI of an app or widget, and a server of a widget or workflow", () => {
    expect(codes("app", ["server.js"])).toEqual(["missingUi"]);
    expect(codes("app", ["client.js"])).toEqual([]);
    expect(codes("widget", [])).toEqual(["missingUi", "missingServer"]);
    expect(codes("workflow", [])).toEqual(["missingServer"]);
  });

  it("allows a workflow no UI", () => {
    expect(codes("workflow", ["server.js", "client.js"])).toEqual(["unexpectedUi"]);
    expect(workspaceKindAllowsFile("workflow", "client.js")).toBe(false);
    expect(workspaceKindAllowsFile("workflow", "lib/client.js")).toBe(true);
    expect(workspaceKindAllowsFile("widget", "client.js")).toBe(true);
  });
});

// The shared classification matrix (bound-view and callable-widget contracts, §2.1), row by row.
// `ok` parses under the injected parsers and `bad` does not; `null` is a file that is not UTF-8.
const parsers: GadgetFileParsers = {
  view: text => { if (text !== "ok") throw new Error("bad view"); },
  tools: text => { if (text !== "ok") throw new Error("bad tools"); },
};
type Row = [
  name: string, kind: WorkspaceKind, files: Record<string, string | null>,
  codes: GadgetFileViolationCode[], fileClass: GadgetFileClass | null,
];
const UI = { "client.js": "" };
const SERVER = { "server.js": "" };
const VIEW = { "view.json": "ok" };
const TOOLS = { "tools.json": "ok" };
const BAD_VIEW = { "view.json": "bad" };
const BAD_TOOLS = { "tools.json": "bad" };
const MATRIX: Row[] = [
  ["M1 widget: UI and server", "widget", { ...UI, ...SERVER }, [], "visualWidget"],
  ["M2 widget: server and valid tools", "widget", { ...SERVER, ...TOOLS }, [], "callableTools"],
  ["M3 widget: UI, server and valid tools", "widget", { ...UI, ...SERVER, ...TOOLS }, [],
    "callableCombined"],
  ["M4 widget: valid view alone", "widget", { ...VIEW, "README.md": "" }, [], "viewOnly"],
  ["M5 widget: view with client.js", "widget", { ...UI, ...VIEW }, ["mixedView"], null],
  ["M5 widget: view with server.js", "widget", { ...SERVER, ...VIEW }, ["mixedView"], null],
  ["M5 widget: view with any other .js", "widget", { ...VIEW, "lib/util.js": "" },
    ["mixedView"], null],
  ["M6 widget: view with tools and server", "widget", { ...SERVER, ...VIEW, ...TOOLS },
    ["mixedView"], null],
  ["M6 widget: view with tools, no server", "widget", { ...VIEW, ...TOOLS },
    ["mixedView", "toolsWithoutServer"], null],
  ["M7 widget: invalid view alone", "widget", BAD_VIEW, ["invalidView"], null],
  ["M8 widget: server and invalid tools", "widget", { ...SERVER, ...BAD_TOOLS },
    ["invalidTools"], null],
  ["M8 widget: UI, server and invalid tools", "widget", { ...UI, ...SERVER, ...BAD_TOOLS },
    ["invalidTools"], null],
  ["M9 widget: valid tools, no server", "widget", TOOLS, ["toolsWithoutServer"], null],
  ["M9 widget: UI and valid tools, no server", "widget", { ...UI, ...TOOLS },
    ["toolsWithoutServer"], null],
  ["M10 widget: server alone", "widget", SERVER, ["missingUi"], null],
  ["M11 widget: UI alone", "widget", UI, ["missingServer"], null],
  ["M12 widget: nothing", "widget", {}, ["missingUi", "missingServer"], null],
  ["M13 app: UI and server", "app", { ...UI, ...SERVER }, [], "app"],
  ["M13 app: UI only", "app", UI, [], "app"],
  ["M14 app: no UI", "app", SERVER, ["missingUi"], null],
  ["M15 app: view.json", "app", { ...UI, ...VIEW }, ["unexpectedView"], null],
  ["M16 app: tools.json", "app", { ...UI, ...TOOLS }, ["unexpectedTools"], null],
  ["M17 workflow: server only", "workflow", SERVER, [], "workflow"],
  ["M18 workflow: UI", "workflow", { ...UI, ...SERVER }, ["unexpectedUi"], null],
  ["M19 workflow: no server", "workflow", {}, ["missingServer"], null],
  ["M19+M18 workflow: UI, no server", "workflow", UI, ["unexpectedUi", "missingServer"], null],
  ["M20 workflow: view.json", "workflow", { ...SERVER, ...VIEW }, ["unexpectedView"], null],
  ["M21 workflow: tools.json", "workflow", { ...SERVER, ...TOOLS }, ["unexpectedTools"], null],
  // Violations accumulate, in a fixed order.
  ["accumulates: app with view and tools", "app", { ...UI, ...VIEW, ...TOOLS },
    ["unexpectedView", "unexpectedTools"], null],
  ["accumulates: app with no UI, view and tools", "app", { ...VIEW, ...TOOLS },
    ["missingUi", "unexpectedView", "unexpectedTools"], null],
  ["accumulates: workflow with everything", "workflow", { ...UI, ...VIEW, ...TOOLS },
    ["unexpectedUi", "missingServer", "unexpectedView", "unexpectedTools"], null],
  // Parse totality: an invalid file is reported beside every other row's code.
  ["totality: invalid view with code", "widget", { ...UI, ...SERVER, ...BAD_VIEW },
    ["mixedView", "invalidView"], null],
  ["totality: invalid view and invalid tools", "widget", { ...BAD_VIEW, ...BAD_TOOLS },
    ["mixedView", "invalidView", "invalidTools", "toolsWithoutServer"], null],
  ["totality: invalid tools, no server", "widget", BAD_TOOLS,
    ["invalidTools", "toolsWithoutServer"], null],
  ["totality: view that is not UTF-8", "widget", { "view.json": null }, ["invalidView"], null],
  ["totality: tools that are not UTF-8", "widget", { ...SERVER, "tools.json": null },
    ["invalidTools"], null],
  // No parsing outside widgets: an app's or workflow's files are refused on presence alone.
  ["no parsing: app with an invalid view", "app", { ...UI, ...BAD_VIEW }, ["unexpectedView"],
    null],
  ["no parsing: workflow with unreadable tools", "workflow", { ...SERVER, "tools.json": null },
    ["unexpectedTools"], null],
  // Only the gadget's own top-level files count.
  ["nested view.json is just a file", "widget", { ...UI, ...SERVER, "docs/view.json": "bad" },
    [], "visualWidget"],
];

// `classify` uses the kernel's own parsers: the bound-view parser for view.json, and for
// tools.json a stand-in that refuses every file for now; `refusals` the injected ones.
const classify = (kind: WorkspaceKind, files: Record<string, string | null>) =>
  classifyGadgetFiles(kind, new Map(Object.entries(files))).violations.map(v => v.code);
const refusals = (kind: WorkspaceKind, files: Record<string, string | null>) =>
  blueprintPublishRefusals(kind,
      classifyGadgetFiles(kind, new Map(Object.entries(files)), parsers).violations)
    .map(violation => violation.code);

describe("classifyGadgetFiles", () => {
  it.each(MATRIX)("%s", (_name, kind, files, expected, fileClass) => {
    const result = classifyGadgetFiles(kind, new Map(Object.entries(files)), parsers);
    expect(result.violations.map(violation => violation.code)).toEqual(expected);
    expect(result.class).toBe(fileClass);
    for (const violation of result.violations) expect(violation.message).toMatch(/\.$/);
  });

  it("refuses every tools.json until its parser lands", () => {
    expect(classify("widget", { ...SERVER, "tools.json": "[]" })).toEqual(["invalidTools"]);
    expect(classify("widget", { ...UI, ...SERVER, "tools.json": "[]" })).toEqual(["invalidTools"]);
    expect(classify("widget", { ...UI, ...SERVER })).toEqual([]);
  });

  // The matrix rows without tools.json, under the kernel's own view.json parser: `ok` becomes a
  // valid bound view and `bad` one that does not parse.
  const VALID_VIEW = JSON.stringify({
    version: 1, title: "Open work", requirements: ["board"],
    root: { type: "count", label: "Open", of: { requirement: "board", collection: "issues" } },
  });
  const real = (files: Record<string, string | null>) => Object.fromEntries(Object.entries(files).map(
      ([path, text]) => [path, path !== "view.json" ? text : text === "ok" ? VALID_VIEW : text === "bad" ? "{}" : text]));
  it.each(MATRIX.filter(([, , files]) => !("tools.json" in files)))(
    "%s, with the bound-view parser", (_name, kind, files, expected, fileClass) => {
      const result = classifyGadgetFiles(kind, new Map(Object.entries(real(files))));
      expect(result.violations.map(violation => violation.code)).toEqual(expected);
      expect(result.class).toBe(fileClass);
    });

  it("classifies a valid view.json alone as view-only, and reports a bad one's problems", () => {
    expect(parseBoundViewSpec(VALID_VIEW).ok).toBe(true);
    expect(classifyGadgetFiles("widget", new Map([["view.json", VALID_VIEW]])))
      .toEqual({ class: "viewOnly", violations: [] });
    const [bad] = classifyGadgetFiles("widget", new Map([["view.json", '{"version":1,"version":1}']])).violations;
    expect(bad).toEqual({ code: "invalidView",
      message: "This gadget's view.json is not a valid view: duplicateKey at $.version; if " +
          "view.json is a data file, rename it to publish this gadget." });
    expect(classify("widget", { "view.json": "{}" })).toEqual(["invalidView"]);
    expect(classify("widget", { ...UI, ...SERVER, "view.json": VALID_VIEW })).toEqual(["mixedView"]);
    expect(classify("widget", { "view.json": VALID_VIEW, "lib/x.js": "" })).toEqual(["mixedView"]);
    expect(classify("widget", { "view.json": null })).toEqual(["invalidView"]);
  });

  it("checks filenames alone as before, failing to parse a view or tools it cannot read", () => {
    expect(codes("widget", ["client.js", "server.js"])).toEqual([]);
    expect(codes("widget", ["view.json"])).toEqual(["invalidView"]);
    expect(codes("app", ["client.js", "tools.json"])).toEqual(["unexpectedTools"]);
  });

  it("tells the author of an app or workflow to rename the file", () => {
    const [view, tools] = classifyGadgetFiles("app",
        new Map([["client.js", ""], ["view.json", ""], ["tools.json", ""]])).violations;
    expect(view!.message).toBe("An App does not use view.json; rename this gadget's view.json " +
        "to publish it.");
    expect(tools!.message).toMatch(/rename this gadget's tools\.json/);
  });

  it("tells the author of a widget with a view.json or tools.json data file to rename it", () => {
    const messages = (files: Record<string, string>) =>
      classifyGadgetFiles("widget", new Map(Object.entries(files))).violations
        .map(violation => violation.message);
    expect(messages({ ...UI, ...SERVER, "tools.json": "[]" })).toEqual([
      "This gadget's tools.json is not a valid tool list: callable widgets are not supported " +
          "yet; if tools.json is a data file, rename it to publish this gadget.",
    ]);
    expect(messages({ "view.json": "{}" })).toEqual([
      "This gadget's view.json is not a valid view: missingKey at $.version; missingKey at " +
          "$.title; missingKey at $.requirements; missingKey at $.root; if view.json is a data " +
          "file, rename it to publish this gadget.",
    ]);
  });

  it("counts a gadget's JavaScript modules as the gadget loader does", () => {
    // The loader (OverseerImpl's worker code) loads exactly the paths isGadgetModule accepts, and
    // mixedView refuses a view with any of them.
    for (const path of ["client.js", "server.js", "lib/util.js", "a.b.js"]) {
      expect(isGadgetModule(path), path).toBe(true);
      expect(classify("widget", { [path]: "", "view.json": "{}" }), path).toContain("mixedView");
    }
    for (const path of ["view.json", "lib.mjs", "x.cjs", "a.ts", "js", "README.md"]) {
      expect(isGadgetModule(path), path).toBe(false);
      expect(classify("widget", { [path]: "", "view.json": "{}" }), path)
        .not.toContain("mixedView");
    }
  });
});

describe("blueprintPublishRefusals", () => {
  it("refuses a widget on every violation", () => {
    for (const [, kind, files, expected] of MATRIX.filter(row => row[1] === "widget")) {
      expect(refusals(kind, files)).toEqual(expected);
    }
  });

  it("refuses an app or workflow only on a view.json or tools.json", () => {
    // These publish today, and still do.
    expect(refusals("app", SERVER)).toEqual([]);
    expect(refusals("app", {})).toEqual([]);
    expect(refusals("workflow", { ...UI, ...SERVER })).toEqual([]);
    expect(refusals("workflow", UI)).toEqual([]);
    expect(refusals("app", { ...SERVER, ...VIEW, ...TOOLS }))
      .toEqual(["unexpectedView", "unexpectedTools"]);
    expect(refusals("workflow", { ...UI, ...BAD_TOOLS })).toEqual(["unexpectedTools"]);
  });
});
