import { CanvasConflictError, type CanvasDefinition } from "@gadgets/workshop-shared/canvas";
import { consoleScreens, MAX_WORKSPACE_CONSOLES, parseOperateConsoleContent, publishedConsole, type ConsoleSource, type OperateConsole, type OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import type { OverseerStorage } from "./overseer";

/**
 * A screen as a console published it: a copy of the canvas taken when the console was published,
 * so editing the canvas afterwards changes only the draft. Keyed by `consoleScreenKey`.
 */
export type ConsoleScreenSnapshot = { consoleId: string; screenId: string; screen: CanvasDefinition };

/** The storage key of one published console screen. Ids never contain "/". */
export function consoleScreenKey(consoleId: string, screenId: string): string {
  return `${consoleId}/${screenId}`;
}

function dropPublishedScreens(storage: Pick<OverseerStorage, "consoleScreens">, consoleId: string): void {
  for (let old of Array.from(storage.consoleScreens.list({ prefix: `${consoleId}/` }))) {
    storage.consoleScreens.delete(consoleScreenKey(old.consoleId, old.screenId));
  }
}

/**
 * Makes `stored`'s draft its published revision, copying in the canvases its views reference.
 * Call inside a storage transaction. Shared by publishing and the storage migration that
 * publishes consoles saved before publication existed.
 */
export function publishConsoleRecord(storage: Pick<OverseerStorage, "consoles" | "canvases" | "consoleScreens">,
    stored: OperateConsole, publishedAt: string): OperateConsole {
  let { id, revision, published: _, ...content } = stored;
  dropPublishedScreens(storage, id);
  for (let screenId of consoleScreens(content)) {
    let screen = storage.canvases.get(screenId);
    if (screen) storage.consoleScreens.put({ consoleId: id, screenId, screen });
  }
  let result: OperateConsole = { ...stored, published: { revision, publishedAt, content } };
  storage.consoles.put(result);
  return result;
}

/**
 * A workspace's authored consoles, reachable only through a build-capable Overseer session and
 * under the same installation flags as its canvases, which a console's views reference. Editing
 * changes a console's draft; `publish` makes the draft, with copies of its screens, what operators
 * use (see `OperateConsole`).
 */
export class WorkspaceConsoleStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage, "consoles" | "canvases" | "consoleScreens">,
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

  /** Every published console, as operators see it (see `publishedConsole`). */
  listPublished(): OperateConsole[] {
    return this.list().flatMap(stored => publishedConsole(stored) ?? []);
  }

  /** One console's draft, or its published revision as operators see it; null if there is none. */
  get(id: string, source: ConsoleSource): OperateConsole | null {
    this.#requireEnabled();
    let stored = this.storage.consoles.get(id);
    if (!stored) return null;
    return source === "draft" ? stored : publishedConsole(stored);
  }

  /**
   * A screen of one console: as it was published, or (for the draft) the canvas as it is now. Null
   * if that revision of the console doesn't show the screen.
   */
  screen(consoleId: string, screenId: string, source: ConsoleSource): CanvasDefinition | null {
    let shown = this.get(consoleId, source);
    if (!shown || !consoleScreens(shown).includes(screenId)) return null;
    if (source === "draft") return this.storage.canvases.get(screenId) ?? null;
    return this.storage.consoleScreens.get(consoleScreenKey(consoleId, screenId))?.screen ?? null;
  }

  /**
   * A screen as some published console shows it, for callers that name a screen without its
   * console. Where consoles published different revisions of it, the latest revision wins.
   */
  publishedScreen(screenId: string): CanvasDefinition | null {
    let latest: CanvasDefinition | null = null;
    for (let shown of this.listPublished()) {
      let screen = this.screen(shown.id, screenId, "published");
      if (screen && (!latest || BigInt(screen.revision) > BigInt(latest.revision))) latest = screen;
    }
    return latest;
  }

  /**
   * Publishes the draft at `expectedRevision`: operators move to it, with each screen as it is
   * now, and later edits to the console or its screens stay draft until the next publish. Each
   * publish raises the revision, like a replace, so of two publishes at one revision only the
   * first wins, and a republish of unchanged content (picking up edited screens) is still a new
   * revision that open sessions move to.
   */
  publish(id: string, expectedRevision: string): OperateConsole {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let current = this.#current(id, expectedRevision);
      let raised = { ...current, revision: String(BigInt(current.revision) + 1n) };
      return publishConsoleRecord(this.storage, raised, new Date().toISOString());
    });
  }

  create(content: OperateConsoleContent): OperateConsole {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let created: OperateConsole = {
        ...this.#parse(content), id: crypto.randomUUID(), revision: "0", published: null,
      };
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
      let current = this.#current(id, expectedRevision);
      let replaced: OperateConsole = {
        ...this.#parse(content), id,
        revision: String(BigInt(current.revision) + 1n),
        published: current.published,
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
      dropPublishedScreens(this.storage, id);
    });
  }

  #current(id: string, expectedRevision: string): OperateConsole {
    let current = this.storage.consoles.get(id);
    if (!current) throw new Error("Console not found");
    if (current.revision !== expectedRevision) throw new CanvasConflictError(current.revision);
    return current;
  }
}
