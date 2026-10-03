import { CanvasConflictError } from "@gadgets/workshop-shared/canvas";
import { consoleScreens, MAX_WORKSPACE_CONSOLES, parseOperateConsoleContent, type OperateConsole, type OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import type { OverseerStorage } from "./overseer";

/**
 * A workspace's authored consoles, reachable only through a build-capable Overseer session and
 * under the same installation flags as its canvases, which a console's views reference.
 */
export class WorkspaceConsoleStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage, "consoles" | "canvases">,
      private env: Pick<Cloudflare.Env, "COMPOSABLE_VIEWS" | "DURABLE_VIEWS">) {}

  #requireEnabled(): void {
    if (this.env.COMPOSABLE_VIEWS !== "true" || this.env.DURABLE_VIEWS !== "true") {
      throw new Error("Durable views are disabled for this installation");
    }
  }

  // A console may only be saved over screens that exist; one deleted later shows as unavailable.
  #parse(content: OperateConsoleContent): OperateConsoleContent {
    let parsed = parseOperateConsoleContent(content);
    let missing = consoleScreens(parsed).find(screen => !this.storage.canvases.get(screen));
    if (missing) throw new Error(`Console screen ${missing} is not a screen in this workspace`);
    return parsed;
  }

  list(): OperateConsole[] {
    this.#requireEnabled();
    return Array.from(this.storage.consoles.list());
  }

  create(content: OperateConsoleContent): OperateConsole {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let created: OperateConsole = { ...this.#parse(content), id: crypto.randomUUID(), revision: "0" };
      if (Array.from(this.storage.consoles.list({ limit: MAX_WORKSPACE_CONSOLES })).length >= MAX_WORKSPACE_CONSOLES) {
        throw new Error("Workspace console limit reached");
      }
      this.storage.consoles.put(created);
      return created;
    });
  }

  replace(id: string, expectedRevision: string, content: OperateConsoleContent): OperateConsole {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let replaced: OperateConsole = {
        ...this.#parse(content), id,
        revision: String(BigInt(this.#current(id, expectedRevision).revision) + 1n),
      };
      this.storage.consoles.put(replaced);
      return replaced;
    });
  }

  delete(id: string, expectedRevision: string): void {
    this.#requireEnabled();
    this.durableStorage.transactionSync(() => {
      this.#current(id, expectedRevision);
      this.storage.consoles.delete(id);
    });
  }

  #current(id: string, expectedRevision: string): OperateConsole {
    let current = this.storage.consoles.get(id);
    if (!current) throw new Error("Console not found");
    if (current.revision !== expectedRevision) throw new CanvasConflictError(current.revision);
    return current;
  }
}
