/**
 * The versioned nested canvas model (ADR 0013, proposed). Nothing stores, renders or runs it yet:
 * saved canvases stay `CanvasDefinition` until the migration that wires this in.
 *
 * Containment says only where a node sits and what is removed with it. Nothing passes along it:
 * no permission, setting or event reaches a parent or child unless an attachment names that target.
 * A reference identifies a target and an attachment grants nothing; both are checked at use, under
 * the acting person's or run's own authority.
 */
import { CANVAS_ID, CANVAS_REVISION, parseCanvasWidget, type CanvasWidget, type CanvasWidgetKind } from "./canvas";

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
