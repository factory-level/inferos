// A person's own widget placements on the Operate canvas (FAC-13): which widgets they placed, where
// and how large, and the filters each shows. Saved in the person's own user Durable Object beside
// their presentation state (FAC-88), so a placement survives a reload and another device, belongs
// to the company they work in now, and is dropped when that company changes. Scroll position and
// other transient UI stay in the browser.
//
// A placement holds references only: the console widget it shows, named as a Wiki embed names it,
// or a built-in widget's target. Never a business record, a copy of one, or a credential. Placing
// a widget grants nothing: it is opened through the same checked path as an embed, every time.

/** A published console's widget, named as `Overseer.listWidgetInstances` names it. */
export type ConsoleWidgetPlacementRef = {
  type: "console-widget";
  /** The InferOS workspace whose published console offers it. */
  workspaceId: string;
  consoleId: string;
  /** The registered gadget its frozen installs are made from, which a republish keeps. */
  sourceGadgetId: number;
  /** The definition the person placed, which a later publication may no longer run. */
  blueprintId: string;
  version: number;
};

/** A built-in widget kind (InferOps' widget registry), with the reference it shows. */
export type BuiltinWidgetPlacementRef = {
  type: "builtin";
  /** `<domain>/<widget>`, as InferOps' widget search names it (e.g. `project/board`). */
  kind: string;
  /** What it shows: an `inferops://` reference, which identifies a target and authorizes nothing. */
  target: string;
};

/** What a placement shows. */
export type WidgetPlacementRef = ConsoleWidgetPlacementRef | BuiltinWidgetPlacementRef;

/** Where a placement sits on the canvas grid: columns from 0, rows from 0, its width and height. */
export type WidgetPlacementLayout = { x: number; y: number; w: number; h: number };

/** One placed widget. */
export type WidgetPlacement = {
  /** Kernel-minted, stable for the placement's life; what a deep link names. */
  placementId: string;
  ref: WidgetPlacementRef;
  layout: WidgetPlacementLayout;
  /** This placement's own filter values, by name: the person's choices, never a record. */
  filters: Record<string, string>;
  /** When it was last saved, in ms since the epoch. */
  updatedAt: number;
};

/** A person's placements, ordered by row then column, and the revision a change must name. */
export type WidgetPlacements = { revision: number; placements: WidgetPlacement[] };

/** A placement to save: a new one without `placementId`, or a change to one with it. */
export type WidgetPlacementInput = {
  placementId?: string;
  ref: WidgetPlacementRef;
  layout: WidgetPlacementLayout;
  filters?: Record<string, string>;
};

/** The limits on a person's placements. */
export const WIDGET_PLACEMENT_LIMITS = Object.freeze({
  /** Most placements one person keeps, for the company they work in now. */
  placements: 64,
  /** Canvas grid columns; a placement fits within them. */
  columns: 12,
  /** Rows a placement may start at, from 0. */
  rows: 500,
  /** Tallest placement, in rows. */
  height: 24,
  /** Most filters on one placement. */
  filters: 16,
  /** Longest filter value. */
  filterValue: 256,
});

/** Why a placement change was refused. */
export const WIDGET_PLACEMENT_ERROR_CODES = Object.freeze({
  /** Another change landed first: read the placements again and retry. */
  conflict: "WIDGET_PLACEMENTS_CONFLICT",
  /** No placement has that id (it was removed, or the company changed). */
  notFound: "WIDGET_PLACEMENT_NOT_FOUND",
  /** The person already keeps the most placements. */
  tooMany: "WIDGET_PLACEMENTS_FULL",
  /** A change named another widget than the placement shows: remove it and place the other. */
  refChanged: "WIDGET_PLACEMENT_REF_CHANGED",
  /** The placement isn't well formed. */
  invalid: "WIDGET_PLACEMENT_INVALID",
});

/** A refused placement change; its message starts with its code, which survives RPC. */
export class WidgetPlacementError extends Error {
  /** One of `WIDGET_PLACEMENT_ERROR_CODES`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WidgetPlacementError";
    this.code = code;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KIND = /^[a-z0-9-]{1,64}\/[a-z0-9-]{1,64}$/;
const FILTER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** Names an object already has on its prototype: refused, so a filter never vanishes silently. */
const RESERVED_FILTER_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const TARGET = /^inferops:\/\/[\x21-\x7e]{1,500}$/;

function invalid(message: string): never {
  throw new WidgetPlacementError(WIDGET_PLACEMENT_ERROR_CODES.invalid, message);
}

function int(value: unknown, min: number, max: number, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(`${what} must be a whole number from ${min} to ${max}.`);
  }
  return value as number;
}

function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) invalid(`${what} isn't a valid id.`);
  return value;
}

/** Checks a placement's reference from a client: only the fields of its type are read. */
export function parseWidgetPlacementRef(ref: unknown): WidgetPlacementRef {
  if (typeof ref !== "object" || ref === null) invalid("A placement names the widget it shows.");
  let raw = ref as Record<string, unknown>;
  if (raw.type === "console-widget") {
    return {
      type: "console-widget", workspaceId: id(raw.workspaceId, "The workspace"), consoleId: id(raw.consoleId, "The console"),
      sourceGadgetId: int(raw.sourceGadgetId, 0, Number.MAX_SAFE_INTEGER, "The widget"),
      blueprintId: id(raw.blueprintId, "The definition"), version: int(raw.version, 1, Number.MAX_SAFE_INTEGER, "The version"),
    };
  }
  if (raw.type === "builtin") {
    if (typeof raw.kind !== "string" || !KIND.test(raw.kind)) invalid("A built-in widget is named by its kind.");
    if (typeof raw.target !== "string" || !TARGET.test(raw.target)) invalid("A built-in widget shows an inferops:// reference.");
    return { type: "builtin", kind: raw.kind, target: raw.target };
  }
  return invalid("A placement shows a console widget or a built-in one.");
}

/** Checks a layout: whole grid cells, within the canvas's columns. */
export function parseWidgetPlacementLayout(layout: unknown): WidgetPlacementLayout {
  if (typeof layout !== "object" || layout === null) invalid("A placement has a position and a size.");
  let { x, y, w, h } = layout as Record<string, unknown>;
  let { columns, rows, height } = WIDGET_PLACEMENT_LIMITS;
  let parsed = { x: int(x, 0, columns - 1, "x"), y: int(y, 0, rows - 1, "y"), w: int(w, 1, columns, "w"), h: int(h, 1, height, "h") };
  if (parsed.x + parsed.w > columns) invalid(`A placement fits within ${columns} columns.`);
  return parsed;
}

/** Checks a placement's filters: bounded names and values, strings only. */
export function parseWidgetPlacementFilters(filters: unknown): Record<string, string> {
  if (filters === undefined) return {};
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) invalid("Filters are named values.");
  let entries = Object.entries(filters as Record<string, unknown>);
  if (entries.length > WIDGET_PLACEMENT_LIMITS.filters) invalid(`A placement has at most ${WIDGET_PLACEMENT_LIMITS.filters} filters.`);
  let parsed: Record<string, string> = {};
  for (let [name, value] of entries) {
    if (!FILTER_NAME.test(name) || RESERVED_FILTER_NAMES.has(name)) invalid("A filter's name isn't valid.");
    if (typeof value !== "string" || value.length > WIDGET_PLACEMENT_LIMITS.filterValue) {
      invalid(`A filter's value is text of at most ${WIDGET_PLACEMENT_LIMITS.filterValue} characters.`);
    }
    parsed[name] = value;
  }
  return parsed;
}

/** Checks a placement to save from a client. */
export function parseWidgetPlacementInput(input: unknown): WidgetPlacementInput {
  if (typeof input !== "object" || input === null) invalid("Say what to place, and where.");
  let raw = input as Record<string, unknown>;
  let placementId = raw.placementId === undefined ? undefined : id(raw.placementId, "The placement");
  return {
    ...(placementId === undefined ? {} : { placementId }),
    ref: parseWidgetPlacementRef(raw.ref), layout: parseWidgetPlacementLayout(raw.layout),
    filters: parseWidgetPlacementFilters(raw.filters),
  };
}

/** Whether two references name the same widget. */
export function sameWidgetPlacementRef(a: WidgetPlacementRef, b: WidgetPlacementRef): boolean {
  if (a.type === "console-widget" && b.type === "console-widget") {
    return a.workspaceId === b.workspaceId && a.consoleId === b.consoleId && a.sourceGadgetId === b.sourceGadgetId &&
      a.blueprintId === b.blueprintId && a.version === b.version;
  }
  return a.type === "builtin" && b.type === "builtin" && a.kind === b.kind && a.target === b.target;
}

/** Placements in canvas order: by row, then column, then id. */
export function orderWidgetPlacements(placements: Iterable<WidgetPlacement>): WidgetPlacement[] {
  return [...placements].toSorted((a, b) =>
    a.layout.y - b.layout.y || a.layout.x - b.layout.x || a.placementId.localeCompare(b.placementId));
}
