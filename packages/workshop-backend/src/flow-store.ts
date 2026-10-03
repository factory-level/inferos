import { CanvasConflictError } from "@gadgets/workshop-shared/canvas";
import { MAX_WORKSPACE_FLOWS, parseOperateFlowContent, type OperateFlow, type OperateFlowContent } from "@gadgets/workshop-shared/operate-flow";
import type { OverseerStorage } from "./overseer";

/**
 * A workspace's authored flows, reachable only through a build-capable Overseer session and under
 * the same installation flags as its canvases, whose ids a flow's steps are.
 */
export class WorkspaceFlowStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage, "flows" | "canvases">,
      private env: Pick<Cloudflare.Env, "COMPOSABLE_VIEWS" | "DURABLE_VIEWS">) {}

  #requireEnabled(): void {
    if (this.env.COMPOSABLE_VIEWS !== "true" || this.env.DURABLE_VIEWS !== "true") {
      throw new Error("Durable views are disabled for this installation");
    }
  }

  // A flow may only be saved over screens that exist; one deleted later shows as unavailable.
  #parse(content: OperateFlowContent): OperateFlowContent {
    let parsed = parseOperateFlowContent(content);
    let missing = parsed.steps.find(step => !this.storage.canvases.get(step));
    if (missing) throw new Error(`Flow step ${missing} is not a screen in this workspace`);
    return parsed;
  }

  list(): OperateFlow[] {
    this.#requireEnabled();
    return Array.from(this.storage.flows.list());
  }

  create(content: OperateFlowContent): OperateFlow {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let flow: OperateFlow = { ...this.#parse(content), id: crypto.randomUUID(), revision: "0" };
      if (Array.from(this.storage.flows.list({ limit: MAX_WORKSPACE_FLOWS })).length >= MAX_WORKSPACE_FLOWS) {
        throw new Error("Workspace flow limit reached");
      }
      this.storage.flows.put(flow);
      return flow;
    });
  }

  replace(id: string, expectedRevision: string, content: OperateFlowContent): OperateFlow {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let flow: OperateFlow =
          { ...this.#parse(content), id, revision: String(BigInt(this.#current(id, expectedRevision).revision) + 1n) };
      this.storage.flows.put(flow);
      return flow;
    });
  }

  delete(id: string, expectedRevision: string): void {
    this.#requireEnabled();
    this.durableStorage.transactionSync(() => {
      this.#current(id, expectedRevision);
      this.storage.flows.delete(id);
    });
  }

  #current(id: string, expectedRevision: string): OperateFlow {
    let current = this.storage.flows.get(id);
    if (!current) throw new Error("Flow not found");
    if (current.revision !== expectedRevision) throw new CanvasConflictError(current.revision);
    return current;
  }
}
