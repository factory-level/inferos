import { describe, expect, test } from "vitest";
import { applyCanvasOperations, CANVAS_WIDGET_KINDS, parseCanvasDefinition, type CanvasDefinition, type CanvasWidget } from "./canvas";
import {
  CANVAS_RUN_EVENTS, canvasPageEffects, canvasRunEffects, canvasRunEvent, canvasRunEventsHeard, parseCanvasRunEvent,
  canvasWidgetEventsHeard,
  CANVAS_MODEL_LIMITS, CANVAS_WIDGET_ACTIONS, CanvasModelError, applyCanvasPageOperations, canvasDefinitionFromPage, canvasPageFromDefinition, canvasTargetPath, formatCanvasTarget, parseCanvasPage, parseCanvasTarget, parseCanvasWorkspacePages,
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

const canvasBoardAt = (page: CanvasPage) => page.nodes.find((node): node is Extract<CanvasNode, {nodeType: "widget"}> =>
  node.nodeType === "widget" && node.kind === "inferops.project-board")!;
const canvasAuthorityFields = (widget: CanvasNode) => JSON.stringify(Object.fromEntries(
  Object.entries(widget).filter(([key]) => ["permission", "permissions", "grant", "grants", "capability", "capabilities", "scope", "scopes", "role", "roles", "principal", "runAs", "credential", "credentials", "token", "apiKey", "secret", "owner", "ownership", "sharing", "authority"].includes(key)),
));

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

  test("adding, changing, or removing a read binding leaves the stored widget's authority unchanged", () => {
    const source = structuredClone(valid[2].page) as { nodes: Record<string, unknown>[] };
    const initial = parseCanvasPage(source);
    const initialBoard = canvasBoardAt(initial);
    const actionListBytes = JSON.stringify(CANVAS_WIDGET_ACTIONS[initialBoard.kind]);
    const initialAuthorityBytes = canvasAuthorityFields(initialBoard);
    expect(Object.keys(initialBoard.dataBinding ?? {}).toSorted()).toEqual(["ref", "resource", "schemaVersion"]);

    // Legacy input without a binding is normalized; changing a binding means changing its target
    // and matching typed reference together. In neither case does it add widget authority.
    const withoutBinding = structuredClone(source);
    delete withoutBinding.nodes.find(node => node.id === "board-1")!.dataBinding;
    const otherTarget = "inferops://acme.operations/project/board/OTHER";
    const changedBinding = structuredClone(source);
    const changed = changedBinding.nodes.find(node => node.id === "board-1")!;
    changed.targetRef = otherTarget;
    changed.dataBinding = { resource: "project/board", ref: otherTarget, schemaVersion: 1 };

    for (const input of [source, withoutBinding, changedBinding]) {
      const stored = canvasBoardAt(parseCanvasPage(input));
      expect(JSON.stringify(CANVAS_WIDGET_ACTIONS[stored.kind])).toBe(actionListBytes);
      expect(canvasAuthorityFields(stored)).toBe(initialAuthorityBytes);
    }
    expect(CANVAS_WIDGET_ACTIONS["inferos.gadget"]).toEqual([]);
  });

  test.each([
    ["a Wiki resource on a board widget", { resource: "knowledge/wiki", ref: "inferops://acme.operations/project/board/ENG", schemaVersion: 1 }, "incompatible-data-binding"],
    ["a reference different from targetRef", { resource: "project/board", ref: "inferops://other.operations/project/board/ENG", schemaVersion: 1 }, "invalid-data-binding"],
    ["an unsupported schema version", { resource: "project/board", ref: "inferops://acme.operations/project/board/ENG", schemaVersion: 2 }, "invalid-data-binding"],
    ["an authority field", { resource: "project/board", ref: "inferops://acme.operations/project/board/ENG", schemaVersion: 1, workflow: "invoke" }, "invalid-data-binding"],
    ["an action-capability field", { resource: "project/board", ref: "inferops://acme.operations/project/board/ENG", schemaVersion: 1, actionCapabilities: ["create-issue"] }, "invalid-data-binding"],
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

// FAC-94: a widget's own declared event (FAC-86 states) can drive a page effect through an explicit
// attachment; an event nothing is wired to stays local, and nothing propagates on its own.
describe("widget events drive page effects (FAC-94)", () => {
  const gadgetPage = (widgetAttachments: unknown[], objectAttachments: unknown[] = [], pageAttachments: unknown[] = []) => ({
    schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["a"], attachments: pageAttachments, nodes: [
      { nodeType: "object", id: "a", title: "A", columns: 1, children: ["g"], attachments: objectAttachments },
      { nodeType: "widget", id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:7", size: "normal", params: {},
        attachments: widgetAttachments },
    ],
  });

  test("a gadget widget's attachment may listen for its own declared event, checked at publish", () => {
    const page = parseCanvasPage(gadgetPage([{ id: "done", version: 1, on: "finish", effect: { kind: "navigate", page: "q" } }]));
    expect(canvasWidgetEventsHeard(page)).toEqual([{ nodeId: "g", targetRef: "gadget:7", event: "finish", attachmentId: "done" }]);
  });

  test("a gadget widget still can't listen for action events it never emits, and a board's unknown event is refused", () => {
    expect(rejection(() => parseCanvasPage(gadgetPage([{ id: "x", version: 1, on: "action-completed", effect: { kind: "navigate", page: "q" } }]))))
      .toEqual({ code: "unknown-event", at: "x" });
    const board = { schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["w"], attachments: [], nodes: [
      { nodeType: "widget", id: "w", kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG", size: "normal",
        params: { workflow: "software", showCompleted: false }, attachments: [{ id: "y", version: 1, on: "finish", effect: { kind: "navigate", page: "q" } }] },
    ] };
    expect(rejection(() => parseCanvasPage(board))).toEqual({ code: "unknown-event", at: "y" });
  });

  test("resolves a wired event to its page effects, following raised events, and an unwired one to none", () => {
    const page = parseCanvasPage(gadgetPage(
      [{ id: "up", version: 1, on: "finish", effect: { kind: "raise-event", target: "a", event: "section-done" } },
        { id: "now", version: 1, on: "fail", effect: { kind: "navigate", page: "help" } }],
      [{ id: "next", version: 1, on: "section-done", effect: { kind: "raise-event", target: "p", event: "all-done" } }],
      [{ id: "go", version: 1, on: "all-done", effect: { kind: "navigate", page: "q" } }],
    ));
    expect(canvasPageEffects(page, "gadget:7", "finish")).toEqual([{ kind: "navigate", page: "q" }]);
    expect(canvasPageEffects(page, "gadget:7", "fail")).toEqual([{ kind: "navigate", page: "help" }]);
    expect(canvasPageEffects(page, "gadget:7", "reset")).toEqual([]);
    expect(canvasPageEffects(page, "gadget:8", "finish")).toEqual([]);
  });

  test("still refuses a loop of raised events", () => {
    expect(rejection(() => parseCanvasPage(gadgetPage(
      [{ id: "up", version: 1, on: "finish", effect: { kind: "raise-event", target: "a", event: "ping" } }],
      [{ id: "back", version: 1, on: "ping", effect: { kind: "raise-event", target: "a", event: "ping" } }],
    )))).toEqual({ code: "reference-cycle", at: "back" });
  });
});

// FAC-98: a widget event may put a prompt in the person's own chat, as a draft only: nothing is
// sent, so a field asking for that (`submit`) is refused. The effect names no person, session,
// company or authority: its only target is the transitioning session's own chat.
describe("a prompt inserted into the person's chat (FAC-98)", () => {
  const promptPage = (effect: unknown) => ({
    schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["a"], attachments: [], nodes: [
      { nodeType: "object", id: "a", title: "A", columns: 1, children: ["g"], attachments: [] },
      { nodeType: "widget", id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:7", size: "normal", params: {},
        attachments: [{ id: "ask", version: 1, on: "finish", effect }] },
    ],
  });

  test("parses a draft, trimmed, and resolves the event to it", () => {
    const draft = parseCanvasPage(promptPage({ kind: "insert-prompt", text: "  Summarise this intake  " }));
    expect(canvasPageEffects(draft, "gadget:7", "finish")).toEqual([{ kind: "insert-prompt", text: "Summarise this intake" }]);
  });

  test.each([
    ["asking to send it", { kind: "insert-prompt", text: "x", submit: true }, { code: "unknown-field", at: "ask" }],
    ["submit false", { kind: "insert-prompt", text: "x", submit: false }, { code: "unknown-field", at: "ask" }],
    ["empty text", { kind: "insert-prompt", text: "   " }, { code: "invalid-attachment", at: "ask" }],
    ["text that isn't a string", { kind: "insert-prompt", text: 3 }, { code: "invalid-attachment", at: "ask" }],
    ["text over the limit", { kind: "insert-prompt", text: "x".repeat(CANVAS_MODEL_LIMITS.promptText + 1) }, { code: "invalid-attachment", at: "ask" }],
    ["no text", { kind: "insert-prompt" }, { code: "invalid-shape", at: "ask" }],
    ["a target person", { kind: "insert-prompt", text: "x", user: "someone" }, { code: "unknown-field", at: "ask" }],
    ["a target session", { kind: "insert-prompt", text: "x", target: "other" }, { code: "unknown-field", at: "ask" }],
    ["who it runs as", { kind: "insert-prompt", text: "x", runAs: "admin" }, { code: "authority-field", at: "ask.runAs" }],
    ["a grant", { kind: "insert-prompt", text: "x", grant: "project/write" }, { code: "authority-field", at: "ask.grant" }],
  ])("refuses %s", (_, effect, expected) => {
    expect(rejection(() => parseCanvasPage(promptPage(effect)))).toEqual(expected);
  });

  test("accepts text exactly at the limit", () => {
    const text = "x".repeat(CANVAS_MODEL_LIMITS.promptText);
    expect(canvasPageEffects(parseCanvasPage(promptPage({ kind: "insert-prompt", text })), "gadget:7", "finish")).toEqual([{ kind: "insert-prompt", text }]);
  });
});

// FAC-116: a run a person asked a trigger for can drive a page effect through an explicit attachment
// on the trigger's gadget widget, its event naming the trigger; nothing else raises or hears it.
describe("a requested run's result drives page effects (FAC-116)", () => {
  const runPage = (widgetAttachments: unknown[], objectAttachments: unknown[] = [], pageAttachments: unknown[] = []) => ({
    schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["a"], attachments: pageAttachments, nodes: [
      { nodeType: "object", id: "a", title: "A", columns: 1, children: ["g"], attachments: objectAttachments },
      { nodeType: "widget", id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:7", size: "normal", params: {},
        attachments: widgetAttachments },
    ],
  });
  const done = { id: "done", version: 1, on: canvasRunEvent("run-succeeded", 11), effect: { kind: "navigate", page: "q" } };

  test("names the trigger inside the event, and reads it back", () => {
    expect(done.on).toBe("run-result-succeeded-000000000000000000000011");
    expect(parseCanvasRunEvent(canvasRunEvent("run-uncertain", 42))).toEqual({ event: "run-uncertain", trigger: 42 });
    expect(parseCanvasRunEvent("finish")).toBeNull();
    // The earlier encoding is an ordinary widget event now, nothing reserved.
    expect(parseCanvasRunEvent("run-succeeded-11")).toBeNull();
    for (const on of ["run-result-succeeded", "run-result-failed-11",
      "run-result-done-000000000000000000000011", "run-result-uncertain-999999999999999999999999"]) {
      expect(parseCanvasRunEvent(on), on).toBe("malformed");
    }
  });

  test("hears a workspace's first trigger, hook 0", () => {
    const first = { ...done, on: canvasRunEvent("run-succeeded", 0) };
    expect(first.on).toBe("run-result-succeeded-000000000000000000000000");
    expect(parseCanvasRunEvent(first.on)).toEqual({ event: "run-succeeded", trigger: 0 });
    const page = parseCanvasPage(runPage([first]));
    expect(canvasRunEventsHeard(page)).toEqual([{ nodeId: "g", targetRef: "gadget:7", trigger: 0, event: "run-succeeded", attachmentId: "done" }]);
    expect(canvasRunEffects(page, 0, "run-succeeded")).toEqual([{ kind: "navigate", page: "q" }]);
  });

  test("a gadget widget's attachment may hear one trigger's run results, checked at publish", () => {
    const page = parseCanvasPage(runPage([done]));
    expect(page.nodes[1]!.attachments[0]).toEqual(done);
    expect(canvasRunEventsHeard(page)).toEqual([{ nodeId: "g", targetRef: "gadget:7", trigger: 11, event: "run-succeeded", attachmentId: "done" }]);
    // Not the widget's own declared event, so publication doesn't look for it in its states.
    expect(canvasWidgetEventsHeard(page)).toEqual([]);
  });

  test("is stored in exactly the fields an earlier reader accepts, so a rollback still reads the page", () => {
    // The reader before FAC-116 accepts an attachment with exactly these fields, its event matching
    // this pattern, and reads a gadget widget's event it can't know as the widget's own, which
    // publication then refuses as undeclared and nothing raises.
    const stored = JSON.parse(JSON.stringify(parseCanvasPage(runPage([done])))) as CanvasPage;
    const attachment = stored.nodes[1]!.attachments[0]!;
    expect(Object.keys(attachment).toSorted()).toEqual(["effect", "id", "on", "version"]);
    expect(attachment.on).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  });

  test("a run event names a well-formed trigger, only a gadget widget hears it, and nothing raises it", () => {
    const at = (on: string) => rejection(() => parseCanvasPage(runPage([{ ...done, on }])));
    for (const on of ["run-result-succeeded", "run-result-failed-11", "run-result-x"]) expect(at(on), on).toEqual({ code: "invalid-attachment", at: "done" });
    expect(rejection(() => parseCanvasPage(runPage([], [{ ...done, id: "o" }])))).toEqual({ code: "unknown-event", at: "o" });
    expect(rejection(() => parseCanvasPage(runPage([], [], [{ ...done, id: "pg" }])))).toEqual({ code: "unknown-event", at: "pg" });
    // Nobody can claim a run's result by raising it.
    expect(rejection(() => parseCanvasPage(runPage(
      [{ id: "fake", version: 1, on: "finish", effect: { kind: "raise-event", target: "g", event: canvasRunEvent("run-succeeded", 11) } }],
    )))).toEqual({ code: "reserved-event", at: "fake" });
  });

  test("resolves one trigger's run event to its page effects, following raised events, and nothing else to them", () => {
    const page = parseCanvasPage(runPage(
      [{ ...done, effect: { kind: "raise-event", target: "a", event: "refunds-done" } },
        { id: "failed", version: 1, on: canvasRunEvent("run-failed", 11), effect: { kind: "navigate", page: "help" } },
        { id: "other", version: 1, on: canvasRunEvent("run-succeeded", 12), effect: { kind: "navigate", page: "other" } }],
      [{ id: "next", version: 1, on: "refunds-done", effect: { kind: "navigate", page: "q" } }],
    ));
    expect(canvasRunEffects(page, 11, "run-succeeded")).toEqual([{ kind: "navigate", page: "q" }]);
    expect(canvasRunEffects(page, 11, "run-failed")).toEqual([{ kind: "navigate", page: "help" }]);
    expect(canvasRunEffects(page, 11, "run-uncertain")).toEqual([]);
    expect(canvasRunEffects(page, 12, "run-succeeded")).toEqual([{ kind: "navigate", page: "other" }]);
    expect(canvasRunEffects(page, 13, "run-succeeded")).toEqual([]);
    // A widget's own events never reach a run's attachments.
    expect(canvasPageEffects(page, "gadget:7", done.on)).toEqual([]);
  });

  test("a widget's own event never collides with a run event, either way", () => {
    // A gadget may declare the earlier encoding as its own event: it stays the widget's, and no run reaches it.
    const own = parseCanvasPage(runPage([{ id: "mine", version: 1, on: "run-succeeded-11", effect: { kind: "navigate", page: "q" } }]));
    expect(canvasWidgetEventsHeard(own)).toEqual([{ nodeId: "g", targetRef: "gadget:7", event: "run-succeeded-11", attachmentId: "mine" }]);
    expect(canvasRunEventsHeard(own)).toEqual([]);
    expect(canvasPageEffects(own, "gadget:7", "run-succeeded-11")).toEqual([{ kind: "navigate", page: "q" }]);
    expect(canvasRunEffects(own, 11, "run-succeeded")).toEqual([]);
    // And a run event is longer than any event a widget can declare (at most 40 characters).
    for (const event of CANVAS_RUN_EVENTS) for (const trigger of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(canvasRunEvent(event, trigger).length).toBeGreaterThan(40);
      expect(canvasRunEvent(event, trigger).length).toBeLessThanOrEqual(64);
    }
  });
});

// FAC-95: a page may override the workspace's settings, by registry key only (ADR 0017).
describe("a page's settings (FAC-95)", () => {
  const base = { schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["a"], attachments: [],
    nodes: [{ nodeType: "object", id: "a", title: "A", columns: 1, children: [], attachments: [] }] };

  test("are registry keys with their values, kept only when there are some", () => {
    expect(parseCanvasPage({ ...base, settings: { "baseUi.alerts": true } }).settings).toEqual({ "baseUi.alerts": true });
    expect(parseCanvasPage({ ...base, settings: {} })).not.toHaveProperty("settings");
    expect(parseCanvasPage(base)).not.toHaveProperty("settings");
  });

  test("refuse an unknown key or value as invalid-setting, and every other override field as before", () => {
    expect(rejection(() => parseCanvasPage({ ...base, settings: { "baseUi.modals": true } }))).toEqual({ code: "invalid-setting", at: "p.settings" });
    expect(rejection(() => parseCanvasPage({ ...base, settings: { "chatPane.widgets": "all" } }))).toEqual({ code: "invalid-setting", at: "p.settings" });
    expect(rejection(() => parseCanvasPage({ ...base, overrides: { "baseUi.alerts": true } }))).toMatchObject({ code: "undefined-inheritance" });
  });

  test("are replaced by one operation, and keep a page version 1 can't hold", () => {
    const page = parseCanvasPage(base);
    const set = applyCanvasPageOperations(page, [{ type: "setSettings", settings: { "chatPane.widgets": "none" } }]);
    expect(set.settings).toEqual({ "chatPane.widgets": "none" });
    expect(canvasDefinitionFromPage(set)).toBeNull();
    expect(canvasDefinitionFromPage(page)).not.toBeNull();
    expect(applyCanvasPageOperations(set, [{ type: "renamePage", title: "Q" }]).settings).toEqual({ "chatPane.widgets": "none" });
    expect(applyCanvasPageOperations(set, [{ type: "setSettings", settings: {} }])).not.toHaveProperty("settings");
    expect(rejection(() => applyCanvasPageOperations(page, [{ type: "setSettings", settings: { x: 1 } }])))
      .toEqual({ code: "invalid-setting", at: "operations[0]" });
  });
});

// FAC-9 rollback safety: a reader that meets a widget a newer InferOS stored shows it as an inert
// placeholder instead of refusing the whole view, but only where it reads; writes stay strict.
describe("a widget from a newer InferOS (FAC-9)", () => {
  const newer = { id: "n", kind: "inferos.future-widget", version: 1, targetRef: "future://thing/1", size: "wide",
    params: { anything: true }, dataBinding: { resource: "future/thing", ref: "future://thing/1", schemaVersion: 1 } };
  const v1 = (widget: Record<string, unknown>) => ({ schemaVersion: 1, id: "c", revision: "4", title: "C", sections: [{
    id: "s", title: "S", columns: 2, widgets: [
      widget,
      { id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:1", size: "normal", params: {} },
    ],
  }] });
  const placeholder = { id: "n", kind: "inferos.unsupported", version: 1, targetRef: "", size: "wide", params: {}, storedKind: "inferos.future-widget" };

  test("reads an unknown kind, or a known kind at an unknown version, as a placeholder, keeping its id and place", () => {
    expect(parseCanvasDefinition(v1(newer), { tolerateNewer: true }).sections[0]!.widgets).toEqual([placeholder,
      { id: "g", kind: "inferos.gadget", version: 1, targetRef: "gadget:1", size: "normal", params: {} }]);
    const nextVersion = { id: "n", kind: "inferops.wiki", version: 2, targetRef: "inferops://acme.k/knowledge/wiki", size: "full", params: { page: null, more: 1 } };
    expect(parseCanvasDefinition(v1(nextVersion), { tolerateNewer: true }).sections[0]!.widgets[0])
      .toEqual({ ...placeholder, size: "full", storedKind: "inferops.wiki" });
    // A write, or any strict read, still refuses it.
    expect(() => parseCanvasDefinition(v1(newer))).toThrow("Invalid canvas widget");
  });

  test("grants and offers nothing: no actions, never offered by the catalog, and never added by an edit", () => {
    expect(CANVAS_WIDGET_ACTIONS["inferos.unsupported"]).toEqual([]);
    expect(CANVAS_WIDGET_KINDS).not.toContain("inferos.unsupported");
    // The placeholder itself parses, so a reader can pass on what it read; it can't be written.
    expect(parseCanvasDefinition(v1(placeholder)).sections[0]!.widgets[0]).toEqual(placeholder);
    const current = parseCanvasDefinition(v1({ id: "b", kind: "inferos.gadget", version: 1, targetRef: "gadget:2", size: "normal", params: {} }));
    expect(() => applyCanvasOperations(current, "4", [{ type: "addWidget", sectionId: "s", index: 0, widget: { ...placeholder, id: "x" } }]))
      .toThrow("A widget from a newer InferOS can't be added or changed here.");
  });

  test("reads a nested page holding one: the placeholder hears and runs nothing, and the rest of the page reads", () => {
    const page = {
      schemaVersion: 2, id: "p", revision: "0", title: "P", children: ["a"], attachments: [], nodes: [
        { nodeType: "object", id: "a", title: "A", columns: 1, children: ["n", "b"], attachments: [
          { id: "ask", version: 1, on: "ping", effect: { kind: "request-action", target: "n", action: "do-future-thing" } },
        ] },
        { ...newer, nodeType: "widget", attachments: [{ id: "x", version: 1, on: "future-event", effect: { kind: "navigate", page: "q" } }] },
        { nodeType: "widget", id: "b", kind: "inferops.project-board", version: 1, targetRef: "inferops://acme.operations/project/board/ENG",
          size: "normal", params: { workflow: "software", showCompleted: false },
          attachments: [{ id: "up", version: 1, on: "action-completed", effect: { kind: "raise-event", target: "a", event: "ping" } }] },
      ],
    };
    const read = parseCanvasPage(page, { tolerateNewer: true });
    expect(read.nodes.find(node => node.id === "n")).toEqual({ ...placeholder, nodeType: "widget", attachments: [] });
    // An attachment that asks the placeholder for an action is dropped; everything else stays.
    expect(read.nodes.find(node => node.id === "a")!.attachments).toEqual([]);
    expect(read.nodes.find(node => node.id === "b")!.attachments.map(item => item.id)).toEqual(["up"]);
    expect(() => parseCanvasPage(page)).toThrow();
    // Converting a tolerantly read definition keeps the placeholder.
    expect(canvasPageFromDefinition(v1(newer), { tolerateNewer: true }).nodes.find(node => node.id === "n"))
      .toEqual({ ...placeholder, nodeType: "widget", attachments: [] });
  });
});
