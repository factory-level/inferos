import type { WorkspaceSettings } from "@gadgets/workshop-shared/workspace-settings";
import { applyCanvasOperations, CanvasConflictError, parseCanvasDefinition, type CanvasContent, type CanvasDefinition, type CanvasOperation } from "@gadgets/workshop-shared/canvas";
import { applyCanvasPageOperations, canvasDefinitionFromPage, canvasDefinitionProjection, canvasPageFromDefinition, parseCanvasPage, parseCanvasWorkspacePages, type CanvasAttachment, type CanvasPage, type CanvasPageOperation } from "@gadgets/workshop-shared/canvas-model";
import { readCanvasCatalog } from "./canvas-catalog";
import type { OverseerStorage } from "./overseer";

/**
 * A page version 1 can't hold, beside its untouched `canvases` row. `basedOnRevision` is that row's
 * revision when this was saved: if the row has moved, code without pages edited it, and the row wins.
 */
export interface StoredCanvasPage {
  /** The nested page, without its settings or prompts (see `settings` and `prompts`). */
  page: CanvasPage;
  /** The revision of the `canvases` row this page replaces while the two agree. */
  basedOnRevision: string;
  /**
   * The page's settings overrides (FAC-95), kept beside the page rather than in it, so a reader
   * from before page settings, which refuses any page field it doesn't know, still reads the page
   * and leaves the overrides inert. Absent when the page overrides nothing.
   */
  settings?: WorkspaceSettings;
  /**
   * The page's `insert-prompt` attachments (FAC-98), kept beside the page rather than in it, so a
   * reader from before that effect, which refuses an effect kind it doesn't know, still reads the
   * page and never fires them. Absent when the page has none.
   */
  prompts?: StoredPagePrompt[];
}

/**
 * One `insert-prompt` attachment kept beside its page (FAC-98): the page or node holding it
 * (`owner`, its id), its position among that owner's attachments, and the attachment itself.
 */
export interface StoredPagePrompt {
  /** The id of the page or node whose attachments held it. */
  owner: string;
  /** Its index in that owner's attachments, before any were taken out. */
  index: number;
  /** The attachment, as the page held it. */
  attachment: CanvasAttachment;
}

/** A page as storage keeps it: what an earlier reader parses, and what is kept beside it. */
export interface SplitStoredPage {
  /** The page without its settings or its prompts. */
  page: CanvasPage;
  /** Its settings overrides (FAC-95), when it has any. */
  settings?: WorkspaceSettings;
  /** Its `insert-prompt` attachments (FAC-98), when it has any. */
  prompts?: StoredPagePrompt[];
}

/**
 * A page split for storage, so a reader from before page settings (FAC-95 follow-up) or before
 * `insert-prompt` (FAC-98) still parses it and leaves what it doesn't know inert: the settings and
 * the prompt attachments go beside the page. `joinStoredPage` puts them back.
 */
export function splitStoredPage(page: CanvasPage): SplitStoredPage {
  const { settings, ...rest } = page;
  const prompts: StoredPagePrompt[] = [];
  const keep = (owner: string, attachments: CanvasAttachment[]) => attachments.filter((attachment, index) => {
    if (attachment.effect.kind !== "insert-prompt") return true;
    prompts.push({ owner, index, attachment });
    return false;
  });
  const stripped = { ...rest, attachments: keep(page.id, page.attachments),
    nodes: page.nodes.map(node => ({ ...node, attachments: keep(node.id, node.attachments) })) } as CanvasPage;
  return { page: stripped, ...(settings ? { settings } : {}), ...(prompts.length > 0 ? { prompts } : {}) };
}

/**
 * A stored page with its settings and prompts put back, parsed into one page. Each prompt returns
 * to its owner at its index; one whose owner the page no longer holds throws, as a corrupt record.
 */
export function joinStoredPage(page: unknown, settings: WorkspaceSettings | undefined, prompts?: readonly StoredPagePrompt[]): CanvasPage {
  let joined = settings ? { ...(page as object), settings } : page;
  if (prompts && prompts.length > 0) joined = withPrompts(joined as Record<string, unknown>, prompts);
  return parseCanvasPage(joined);
}

// `page` with each prompt back among its owner's attachments, in ascending index order so each lands
// where it was. The stored page is untrusted shape, so only what's there is copied.
function withPrompts(page: Record<string, unknown>, prompts: readonly StoredPagePrompt[]): Record<string, unknown> {
  const restore = (owner: unknown, attachments: unknown) => {
    const list = Array.isArray(attachments) ? [...attachments] : [];
    for (const prompt of prompts.filter(item => item.owner === owner).sort((a, b) => a.index - b.index)) {
      list.splice(prompt.index, 0, prompt.attachment);
    }
    return list;
  };
  const nodes = Array.isArray(page.nodes) ? page.nodes as Record<string, unknown>[] : [];
  const owners = new Set([page.id, ...nodes.map(node => node.id)]);
  const lost = prompts.find(prompt => !owners.has(prompt.owner));
  if (lost) throw new Error(`A stored prompt names ${lost.owner}, which its page doesn't hold`);
  return { ...page, attachments: restore(page.id, page.attachments),
    nodes: nodes.map(node => ({ ...node, attachments: restore(node.id, node.attachments) })) };
}

/**
 * One saved canvas as a version 1 reader sees it: its row, or, while a nested page replaces that row,
 * the page's projection (`canvasDefinitionProjection`). Every reader of `sections` goes through
 * this, so a nested save is never shown as the layout it replaced (FAC-83). The row is returned as
 * stored, unparsed, as the console store has always read it; the canvas store parses its own reads.
 * A console publication (FAC-89) reads the page itself (`currentPage`), never this projection.
 */
export function readCanvasDefinition(storage: Pick<OverseerStorage, "canvases" | "canvasPages">, id: string): CanvasDefinition | null {
  const row = storage.canvases.get(id);
  if (!row) return null;
  const nested = nestedPage(storage, row);
  return nested ? canvasDefinitionProjection(nested) : row;
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
  return stored?.basedOnRevision === row.revision ? joinStoredPage(stored.page, stored.settings, stored.prompts) : null;
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

  /** Every canvas as a version 1 reader sees it (`readCanvasDefinition`). */
  list(): CanvasDefinition[] {
    this.#requireEnabled();
    return Array.from(this.storage.canvases.list(), row => parseCanvasDefinition(readCanvasDefinition(this.storage, parseCanvasDefinition(row).id)));
  }

  /** One canvas as a version 1 reader sees it (`readCanvasDefinition`). */
  get(id: string): CanvasDefinition | null {
    this.#requireEnabled();
    const value = readCanvasDefinition(this.storage, id);
    return value ? parseCanvasDefinition(value) : null;
  }

  /** The stored version 1 row itself, which writers check revisions against. */
  #row(id: string): CanvasDefinition | null {
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
    return nestedPage(this.storage, row);
  }

  /** One page by ID: its nested page, or its version 1 row by conversion (see `currentPage`). Reads never write. */
  getPage(id: string): CanvasPage | null {
    this.#requireEnabled();
    // The raw row: `get` shows a nested page's projection, whose revision is the page's.
    const row = this.#row(id);
    return row ? currentPage(this.storage, row) : null;
  }

  /** Every page of this workspace. Reads never write. */
  listPages(): CanvasPage[] {
    this.#requireEnabled();
    return Array.from(this.storage.canvases.list(), row => currentPage(this.storage, parseCanvasDefinition(row)));
  }

  /**
   * Apply typed page operations at the expected revision and save the result (FAC-83). A stale
   * revision throws `CanvasConflictError` and writes nothing, so newer work is never overwritten.
   */
  editPage(id: string, expectedRevision: string, operations: CanvasPageOperation[]): CanvasPage {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      const current = this.getPage(id);
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
      this.storage.canvasPages.put({ ...splitStoredPage(updated), basedOnRevision: row.revision });
    }
    return updated;
  }
}
