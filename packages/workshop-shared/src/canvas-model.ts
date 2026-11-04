/**
 * The versioned nested canvas model (ADR 0014, proposed). Saved canvases stay `CanvasDefinition`,
 * and a page is read from one by conversion. Nothing renders or runs this model yet.
 *
 * Containment says only where a node sits and what is removed with it. Nothing passes along it:
 * no permission, setting or event reaches a parent or child unless an attachment names that target.
 * A reference identifies a target and an attachment grants nothing; both are checked at use, under
 * the acting person's or run's own authority.
 */
import { CANVAS_ID, CANVAS_REVISION, parseCanvasDefinition, parseCanvasWidget, type CanvasDefinition, type CanvasWidget, type CanvasWidgetKind } from "./canvas";

/** The schema version this module reads. `CanvasDefinition`, with sections, is version 1. */
export const CANVAS_MODEL_SCHEMA_VERSION = 2;

/** Structural limits per page, and pages per workspace. They bound validation work and aren't performance claims. */
export const CANVAS_MODEL_LIMITS = {
  /** Objects and widgets on one page. Holds version 1's largest canvas, 12 sections and 48 widgets. */
  nodes: 96,
  /** Widgets on one page, as in version 1. */
  widgets: 48,
  /** Direct children of one page or object. */
  children: 48,
  /** Attachments on one page, across all its nodes. */
  attachments: 64,
  /** Levels of objects below the page. */
  depth: 4,
  /** Pages in one workspace, the existing limit on saved canvases. */
  pages: 64,
} as const;

/** Events a widget emits about its own actions. Accepted isn't completed, and only the widget can say either. */
export const CANVAS_ACTION_EVENTS = ["action-accepted", "action-completed", "action-failed", "action-uncertain"] as const;

/**
 * Actions an attachment may request of each widget kind, as the widgets offer them today.
 * Naming one requests it; the widget's own approval path and the actor's authority still decide.
 */
export const CANVAS_WIDGET_ACTIONS: Readonly<Record<CanvasWidgetKind, readonly string[]>> = {
  "inferops.project-board": ["transition-issue", "create-issue", "update-issue"],
  "inferops.wiki": ["update-document", "update-section"],
  "inferos.gadget": [],
};

/** Raise a named event on one node, which hears it only through its own attachments. */
export interface CanvasRaiseEventEffect {
  /** Effect kind. */
  kind: "raise-event";
  /** The page, object or widget that receives the event. */
  target: string;
  /** Event name. A widget's own action events can't be raised, so completion can't be claimed. */
  event: string;
}

/** Navigate the person who triggered this to another named page of the workspace. */
export interface CanvasNavigateEffect {
  /** Effect kind. */
  kind: "navigate";
  /** Stable ID of the destination page. */
  page: string;
}

/** Request one of a widget's declared actions. It grants nothing and can be refused at use. */
export interface CanvasRequestActionEffect {
  /** Effect kind. */
  kind: "request-action";
  /** The widget whose action is requested. */
  target: string;
  /** An action `CANVAS_WIDGET_ACTIONS` lists for that widget's kind. */
  action: string;
}

/** What an attachment does. Unknown kinds are rejected. */
export type CanvasEffect = CanvasRaiseEventEffect | CanvasNavigateEffect | CanvasRequestActionEffect;

/** Behavior attached to one node: when that node has this event, run this effect. */
export interface CanvasAttachment {
  /** Stable ID, unique across the page. */
  id: string;
  /** Attachment schema version. */
  version: 1;
  /** Event on the owning node: a widget's action event, or one an attachment on this page raises. */
  on: string;
  /** The single effect it runs. */
  effect: CanvasEffect;
}

/** A nested group of children with a curated column count. A version 1 section is one of these. */
export interface CanvasObjectNode {
  /** Node type. */
  nodeType: "object";
  /** Stable ID, unique across the page. */
  id: string;
  /** Plain-text heading, at most 120 characters. */
  title: string;
  /** Maximum desktop columns for its children. */
  columns: 1 | 2 | 3;
  /** IDs of its direct children, in display order. */
  children: string[];
  /** Behavior attached to this object. */
  attachments: CanvasAttachment[];
}

/** A placed widget instance: a version 1 widget unchanged, plus its attachments. It has no children. */
export type CanvasWidgetNode = CanvasWidget & {
  /** Node type. */
  nodeType: "widget";
  /** Behavior attached to this instance. */
  attachments: CanvasAttachment[];
};

/** A node a page contains. */
export type CanvasNode = CanvasObjectNode | CanvasWidgetNode;

/**
 * One named page of a workspace: the unit of saving and of the revision check. Containment is a
 * table of nodes so that a cycle or a second parent is a rejected value, not an unrepresentable one.
 */
export interface CanvasPage {
  /** Schema version. Other versions need an explicit migration. */
  schemaVersion: typeof CANVAS_MODEL_SCHEMA_VERSION;
  /** Stable page ID, which also names it in the node and attachment ID space. */
  id: string;
  /** Canonical decimal revision; unrelated to InferOps row revisions. */
  revision: string;
  /** Plain-text page title, at most 120 characters. */
  title: string;
  /** IDs of its direct children, stacked in display order. */
  children: string[];
  /** Behavior attached to the page. */
  attachments: CanvasAttachment[];
  /** Every object and widget on the page. Array order means nothing; `children` carries the layout. */
  nodes: CanvasNode[];
}

/** Why a value was rejected. Each is stable, so a caller can act on it without reading a message. */
export type CanvasModelErrorCode =
  | "invalid-shape" | "invalid-id" | "unknown-version" | "unknown-node-type" | "invalid-widget"
  | "unknown-field" | "undefined-inheritance" | "authority-field" | "entity-copy"
  | "duplicate-id" | "limit-exceeded" | "missing-reference"
  | "containment-cycle" | "multiple-parents" | "orphan-node" | "invalid-nesting" | "nesting-too-deep"
  | "invalid-attachment" | "unknown-effect" | "invalid-target" | "unavailable-action"
  | "unknown-event" | "reserved-event" | "reference-cycle";

/** A rejected page. Its message and `at` hold only validated IDs and known field names, never submitted values. */
export class CanvasModelError extends Error {
  /** Why it was rejected. */
  readonly code: CanvasModelErrorCode;
  /** The ID or position rejected: `attachment-1`, `nodes[3]`, `section-1.grants`. */
  readonly at: string;
  /** Construct a rejection from a stable code and a validated location. */
  constructor(code: CanvasModelErrorCode, at: string) {
    super(`Invalid canvas model: ${code} at ${at}`);
    this.name = "CanvasModelError";
    this.code = code;
    this.at = at;
  }
}

const reject = (code: CanvasModelErrorCode, at: string): never => { throw new CanvasModelError(code, at); };

const INHERITANCE_FIELDS = new Set(["inherit", "inherits", "inheritFrom", "inherited", "extends", "override", "overrides",
  "propagate", "propagates", "propagation", "bubble", "bubbles", "capture", "cascade", "defaults"]);
const AUTHORITY_FIELDS = new Set(["permission", "permissions", "grant", "grants", "capability", "capabilities", "scope", "scopes",
  "role", "roles", "principal", "runAs", "credential", "credentials", "token", "apiKey", "secret", "owner", "ownership", "sharing", "authority"]);
const ENTITY_FIELDS = new Set(["board", "issue", "issues", "card", "cards", "row", "rows", "record", "records", "data", "entity", "entities", "snapshot"]);

/** Name what a disallowed field would have meant, so the rejection says more than "unknown". */
const refuseField = (key: string, at: string): never => {
  if (INHERITANCE_FIELDS.has(key)) return reject("undefined-inheritance", `${at}.${key}`);
  if (AUTHORITY_FIELDS.has(key)) return reject("authority-field", `${at}.${key}`);
  if (ENTITY_FIELDS.has(key)) return reject("entity-copy", `${at}.${key}`);
  return reject("unknown-field", at);
};

const fields = (value: unknown, allowed: readonly string[], at: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("invalid-shape", at);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!allowed.includes(key)) refuseField(key, at);
  if (allowed.some(key => !Object.hasOwn(result, key))) return reject("invalid-shape", at);
  return result;
};

const parseId = (value: unknown, at: string): string => typeof value === "string" && CANVAS_ID.test(value) ? value : reject("invalid-id", at);
const parseTitle = (value: unknown, at: string): string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 120 ? value.trim() : reject("invalid-shape", at);
const parseEvent = (value: unknown, at: string): string =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : reject("invalid-attachment", at);

const idList = (value: unknown, at: string): string[] => {
  if (!Array.isArray(value)) return reject("invalid-shape", at);
  if (value.length > CANVAS_MODEL_LIMITS.children) return reject("limit-exceeded", at);
  return value.map(child => parseId(child, at));
};

function parseEffect(value: unknown, at: string): CanvasEffect {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("invalid-attachment", at);
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "raise-event") {
    const e = fields(value, ["kind", "target", "event"], at);
    return { kind, target: parseId(e.target, at), event: parseEvent(e.event, at) };
  }
  if (kind === "navigate") {
    const e = fields(value, ["kind", "page"], at);
    return { kind, page: parseId(e.page, at) };
  }
  if (kind === "request-action") {
    const e = fields(value, ["kind", "target", "action"], at);
    return { kind, target: parseId(e.target, at), action: parseEvent(e.action, at) };
  }
  return reject("unknown-effect", at);
}

function parseAttachments(value: unknown, at: string): CanvasAttachment[] {
  if (!Array.isArray(value)) return reject("invalid-shape", at);
  if (value.length > CANVAS_MODEL_LIMITS.attachments) return reject("limit-exceeded", at);
  return value.map((entry, index) => {
    const position = `${at}.attachments[${index}]`;
    const id = parseId(entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : undefined, position);
    const a = fields(entry, ["id", "version", "on", "effect"], id);
    if (a.version !== 1) return reject("unknown-version", id);
    return { id, version: 1, on: parseEvent(a.on, id), effect: parseEffect(a.effect, id) };
  });
}

function parseNode(value: unknown, index: number): CanvasNode {
  const position = `nodes[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("invalid-shape", position);
  const raw = value as Record<string, unknown>;
  const id = parseId(raw.id, position);
  if (raw.nodeType === "object") {
    const o = fields(value, ["nodeType", "id", "title", "columns", "children", "attachments"], id);
    if (o.columns !== 1 && o.columns !== 2 && o.columns !== 3) return reject("invalid-shape", id);
    return { nodeType: "object", id, title: parseTitle(o.title, id), columns: o.columns, children: idList(o.children, id), attachments: parseAttachments(o.attachments, id) };
  }
  if (raw.nodeType !== "widget") return reject("unknown-node-type", id);
  if (Object.hasOwn(raw, "children")) return reject("invalid-nesting", id);
  const w = fields(value, ["nodeType", "id", "kind", "version", "targetRef", "size", "params", "attachments"], id);
  if (w.params && typeof w.params === "object") {
    for (const key of Object.keys(w.params)) {
      if (INHERITANCE_FIELDS.has(key) || AUTHORITY_FIELDS.has(key) || ENTITY_FIELDS.has(key)) refuseField(key, `${id}.params`);
    }
  }
  let widget: CanvasWidget;
  try {
    widget = parseCanvasWidget({ id, kind: w.kind, version: w.version, targetRef: w.targetRef, size: w.size, params: w.params });
  } catch {
    return reject("invalid-widget", id);
  }
  return { ...widget, nodeType: "widget", attachments: parseAttachments(w.attachments, id) };
}

/** Containment must be one tree under the page, within the depth limit. Cycles are named before anything they'd also break. */
function checkContainment(page: CanvasPage, byId: ReadonlyMap<string, CanvasNode>): void {
  const childrenOf = (id: string): readonly string[] => {
    if (id === page.id) return page.children;
    const node = byId.get(id);
    return node?.nodeType === "object" ? node.children : [];
  };
  for (const id of [page.id, ...byId.keys()]) {
    for (const child of childrenOf(id)) {
      if (child === page.id) return reject("invalid-nesting", id);
      if (!byId.has(child)) return reject("missing-reference", id);
    }
  }
  const finished = new Set<string>();
  const visit = (id: string, path: Set<string>): void => {
    path.add(id);
    for (const child of childrenOf(id)) {
      if (path.has(child)) return reject("containment-cycle", child);
      if (!finished.has(child)) visit(child, path);
    }
    path.delete(id);
    finished.add(id);
  };
  for (const id of [page.id, ...byId.keys()]) if (!finished.has(id)) visit(id, new Set());

  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    for (const child of childrenOf(id)) {
      if (seen.has(child)) return reject("multiple-parents", child);
      seen.add(child);
      if (byId.get(child)?.nodeType === "object" && depth + 1 > CANVAS_MODEL_LIMITS.depth) return reject("nesting-too-deep", child);
      walk(child, depth + 1);
    }
  };
  walk(page.id, 0);
  for (const id of byId.keys()) if (!seen.has(id)) return reject("orphan-node", id);
}

/** Every attachment must name a real target, a reachable event and an offered action, and effects can't feed themselves. */
function checkAttachments(page: CanvasPage, byId: ReadonlyMap<string, CanvasNode>): void {
  const owners: { id: string; node: CanvasNode | undefined; attachments: CanvasAttachment[] }[] =
    [{ id: page.id, node: undefined, attachments: page.attachments }, ...page.nodes.map(node => ({ id: node.id, node, attachments: node.attachments }))];
  const total = owners.reduce((sum, owner) => sum + owner.attachments.length, 0);
  if (total > CANVAS_MODEL_LIMITS.attachments) return reject("limit-exceeded", page.id);

  const ids = new Set<string>([page.id, ...byId.keys()]);
  const raised = new Set<string>();
  const edges = new Map<string, { to: string; attachment: string }[]>();
  const edge = (from: string, to: string, attachment: string) => { edges.set(from, [...edges.get(from) ?? [], { to, attachment }]); };
  const key = (node: string, event: string) => `${node}\n${event}`;
  const actionEvents: readonly string[] = CANVAS_ACTION_EVENTS;

  for (const owner of owners) {
    for (const attachment of owner.attachments) {
      if (ids.has(attachment.id)) return reject("duplicate-id", attachment.id);
      ids.add(attachment.id);
      const effect = attachment.effect;
      if (effect.kind === "navigate") continue;
      if (effect.target !== page.id && !byId.has(effect.target)) return reject("missing-reference", attachment.id);
      if (effect.kind === "raise-event") {
        if (actionEvents.includes(effect.event)) return reject("reserved-event", attachment.id);
        raised.add(key(effect.target, effect.event));
        edge(key(owner.id, attachment.on), key(effect.target, effect.event), attachment.id);
      } else {
        const target = byId.get(effect.target);
        if (target?.nodeType !== "widget") return reject("invalid-target", attachment.id);
        if (!CANVAS_WIDGET_ACTIONS[target.kind].includes(effect.action)) return reject("unavailable-action", attachment.id);
        // Requesting an action leads to that widget's action events, so a loop through them is a real loop.
        for (const event of actionEvents) edge(key(owner.id, attachment.on), key(effect.target, event), attachment.id);
      }
    }
  }
  for (const owner of owners) {
    const emits = owner.node?.nodeType === "widget" && CANVAS_WIDGET_ACTIONS[owner.node.kind].length > 0;
    for (const attachment of owner.attachments) {
      const declared = emits && actionEvents.includes(attachment.on);
      if (!declared && !raised.has(key(owner.id, attachment.on))) return reject("unknown-event", attachment.id);
    }
  }
  const finished = new Set<string>();
  const visit = (from: string, path: Set<string>): void => {
    path.add(from);
    for (const { to, attachment } of edges.get(from) ?? []) {
      if (path.has(to)) return reject("reference-cycle", attachment);
      if (!finished.has(to)) visit(to, path);
    }
    path.delete(from);
    finished.add(from);
  };
  for (const from of edges.keys()) if (!finished.has(from)) visit(from, new Set());
}

/**
 * Validate and detach one page. Throws `CanvasModelError`. This takes no viewer and performs no I/O:
 * accepting a page says its shape is sound, and says nothing about who may see a target it names.
 */
export function parseCanvasPage(value: unknown): CanvasPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("invalid-shape", "page");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== CANVAS_MODEL_SCHEMA_VERSION) return reject("unknown-version", "page");
  const id = parseId(raw.id, "page");
  const p = fields(value, ["schemaVersion", "id", "revision", "title", "children", "attachments", "nodes"], id);
  if (typeof p.revision !== "string" || !CANVAS_REVISION.test(p.revision)) return reject("invalid-shape", id);
  if (!Array.isArray(p.nodes)) return reject("invalid-shape", id);
  if (p.nodes.length > CANVAS_MODEL_LIMITS.nodes) return reject("limit-exceeded", id);
  const nodes = p.nodes.map(parseNode);
  const byId = new Map<string, CanvasNode>();
  for (const node of nodes) {
    if (node.id === id || byId.has(node.id)) return reject("duplicate-id", node.id);
    byId.set(node.id, node);
  }
  if (nodes.filter(node => node.nodeType === "widget").length > CANVAS_MODEL_LIMITS.widgets) return reject("limit-exceeded", id);
  const page: CanvasPage = {
    schemaVersion: CANVAS_MODEL_SCHEMA_VERSION, id, revision: p.revision, title: parseTitle(p.title, id),
    children: idList(p.children, id), attachments: parseAttachments(p.attachments, id), nodes,
  };
  checkContainment(page, byId);
  checkAttachments(page, byId);
  return page;
}

/**
 * Validate a workspace's page collection: each page, unique page IDs and every navigation target.
 * Navigation may form loops, because moving between pages is how a person returns or retries, and
 * arriving on a page raises no event, so a navigation loop can't run by itself.
 */
export function parseCanvasWorkspacePages(value: unknown): CanvasPage[] {
  if (!Array.isArray(value)) return reject("invalid-shape", "pages");
  if (value.length > CANVAS_MODEL_LIMITS.pages) return reject("limit-exceeded", "pages");
  const pages = value.map(parseCanvasPage);
  const ids = new Set<string>();
  for (const page of pages) {
    if (ids.has(page.id)) return reject("duplicate-id", page.id);
    ids.add(page.id);
  }
  for (const page of pages) {
    for (const attachment of [...page.attachments, ...page.nodes.flatMap(node => node.attachments)]) {
      if (attachment.effect.kind === "navigate" && !ids.has(attachment.effect.page)) return reject("missing-reference", attachment.id);
    }
  }
  return pages;
}

/**
 * The page a version 1 definition maps to. Pure and deterministic, so converting twice or
 * concurrently gives the same IDs and one result. It keeps the revision, because conversion isn't
 * an edit, and throws without changing anything if the definition isn't valid.
 */
export function canvasPageFromDefinition(definition: unknown): CanvasPage {
  const { id, revision, title, sections } = parseCanvasDefinition(definition);
  return parseCanvasPage({
    schemaVersion: CANVAS_MODEL_SCHEMA_VERSION, id, revision, title, attachments: [],
    children: sections.map(section => section.id),
    nodes: sections.flatMap(section => [
      { nodeType: "object", id: section.id, title: section.title, columns: section.columns, attachments: [],
        children: section.widgets.map(widget => widget.id) },
      ...section.widgets.map(widget => ({ ...widget, nodeType: "widget", attachments: [] })),
    ]),
  });
}

/**
 * The version 1 definition that holds this page exactly, or null if version 1 can't: it has
 * attachments, nesting, a widget directly under the page, or more sections than version 1 allows.
 */
export function canvasDefinitionFromPage(page: CanvasPage): CanvasDefinition | null {
  if (page.attachments.length > 0 || page.children.length > 12) return null;
  const byId = new Map(page.nodes.map(node => [node.id, node]));
  const sections: CanvasDefinition["sections"] = [];
  for (const sectionId of page.children) {
    const section = byId.get(sectionId);
    if (section?.nodeType !== "object" || section.attachments.length > 0) return null;
    const widgets: CanvasWidget[] = [];
    for (const widgetId of section.children) {
      const node = byId.get(widgetId);
      if (node?.nodeType !== "widget" || node.attachments.length > 0) return null;
      const { nodeType: _nodeType, attachments: _attachments, ...widget } = node;
      widgets.push(widget);
    }
    sections.push({ id: section.id, title: section.title, columns: section.columns, widgets });
  }
  return parseCanvasDefinition({ schemaVersion: 1, id: page.id, revision: page.revision, title: page.title, sections });
}

/** An explicit edit target. It identifies what is selected within one workspace and authorizes nothing. */
export type CanvasTarget =
  | { kind: "workspace" }
  | { kind: "page"; pageId: string }
  | { kind: "node"; pageId: string; nodeId: string }
  | { kind: "attachment"; pageId: string; attachmentId: string };

/** Write a target as `workspace`, `page:<id>`, `page:<id>/node:<id>` or `page:<id>/attachment:<id>`. */
export function formatCanvasTarget(target: CanvasTarget): string {
  switch (target.kind) {
    case "workspace": return "workspace";
    case "page": return `page:${target.pageId}`;
    case "node": return `page:${target.pageId}/node:${target.nodeId}`;
    case "attachment": return `page:${target.pageId}/attachment:${target.attachmentId}`;
  }
}

/** Read a target's written form, or return null for anything else. */
export function parseCanvasTarget(value: unknown): CanvasTarget | null {
  if (value === "workspace") return { kind: "workspace" };
  if (typeof value !== "string") return null;
  const match = /^page:([^/]+)(?:\/(node|attachment):([^/]+))?$/.exec(value);
  if (!match || !CANVAS_ID.test(match[1]) || (match[3] !== undefined && !CANVAS_ID.test(match[3]))) return null;
  if (match[2] === "node") return { kind: "node", pageId: match[1], nodeId: match[3] };
  if (match[2] === "attachment") return { kind: "attachment", pageId: match[1], attachmentId: match[3] };
  return { kind: "page", pageId: match[1] };
}

/** What a target selects on a page, with the node that owns an attachment. */
export type CanvasResolvedTarget =
  | { kind: "page"; page: CanvasPage }
  | { kind: "object"; node: CanvasObjectNode }
  | { kind: "widget"; node: CanvasWidgetNode }
  | { kind: "attachment"; attachment: CanvasAttachment; ownerId: string };

/** Find a page-level target on this page, or return null when this page doesn't hold it. Authorizes nothing. */
export function resolveCanvasTarget(page: CanvasPage, target: CanvasTarget): CanvasResolvedTarget | null {
  if (target.kind === "workspace" || target.pageId !== page.id) return null;
  if (target.kind === "page") return { kind: "page", page };
  if (target.kind === "node") {
    const node = page.nodes.find(entry => entry.id === target.nodeId);
    if (!node) return null;
    return node.nodeType === "object" ? { kind: "object", node } : { kind: "widget", node };
  }
  for (const owner of [page, ...page.nodes]) {
    const attachment = owner.attachments.find(entry => entry.id === target.attachmentId);
    if (attachment) return { kind: "attachment", attachment, ownerId: owner.id };
  }
  return null;
}

/** One step of a target's path from the workspace down: what it is, and the target that selects it alone. */
export type CanvasTargetStep =
  | { kind: "workspace"; target: CanvasTarget }
  | { kind: "page"; target: CanvasTarget; page: CanvasPage }
  | { kind: "object"; target: CanvasTarget; node: CanvasObjectNode }
  | { kind: "widget"; target: CanvasTarget; node: CanvasWidgetNode }
  | { kind: "attachment"; target: CanvasTarget; attachment: CanvasAttachment };

/**
 * Where `target` sits on this page, for a breadcrumb: the workspace, the page, every object that
 * contains it, outermost first, then the target itself; an attachment follows the page or node that
 * holds it. Null when this page doesn't hold the target. Each step's target selects that step only.
 * Authorizes nothing.
 */
export function canvasTargetPath(page: CanvasPage, target: CanvasTarget): CanvasTargetStep[] | null {
  const workspace: CanvasTargetStep = { kind: "workspace", target: { kind: "workspace" } };
  if (target.kind === "workspace") return [workspace];
  const resolved = resolveCanvasTarget(page, target);
  if (!resolved) return null;
  const pageStep: CanvasTargetStep = { kind: "page", target: { kind: "page", pageId: page.id }, page };
  const byId = new Map(page.nodes.map(node => [node.id, node]));
  const parentOf = new Map<string, string>();
  for (const node of page.nodes) if (node.nodeType === "object") for (const child of node.children) parentOf.set(child, node.id);
  // Containment is acyclic and every node is reached once (parseCanvasPage checks both), so this ends.
  const nodeSteps = (id: string): CanvasTargetStep[] => {
    const steps: CanvasTargetStep[] = [];
    for (let at: string | undefined = id; at !== undefined; at = parentOf.get(at)) {
      const node = byId.get(at)!;
      const nodeTarget: CanvasTarget = { kind: "node", pageId: page.id, nodeId: node.id };
      steps.unshift(node.nodeType === "object" ? { kind: "object", target: nodeTarget, node } : { kind: "widget", target: nodeTarget, node });
    }
    return steps;
  };
  switch (resolved.kind) {
    case "page": return [workspace, pageStep];
    case "object": case "widget": return [workspace, pageStep, ...nodeSteps(resolved.node.id)];
    case "attachment": return [workspace, pageStep, ...(resolved.ownerId === page.id ? [] : nodeSteps(resolved.ownerId)),
      { kind: "attachment", target, attachment: resolved.attachment }];
  }
}

/** Direct children of a page, which are all objects: version 1's section limit, so every page projects to version 1. */
export const CANVAS_PAGE_TOP_OBJECTS = 12;

/**
 * One typed edit to a page (FAC-83). Each names its target by stable ID. None reads or writes
 * business data: removing a node removes only the reference on this page, never the record it names.
 */
export type CanvasPageOperation =
  /** Change the page's plain-text title. */
  | { type: "renamePage"; title: string }
  /** Insert an empty object under the page or an object, at a zero-based position. */
  | { type: "addObject"; parent: string; index: number; object: { id: string; title: string; columns: 1 | 2 | 3 } }
  /** Insert a widget instance under an object, at a zero-based position. */
  | { type: "addWidget"; parent: string; index: number; widget: CanvasWidget }
  /** Move a node, with what it contains, under another parent or to another position under the same one. */
  | { type: "moveNode"; nodeId: string; parent: string; index: number }
  /** Change an object's heading and column count. */
  | { type: "configureObject"; nodeId: string; title: string; columns: 1 | 2 | 3 }
  /** Replace a widget instance's parameters, reference or size, keeping its ID and attachments. */
  | { type: "configureWidget"; widget: CanvasWidget }
  /** Remove a node and everything it contains from the page. */
  | { type: "removeNode"; nodeId: string }
  /** Replace the attachments of the page or of one node. */
  | { type: "setAttachments"; target: string; attachments: CanvasAttachment[] };

const COLUMNS = (value: unknown, at: string): 1 | 2 | 3 =>
  value === 1 || value === 2 || value === 3 ? value : reject("invalid-shape", at);

/**
 * Apply page operations in order to a validated page and return the validated result, at the same
 * revision: the store checks the revision and moves it. Throws `CanvasModelError` and changes nothing
 * if any operation, or the page they produce, is invalid. A page's direct children must be objects,
 * at most `CANVAS_PAGE_TOP_OBJECTS`, so a version 1 reader can always be shown the page.
 */
export function applyCanvasPageOperations(current: CanvasPage, operations: unknown): CanvasPage {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 32) return reject("invalid-shape", "operations");
  const page = parseCanvasPage(current);
  let title = page.title;
  let pageChildren = [...page.children];
  let pageAttachments = page.attachments;
  const nodes = new Map<string, CanvasNode>(page.nodes.map(node => [node.id, node]));

  const childrenOf = (parent: string, at: string): string[] => {
    if (parent === page.id) return pageChildren;
    const node = nodes.get(parent);
    return node?.nodeType === "object" ? node.children : reject("invalid-target", at);
  };
  const setChildren = (parent: string, children: string[]) => {
    if (parent === page.id) pageChildren = children;
    else nodes.set(parent, { ...(nodes.get(parent) as CanvasObjectNode), children });
  };
  const insert = (parent: string, index: unknown, id: string, at: string) => {
    const children = childrenOf(parent, at);
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > children.length) return reject("invalid-shape", at);
    setChildren(parent, [...children.slice(0, index), id, ...children.slice(index)]);
  };
  const detach = (id: string) => {
    for (const parent of [page.id, ...nodes.keys()]) {
      const node = parent === page.id ? undefined : nodes.get(parent);
      if (parent !== page.id && node?.nodeType !== "object") continue;
      const children = childrenOf(parent, id);
      if (children.includes(id)) setChildren(parent, children.filter(child => child !== id));
    }
  };
  const fresh = (id: string, at: string): string => {
    const parsed = parseId(id, at);
    return parsed === page.id || nodes.has(parsed) ? reject("duplicate-id", parsed) : parsed;
  };
  const widgetOf = (value: unknown, at: string): CanvasWidget => {
    try {
      return parseCanvasWidget(value);
    } catch {
      return reject("invalid-widget", at);
    }
  };

  operations.forEach((raw, index) => {
    const at = `operations[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject("invalid-shape", at);
    const op = raw as Record<string, unknown>;
    switch (op.type) {
      case "renamePage":
        title = parseTitle(fields(op, ["type", "title"], at).title, at);
        return;
      case "addObject": {
        const o = fields(op, ["type", "parent", "index", "object"], at);
        const spec = fields(o.object, ["id", "title", "columns"], at);
        const id = fresh(spec.id as string, at);
        nodes.set(id, { nodeType: "object", id, title: parseTitle(spec.title, at), columns: COLUMNS(spec.columns, at), children: [], attachments: [] });
        return insert(parseId(o.parent, at), o.index, id, at);
      }
      case "addWidget": {
        const o = fields(op, ["type", "parent", "index", "widget"], at);
        const widget = widgetOf(o.widget, at);
        fresh(widget.id, at);
        const parent = parseId(o.parent, at);
        if (parent === page.id) return reject("invalid-nesting", at);
        nodes.set(widget.id, { ...widget, nodeType: "widget", attachments: [] });
        return insert(parent, o.index, widget.id, at);
      }
      case "moveNode": {
        const o = fields(op, ["type", "nodeId", "parent", "index"], at);
        const id = parseId(o.nodeId, at);
        if (!nodes.has(id)) return reject("missing-reference", at);
        const parent = parseId(o.parent, at);
        childrenOf(parent, at);
        detach(id);
        return insert(parent, o.index, id, at);
      }
      case "configureObject": {
        const o = fields(op, ["type", "nodeId", "title", "columns"], at);
        const node = nodes.get(parseId(o.nodeId, at));
        if (node?.nodeType !== "object") return reject("invalid-target", at);
        nodes.set(node.id, { ...node, title: parseTitle(o.title, at), columns: COLUMNS(o.columns, at) });
        return;
      }
      case "configureWidget": {
        const o = fields(op, ["type", "widget"], at);
        const widget = widgetOf(o.widget, at);
        const node = nodes.get(widget.id);
        if (node?.nodeType !== "widget") return reject("invalid-target", at);
        nodes.set(widget.id, { ...widget, nodeType: "widget", attachments: node.attachments });
        return;
      }
      case "removeNode": {
        const o = fields(op, ["type", "nodeId"], at);
        const id = parseId(o.nodeId, at);
        if (!nodes.has(id)) return reject("missing-reference", at);
        detach(id);
        const drop = (nodeId: string) => {
          const node = nodes.get(nodeId);
          nodes.delete(nodeId);
          if (node?.nodeType === "object") node.children.forEach(drop);
        };
        drop(id);
        return;
      }
      case "setAttachments": {
        const o = fields(op, ["type", "target", "attachments"], at);
        const target = parseId(o.target, at);
        const attachments = parseAttachments(o.attachments, at);
        if (target === page.id) pageAttachments = attachments;
        else {
          const node = nodes.get(target);
          if (!node) return reject("missing-reference", at);
          nodes.set(target, { ...node, attachments });
        }
        return;
      }
      default:
        return reject("invalid-shape", at);
    }
  });

  if (pageChildren.length > CANVAS_PAGE_TOP_OBJECTS) return reject("limit-exceeded", page.id);
  if (pageChildren.some(child => nodes.get(child)?.nodeType !== "object")) return reject("invalid-nesting", page.id);
  return parseCanvasPage({ ...page, title, children: pageChildren, attachments: pageAttachments, nodes: [...nodes.values()] });
}

/**
 * What a reader of version 1 sees of a page that version 1 can't hold exactly: each top-level object
 * as a section holding every widget beneath it, in tree order, under that object's heading and
 * columns. Widget IDs, kinds, references and revision are kept; nesting and attachments aren't shown.
 * Throws `CanvasModelError` if the page breaks the top-level rule `applyCanvasPageOperations` keeps.
 */
export function canvasDefinitionProjection(page: CanvasPage): CanvasDefinition {
  const exact = canvasDefinitionFromPage(page);
  if (exact) return exact;
  const byId = new Map(page.nodes.map(node => [node.id, node]));
  const widgetsUnder = (id: string): CanvasWidget[] => {
    const node = byId.get(id);
    if (node?.nodeType === "widget") {
      const { nodeType: _nodeType, attachments: _attachments, ...widget } = node;
      return [widget];
    }
    return node?.nodeType === "object" ? node.children.flatMap(widgetsUnder) : [];
  };
  if (page.children.length > CANVAS_PAGE_TOP_OBJECTS) return reject("limit-exceeded", page.id);
  const sections = page.children.map(id => {
    const node = byId.get(id);
    if (node?.nodeType !== "object") return reject("invalid-nesting", page.id);
    return { id: node.id, title: node.title, columns: node.columns, widgets: widgetsUnder(id) };
  });
  return parseCanvasDefinition({ schemaVersion: 1, id: page.id, revision: page.revision, title: page.title, sections });
}
