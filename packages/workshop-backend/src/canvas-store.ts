import { applyCanvasOperations, CanvasConflictError, parseCanvasDefinition, type CanvasContent, type CanvasDefinition, type CanvasOperation } from "@gadgets/workshop-shared/canvas";
import { readCanvasCatalog } from "./canvas-catalog";
import type { OverseerStorage } from "./overseer";

/** Workspace-local composition persistence, reachable only through a build-capable Overseer session. */
export class WorkspaceCanvasStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage, "canvases">,
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
      if (current.revision !== expectedRevision) throw new CanvasConflictError(current.revision);
      this.storage.canvases.delete(id);
    });
  }
}
