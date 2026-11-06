import { describe, expect, test } from "vitest";
import { parseCanvasDefinition, type CanvasDefinition, type CanvasWidget } from "./canvas";
import {
  CANVAS_MODEL_LIMITS, CANVAS_WIDGET_ACTIONS, CanvasModelError, canvasDefinitionFromPage, canvasPageFromDefinition, canvasTargetPath, formatCanvasTarget, parseCanvasPage, parseCanvasTarget, parseCanvasWorkspacePages,
  resolveCanvasTarget, type CanvasModelErrorCode, type CanvasNode, type CanvasPage, type CanvasTarget,
} from "./canvas-model";
import rejected from "./canvas-model-fixtures/rejected.json";
import sectionMapping from "./canvas-model-fixtures/section-mapping.json";
import valid from "./canvas-model-fixtures/valid.json";

const rejection = (run: () => unknown): { code: CanvasModelErrorCode; at: string } => {
  try {
    run();
  } catch (caught) {
    if (caught instanceof CanvasModelError) return { code: caught.code, at: caught.at };
    throw caught;
  }
  throw new Error("Expected a rejection");
};

/**
 * Read a page back as sections. It checks the documented mapping from the other direction, so a
 * fixture can't lose a reference or a layout field and still pass. The migration itself is FAC-81's.
 */
const asSections = (page: CanvasPage): CanvasDefinition => {
  const byId = new Map<string, CanvasNode>(page.nodes.map(node => [node.id, node]));
  return {
    schemaVersion: 1, id: page.id, revision: page.revision, title: page.title,
    sections: page.children.map(sectionId => {
      const section = byId.get(sectionId);
      if (section?.nodeType !== "object") throw new Error("A mapped section must be an object");
      return {
        id: section.id, title: section.title, columns: section.columns,
        widgets: section.children.map(widgetId => {
          const node = byId.get(widgetId);
          if (node?.nodeType !== "widget") throw new Error("A mapped widget must be a widget");
          expect(node.attachments).toEqual([]);
          return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "nodeType" && key !== "attachments")) as unknown as CanvasWidget;
        }),
      };
    }),
  };
};

describe("valid fixtures", () => {
  test.each(valid)("$name", ({ page }) => {
    // Legacy board/Wiki pages gain their typed binding while preserving their existing fields.
    expect(parseCanvasPage(page)).toMatchObject(page);
  });

  test("returns a detached copy", () => {
    const input = structuredClone(valid[1].page) as { children: string[] };
    const parsed = parseCanvasPage(input);
    input.children.push("changed");
    expect(parsed.children).toEqual(valid[1].page.children);
  });

  test("keeps every stable ID across a second parse", () => {
    for (const { page } of valid) expect(parseCanvasPage(parseCanvasPage(page))).toEqual(parseCanvasPage(page));
  });

  test("normalizes board and Wiki references into typed read bindings", () => {
    const page = canvasPageFromDefinition({ schemaVersion: 1, id: "p", revision: "0", title: "P", sections: [{
      id: "s", title: "S", columns: 1, widgets: [
        { id: "b", kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG", size: "normal",
          params: { workflow: "software", showCompleted: false } },
        { id: "w", kind: "inferops.wiki", version: 1, targetRef: "inferops://acme.knowledge/knowledge/wiki", size: "normal", params: { page: null } },
        { id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:1", size: "normal", params: {} },
      ],
    }] });
    const byId = new Map(page.nodes.map(node => [node.id, node]));
    expect((byId.get("b") as Extract<CanvasNode, {nodeType: "widget"}>).dataBinding)
      .toEqual({ resource: "project/board", ref: "inferops://acme.operations/project/board/ENG", schemaVersion: 1 });
    expect((byId.get("w") as Extract<CanvasNode, {nodeType: "widget"}>).dataBinding)
      .toEqual({ resource: "knowledge/wiki", ref: "inferops://acme.knowledge/knowledge/wiki", schemaVersion: 1 });
    expect((byId.get("g") as Extract<CanvasNode, {nodeType: "widget"}>).dataBinding).toBeUndefined();
  });

  test("a read binding has no write or workflow fields and cannot alter action offers", () => {
    const page = parseCanvasPage(valid[2].page);
    const board = page.nodes.find((node): node is Extract<CanvasNode, {nodeType: "widget"}> => node.nodeType === "widget" && node.kind === "inferops.project-board")!;
    expect(Object.keys(board.dataBinding ?? {}).toSorted()).toEqual(["ref", "resource", "schemaVersion"]);
    expect(CANVAS_WIDGET_ACTIONS[board.kind]).toEqual(["transition-issue", "create-issue", "update-issue"]);
    expect(CANVAS_WIDGET_ACTIONS["inferos.gadget"]).toEqual([]);
  });

  test.each([
    ["a Wiki resource on a board widget", { resource: "knowledge/wiki", ref: "inferops://acme.operations/project/board/ENG", schemaVersion: 1 }, "incompatible-data-binding"],
    ["a reference different from targetRef", { resource: "project/board", ref: "inferops://other.operations/project/board/ENG", schemaVersion: 1 }, "invalid-data-binding"],
    ["an unsupported schema version", { resource: "project/board", ref: "inferops://acme.operations/project/board/ENG", schemaVersion: 2 }, "invalid-data-binding"],
    ["an authority field", { resource: "project/board", ref: "inferops://acme.operations/project/board/ENG", schemaVersion: 1, workflow: "invoke" }, "invalid-data-binding"],
  ] as const)("rejects %s", (_name, dataBinding, code) => {
    const page = structuredClone(valid[2].page) as { nodes: Record<string, unknown>[] };
    const board = page.nodes.find(node => node.id === "board-1")!;
    board.dataBinding = dataBinding;
    expect(rejection(() => parseCanvasPage(page)).code).toBe(code);
  });

  test("accepts the largest version 1 canvas", () => {
    const widgets = Array.from({ length: 48 }, (_, index) => ({
      nodeType: "widget", id: `w${index}`, kind: "inferos.gadget", version: 1, targetRef: `gadget:${index}`, size: "normal", params: {}, attachments: [],
    }));
    const sections = Array.from({ length: 12 }, (_, index) => ({
      nodeType: "object", id: `s${index}`, title: `S${index}`, columns: 3, attachments: [],
      children: widgets.slice(index * 4, index * 4 + 4).map(widget => widget.id),
    }));
    expect(parseCanvasPage({ schemaVersion: 2, id: "p", revision: "0", title: "P", attachments: [],
      children: sections.map(section => section.id), nodes: [...sections, ...widgets] }).nodes).toHaveLength(60);
  });
});

describe("rejected fixtures", () => {
  test.each(rejected)("$group: $name", ({ page, expected }) => {
    expect(rejection(() => parseCanvasPage(page))).toEqual(expected);
  });

  test("cover every group the contract rejects", () => {
    expect(new Set(rejected.map(entry => entry.group))).toEqual(
      new Set(["containment", "identity", "versioning", "inheritance", "authority", "data", "reference", "attachment"]));
  });

  test("never repeat a submitted value in the error", () => {
    const secret = "do-not-repeat-this-value";
    const pages = [
      { schemaVersion: 2, id: "p", revision: "0", title: "P", children: [], attachments: [], nodes: [], [secret]: true },
      { schemaVersion: 2, id: "p", revision: "0", title: "P", children: [], attachments: [],
        nodes: [{ nodeType: "object", id: secret + "/", title: "A", columns: 1, children: [], attachments: [] }] },
      { schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["w"], attachments: [],
        nodes: [{ nodeType: "widget", id: "w", kind: "inferops.project-board", version: 1, targetRef: secret, size: "normal",
          params: { workflow: "software", showCompleted: false }, attachments: [] }] },
    ];
    for (const page of pages) {
      expect(() => parseCanvasPage(page)).toThrow(CanvasModelError);
      try { parseCanvasPage(page); } catch (caught) { expect((caught as Error).message).not.toContain(secret); }
    }
  });

  test("names each limit", () => {
    const widget = (id: string) => ({ nodeType: "widget", id, kind: "inferos.gadget", version: 1, targetRef: "gadget:1", size: "normal", params: {}, attachments: [] });
    const object = (id: string, children: string[]) => ({ nodeType: "object", id, title: "O", columns: 1, children, attachments: [] });
    const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
    const page = (children: string[], nodes: unknown[], attachments: unknown[] = []) => ({ schemaVersion: 2, id: "p", revision: "0", title: "P", children, attachments, nodes });

    expect(rejection(() => parseCanvasPage(page([], ids("n", CANVAS_MODEL_LIMITS.nodes + 1).map(widget))))).toEqual({ code: "limit-exceeded", at: "p" });
    expect(rejection(() => parseCanvasPage(page([], ids("n", CANVAS_MODEL_LIMITS.widgets + 1).map(widget))))).toEqual({ code: "limit-exceeded", at: "p" });
    expect(rejection(() => parseCanvasPage(page(ids("n", CANVAS_MODEL_LIMITS.children + 1), [])))).toEqual({ code: "limit-exceeded", at: "p" });
    expect(rejection(() => parseCanvasPage(page([], [object("o", ids("n", CANVAS_MODEL_LIMITS.children + 1))])))).toEqual({ code: "limit-exceeded", at: "o" });
    const attachment = (id: string) => ({ id, version: 1, on: "go", effect: { kind: "raise-event", target: "p", event: "stop" } });
    const half = Math.ceil(CANVAS_MODEL_LIMITS.attachments / 2) + 1;
    expect(rejection(() => parseCanvasPage(page(["o"], [{ ...object("o", []), attachments: ids("x", half).map(attachment) }], ids("y", half).map(attachment)))))
        .toEqual({ code: "limit-exceeded", at: "p" });
    expect(rejection(() => parseCanvasWorkspacePages(Array.from({ length: CANVAS_MODEL_LIMITS.pages + 1 }, (_, index) => ({ ...page([], []), id: `p${index}` })))))
        .toEqual({ code: "limit-exceeded", at: "pages" });
  });
});

describe("malformed input", () => {
  /** Call `check` once for each replacement of each nested value, restoring it afterward. */
  const eachReplacement = (value: unknown, check: () => void): void => {
    if (!value || typeof value !== "object") return;
    const holder = value as Record<string, unknown>;
    for (const key of Object.keys(holder)) {
      const original = holder[key];
      for (const next of [null, 7, "", [], {}, [null], "__proto__"]) {
        holder[key] = next;
        check();
      }
      holder[key] = original;
      eachReplacement(original, check);
    }
  };

  test("is only ever accepted or rejected with a stable code", () => {
    let tried = 0;
    for (const { page } of [...valid, ...sectionMapping, ...rejected]) {
      const copy: unknown = structuredClone(page);
      eachReplacement(copy, () => {
        tried++;
        try { parseCanvasPage(copy); } catch (caught) { expect(caught).toBeInstanceOf(CanvasModelError); }
      });
    }
    expect(tried).toBeGreaterThan(1000);
  });
});

describe("containment carries nothing", () => {
  test("a child's event stays local until a link names its parent", () => {
    const page = (objectAttachments: unknown[], widgetAttachments: unknown[]) => ({
      schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["a"], attachments: [], nodes: [
        { nodeType: "object", id: "a", title: "A", columns: 1, children: ["w"], attachments: objectAttachments },
        { nodeType: "widget", id: "w", kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG", size: "normal",
          params: { workflow: "software", showCompleted: false }, attachments: widgetAttachments },
      ],
    });
    const listening = page([{ id: "l", version: 1, on: "action-completed", effect: { kind: "navigate", page: "q" } }], []);
    expect(rejection(() => parseCanvasPage(listening))).toEqual({ code: "unknown-event", at: "l" });

    const wired = page(
      [{ id: "l", version: 1, on: "work-done", effect: { kind: "navigate", page: "q" } }],
      [{ id: "up", version: 1, on: "action-completed", effect: { kind: "raise-event", target: "a", event: "work-done" } }],
    );
    expect(parseCanvasPage(wired).nodes[0].attachments).toHaveLength(1);
  });

  test("a chain of links without a loop is accepted", () => {
    const parsed = parseCanvasPage({ schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["a", "w"], nodes: [
      { nodeType: "object", id: "a", title: "A", columns: 1, children: [], attachments: [
        { id: "second", version: 1, on: "one", effect: { kind: "raise-event", target: "p", event: "two" } },
      ] },
      { nodeType: "widget", id: "w", kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG", size: "normal",
        params: { workflow: "software", showCompleted: false }, attachments: [
          { id: "first", version: 1, on: "action-completed", effect: { kind: "raise-event", target: "a", event: "one" } },
        ] },
    ], attachments: [
      { id: "third", version: 1, on: "two", effect: { kind: "navigate", page: "q" } },
    ] });
    expect(parsed.attachments).toHaveLength(1);
  });
});

describe("parseCanvasWorkspacePages", () => {
  const navigating = (id: string, to: string) => ({
    schemaVersion: 2, id, revision: "0", title: id, children: ["w"], attachments: [], nodes: [
      { nodeType: "widget", id: "w", kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG", size: "normal",
        params: { workflow: "software", showCompleted: false }, attachments: [{ id: "go", version: 1, on: "action-completed", effect: { kind: "navigate", page: to } }] },
    ],
  });

  test("allows a navigation loop, which is how a person returns or retries", () => {
    expect(parseCanvasWorkspacePages([navigating("a", "b"), navigating("b", "a")]).map(page => page.id)).toEqual(["a", "b"]);
  });

  test("allows the same node ID on different pages", () => {
    expect(parseCanvasWorkspacePages([navigating("a", "a"), navigating("b", "a")])).toHaveLength(2);
  });

  test("rejects navigation to a page the workspace doesn't have", () => {
    expect(rejection(() => parseCanvasWorkspacePages([navigating("a", "ghost")]))).toEqual({ code: "missing-reference", at: "go" });
  });

  test("rejects two pages with one ID", () => {
    expect(rejection(() => parseCanvasWorkspacePages([navigating("a", "a"), navigating("a", "a")]))).toEqual({ code: "duplicate-id", at: "a" });
  });
});

describe("explicit targets", () => {
  const page = parseCanvasPage(valid[2].page);
  const targets: [string, CanvasTarget][] = [
    ["workspace", { kind: "workspace" }],
    ["page:page-triage", { kind: "page", pageId: "page-triage" }],
    ["page:page-triage/node:board-1", { kind: "node", pageId: "page-triage", nodeId: "board-1" }],
    ["page:page-triage/attachment:on-triaged", { kind: "attachment", pageId: "page-triage", attachmentId: "on-triaged" }],
  ];

  test.each(targets)("%s reads and writes back", (text, target) => {
    expect(parseCanvasTarget(text)).toEqual(target);
    expect(formatCanvasTarget(target)).toBe(text);
  });

  test("refuses anything else", () => {
    for (const bad of ["", "page:", "page:a/node:", "page:a/widget:b", "page:../a", "page:a/node:b/node:c", "workspace:a", 7, null]) {
      expect(parseCanvasTarget(bad), String(bad)).toBeNull();
    }
  });

  test("selects the page, an object, a widget or an attachment, and says which", () => {
    const resolve = (text: string) => resolveCanvasTarget(page, parseCanvasTarget(text)!);
    expect(resolve("page:page-triage")?.kind).toBe("page");
    expect(resolve("page:page-triage/node:group-1")?.kind).toBe("object");
    expect(resolve("page:page-triage/node:board-1")?.kind).toBe("widget");
    expect(resolve("page:page-triage/attachment:link-completed")).toMatchObject({ kind: "attachment", ownerId: "board-1" });
    expect(resolve("page:page-triage/attachment:on-triaged")).toMatchObject({ kind: "attachment", ownerId: "page-triage" });
  });

  test("finds nothing on another page, or for an ID the page doesn't hold", () => {
    for (const text of ["workspace", "page:other", "page:other/node:board-1", "page:page-triage/node:ghost", "page:page-triage/attachment:ghost"]) {
      expect(resolveCanvasTarget(page, parseCanvasTarget(text)!), text).toBeNull();
    }
  });
});

describe("a target's path", () => {
  const nested = parseCanvasPage(valid[1].page);
  const triage = parseCanvasPage(valid[2].page);
  const path = (page: CanvasPage, text: string) =>
    canvasTargetPath(page, parseCanvasTarget(text)!)?.map(step => `${step.kind}:${formatCanvasTarget(step.target)}`);

  test("runs from the workspace through every containing object to the target", () => {
    expect(path(nested, "page:page-operations/node:gadget-1")).toEqual([
      "workspace:workspace", "page:page:page-operations",
      "object:page:page-operations/node:level-1", "object:page:page-operations/node:level-2",
      "object:page:page-operations/node:level-3", "object:page:page-operations/node:level-4",
      "widget:page:page-operations/node:gadget-1",
    ]);
    expect(path(nested, "page:page-operations/node:board-direct")).toEqual(
      ["workspace:workspace", "page:page:page-operations", "widget:page:page-operations/node:board-direct"]);
  });

  test("ends an attachment's path at the node or page that holds it", () => {
    expect(path(triage, "page:page-triage/attachment:link-completed")).toEqual([
      "workspace:workspace", "page:page:page-triage", "object:page:page-triage/node:group-1",
      "widget:page:page-triage/node:board-1", "attachment:page:page-triage/attachment:link-completed",
    ]);
    expect(path(triage, "page:page-triage/attachment:on-triaged")).toEqual(
      ["workspace:workspace", "page:page:page-triage", "attachment:page:page-triage/attachment:on-triaged"]);
  });

  test("is the workspace alone for the workspace, and null for what the page doesn't hold", () => {
    expect(path(triage, "workspace")).toEqual(["workspace:workspace"]);
    for (const text of ["page:other", "page:page-triage/node:ghost", "page:page-triage/attachment:ghost"]) {
      expect(canvasTargetPath(triage, parseCanvasTarget(text)!), text).toBeNull();
    }
  });

  test("carries each step's own node, so a step is never another's", () => {
    const steps = canvasTargetPath(triage, parseCanvasTarget("page:page-triage/node:board-1")!)!;
    expect(steps.map(step => step.kind === "object" || step.kind === "widget" ? step.node.id : step.kind === "page" ? step.page.id : step.kind))
      .toEqual(["workspace", "page-triage", "group-1", "board-1"]);
  });
});

describe("section-based canvases", () => {
  test.each(sectionMapping)("$name maps with its references and layout intact", ({ sections, page }) => {
    const before = parseCanvasDefinition(sections);
    const after = parseCanvasPage(page);
    expect(after.id).toBe(before.id);
    expect(after.revision).toBe(before.revision);
    expect(asSections(after)).toEqual(before);
    const references = (definition: CanvasDefinition) => definition.sections.flatMap(section => section.widgets.map(widget => [widget.id, widget.targetRef]));
    expect(after.nodes.flatMap(node => node.nodeType === "widget" ? [[node.id, node.targetRef]] : []).toSorted()).toEqual(references(before).toSorted());
  });

  test.each(sectionMapping)("$name converts both ways, and converting again changes nothing", ({ sections, page }) => {
    expect(canvasPageFromDefinition(sections)).toEqual(parseCanvasPage(page));
    expect(canvasPageFromDefinition(sections)).toEqual(canvasPageFromDefinition(sections));
    expect(canvasDefinitionFromPage(parseCanvasPage(page))).toEqual(parseCanvasDefinition(sections));
  });

  test("a page version 1 can't hold has no version 1 form", () => {
    for (const entry of valid.slice(1)) expect(canvasDefinitionFromPage(parseCanvasPage(entry.page)), entry.name).toBeNull();
    expect(canvasDefinitionFromPage(parseCanvasPage(valid[0].page))).not.toBeNull();
  });

  test("a page with more sections than version 1 allows has no version 1 form", () => {
    const sections = Array.from({ length: 13 }, (_, index) => ({ nodeType: "object", id: `s${index}`, title: "S", columns: 1, children: [], attachments: [] }));
    expect(canvasDefinitionFromPage(parseCanvasPage({ schemaVersion: 2, id: "p", revision: "0", title: "P", attachments: [],
      children: sections.map(section => section.id), nodes: sections }))).toBeNull();
  });

  test("an invalid definition doesn't convert", () => {
    expect(() => canvasPageFromDefinition({ schemaVersion: 1, id: "p", revision: "0", title: "P", sections: [{}] })).toThrow("Invalid canvas");
  });

  test("a version 1 reader refuses a nested page rather than guessing", () => {
    expect(() => parseCanvasDefinition(sectionMapping[0].page)).toThrow("Invalid canvas");
  });

  test("this contract refuses a version 1 definition rather than guessing", () => {
    expect(rejection(() => parseCanvasPage(sectionMapping[0].sections))).toEqual({ code: "unknown-version", at: "page" });
  });
});
