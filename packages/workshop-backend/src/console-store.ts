import type { BlueprintInstall, ConsoleWidgetFrozenFor, WorkpieceId } from "@gadgets/workshop-shared/api";
import { parseBoundViewSpec } from "@gadgets/workshop-shared/bound-view";
import { CANVAS_GADGET_REF, CanvasConflictError, type CanvasDefinition } from "@gadgets/workshop-shared/canvas";
import { consoleScreens, MAX_WORKSPACE_CONSOLES, parseOperateConsoleContent, publishedConsole, type BoundViewEntry, type ConsoleSource, type ConsoleWidgetEntry, type HostBoardEntry, type OperateConsole, type OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import type { GadgetFileClassification } from "@gadgets/workshop-shared/workspace-kind";
import { HOST_BOARDS_OFF, hostBoardsEnabled } from "./host-boards";
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
 * A registered gadget's commit as read before a console save or publication: its classification as
 * a widget (`classifyGadgetFiles`, from its full file map), and its `view.json` text when it is
 * view-only.
 */
export type SourceCommit = {
  /** The commit's files, classified for the `widget` kind. */
  classification: GadgetFileClassification;
  /** The strict UTF-8 text of `view.json`, for a `viewOnly` commit; otherwise null. */
  viewText: string | null;
};

/**
 * The commits of a console's registered gadgets, by commit id, read outside the storage
 * transaction that checks them. A commit is immutable, so the transaction need only check that
 * each gadget is still at a commit read here.
 */
export type SourceCommits = ReadonlyMap<string, SourceCommit>;

/** The message every save or publication refused by the bound-view switch carries. */
export const BOUND_VIEWS_OFF = "Bound views are turned off for this installation.";

/**
 * Whether bound views are on: `INFEROPS_BOUND_VIEWS` exactly `"true"`, and only while host boards
 * are (`hostBoardsEnabled`), whose reads they show. Checked at registration and publication.
 */
export function boundViewsEnabled(
    env: Pick<Cloudflare.Env, "INFEROPS_BOUND_VIEWS" | "INFEROPS_HOST_BOARDS" | "INFEROPS_ENABLED">): boolean {
  return env.INFEROPS_BOUND_VIEWS === "true" && hostBoardsEnabled(env);
}

/**
 * The size bounds of a stored console, in UTF-8 bytes of `JSON.stringify`: a bound view entry
 * without `frozen` (its spec is not stored), one with it (the spec at most doubles when escaped),
 * and the whole stored record, draft and publication together, well inside a Durable Object's
 * per-value limit.
 */
export const CONSOLE_SIZE_LIMITS = {
  /** A bound view entry as saved: 4 KiB. */
  boundViewEntry: 4 * 1024,
  /** A published bound view entry, with its `frozen` spec: 20 KiB. */
  frozenBoundViewEntry: 20 * 1024,
  /** A stored console, checked at publication: 448 KiB. */
  console: 448 * 1024,
} as const;

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// What `consoleWidgetRefusal` and `boundViewRefusal` share: the registered gadget is a permanent,
// unfrozen widget install at the entry's blueprint and version, with no data contract or bindings.
function installRefusal(storage: Pick<ConsoleStorage, "gadgets">,
    entry: Pick<ConsoleWidgetEntry, "gadgetId" | "blueprintId" | "version">): string | null {
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

// The read commit of the gadget `id`'s current commit, or a refusal when it was not read (it moved
// since, so the caller must try again).
function currentCommit(storage: Pick<ConsoleStorage, "gadgets">, commits: SourceCommits,
    id: WorkpieceId): SourceCommit | string {
  let record = storage.gadgets.get(id);
  let commit = record?.type === "gadget" && record.commitId !== undefined ? commits.get(record.commitId) : undefined;
  return commit ?? `Gadget ${id} changed while it was being checked; try again.`;
}

/**
 * Why a console of this workspace cannot offer `entry`, or null if it can: the entry must name a
 * permanent, unfrozen gadget installed from a widget blueprint at the entry's blueprint and
 * version, declaring no data contract, and with no bindings at all. Bindings are checked on the
 * gadget itself, since they can be added after install; they run under the binder's own accounts,
 * so a frozen copy would lend them to every operator. Given `commits`, its current commit must be
 * one of them and must not be view-only: a view has no code to run, and is offered only as a
 * bound view (`boundViewRefusal`).
 */
export function consoleWidgetRefusal(storage: Pick<ConsoleStorage, "gadgets">, entry: ConsoleWidgetEntry,
    commits?: SourceCommits): string | null {
  let refusal = installRefusal(storage, entry);
  if (refusal || !commits) return refusal;
  let commit = currentCommit(storage, commits, entry.gadgetId);
  if (typeof commit === "string") return commit;
  return commit.classification.class === "viewOnly"
    ? `Gadget ${entry.gadgetId} is a view with no code; offer it as a bound view instead.` : null;
}

/**
 * Why a console of this workspace cannot offer `entry` as a bound view, or null if it can: the
 * gadget must pass the same install checks as a registered widget (`consoleWidgetRefusal`), its
 * current commit must be one of `commits` and classified view-only, and its spec's requirement
 * names must equal the entry's as a set.
 */
export function boundViewRefusal(storage: Pick<ConsoleStorage, "gadgets">, entry: BoundViewEntry,
    commits: SourceCommits): string | null {
  let refusal = installRefusal(storage, entry);
  if (refusal) return refusal;
  let commit = currentCommit(storage, commits, entry.gadgetId);
  if (typeof commit === "string") return commit;
  let parsed = commit.viewText === null ? null : parseBoundViewSpec(commit.viewText);
  if (commit.classification.class !== "viewOnly" || !parsed?.ok) {
    let reasons = commit.classification.violations.map(violation => violation.message).join(" ");
    return `Gadget ${entry.gadgetId} is not a view-only widget.${reasons ? ` ${reasons}` : ""}`;
  }
  let declared = parsed.spec.requirements;
  if (declared.length !== entry.requirements.length || declared.some(name => !entry.requirements.includes(name))) {
    return `Gadget ${entry.gadgetId}'s view reads ${declared.join(", ")}, not ${entry.requirements.join(", ")}.`;
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
 * each entry must pass `consoleWidgetRefusal` (against `commits`, when given), and every widget install (or frozen install) placed
 * on a screen the console shows must be registered. Other gadgets, such as installed apps, are
 * placed as before.
 */
function checkConsoleWidgets(storage: Pick<ConsoleStorage, "canvases" | "gadgets">, content: OperateConsoleContent,
    commits?: SourceCommits): void {
  let registered = new Set<WorkpieceId>();
  for (let entry of content.widgets ?? []) {
    let refusal = consoleWidgetRefusal(storage, entry, commits);
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
 * What a console publication reads before its transaction (`WorkspaceConsoleStore.capture`): the
 * draft revision; each bound view entry, in order, with the host-board entry id each requirement
 * name maps to and its source gadget's provenance and commit as they were; and the commit of every
 * registered widget and bound view. The publication refuses unless the same capture, taken again
 * inside its transaction, is equal.
 */
export type ConsoleCapture = {
  /** The draft revision captured. */
  revision: string;
  /** The bound view entries, in order. */
  boundViews: {
    id: string | null;
    requirements: { name: string; hostBoardEntryId: string | null }[];
    source: { gadgetId: WorkpieceId; installedFrom: BlueprintInstall | null; commitId: string | null };
  }[];
  /** Every registered gadget's commit, each once: what the publication must read. */
  commitIds: string[];
};

function captureConsole(storage: Pick<ConsoleStorage, "gadgets">, stored: OperateConsole): ConsoleCapture {
  let boards = new Map((stored.hostBoards ?? []).map(board => [board.requirement.name, board.id ?? null]));
  let source = (gadgetId: WorkpieceId) => {
    let record = storage.gadgets.get(gadgetId);
    let gadget = record?.type === "gadget" ? record : undefined;
    return { gadgetId, installedFrom: gadget?.installedFrom ?? null, commitId: gadget?.commitId ?? null };
  };
  let boundViews = (stored.boundViews ?? []).map(entry => ({
    id: entry.id ?? null,
    requirements: entry.requirements.map(name => ({ name, hostBoardEntryId: boards.get(name) ?? null })),
    source: source(entry.gadgetId),
  }));
  let registered = [...stored.widgets ?? [], ...stored.boundViews ?? []].map(entry => source(entry.gadgetId).commitId);
  return { revision: stored.revision, boundViews,
    commitIds: [...new Set(registered.filter(commitId => commitId !== null))] };
}

/**
 * Makes `stored`'s draft its published revision, copying in the canvases its views reference.
 * Each registered widget gets a frozen install made through `frozen`, which the published
 * registry and screen copies reference instead of the registered gadget, and the frozen installs
 * of the console's previous publication are removed. Each bound view must pass `boundViewRefusal`
 * against `commits`, and gets its source commit's spec in `frozen`; no install is made for it.
 * Everything is checked before anything is created, except the stored record's size, which is
 * checked last. Call inside a storage transaction, which undoes the installs if that refuses.
 * Shared by publishing and the storage migration that publishes consoles saved before publication
 * existed, which have no widgets or bound views.
 */
export function publishConsoleRecord(storage: ConsoleStorage, stored: OperateConsole, publishedAt: string,
    frozen?: FrozenInstalls, commits?: SourceCommits): OperateConsole {
  let { id, revision, published: _, ...content } = stored;
  checkConsoleWidgets(storage, content, commits);
  let entries = content.widgets ?? [];
  if (entries.length > 0 && !frozen) throw new Error("This console's widgets cannot be published here.");
  let boundViews = (content.boundViews ?? []).map((entry): BoundViewEntry => {
    if (!commits) throw new Error("This console's bound views cannot be published here.");
    let refusal = boundViewRefusal(storage, entry, commits);
    if (refusal) throw new Error(`Console bound view "${entry.label}": ${refusal}`);
    let commitId = (storage.gadgets.get(entry.gadgetId) as GadgetRecord).commitId!;
    let published = { ...entry, frozen: { sourceGadgetId: entry.gadgetId, commitId, specText: commits.get(commitId)!.viewText! } };
    if (jsonBytes(published) > CONSOLE_SIZE_LIMITS.frozenBoundViewEntry) {
      throw new Error(`Console bound view "${entry.label}" is over ${CONSOLE_SIZE_LIMITS.frozenBoundViewEntry} bytes published.`);
    }
    return published;
  });

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
  let publishedContent = { ...content, ...(content.widgets === undefined ? {} : { widgets }),
    ...(content.boundViews === undefined ? {} : { boundViews }) };
  let result: OperateConsole = { ...stored, published: { revision, publishedAt, content: publishedContent } };
  if (jsonBytes(result) > CONSOLE_SIZE_LIMITS.console) {
    throw new Error(`This console would be over ${CONSOLE_SIZE_LIMITS.console} bytes published.`);
  }
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
      private env: Pick<Cloudflare.Env, "COMPOSABLE_VIEWS" | "DURABLE_VIEWS" | "INFEROPS_HOST_BOARDS" | "INFEROPS_BOUND_VIEWS" | "INFEROPS_ENABLED">,
      private frozen?: FrozenInstalls) {}

  #requireEnabled(): void {
    if (this.env.COMPOSABLE_VIEWS !== "true" || this.env.DURABLE_VIEWS !== "true") {
      throw new Error("Durable views are disabled for this installation");
    }
  }

  // Omitted means keep: editors that predate host boards or bound views send no `hostBoards` or
  // `boundViews`, and replacing through them must not delete saved entries. An explicit list (`[]`
  // included) replaces them. The saved entries are merged in before parsing, so the combined
  // registry limit and the requirement names apply.
  #inherit(content: OperateConsoleContent, current?: OperateConsole): OperateConsoleContent {
    return { ...content,
      ...(content.hostBoards === undefined && current?.hostBoards !== undefined ? { hostBoards: current.hostBoards } : {}),
      ...(content.boundViews === undefined && current?.boundViews !== undefined ? { boundViews: current.boundViews } : {}) };
  }

  // A console may only be saved over screens that exist; one deleted later shows as unavailable.
  // Its widgets and bound views are checked now, against `commits`, and again at publication,
  // since screens and gadgets change.
  #parse(content: OperateConsoleContent, commits: SourceCommits | undefined, current?: OperateConsole): OperateConsoleContent {
    let parsed = parseOperateConsoleContent(this.#inherit(content, current));
    let missing = consoleScreens(parsed).find(screen => !this.storage.canvases.get(screen));
    if (missing) throw new Error(`Console screen ${missing} is not a screen in this workspace`);
    checkConsoleWidgets(this.storage, parsed, commits);
    let hostBoards = parsed.hostBoards === undefined ? undefined : this.#hostBoards(parsed.hostBoards, current);
    let boundViews = parsed.boundViews === undefined ? undefined : this.#boundViews(parsed.boundViews, commits, current);
    return { ...parsed, ...(hostBoards === undefined ? {} : { hostBoards }), ...(boundViews === undefined ? {} : { boundViews }) };
  }

  // A new entry gets its id here, and is refused while the switch is off; entries this console
  // already holds stay editable and publishable then, since they grant nothing while it is off. An
  // entry naming an id must be one of this console's (draft or published) with exactly that
  // requirement, so a requirement never changes under its id and no id is forged.
  #hostBoards(entries: HostBoardEntry[], current?: OperateConsole): HostBoardEntry[] {
    if (entries.some(entry => entry.id === undefined) && !hostBoardsEnabled(this.env)) throw new Error(HOST_BOARDS_OFF);
    let known = new Map<string, HostBoardEntry>();
    for (let entry of [...current?.hostBoards ?? [], ...current?.published?.content.hostBoards ?? []]) {
      if (entry.id !== undefined) known.set(entry.id, entry);
    }
    return entries.map(entry => {
      if (entry.id === undefined) return { ...entry, id: crypto.randomUUID() };
      let held = known.get(entry.id)?.requirement;
      let { name, resource, target } = entry.requirement;
      if (!held || held.name !== name || held.resource !== resource || held.target !== target) {
        throw new Error(`Host board ${entry.id} is not this console's, or its requirement changed; add a new entry instead.`);
      }
      return entry;
    });
  }

  // As `#hostBoards`, under the bound-view switch: an entry naming an id must be one of this
  // console's with the same gadget, so an id never moves to another source. Every entry must also
  // pass `boundViewRefusal` and the saved size bound.
  #boundViews(entries: BoundViewEntry[], commits: SourceCommits | undefined, current?: OperateConsole): BoundViewEntry[] {
    if (entries.some(entry => entry.id === undefined) && !boundViewsEnabled(this.env)) throw new Error(BOUND_VIEWS_OFF);
    let known = new Map<string, BoundViewEntry>();
    for (let entry of [...current?.boundViews ?? [], ...current?.published?.content.boundViews ?? []]) {
      if (entry.id !== undefined) known.set(entry.id, entry);
    }
    return entries.map(entry => {
      if (entry.id !== undefined && known.get(entry.id)?.gadgetId !== entry.gadgetId) {
        throw new Error(`Bound view ${entry.id} is not this console's, or its gadget changed; add a new entry instead.`);
      }
      let saved = entry.id === undefined ? { ...entry, id: crypto.randomUUID() } : entry;
      if (jsonBytes(saved) > CONSOLE_SIZE_LIMITS.boundViewEntry) {
        throw new Error(`Console bound view "${entry.label}" is over ${CONSOLE_SIZE_LIMITS.boundViewEntry} bytes.`);
      }
      let refusal = boundViewRefusal(this.storage, saved, commits ?? new Map());
      if (refusal) throw new Error(`Console bound view "${entry.label}": ${refusal}`);
      return saved;
    });
  }

  /**
   * The commits of the gadgets that saving `content` over console `id` (or creating it) would
   * check: those of its widgets and bound views, including bound views kept from the saved draft.
   * The caller reads them (see `SourceCommits`) and passes them to `create` or `replace`.
   */
  sourceCommitIds(content: OperateConsoleContent, id?: string): string[] {
    let current = id === undefined ? undefined : this.storage.consoles.get(id);
    let merged = this.#inherit(content, current ?? undefined);
    return captureConsole(this.storage, { ...merged, id: "", revision: "", published: null }).commitIds;
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
   * What publishing console `id` at `expectedRevision` would freeze, as it is now (see
   * `ConsoleCapture`). The caller reads `commitIds` (see `SourceCommits`) and passes both to
   * `publish`.
   */
  capture(id: string, expectedRevision: string): ConsoleCapture {
    this.#requireEnabled();
    return captureConsole(this.storage, this.#current(id, expectedRevision));
  }

  /**
   * Publishes the draft at `expectedRevision`: operators move to it, with each screen as it is
   * now, and later edits to the console or its screens stay draft until the next publish. Each
   * publish raises the revision, like a replace, so of two publishes at one revision only the
   * first wins, and a republish of unchanged content (picking up edited screens) is still a new
   * revision that open sessions move to. Given a `capture` and the `commits` it names, the console
   * and its sources must still be as captured; bound views are published only that way, each
   * with its captured commit's spec.
   */
  publish(id: string, expectedRevision: string, capture?: ConsoleCapture, commits?: SourceCommits): OperateConsole {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let current = this.#current(id, expectedRevision);
      if (capture && JSON.stringify(captureConsole(this.storage, current)) !== JSON.stringify(capture)) {
        throw new Error(`Console ${id} or one of its gadgets changed while it was being published; publish again.`);
      }
      // A host-only publication creates no install. While a switch is off, only entries already
      // published may be published again; publishing any other is refused.
      let published = new Set((current.published?.content.hostBoards ?? []).map(entry => entry.id));
      if (!hostBoardsEnabled(this.env) && (current.hostBoards ?? []).some(entry => !published.has(entry.id))) {
        throw new Error(HOST_BOARDS_OFF);
      }
      let views = new Set((current.published?.content.boundViews ?? []).map(entry => entry.id));
      if (!boundViewsEnabled(this.env) && (current.boundViews ?? []).some(entry => !views.has(entry.id))) {
        throw new Error(BOUND_VIEWS_OFF);
      }
      let raised = { ...current, revision: String(BigInt(current.revision) + 1n) };
      return publishConsoleRecord(this.storage, raised, new Date().toISOString(), this.frozen, capture && commits);
    });
  }

  /**
   * Creates a console from `content`. `commits` holds the commits of the gadgets it registers
   * (`sourceCommitIds`); without it, bound views are refused and widgets are not checked for views.
   */
  create(content: OperateConsoleContent, commits?: SourceCommits): OperateConsole {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let created: OperateConsole = {
        ...this.#parse(content, commits), id: crypto.randomUUID(), revision: "0", published: null,
      };
      if (Array.from(this.storage.consoles.list({ limit: MAX_WORKSPACE_CONSOLES })).length >= MAX_WORKSPACE_CONSOLES) {
        throw new Error("Workspace console limit reached");
      }
      this.storage.consoles.put(created);
      return created;
    });
  }

  /** Replaces console `id`'s draft at `expectedRevision` with `content`, checked as in `create`. */
  replace(id: string, expectedRevision: string, content: OperateConsoleContent, commits?: SourceCommits): OperateConsole {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let current = this.#current(id, expectedRevision);
      let replaced: OperateConsole = {
        ...this.#parse(content, commits, current), id,
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
