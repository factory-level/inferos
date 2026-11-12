// A person's temporary canvases (FAC-137): a set of widget placements their own Dot composed and
// they approved, held in their own operate session workspace, for the company they work in now. A
// temporary canvas expires at a time the server sets unless the person saves it; saving keeps it.
// Like a placement on their personal canvas (widget-placements.ts), a temporary canvas holds
// references only: never a business record, a copy of one, or a credential. It is never a shared
// page or published configuration, so composing, saving or expiring one asks for no shared
// configuration authority, and expiring one removes only the canvas: no record it shows, and no run
// started from one of its widgets, which lives in that widget's own workspace.

import {
  WIDGET_PLACEMENT_LIMITS,
  WidgetPlacementError,
  parseWidgetPlacementInput,
  type WidgetPlacement,
  type WidgetPlacementInput,
} from "./widget-placements.js";
import { isPlainLine } from "./widget-tools.js";

/** One temporary canvas, as its owner reads it. */
export type TemporaryCanvas = {
  /** Kernel-minted, stable for the canvas's life. */
  id: string;
  /** What the person, or the Dot that composed it, called it. */
  title: string;
  /** Its placements, in canvas order (row, then column), each with a kernel-minted id. */
  placements: WidgetPlacement[];
  /** The revision a change must name; raised by every change. */
  revision: number;
  /** When it was created. */
  createdAt: Date;
  /**
   * Present only while it is unsaved: when it stops being available, set by the server when the
   * canvas is created (`OPERATE_TEMPORARY_CANVAS_TTL_HOURS`). Saving removes it.
   */
  expiresAt?: Date;
};

/** A temporary canvas to create: its title and its placements, each without an id. */
export type TemporaryCanvasInput = {
  title: string;
  placements: Omit<WidgetPlacementInput, "placementId">[];
};

/** The limits on a person's temporary canvases. */
export const TEMPORARY_CANVAS_LIMITS = Object.freeze({
  /** Most temporary and saved canvases one operate session holds. */
  canvases: 16,
  /** Longest title, in characters. */
  title: 120,
  /** Most placements on one canvas: as many as a personal canvas holds. */
  placements: WIDGET_PLACEMENT_LIMITS.placements,
});

/**
 * How long an unsaved temporary canvas lasts by default (FAC-137), in hours: 24, a PROPOSED default
 * (inferops docs/human/architecture/workflows.md, Retention rules, selects no duration; inferops#2643
 * proposes this one). A deployment sets `OPERATE_TEMPORARY_CANVAS_TTL_HOURS` from
 * `MIN_TEMPORARY_CANVAS_TTL_HOURS` to `MAX_TEMPORARY_CANVAS_TTL_HOURS`.
 */
export const DEFAULT_TEMPORARY_CANVAS_TTL_HOURS = 24;

/** Shortest TTL a deployment may set for a temporary canvas, in hours. */
export const MIN_TEMPORARY_CANVAS_TTL_HOURS = 1;

/** Longest TTL a deployment may set for a temporary canvas, in hours (30 days). */
export const MAX_TEMPORARY_CANVAS_TTL_HOURS = 720;

/**
 * A temporary canvas's TTL in milliseconds from the deployment's `OPERATE_TEMPORARY_CANVAS_TTL_HOURS`:
 * the default when unset, else a whole number of hours in range. Anything else throws, naming the
 * setting, so a misconfigured deployment refuses to create temporary canvases rather than pick a
 * duration nobody chose (as `dynamicDefinitionTtlMs` does for workflow definitions, FAC-124).
 */
export function temporaryCanvasTtlMs(setting: string | undefined): number {
  if (setting === undefined) return DEFAULT_TEMPORARY_CANVAS_TTL_HOURS * 60 * 60 * 1000;
  let hours = /^\d+$/.test(setting) ? Number(setting) : Number.NaN;
  if (!(hours >= MIN_TEMPORARY_CANVAS_TTL_HOURS && hours <= MAX_TEMPORARY_CANVAS_TTL_HOURS)) {
    throw new Error(`OPERATE_TEMPORARY_CANVAS_TTL_HOURS must be a whole number of hours from ${MIN_TEMPORARY_CANVAS_TTL_HOURS} to ${MAX_TEMPORARY_CANVAS_TTL_HOURS}.`);
  }
  return hours * 60 * 60 * 1000;
}

/** Why a temporary canvas change was refused. */
export const TEMPORARY_CANVAS_ERROR_CODES = Object.freeze({
  /** Another change landed first: read the canvas again and retry. */
  conflict: "TEMPORARY_CANVAS_CONFLICT",
  /** No canvas has that id (it was removed, swept after expiring, or the company changed). */
  notFound: "TEMPORARY_CANVAS_NOT_FOUND",
  /** It expired before it was saved: it can't be saved or opened again. */
  expired: "TEMPORARY_CANVAS_EXPIRED",
  /** The operate session already holds the most canvases. */
  tooMany: "TEMPORARY_CANVASES_FULL",
  /** The canvas isn't well formed. */
  invalid: "TEMPORARY_CANVAS_INVALID",
  /** Temporary canvases live only in their owner's live operate session workspace. */
  unavailable: "TEMPORARY_CANVASES_UNAVAILABLE",
});

/** A refused temporary canvas change; its message starts with its code, which survives RPC. */
export class TemporaryCanvasError extends Error {
  /** One of `TEMPORARY_CANVAS_ERROR_CODES`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "TemporaryCanvasError";
    this.code = code;
  }
}

/** The refusal of saving or opening a temporary canvas past its expiry. */
export const TEMPORARY_CANVAS_EXPIRED = "This canvas expired before it was saved. Ask your Dot for it again.";

function invalid(message: string): never {
  throw new TemporaryCanvasError(TEMPORARY_CANVAS_ERROR_CODES.invalid, message);
}

/**
 * Checks a temporary canvas to create, from anyone: a non-empty title of at most
 * `TEMPORARY_CANVAS_LIMITS.title` characters on one line of plain text (`isPlainLine`), and from one to `TEMPORARY_CANVAS_LIMITS.placements`
 * placements, each checked as a personal placement is (`parseWidgetPlacementInput`) and naming no
 * id, which the kernel mints. Only these fields are read: nothing in it names a workspace to write
 * to, a console or a company.
 */
export function parseTemporaryCanvasInput(input: unknown): TemporaryCanvasInput {
  if (typeof input !== "object" || input === null) invalid("A temporary canvas has a title and placements.");
  let raw = input as Record<string, unknown>;
  if (typeof raw.title !== "string") invalid("A temporary canvas has a title.");
  let title = raw.title.trim();
  if (title.length === 0 || title.length > TEMPORARY_CANVAS_LIMITS.title) {
    invalid(`A temporary canvas's title is 1 to ${TEMPORARY_CANVAS_LIMITS.title} characters.`);
  }
  // One line of plain text (FAC-134): the kernel's own field names the canvas by it, and a line
  // break could add a line there in InferOS's voice. Refused, never flattened.
  if (!isPlainLine(title)) invalid("A temporary canvas's title is one line of plain text.");
  if (!Array.isArray(raw.placements) || raw.placements.length === 0 ||
      raw.placements.length > TEMPORARY_CANVAS_LIMITS.placements) {
    invalid(`A temporary canvas has 1 to ${TEMPORARY_CANVAS_LIMITS.placements} placements.`);
  }
  let placements = raw.placements.map((placement: unknown) => {
    let checked;
    try {
      checked = parseWidgetPlacementInput(placement);
    } catch (error) {
      if (error instanceof WidgetPlacementError) invalid(error.message);
      throw error;
    }
    if (checked.placementId !== undefined) invalid("A new canvas's placements name no id: the kernel mints them.");
    let { placementId: _none, ...rest } = checked;
    return rest;
  });
  return { title, placements };
}
