import { applyCanvasOperations, CanvasConflictError, parseCanvasDefinition, type CanvasContent, type CanvasDefinition, type CanvasOperation } from "@gadgets/workshop-shared/canvas";
import { canvasDefinitionFromPage, canvasPageFromDefinition, parseCanvasPage, parseCanvasWorkspacePages, type CanvasPage } from "@gadgets/workshop-shared/canvas-model";
import { readCanvasCatalog } from "./canvas-catalog";
import type { OverseerStorage } from "./overseer";

/**
 * A page version 1 can't hold, beside its untouched `canvases` row. `basedOnRevision` is that row's
 * revision when this was saved: if the row has moved, code without pages edited it, and the row wins.
 */
export interface StoredCanvasPage {
  /** The nested page. */
  page: CanvasPage;
  /** The revision of the `canvases` row this page replaces while the two agree. */
  basedOnRevision: string;
}

/**
 * The page a `canvases` row currently stands for: its nested page while that page is based on the
 * row's revision, otherwise the row by conversion. What the store's page reads and a console
 * publication (FAC-89) both read. Reads never write.
 */
export function currentPage(storage: Pick<OverseerStorage, "canvasPages">, row: CanvasDefinition): CanvasPage {
  return nestedPage(storage, row) ?? canvasPageFromDefinition(row);
}

/** The nested page that currently replaces `row`, if any: one based on the row's revision. */
export function nestedPage(storage: Pick<OverseerStorage, "canvasPages">, row: Pick<CanvasDefinition, "id" | "revision">): CanvasPage | null {
  const stored = storage.canvasPages.get(row.id);
  return stored?.basedOnRevision === row.revision ? parseCanvasPage(stored.page) : null;
}

/**
 * Workspace-local composition persistence, reachable only through a build-capable Overseer session.
 *
 * `canvases` only ever holds version 1, because code before pages parses every row to list any of
 * them: one nested row there would blank the whole workspace after a rollback (ADR 0014).
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

  list(): CanvasDefinition[] {
    this.#requireEnabled();
    return Array.from(this.storage.canvases.list(), parseCanvasDefinition);
  }

  get(id: string): CanvasDefinition | null {
    this.#requireEnabled();
    const value = this.storage.canvases.get(id);
    return value ? parseCanvasDefinition(value) : null;
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
      const current = this.get(id);
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
      const current = this.get(id);
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
    return nestedPage(this.storage, row);
  }

  /** One page by ID: its nested page, or its version 1 row by conversion (see `currentPage`). Reads never write. */
  getPage(id: string): CanvasPage | null {
    const row = this.get(id);
    return row ? currentPage(this.storage, row) : null;
  }

  /** Every page of this workspace. Reads never write. */
  listPages(): CanvasPage[] {
    this.#requireEnabled();
    return Array.from(this.storage.canvases.list(), row => currentPage(this.storage, parseCanvasDefinition(row)));
  }

  /**
   * Save a page at a new revision. A page version 1 can hold goes in its `canvases` row, and any
   * other goes beside that row, leaving it as it was. The page must already exist. Nothing calls
   * this outside tests until readers understand nested pages (FAC-83).
   */
  savePage(value: unknown, expectedRevision: string): CanvasPage {
    this.#requireEnabled();
    const page = parseCanvasPage(value);
    return this.durableStorage.transactionSync(() => {
      const row = this.get(page.id);
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
      const definition = canvasDefinitionFromPage(updated);
      if (definition) {
        this.storage.canvases.put(definition);
        this.storage.canvasPages.delete(page.id);
      } else {
        this.storage.canvasPages.put({ page: updated, basedOnRevision: row.revision });
      }
      return updated;
    });
  }
}
