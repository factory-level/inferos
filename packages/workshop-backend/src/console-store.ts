import type { ConsoleWidgetFrozenFor, WorkpieceId } from "@gadgets/workshop-shared/api";
import { CANVAS_GADGET_REF, CanvasConflictError, type CanvasDefinition } from "@gadgets/workshop-shared/canvas";
import { consoleScreens, MAX_WORKSPACE_CONSOLES, parseOperateConsoleContent, publishedConsole, type ConsoleSource, type ConsoleWidgetEntry, type OperateConsole, type OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import type { GadgetRecord, OverseerStorage } from "./overseer";

type ConsoleStorage = Pick<OverseerStorage, "consoles" | "canvases" | "consoleScreens" | "gadgets">;

/**
 * How publication creates and removes frozen installs (see `ConsoleWidgetEntry`). Both are called
 * inside the publication's storage transaction.
 */
export type FrozenInstalls = {
  /** Creates the frozen install of `source`, at its current commit and with no bindings. */
  create(source: GadgetRecord, frozenFor: ConsoleWidgetFrozenFor): GadgetRecord;
  /** Removes a frozen install that no published console revision runs any more. */
  remove(id: WorkpieceId): void;
};

/**
 * Why a console of this workspace cannot offer `entry`, or null if it can: the entry must name a
 * permanent, unfrozen gadget installed from a widget blueprint at the entry's blueprint and
 * version, declaring no data contract, and with no bindings at all. Bindings are checked on the
 * gadget itself, since they can be added after install; they run under the binder's own accounts,
 * so a frozen copy would lend them to every operator.
 */
export function consoleWidgetRefusal(storage: Pick<ConsoleStorage, "gadgets">, entry: ConsoleWidgetEntry): string | null {
  let record = storage.gadgets.get(entry.gadgetId);
  if (record?.type !== "gadget" || record.pending) return `Gadget ${entry.gadgetId} is not a gadget of this workspace.`;
  if (record.frozenFor) return `Gadget ${entry.gadgetId} is a frozen install; register the install it was made from.`;
  let installed = record.installedFrom;
  if (!installed) return `Gadget ${entry.gadgetId} is not a blueprint install.`;
  if (installed.kind !== "widget") return `Gadget ${entry.gadgetId} is a ${installed.kind ?? "gadget"} install, not a widget.`;
  if (installed.blueprintId !== entry.blueprintId || installed.version !== entry.version) {
    return `Gadget ${entry.gadgetId} runs blueprint ${installed.blueprintId} version ${installed.version}, ` +
        `not ${entry.blueprintId} version ${entry.version}.`;
  }
  if (installed.dataContract !== undefined) {
    return `Gadget ${entry.gadgetId} declares a data contract, so its state is not resettable.`;
  }
  if (Object.keys(record.bindings).length > 0) {
    return `Gadget ${entry.gadgetId} has bindings; a console offers only widgets with none.`;
  }
  return null;
}

/** The gadget ids `screen`'s `inferos.gadget` widgets reference. */
function placedGadgets(screen: CanvasDefinition): WorkpieceId[] {
  return screen.sections.flatMap(section => section.widgets.flatMap(widget => {
    let match = widget.kind === "inferos.gadget" ? CANVAS_GADGET_REF.exec(widget.targetRef) : null;
    return match ? [Number(match[1])] : [];
  }));
}

/** `screen` with each placed gadget the map names replaced by its frozen install. */
function withFrozenGadgets(screen: CanvasDefinition, frozen: Map<WorkpieceId, WorkpieceId>): CanvasDefinition {
  return { ...screen, sections: screen.sections.map(section => ({ ...section, widgets: section.widgets.map(widget => {
    let match = widget.kind === "inferos.gadget" ? CANVAS_GADGET_REF.exec(widget.targetRef) : null;
    let replacement = match ? frozen.get(Number(match[1])) : undefined;
    return replacement === undefined ? widget : { ...widget, targetRef: `gadget:${replacement}` };
  }) })) };
}

/**
 * Checks `content`'s widget registry and placements in this workspace, throwing the first problem:
 * each entry must pass `consoleWidgetRefusal`, and every widget install (or frozen install) placed
 * on a screen the console shows must be registered. Other gadgets, such as installed apps, are
 * placed as before.
 */
function checkConsoleWidgets(storage: Pick<ConsoleStorage, "canvases" | "gadgets">, content: OperateConsoleContent): void {
  let registered = new Set<WorkpieceId>();
  for (let entry of content.widgets ?? []) {
    let refusal = consoleWidgetRefusal(storage, entry);
    if (refusal) throw new Error(`Console widget "${entry.label}": ${refusal}`);
    registered.add(entry.gadgetId);
  }
  let isWidget = (id: WorkpieceId) => {
    let record = storage.gadgets.get(id);
    return record?.type === "gadget" && (!!record.frozenFor || record.installedFrom?.kind === "widget");
  };
  for (let screenId of consoleScreens(content)) {
    let screen = storage.canvases.get(screenId);
    let unregistered = screen && placedGadgets(screen).find(id => isWidget(id) && !registered.has(id));
    if (unregistered !== undefined && unregistered !== null) {
      throw new Error(`Screen ${screenId} shows widget ${unregistered}, which the console's widget registry does not offer.`);
    }
  }
}

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

/** Removes every frozen install of console `consoleId` that `keep` doesn't list. */
function dropFrozenInstalls(storage: Pick<ConsoleStorage, "gadgets">, frozen: FrozenInstalls,
    consoleId: string, keep: Set<WorkpieceId> = new Set()): void {
  for (let record of Array.from(storage.gadgets.list())) {
    if (record.type === "gadget" && record.frozenFor?.consoleId === consoleId && !keep.has(record.id)) {
      frozen.remove(record.id);
    }
  }
}

/**
 * Makes `stored`'s draft its published revision, copying in the canvases its views reference.
 * Each registered widget gets a frozen install made through `frozen`, which the published
 * registry and screen copies reference instead of the registered gadget, and the frozen installs
 * of the console's previous publication are removed. Everything is checked before anything is
 * created. Call inside a storage transaction. Shared by publishing and the storage migration that
 * publishes consoles saved before publication existed, which have no widgets.
 */
export function publishConsoleRecord(storage: ConsoleStorage, stored: OperateConsole, publishedAt: string,
    frozen?: FrozenInstalls): OperateConsole {
  let { id, revision, published: _, ...content } = stored;
  checkConsoleWidgets(storage, content);
  let entries = content.widgets ?? [];
  if (entries.length > 0 && !frozen) throw new Error("This console's widgets cannot be published here.");

  let frozenIds = new Map<WorkpieceId, WorkpieceId>();
  let widgets = entries.map((entry): ConsoleWidgetEntry => {
    let source = storage.gadgets.get(entry.gadgetId) as GadgetRecord;
    let made = frozen!.create(source, { consoleId: id, revision, sourceGadgetId: source.id });
    frozenIds.set(source.id, made.id);
    return { ...entry, gadgetId: made.id, frozen: { sourceGadgetId: source.id, commitId: made.commitId! } };
  });
  dropPublishedScreens(storage, id);
  for (let screenId of consoleScreens(content)) {
    let screen = storage.canvases.get(screenId);
    if (screen) storage.consoleScreens.put({ consoleId: id, screenId, screen: withFrozenGadgets(screen, frozenIds) });
  }
  let publishedContent = content.widgets === undefined ? content : { ...content, widgets };
  let result: OperateConsole = { ...stored, published: { revision, publishedAt, content: publishedContent } };
  storage.consoles.put(result);
  if (frozen) dropFrozenInstalls(storage, frozen, id, new Set(frozenIds.values()));
  return result;
}

/**
 * A workspace's authored consoles, reachable only through a build-capable Overseer session and
 * under the same installation flags as its canvases, which a console's views reference. Editing
 * changes a console's draft; `publish` makes the draft, with copies of its screens, what operators
 * use (see `OperateConsole`).
 */
export class WorkspaceConsoleStore {
  constructor(private durableStorage: DurableObjectStorage, private storage: ConsoleStorage,
      private env: Pick<Cloudflare.Env, "COMPOSABLE_VIEWS" | "DURABLE_VIEWS">,
      private frozen?: FrozenInstalls) {}

  #requireEnabled(): void {
    if (this.env.COMPOSABLE_VIEWS !== "true" || this.env.DURABLE_VIEWS !== "true") {
      throw new Error("Durable views are disabled for this installation");
    }
  }

  // A console may only be saved over screens that exist; one deleted later shows as unavailable.
  // Its widgets are checked now and again at publication, since screens and gadgets change.
  #parse(content: OperateConsoleContent): OperateConsoleContent {
    let parsed = parseOperateConsoleContent(content);
    let missing = consoleScreens(parsed).find(screen => !this.storage.canvases.get(screen));
    if (missing) throw new Error(`Console screen ${missing} is not a screen in this workspace`);
    checkConsoleWidgets(this.storage, parsed);
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
   * The widget `gadgetId` as console `consoleId`'s published revision `revision` offers it: that
   * revision's registry entry for its frozen install. Throws if the console is no longer published
   * at `revision`, like a stale console move, or does not offer the widget.
   */
  offeredWidget(consoleId: string, revision: string, gadgetId: WorkpieceId): ConsoleWidgetEntry {
    let shown = this.get(consoleId, "published");
    if (!shown) throw new Error(`Console ${consoleId} is not published.`);
    if (shown.revision !== revision) throw new Error(`Console ${consoleId} has changed since it was opened.`);
    let entry = shown.widgets?.find(widget => widget.gadgetId === gadgetId);
    let record = this.storage.gadgets.get(gadgetId);
    if (!entry || record?.type !== "gadget" || record.frozenFor?.consoleId !== consoleId ||
        record.frozenFor.revision !== revision) {
      throw new Error(`Console ${consoleId} does not offer widget ${gadgetId}.`);
    }
    return entry;
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
      return publishConsoleRecord(this.storage, raised, new Date().toISOString(), this.frozen);
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
      if (this.frozen) dropFrozenInstalls(this.storage, this.frozen, id);
    });
  }

  #current(id: string, expectedRevision: string): OperateConsole {
    let current = this.storage.consoles.get(id);
    if (!current) throw new Error("Console not found");
    if (current.revision !== expectedRevision) throw new CanvasConflictError(current.revision);
    return current;
  }
}
