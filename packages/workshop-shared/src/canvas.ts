/** Registered, renderer-owned project board. A target reference never grants resource access. */
export interface CanvasProjectBoardWidget {
  /** Stable instance ID, unique across this definition. */
  id: string;
  /** Registered InferOps board kind; arbitrary renderers are rejected. */
  kind: "inferops.project-board";
  /** Widget parameter schema version. */
  version: 1;
  /** Canonical InferOps project board reference, resolved through a separately granted capability. */
  targetRef: string;
  /** Curated column span; the renderer clamps it to the section's column count. */
  size: "normal" | "wide" | "full";
  /** Presentation filters, never authorization constraints. */
  params: {
    /** Workflow whose cards are displayed. */
    workflow: "software" | "content";
    /** Whether completed/cancelled cards remain visible. */
    showCompleted: boolean;
  };
}

/**
 * A gadget in the workspace that owns the canvas, rendered in the existing sandboxed gadget host.
 * The reference is workspace-local and resolved only through that workspace's already-authorized
 * session; it grants nothing on its own and is meaningless in another workspace.
 */
export interface CanvasGadgetWidget {
  /** Stable instance ID, unique across this definition. */
  id: string;
  /** Registered gadget kind; the gadget's own sandboxed UI bundle is the only renderer. */
  kind: "inferos.gadget";
  /** Widget parameter schema version. */
  version: 1;
  /** `gadget:<workpieceId>` within the owning workspace. */
  targetRef: string;
  /** Curated column span; the renderer clamps it to the section's column count. */
  size: "normal" | "wide" | "full";
  /**
   * No parameters are defined for v1. The parser rejects any key; the type stays an empty object
   * literal because RPC validation cannot express `never`-valued records.
   */
  params: {};
}

/** Registered widget instance; unknown kinds and versions are rejected. */
export type CanvasWidget = CanvasProjectBoardWidget | CanvasGadgetWidget;

/** A registered widget kind name. */
export type CanvasWidgetKind = CanvasWidget["kind"];

/** Every registered widget kind, in display order. */
export const CANVAS_WIDGET_KINDS: readonly CanvasWidgetKind[] = ["inferops.project-board", "inferos.gadget"];

/** Workspace-local gadget reference syntax accepted by `inferos.gadget` widgets. */
export const CANVAS_GADGET_REF = /^gadget:(0|[1-9][0-9]{0,15})$/;

/** Ordered group of widgets with a curated responsive column count. */
export interface CanvasSection {
  /** Stable section ID, unique across this definition. */
  id: string;
  /** Plain-text heading, at most 120 characters. */
  title: string;
  /** Maximum desktop columns; narrower renderers may collapse to one column. */
  columns: 1 | 2 | 3;
  /** Ordered widget instances; no pixel positioning or executable styling. */
  widgets: CanvasWidget[];
}

/** Portable composition content. It contains references, not credentials, ownership or domain rows. */
export interface CanvasContent {
  /** Plain-text view title, at most 120 characters. */
  title: string;
  /** At most 12 sections and 48 widgets in total. These are structural limits, not performance claims. */
  sections: CanvasSection[];
}

/** Versioned composition snapshot. Storage must separately authorize its owning workspace and resources. */
export interface CanvasDefinition extends CanvasContent {
  /** Definition schema version. Unknown versions require an explicit migration. */
  schemaVersion: 1;
  /** Stable view ID. Must not change when editing or restoring content. */
  id: string;
  /** Canonical decimal composition revision; unrelated to InferOps row revisions. */
  revision: string;
}

/** Atomic composition operation. Indices refer to the destination after removing the moved item. */
export type CanvasOperation =
  /** Change the view's plain-text title. */
  | { type: "rename"; title: string }
  /** Insert a validated section at the supplied zero-based position. */
  | { type: "addSection"; index: number; section: CanvasSection }
  /** Remove a section and its widget references, never underlying data. */
  | { type: "removeSection"; sectionId: string }
  /** Reorder a section. */
  | { type: "moveSection"; sectionId: string; index: number }
  /** Change a section heading and curated column count. */
  | { type: "configureSection"; sectionId: string; title: string; columns: 1 | 2 | 3 }
  /** Insert a registered widget into a section. */
  | { type: "addWidget"; sectionId: string; index: number; widget: CanvasWidget }
  /** Remove only the named widget instance. */
  | { type: "removeWidget"; widgetId: string }
  /** Move a widget within or between sections. */
  | { type: "moveWidget"; widgetId: string; sectionId: string; index: number }
  /** Replace parameters/reference/size while retaining the existing instance ID. */
  | { type: "configureWidget"; widget: CanvasWidget }
  /** Restore a prior validated composition at a new revision; never undo domain transactions. */
  | { type: "restore"; content: CanvasContent };

/** A caller edited an obsolete snapshot; reload/rebase rather than silently overwriting it. */
export class CanvasConflictError extends Error {
  /** Authoritative revision of the snapshot supplied to the operation engine. */
  readonly currentRevision: string;
  /** Construct a conflict without including any widget data in the message. */
  constructor(currentRevision: string) {
    super("Canvas changed; reload before applying this edit");
    this.name = "CanvasConflictError";
    this.currentRevision = currentRevision;
  }
}

const invalid = (field: string): never => { throw new Error(`Invalid canvas ${field}`); };
const record = (value: unknown, keys: string[], field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field);
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid(field);
  return result;
};
const id = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) ? value : invalid("ID");
const title = (value: unknown): string => typeof value === "string" && value.trim().length > 0 && value.length <= 120 ? value.trim() : invalid("title");
const revision = (value: unknown): string => typeof value === "string" && /^(0|[1-9][0-9]{0,63})$/.test(value) ? value : invalid("revision");
const columns = (value: unknown): 1 | 2 | 3 => value === 1 || value === 2 || value === 3 ? value : invalid("columns");
const position = (value: unknown, length: number): number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= length ? value : invalid("position");

function widget(value: unknown): CanvasWidget {
  const w = record(value, ["id", "kind", "version", "targetRef", "size", "params"], "widget");
  if (w.version !== 1) return invalid("widget kind/version");
  if (w.size !== "normal" && w.size !== "wide" && w.size !== "full") return invalid("widget size");
  if (typeof w.targetRef !== "string" || w.targetRef.length > 512) return invalid("target reference");
  if (w.kind === "inferos.gadget") {
    if (!CANVAS_GADGET_REF.test(w.targetRef)) return invalid("target reference");
    record(w.params, [], "widget parameters");
    return { id: id(w.id), kind: w.kind, version: w.version, targetRef: w.targetRef, size: w.size, params: {} };
  }
  if (w.kind !== "inferops.project-board") return invalid("widget kind/version");
  if (!/^inferops:\/\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/project\/board\/[A-Za-z0-9_-]+$/.test(w.targetRef)) return invalid("target reference");
  const params = record(w.params, ["workflow", "showCompleted"], "widget parameters");
  if (params.workflow !== "software" && params.workflow !== "content") return invalid("workflow");
  if (typeof params.showCompleted !== "boolean") return invalid("completed filter");
  return { id: id(w.id), kind: w.kind, version: w.version, targetRef: w.targetRef, size: w.size,
    params: { workflow: params.workflow, showCompleted: params.showCompleted } };
}

function section(value: unknown): CanvasSection {
  const s = record(value, ["id", "title", "columns", "widgets"], "section");
  if (!Array.isArray(s.widgets) || s.widgets.length > 48) return invalid("widgets");
  return { id: id(s.id), title: title(s.title), columns: columns(s.columns), widgets: s.widgets.map(widget) };
}

function content(value: unknown): CanvasContent {
  const c = record(value, ["title", "sections"], "content");
  if (!Array.isArray(c.sections) || c.sections.length > 12) return invalid("sections");
  const sections = c.sections.map(section);
  if (sections.reduce((sum, item) => sum + item.widgets.length, 0) > 48) return invalid("widget count");
  return { title: title(c.title), sections };
}

/** Validate and detach a snapshot; rejects unknown fields, kinds, schema versions and duplicate IDs. */
export function parseCanvasDefinition(value: unknown): CanvasDefinition {
  const d = record(value, ["schemaVersion", "id", "revision", "title", "sections"], "definition");
  if (d.schemaVersion !== 1) return invalid("schema version");
  const parsed = content({ title: d.title, sections: d.sections });
  const ids = new Set<string>([id(d.id)]);
  for (const entry of parsed.sections) {
    for (const item of [entry, ...entry.widgets]) {
      if (ids.has(item.id)) return invalid("duplicate ID");
      ids.add(item.id);
    }
  }
  return { schemaVersion: 1, id: id(d.id), revision: revision(d.revision), ...parsed };
}

/**
 * Preview/apply up to 32 edits atomically to a detached snapshot, advancing one revision per batch.
 * This function performs no I/O or authorization. A storage caller must check installation flags,
 * workspace edit authority and resource bindings, then compare/persist in the same transaction.
 *
 * When `allowedKinds` is given, every widget an operation adds, reconfigures or restores must be
 * of one of those kinds. Widgets already on the canvas are left alone, so narrowing the catalog
 * never strands an existing composition.
 */
export function applyCanvasOperations(current: unknown, expectedRevision: unknown, operations: unknown,
    allowedKinds?: readonly CanvasWidgetKind[]): CanvasDefinition {
  let result = parseCanvasDefinition(current);
  const allowed = (item: CanvasWidget): CanvasWidget => {
    if (allowedKinds && !allowedKinds.includes(item.kind)) throw new Error(`Widget kind ${item.kind} is not enabled for this installation`);
    return item;
  };
  if (revision(expectedRevision) !== result.revision) throw new CanvasConflictError(result.revision);
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 32) return invalid("operation batch");
  const findSection = (sectionId: unknown) => {
    const found = result.sections.find(s => s.id === id(sectionId));
    if (!found) return invalid("missing section");
    return found;
  };
  const findWidget = (widgetId: unknown) => {
    const key = id(widgetId);
    for (const parent of result.sections) {
      const index = parent.widgets.findIndex(w => w.id === key);
      if (index >= 0) return { parent, index };
    }
    return invalid("missing widget");
  };
  for (const input of operations) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("operation");
    const type = (input as Record<string, unknown>).type;
    switch (type) {
      case "rename": {
        const op = record(input, ["type", "title"], "rename"); result.title = title(op.title); break;
      }
      case "addSection": {
        const op = record(input, ["type", "index", "section"], "add section");
        const added = section(op.section);
        added.widgets.forEach(allowed);
        result.sections.splice(position(op.index, result.sections.length), 0, added); break;
      }
      case "removeSection": case "moveSection": {
        const op = record(input, type === "moveSection" ? ["type", "sectionId", "index"] : ["type", "sectionId"], "section edit");
        const selected = findSection(op.sectionId);
        result.sections.splice(result.sections.indexOf(selected), 1);
        if (type === "moveSection") result.sections.splice(position(op.index, result.sections.length), 0, selected);
        break;
      }
      case "configureSection": {
        const op = record(input, ["type", "sectionId", "title", "columns"], "configure section");
        const selected = findSection(op.sectionId); selected.title = title(op.title); selected.columns = columns(op.columns); break;
      }
      case "addWidget": {
        const op = record(input, ["type", "sectionId", "index", "widget"], "add widget");
        const selected = findSection(op.sectionId);
        selected.widgets.splice(position(op.index, selected.widgets.length), 0, allowed(widget(op.widget))); break;
      }
      case "removeWidget": case "moveWidget": {
        const op = record(input, type === "moveWidget" ? ["type", "widgetId", "sectionId", "index"] : ["type", "widgetId"], "widget edit");
        const { parent, index } = findWidget(op.widgetId);
        const [selected] = parent.widgets.splice(index, 1);
        if (type === "moveWidget") {
          const destination = findSection(op.sectionId);
          destination.widgets.splice(position(op.index, destination.widgets.length), 0, selected);
        }
        break;
      }
      case "configureWidget": {
        const op = record(input, ["type", "widget"], "configure widget");
        const selected = allowed(widget(op.widget));
        const { parent, index } = findWidget(selected.id); parent.widgets[index] = selected; break;
      }
      case "restore": {
        const op = record(input, ["type", "content"], "restore");
        const restored = content(op.content);
        const existing = new Set(result.sections.flatMap(entry => entry.widgets.map(item => item.id)));
        restored.sections.forEach(entry => entry.widgets.filter(item => !existing.has(item.id)).forEach(allowed));
        result = { ...result, ...restored }; break;
      }
      default: return invalid("operation type");
    }
    // Keep every intermediate composition valid, including limits and stable-ID uniqueness.
    result = parseCanvasDefinition(result);
  }
  return { ...result, revision: revision((BigInt(result.revision) + 1n).toString()) };
}

/** A blueprint the installation offers as a widget: instantiated as a gadget, placed as `inferos.gadget`. */
export interface CanvasCatalogBlueprint {
  /** Blueprint ID passed to gadget creation, e.g. `inferops.kanban`. */
  blueprintId: string;
  /** Short label shown in widget pickers, at most 120 characters. */
  label: string;
  /** One-line description shown in widget pickers and to the agent, at most 512 characters. */
  description: string;
}

/** A starting layout new canvases may be created from. Templates carry references, never gadget IDs. */
export interface CanvasScreenTemplate {
  /** Stable template ID, unique across the catalog. */
  id: string;
  /** Layout copied into a new canvas; it may contain only `inferops.project-board` widgets. */
  content: CanvasContent;
}

/**
 * What an installation offers for composition, configured by the deployment (never by a user or
 * agent). It narrows which widgets may be added; it grants no access to any resource.
 */
export interface CanvasCatalog {
  /** Widget kinds people and agents may add. */
  widgetKinds: CanvasWidgetKind[];
  /** Blueprints offered as widgets; meaningful only when `inferos.gadget` is enabled. */
  blueprints: CanvasCatalogBlueprint[];
  /** Screen templates, in display order. */
  screens: CanvasScreenTemplate[];
}

/** The catalog of an installation that configures none: every kind, no blueprints or templates. */
export const DEFAULT_CANVAS_CATALOG: CanvasCatalog = { widgetKinds: [...CANVAS_WIDGET_KINDS], blueprints: [], screens: [] };

const text = (value: unknown, max: number, field: string): string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : invalid(field);

/** Validate and detach a catalog; rejects unknown kinds, duplicate IDs and gadget references in templates. */
export function parseCanvasCatalog(value: unknown): CanvasCatalog {
  const c = record(value, ["widgetKinds", "blueprints", "screens"], "catalog");
  if (!Array.isArray(c.widgetKinds) || !Array.isArray(c.blueprints) || !Array.isArray(c.screens)) return invalid("catalog");
  if (c.blueprints.length > 32 || c.screens.length > 64) return invalid("catalog size");
  const requested: unknown[] = c.widgetKinds;
  const widgetKinds = CANVAS_WIDGET_KINDS.filter(kind => requested.includes(kind));
  if (widgetKinds.length !== new Set(requested).size) return invalid("widget kind");
  const blueprintIds = new Set<string>();
  const blueprints = c.blueprints.map((entry): CanvasCatalogBlueprint => {
    const b = record(entry, ["blueprintId", "label", "description"], "catalog blueprint");
    const blueprintId = text(b.blueprintId, 128, "blueprint ID");
    if (blueprintIds.has(blueprintId)) return invalid("duplicate blueprint");
    blueprintIds.add(blueprintId);
    return { blueprintId, label: text(b.label, 120, "blueprint label"), description: text(b.description, 512, "blueprint description") };
  });
  const screenIds = new Set<string>();
  const screens = c.screens.map((entry): CanvasScreenTemplate => {
    const t = record(entry, ["id", "content"], "screen template");
    const templateId = id(t.id);
    if (screenIds.has(templateId)) return invalid("duplicate screen template");
    screenIds.add(templateId);
    // Parse as a definition so stable IDs are checked for uniqueness exactly as on a saved canvas.
    const parsed = parseCanvasDefinition({ ...record(t.content, ["title", "sections"], "screen content"), schemaVersion: 1, id: templateId, revision: "0" });
    // Gadget IDs are workspace-local, so a template that names one would be meaningless elsewhere.
    if (parsed.sections.some(entry => entry.widgets.some(item => item.kind !== "inferops.project-board"))) {
      return invalid("screen template widget");
    }
    return { id: templateId, content: { title: parsed.title, sections: parsed.sections } };
  });
  return { widgetKinds, blueprints, screens };
}
