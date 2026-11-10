import type { WorkspaceSettings } from "@gadgets/workshop-shared/workspace-settings";
import { applyCanvasOperations, CanvasConflictError, parseCanvasDefinition, type CanvasContent, type CanvasDefinition, type CanvasOperation, type CanvasReadOptions } from "@gadgets/workshop-shared/canvas";
import { applyCanvasPageOperations, canvasDefinitionFromPage, canvasDefinitionProjection, canvasPageFromDefinition, parseCanvasPage, parseCanvasWorkspacePages, type CanvasPage, type CanvasPageOperation } from "@gadgets/workshop-shared/canvas-model";
import { readCanvasCatalog } from "./canvas-catalog";
import type { OverseerStorage } from "./overseer";

/**
 * A page version 1 can't hold, beside its untouched `canvases` row. `basedOnRevision` is that row's
 * revision when this was saved: if the row has moved, code without pages edited it, and the row wins.
 */
export interface StoredCanvasPage {
  /** The nested page, without its settings (see `settings`). */
  page: CanvasPage;
  /** The revision of the `canvases` row this page replaces while the two agree. */
  basedOnRevision: string;
  /**
   * The page's settings overrides (FAC-95), kept beside the page rather than in it, so a reader
   * from before page settings, which refuses any page field it doesn't know, still reads the page
   * and leaves the overrides inert. Absent when the page overrides nothing.
   */
  settings?: WorkspaceSettings;
}

/**
 * A page split for storage (FAC-95 follow-up): the page as a reader before page settings takes
 * it, and its settings to keep beside it. `joinPageSettings` puts them back.
 */
export function splitPageSettings(page: CanvasPage): { page: CanvasPage; settings?: WorkspaceSettings } {
  const { settings, ...rest } = page;
  return settings ? { page: rest, settings } : { page: rest };
}

/**
 * A stored page with the settings kept beside it, parsed back into one page. With `tolerateNewer`
 * (reads only), a widget a newer InferOS stored reads as a placeholder (FAC-9).
 */
export function joinPageSettings(page: unknown, settings: WorkspaceSettings | undefined, options: CanvasReadOptions = {}): CanvasPage {
  return parseCanvasPage(settings ? { ...(page as object), settings } : page, options);
}

/** How every read of a saved canvas parses it: a newer InferOS's widget is an inert placeholder (FAC-9). */
export const CANVAS_READ: CanvasReadOptions = { tolerateNewer: true };

/**
 * `read` strictly, for a write. Where only a tolerant read succeeds, the canvas holds a newer
 * InferOS's widget, and the write is refused in those words rather than as a parse failure.
 */
export function readStrictly<T>(read: (options: CanvasReadOptions) => T): T {
  try {
    return read({});
  } catch (error) {
    try {
      read(CANVAS_READ);
    } catch {
      throw error;
    }
    throw new Error("This canvas holds a widget from a newer InferOS, so it can't be changed here", { cause: error });
  }
}

/**
 * One saved canvas as a version 1 reader sees it: its row, or, while a nested page replaces that row,
 * the page's projection (`canvasDefinitionProjection`). Every reader of `sections` goes through
 * this, so a nested save is never shown as the layout it replaced (FAC-83). The row is returned as
 * stored, unparsed, as the console store has always read it; the canvas store parses its own reads.
 * A console publication (FAC-89) reads the page itself (`currentPage`), never this projection.
 * `options` is how a nested page is parsed (see `CANVAS_READ`).
 */
export function readCanvasDefinition(storage: Pick<OverseerStorage, "canvases" | "canvasPages">, id: string, options: CanvasReadOptions = {}): CanvasDefinition | null {
  const row = storage.canvases.get(id);
  if (!row) return null;
  const nested = nestedPage(storage, row, options);
  return nested ? canvasDefinitionProjection(nested) : row;
}

/**
 * The page a `canvases` row currently stands for: its nested page while that page is based on the
 * row's revision, otherwise the row by conversion. What the store's page reads and a console
 * publication (FAC-89) both read. Reads never write. `options` is how it's parsed (see `CANVAS_READ`).
 */
export function currentPage(storage: Pick<OverseerStorage, "canvasPages">, row: CanvasDefinition, options: CanvasReadOptions = {}): CanvasPage {
  return nestedPage(storage, row, options) ?? canvasPageFromDefinition(row, options);
}

/** The nested page that currently replaces `row`, if any: one based on the row's revision. */
export function nestedPage(storage: Pick<OverseerStorage, "canvasPages">, row: Pick<CanvasDefinition, "id" | "revision">,
    options: CanvasReadOptions = {}): CanvasPage | null {
  const stored = storage.canvasPages.get(row.id);
  return stored?.basedOnRevision === row.revision ? joinPageSettings(stored.page, stored.settings, options) : null;
}

/**
 * Workspace-local composition persistence, reachable only through a build-capable Overseer session.
 *
 * `canvases` only ever holds version 1, because code before pages parses every row to list any of
 * them: one nested row there would blank the whole workspace after a rollback (ADR 0014).
 *
 * Reads are tolerant (FAC-9): a widget a newer InferOS stored reads as an inert placeholder, and a
 * listing leaves out a row it can't read rather than failing whole. Writes read strictly, so a
 * canvas holding a newer InferOS's widget can't be changed here.
 */
export class WorkspaceCanvasStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage, "canvases" | "canvasPages">,
      private env: Pick<Cloudflare.Env, "COMPOSABLE_VIEWS" | "DURABLE_VIEWS" | "CANVAS_CATALOG">) {}

  #requireEnabled(): void {
    if (this.env.COMPOSABLE_VIEWS !== "true" || this.env.DURABLE_VIEWS !== "true") {
      throw new Error("Durable views are disabled for this installation");
    }
  }

  /** Every canvas as a version 1 reader sees it (`readCanvasDefinition`), leaving out any it can't read. */
  list(): CanvasDefinition[] {
    this.#requireEnabled();
    return this.#readable(row => parseCanvasDefinition(readCanvasDefinition(this.storage, row.id, CANVAS_READ), CANVAS_READ));
  }

  /** One canvas as a version 1 reader sees it (`readCanvasDefinition`). */
  get(id: string): CanvasDefinition | null {
    this.#requireEnabled();
    const value = readCanvasDefinition(this.storage, id, CANVAS_READ);
    return value ? parseCanvasDefinition(value, CANVAS_READ) : null;
  }

  /** Each stored row read by `read`; one that can't be read is left out and logged, never failing the rest. */
  #readable<T>(read: (row: CanvasDefinition) => T): T[] {
    return Array.from(this.storage.canvases.list()).flatMap(row => {
      try {
        return [read(row)];
      } catch (error) {
        console.warn("canvas_unreadable", { id: typeof row?.id === "string" ? row.id.slice(0, 64) : null, reason: error instanceof Error ? error.message : String(error) });
        return [];
      }
    });
  }

  /** The stored version 1 row itself, which writers check revisions against. */
  #row(id: string): CanvasDefinition | null {
    const value = this.storage.canvases.get(id);
    return value ? readStrictly(options => parseCanvasDefinition(value, options)) : null;
  }

  create(content: CanvasContent): CanvasDefinition {
    this.#requireEnabled();
    // The identity belongs to this workspace; imports cannot resurrect a deleted ID or assert ownership.
    const value = parseCanvasDefinition({ ...content, schemaVersion: 1, id: crypto.randomUUID(), revision: "0" });
    // New content is held to the deployment catalog exactly as an edit adding the same widgets is.
    const { widgetKinds } = readCanvasCatalog(this.env);
    const disallowed = value.sections.flatMap(section => section.widgets).find(widget => !widgetKinds.includes(widget.kind));
    if (disallowed) throw new Error(`Widget kind ${disallowed.kind} is not enabled for this installation`);
    return this.durableStorage.transactionSync(() => {
      if (Array.from(this.storage.canvases.list({ limit: 64 })).length >= 64) throw new Error("Workspace canvas limit reached");
      this.storage.canvases.put(value);
      return value;
    });
  }

  edit(id: string, expectedRevision: string, operations: CanvasOperation[]): CanvasDefinition {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      const current = this.#row(id);
      if (!current) throw new Error("Canvas not found");
      if (this.#nestedPage(current)) throw new Error("This page has nested objects, which this editor can't change");
      const updated = applyCanvasOperations(current, expectedRevision, operations, readCanvasCatalog(this.env).widgetKinds);
      this.storage.canvases.put(updated);
      return updated;
    });
  }

  delete(id: string, expectedRevision: string): void {
    this.#requireEnabled();
    this.durableStorage.transactionSync(() => {
      const current = this.#row(id);
      if (!current) throw new Error("Canvas not found");
      const nested = this.#nestedPage(current);
      const revision = nested?.revision ?? current.revision;
      if (revision !== expectedRevision) throw new CanvasConflictError(revision);
      this.storage.canvases.delete(id);
      this.storage.canvasPages.delete(id);
    });
  }

  /** The nested page that currently replaces this row, if any. */
  #nestedPage(row: CanvasDefinition): CanvasPage | null {
    return readStrictly(options => nestedPage(this.storage, row, options));
  }

  /** One page by ID: its nested page, or its version 1 row by conversion (see `currentPage`). Reads never write. */
  getPage(id: string): CanvasPage | null {
    this.#requireEnabled();
    // The raw row: `get` shows a nested page's projection, whose revision is the page's.
    const value = this.storage.canvases.get(id);
    return value ? currentPage(this.storage, parseCanvasDefinition(value, CANVAS_READ), CANVAS_READ) : null;
  }

  /** Every page of this workspace, leaving out any it can't read. Reads never write. */
  listPages(): CanvasPage[] {
    this.#requireEnabled();
    return this.#readable(row => currentPage(this.storage, parseCanvasDefinition(row, CANVAS_READ), CANVAS_READ));
  }

  /**
   * Apply typed page operations at the expected revision and save the result (FAC-83). A stale
   * revision throws `CanvasConflictError` and writes nothing, so newer work is never overwritten.
   */
  editPage(id: string, expectedRevision: string, operations: CanvasPageOperation[]): CanvasPage {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      // Read strictly: a page holding a newer InferOS's widget can't be changed here.
      const row = this.#row(id);
      const current = row ? this.#nestedPage(row) ?? canvasPageFromDefinition(row) : null;
      if (!current) throw new Error("Canvas not found");
      if (current.revision !== expectedRevision) throw new CanvasConflictError(current.revision);
      return this.#save(applyCanvasPageOperations(current, operations), expectedRevision);
    });
  }

  /**
   * Save a page at a new revision. A page version 1 can hold goes in its `canvases` row, and any
   * other goes beside that row, leaving it as it was; version 1 readers see its projection
   * (`readCanvasDefinition`). The page must already exist.
   */
  savePage(value: unknown, expectedRevision: string): CanvasPage {
    this.#requireEnabled();
    const page = parseCanvasPage(value);
    return this.durableStorage.transactionSync(() => this.#save(page, expectedRevision));
  }

  /** The body of `savePage`, for a caller already inside a transaction. */
  #save(page: CanvasPage, expectedRevision: string): CanvasPage {
    const row = this.#row(page.id);
    if (!row) throw new Error("Canvas not found");
    const stored = this.storage.canvasPages.get(page.id);
    if (stored && stored.basedOnRevision !== row.revision) {
      throw new Error("This page was edited on an earlier version, and its nested copy is kept. Choose which to keep first");
    }
    const current = this.#nestedPage(row) ?? canvasPageFromDefinition(row);
    if (current.revision !== expectedRevision) throw new CanvasConflictError(current.revision);
    // An unchanged widget stays when the catalog narrows; a new one, or a new kind under its ID, is held to it.
    const existing = new Map(current.nodes.flatMap(node => node.nodeType === "widget" ? [[node.id, node.kind] as const] : []));
    const { widgetKinds } = readCanvasCatalog(this.env);
    const disallowed = page.nodes.find(node => node.nodeType === "widget" && existing.get(node.id) !== node.kind && !widgetKinds.includes(node.kind));
    if (disallowed?.nodeType === "widget") throw new Error(`Widget kind ${disallowed.kind} is not enabled for this installation`);
    const updated: CanvasPage = { ...page, revision: (BigInt(current.revision) + 1n).toString() };
    parseCanvasWorkspacePages([updated, ...this.listPages().filter(other => other.id !== page.id)]);
    // Refused unless version 1 readers can be shown it, so no saved page can break `list()`.
    canvasDefinitionProjection(updated);
    const definition = canvasDefinitionFromPage(updated);
    if (definition) {
      this.storage.canvases.put(definition);
      this.storage.canvasPages.delete(page.id);
    } else {
      this.storage.canvasPages.put({ ...splitPageSettings(updated), basedOnRevision: row.revision });
    }
    return updated;
  }
}
