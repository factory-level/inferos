import type { BlueprintInstall, BoundViewDescription, ConsoleWidgetFrozenFor, WorkpieceId } from "@gadgets/workshop-shared/api";
import { parseBoundViewSpec } from "@gadgets/workshop-shared/bound-view";
import { CANVAS_GADGET_REF, CanvasConflictError, type CanvasDefinition } from "@gadgets/workshop-shared/canvas";
import { canvasDefinitionProjection, canvasPageFromDefinition, type CanvasPage } from "@gadgets/workshop-shared/canvas-model";
import { nestedPage, readCanvasDefinition } from "./canvas-store";
import { consoleScreens, consoleWidgetVersionId, MAX_WORKSPACE_CONSOLES, parseOperateConsoleContent, publishedConsole, type BoundViewEntry, type ConsoleRef, type ConsoleSource, type ConsoleWidgetCandidate, type ConsoleWidgetEntry, type ConsolePublishedApp, type ConsoleWidgetFreeze, type HostBoardEntry, type OperateConsole, type OperateConsoleContent } from "@gadgets/workshop-shared/operate-console";
import type { OperateFlow } from "@gadgets/workshop-shared/operate-flow";
import type { WidgetToolDeclaration } from "@gadgets/workshop-shared/widget-tools";
import type { WidgetStateMachine } from "@gadgets/workshop-shared/widget-state";
import type { GadgetFileClassification } from "@gadgets/workshop-shared/workspace-kind";
import { HOST_BOARDS_OFF, hostBoardsEnabled } from "./host-boards";
import type { GadgetRecord, OverseerStorage } from "./overseer";

type ConsoleStorage = Pick<OverseerStorage, "consoles" | "canvases" | "canvasPages" | "consoleScreens" | "gadgets" | "flows">;

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
 * A registered gadget's commit as read before a console save or publication, in one pass over its
 * paths and its `view.json` and `tools.json` text: its classification as a widget
 * (`classifyGadgetFiles`), its `view.json` text when it is view-only, and the tools its `tools.json`
 * declares when it is callable.
 */
export type SourceCommit = {
  /** The commit's files, classified for the `widget` kind. */
  classification: GadgetFileClassification;
  /** The strict UTF-8 text of `view.json`, for a `viewOnly` commit; otherwise null. */
  viewText: string | null;
  /** The parsed `tools.json`, for a `callableTools` or `callableCombined` commit; otherwise null. */
  tools: WidgetToolDeclaration[] | null;
  /** The parsed `states.json` of a widget that declares one; otherwise null. */
  states: WidgetStateMachine | null;
  /** Why a present `states.json` doesn't parse, which refuses the widget; otherwise null. */
  statesProblem: string | null;
};

/**
 * The commits of a console's registered gadgets, by commit id, read outside the storage
 * transaction that checks them. A commit is immutable, so the transaction need only check that
 * each gadget is still at a commit read here.
 */
export type SourceCommits = ReadonlyMap<string, SourceCommit>;

/**
 * The one retryable refusal of a console save or publication: the console, or a gadget it
 * registers, changed between the read of its sources' commits and the transaction that checks
 * them. Nothing was written, so the builder saves or publishes again.
 */
export const CONSOLE_CHANGED =
  "The console or one of its gadgets changed while it was being saved or published; try again.";

/** The message an offered-tool lookup refused by the console-tools switch carries. */
export const CONSOLE_TOOLS_OFF = "Console tools are turned off for this installation.";

/**
 * Whether console tools are on: `CONSOLE_TOOLS` exactly `"true"`; anything else, or unset, is off.
 * While off, publication snapshots no tools (`ConsoleWidgetFreeze.tools`) and no tool is offered
 * (`WorkspaceConsoleStore.offeredTool`). It must stay unset in every shared or deployed environment
 * until the remote CPU, wall-time and memory checks pass (see operate-mode.md).
 */
export function consoleToolsEnabled(env: Pick<Cloudflare.Env, "CONSOLE_TOOLS">): boolean {
  return env.CONSOLE_TOOLS === "true";
}

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
 * The size bounds of a stored console, in UTF-8 bytes of `JSON.stringify`: a registry entry as
 * saved, a bound view entry with its `frozen` spec (the spec at most doubles when escaped), and the
 * whole stored record, draft and publication together, well inside a Durable Object's per-value
 * limit. Each is a backstop: the field bounds `parseOperateConsoleContent` enforces keep legal
 * content under every one of them.
 */
export const CONSOLE_SIZE_LIMITS = {
  /**
   * Any registry entry (widget, host board or bound view) as saved, checked at save: 4 KiB. Its
   * fields are bounded (a label of 120 and a blueprint id of 128 code units, ids of 64, at most 4
   * requirement names of 64), so even with every character escaped to 6 bytes an entry is under
   * 2 KiB.
   */
  entry: 4 * 1024,
  /** A published bound view entry, with its `frozen` spec: 20 KiB. */
  frozenBoundViewEntry: 20 * 1024,
  /**
   * A stored console, checked at publication: 704 KiB, the sum of four bounds over the at most
   * `MAX_CONSOLE_WIDGETS` (16) registry entries. The draft is at most 16 × 4 KiB of entries
   * (`entry`) plus 32 KiB of title, views and customization (12 views of at most 12 screen ids
   * come to under 24 KiB even fully escaped) = 96 KiB, and the publication's content as much again
   * (96 KiB). On top, each published entry freezes at most one payload: a bound
   * view's spec, at most 16 KiB escaped (8 KiB at most doubled), or a callable widget's tools, at
   * most 32 KiB (a 16 KiB `tools.json` re-serialized: whitespace, strings and keys never grow,
   * and a number grows by at most 17 bytes, as `1e20` does, while each schema holding numbers is
   * at least 42 bytes with at most two, so the whole at most doubles). So the frozen payloads come
   * to at most 16 × 32 KiB (512 KiB). 704 KiB stays inside the 2 MB per-value limit of
   * SQLite-backed Durable Objects. Legal content stays well under it, so it never refuses a
   * console that parsed; it guards the row if a field bound is ever loosened.
   */
  console: 704 * 1024,
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

// The read commit of the gadget `id`'s current commit. Throws `CONSOLE_CHANGED` when it was not
// read: it moved since, so the caller must try again. A gadget with no commit at all has nothing
// to check, which no retry changes, so that refusal is its own.
function currentCommit(storage: Pick<ConsoleStorage, "gadgets">, commits: SourceCommits, id: WorkpieceId): SourceCommit {
  let record = storage.gadgets.get(id);
  if (record?.type === "gadget" && record.commitId === undefined) {
    throw new Error(`Gadget ${id} has no committed files, so a console cannot offer it.`);
  }
  let commit = record?.type === "gadget" ? commits.get(record.commitId!) : undefined;
  if (!commit) throw new Error(CONSOLE_CHANGED);
  return commit;
}

/**
 * Why a console of this workspace cannot offer `entry`, or null if it can: the entry must name a
 * permanent, unfrozen gadget installed from a widget blueprint at the entry's blueprint and
 * version, declaring no data contract, and with no bindings at all. Bindings are checked on the
 * gadget itself, since they can be added after install; they run under the binder's own accounts,
 * so a frozen copy would lend them to every operator. Given `commits`, its current commit must be
 * one of them (else this throws `CONSOLE_CHANGED`) and classify as a widget with code: visual, or
 * callable with or without a UI. A view-only commit has no code to run, and is offered only as a
 * bound view (`boundViewRefusal`).
 */
export function consoleWidgetRefusal(storage: Pick<ConsoleStorage, "gadgets">, entry: ConsoleWidgetEntry,
    commits?: SourceCommits): string | null {
  let refusal = installRefusal(storage, entry);
  if (refusal || !commits) return refusal;
  let commit = currentCommit(storage, commits, entry.gadgetId);
  let { class: fileClass, violations } = commit.classification;
  if (fileClass === "visualWidget" || fileClass === "callableTools" || fileClass === "callableCombined") {
    return commit.statesProblem === null ? null
      : `Gadget ${entry.gadgetId}'s states.json isn't valid: ${commit.statesProblem}`;
  }
  if (fileClass === "viewOnly") return `Gadget ${entry.gadgetId} is a view with no code; offer it as a bound view instead.`;
  let reasons = violations.map(violation => violation.message).join(" ");
  return `Gadget ${entry.gadgetId}'s files are not a widget a console runs.${reasons ? ` ${reasons}` : ""}`;
}

// Whether a commit has no UI: a tools-only callable widget, which is never placed on a screen.
function hasNoUi(commit: SourceCommit | undefined): boolean {
  return commit?.classification.class === "callableTools";
}

/**
 * Why a console of this workspace cannot offer `entry` as a bound view, or null if it can: the
 * gadget must pass the same install checks as a registered widget (`consoleWidgetRefusal`), its
 * current commit must be one of `commits` (else this throws `CONSOLE_CHANGED`) and classified
 * view-only, and its spec's requirement names must equal the entry's as a set.
 */
export function boundViewRefusal(storage: Pick<ConsoleStorage, "gadgets">, entry: BoundViewEntry,
    commits: SourceCommits): string | null {
  let refusal = installRefusal(storage, entry);
  if (refusal) return refusal;
  let commit = currentCommit(storage, commits, entry.gadgetId);
  return viewRefusal(entry, commit);
}

// Why `commit` is not a view `entry` can show: it must be view-only, with a valid spec reading
// exactly the entry's requirements.
function viewRefusal(entry: BoundViewEntry, commit: SourceCommit): string | null {
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

/**
 * The gadget ids the `inferos.gadget` widgets of screen `row` reference: its nested page's, at any
 * depth, while one is current, otherwise its sections'. A row is read unparsed, as stored.
 */
function placedGadgets(storage: Pick<ConsoleStorage, "canvasPages">, row: CanvasDefinition): WorkpieceId[] {
  let nested = nestedPage(storage, row);
  let widgets = nested ? nested.nodes.flatMap(node => node.nodeType === "widget" ? [node] : [])
    : row.sections.flatMap(section => section.widgets);
  return widgets.flatMap(widget => {
    let match = widget.kind === "inferos.gadget" ? CANVAS_GADGET_REF.exec(widget.targetRef) : null;
    return match ? [Number(match[1])] : [];
  });
}

// Whether `record` is an app a screen places: a permanent gadget of this workspace that is not a
// widget install, registered or frozen (those are the widget registry's; see `checkConsoleWidgets`).
function isApp(record: ReturnType<ConsoleStorage["gadgets"]["get"]>): record is GadgetRecord {
  return record?.type === "gadget" && !record.pending && !record.frozenFor && record.installedFrom?.kind !== "widget";
}

/**
 * Each app the screens `content` shows place (FAC-89 part 2), once, in the order the screens show
 * them, at any depth of a nested page, with its current commit (null when it has none).
 */
function placedApps(storage: Pick<ConsoleStorage, "canvases" | "canvasPages" | "gadgets">, content: OperateConsoleContent)
    : { gadgetId: WorkpieceId; commitId: string | null }[] {
  let seen = new Set<WorkpieceId>();
  let apps: { gadgetId: WorkpieceId; commitId: string | null }[] = [];
  for (let screenId of consoleScreens(content)) {
    let row = storage.canvases.get(screenId);
    for (let gadgetId of row ? placedGadgets(storage, row) : []) {
      let record = storage.gadgets.get(gadgetId);
      if (seen.has(gadgetId) || !isApp(record)) continue;
      seen.add(gadgetId);
      apps.push({ gadgetId, commitId: record.commitId ?? null });
    }
  }
  return apps;
}

// The gadget ids a published screen copy places: its frozen page's, at any depth, when it has one,
// otherwise its version 1 copy's. Apps keep their own ids there; only widgets were replaced.
function snapshotGadgets(snapshot: ConsoleScreenSnapshot): WorkpieceId[] {
  let widgets = snapshot.page ? snapshot.page.nodes.flatMap(node => node.nodeType === "widget" ? [node] : [])
    : snapshot.screen.sections.flatMap(section => section.widgets);
  return widgets.flatMap(widget => {
    let match = widget.kind === "inferos.gadget" ? CANVAS_GADGET_REF.exec(widget.targetRef) : null;
    return match ? [Number(match[1])] : [];
  });
}

/** What an operator is told about an app whose commit moved since the console was published. */
function appChanged(record: GadgetRecord | undefined, gadgetId: WorkpieceId, consoleTitle: string): string {
  return `App ${record?.title ?? gadgetId} has changed since console ${consoleTitle} was published; ` +
      "a builder must publish the console again before operators can open it.";
}

/** `page` with each placed gadget the map names replaced by its frozen install, at any depth. */
function withFrozenNodes(page: CanvasPage, frozen: Map<WorkpieceId, WorkpieceId>): CanvasPage {
  return { ...page, nodes: page.nodes.map(node => {
    let match = node.nodeType === "widget" && node.kind === "inferos.gadget" ? CANVAS_GADGET_REF.exec(node.targetRef) : null;
    let replacement = match ? frozen.get(Number(match[1])) : undefined;
    return replacement === undefined ? node : { ...node, targetRef: `gadget:${replacement}` };
  }) };
}

/**
 * The revision of the page screen `screenId` stands for now: its current nested page's, otherwise
 * its row's (a converted page keeps the row's revision). Null if there is no such screen.
 */
function screenRevision(storage: Pick<ConsoleStorage, "canvases" | "canvasPages">, screenId: string): string | null {
  let row = storage.canvases.get(screenId);
  return row ? (nestedPage(storage, row) ?? row).revision : null;
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
 * each entry must pass `consoleWidgetRefusal` (against `commits`, when given), and every widget
 * install (or frozen install) placed on a screen the console shows must be registered and, given
 * `commits`, have a UI. Other gadgets, such as installed apps, are placed as before.
 */
function checkConsoleWidgets(storage: Pick<ConsoleStorage, "canvases" | "canvasPages" | "gadgets">, content: OperateConsoleContent,
    commits?: SourceCommits): void {
  let registered = new Set<WorkpieceId>();
  let noUi = new Set<WorkpieceId>();
  for (let entry of content.widgets ?? []) {
    let refusal = consoleWidgetRefusal(storage, entry, commits);
    if (refusal) throw new Error(`Console widget "${entry.label}": ${refusal}`);
    registered.add(entry.gadgetId);
    let record = storage.gadgets.get(entry.gadgetId);
    if (commits && record?.type === "gadget" && hasNoUi(commits.get(record.commitId!))) noUi.add(entry.gadgetId);
  }
  let isWidget = (id: WorkpieceId) => {
    let record = storage.gadgets.get(id);
    return record?.type === "gadget" && (!!record.frozenFor || record.installedFrom?.kind === "widget");
  };
  for (let screenId of consoleScreens(content)) {
    let screen = storage.canvases.get(screenId);
    let unregistered = screen && placedGadgets(storage, screen).find(id => isWidget(id) && !registered.has(id));
    if (unregistered !== undefined && unregistered !== null) {
      throw new Error(`Screen ${screenId} shows widget ${unregistered}, which the console's widget registry does not offer.`);
    }
    let uiLess = screen && placedGadgets(storage, screen).find(id => noUi.has(id));
    if (uiLess !== undefined && uiLess !== null) {
      throw new Error(`Screen ${screenId} shows widget ${uiLess}, which has no UI; a console offers its tools only.`);
    }
  }
}

/**
 * A screen as a console published it: a copy of the canvas taken when the console was published,
 * so editing the canvas afterwards changes only the draft. Keyed by `consoleScreenKey`.
 */
export type ConsoleScreenSnapshot = {
  consoleId: string;
  screenId: string;
  /** The version 1 copy, for readers without pages: the screen's `canvases` row as it stood. */
  screen: CanvasDefinition;
  /**
   * The nested page the publication froze (FAC-89), when one was current, with placed widget
   * installs replaced by their frozen installs at any depth. Absent otherwise, and on snapshots
   * taken before it was recorded: the page is then `screen` by conversion.
   */
  page?: CanvasPage;
};

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
  /** Each screen the console shows, with the revision of the page it stands for (null if missing). */
  screens: { id: string; revision: string | null }[];
  /** Each app those screens place, with its commit as read (see `placedApps`): what the publication fences. */
  apps: { gadgetId: WorkpieceId; commitId: string | null }[];
};

function captureConsole(storage: Pick<ConsoleStorage, "gadgets" | "canvases" | "canvasPages">, stored: OperateConsole): ConsoleCapture {
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
  // A page saved beside an unchanged row (a nested page) moves only the page's revision.
  let screens = consoleScreens(stored).map(id => ({ id, revision: screenRevision(storage, id) }));
  return { revision: stored.revision, boundViews,
    commitIds: [...new Set(registered.filter(commitId => commitId !== null))], screens, apps: placedApps(storage, stored) };
}

// The surfaces a published widget entry freezes from its source commit: whether it has a UI, and
// its declared tools when it has some (`commits` holds none while console tools are off).
function frozenSurfaces(commit: SourceCommit): Pick<ConsoleWidgetFreeze, "ui" | "tools" | "states"> {
  return { ui: !hasNoUi(commit), ...(commit.tools === null ? {} : { tools: commit.tools }),
    ...(commit.states === null ? {} : { states: commit.states }) };
}

/**
 * Makes `stored`'s draft its published revision, copying in the canvases its views reference.
 * Each registered widget gets a frozen install made through `frozen`, which the published
 * registry and screen copies reference instead of the registered gadget, and the frozen installs
 * of the console's previous publication are removed. Each widget's current commit must be one of
 * `commits`, whose surfaces its entry freezes (`ConsoleWidgetFreeze.ui` and `.tools`), and a widget
 * with no UI must not be placed on a screen. Each bound view must pass `boundViewRefusal` against
 * `commits`, and gets its source commit's spec in `frozen`; no install is made for it. Each listed
 * flow is copied into the publication as it is now (see `publishedFlows`).
 * Everything is checked before anything is created, except the stored record's size, which is
 * checked last. Call inside a storage transaction, which undoes the installs if that refuses.
 * Shared by publishing and the storage migration that publishes consoles saved before publication
 * existed, which have no widgets, bound views or flows.
 */
export function publishConsoleRecord(storage: ConsoleStorage, stored: OperateConsole, publishedAt: string,
    frozen?: FrozenInstalls, commits?: SourceCommits): OperateConsole {
  let { id, revision, published: _, ...content } = stored;
  checkConsoleWidgets(storage, content, commits);
  let screens = publishedPages(storage, content);
  let flows = publishedFlows(storage, content);
  // Apps are fenced, not copied: they keep their storage and bindings (see `ConsolePublishedApp`).
  let apps = placedApps(storage, content).flatMap(({ gadgetId, commitId }): ConsolePublishedApp[] =>
    commitId === null ? [] : [{ gadgetId, commitId }]);
  let entries = content.widgets ?? [];
  if (entries.length > 0 && (!frozen || !commits)) throw new Error("This console's widgets cannot be published here.");
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
    let surfaces = frozenSurfaces(commits!.get(source.commitId!)!);
    let made = frozen!.create(source, { consoleId: id, revision, sourceGadgetId: source.id });
    frozenIds.set(source.id, made.id);
    return { ...entry, gadgetId: made.id, frozen: { sourceGadgetId: source.id, commitId: made.commitId!, ...surfaces } };
  });
  dropPublishedScreens(storage, id);
  for (let { screenId, row, page } of screens) {
    // The publication keeps the real nested page (FAC-89); `screen`, what a version 1 reader of the
    // published console sees, is that page's projection (FAC-83), never the layout it replaced.
    storage.consoleScreens.put({ consoleId: id, screenId,
      screen: withFrozenGadgets(page ? canvasDefinitionProjection(page) : row, frozenIds),
      ...(page ? { page: withFrozenNodes(page, frozenIds) } : {}) });
  }
  let publishedContent = { ...content, ...(content.widgets === undefined ? {} : { widgets }),
    ...(content.boundViews === undefined ? {} : { boundViews }) };
  let result: OperateConsole = { ...stored,
    published: { revision, publishedAt, content: publishedContent, ...(flows.length === 0 ? {} : { flows }),
      screens: screens.map(({ screenId, row, page }) => ({ id: screenId, revision: (page ?? row).revision })), apps } };
  if (jsonBytes(result) > CONSOLE_SIZE_LIMITS.console) {
    throw new Error(`This console would be over ${CONSOLE_SIZE_LIMITS.console} bytes published.`);
  }
  storage.consoles.put(result);
  if (frozen) dropFrozenInstalls(storage, frozen, id, new Set(frozenIds.values()));
  return result;
}

// Each screen `content` shows that exists, with its row and the page it stands for now, for its
// publication. Behavior on a page may navigate only to a page the console also shows, so an
// operator is never sent to one the publication has no copy of; otherwise nothing is published.
function publishedPages(storage: Pick<ConsoleStorage, "canvases" | "canvasPages">, content: OperateConsoleContent) {
  let shown = new Set(consoleScreens(content));
  return consoleScreens(content).flatMap(screenId => {
    let row = storage.canvases.get(screenId);
    if (!row) return [];
    // Only a nested page has behavior; a version 1 row has none.
    let page = nestedPage(storage, row);
    for (let owner of page ? [page, ...page.nodes] : []) {
      for (let attachment of owner.attachments) {
        if (attachment.effect.kind === "navigate" && !shown.has(attachment.effect.page)) {
          throw new Error(`Screen ${screenId} navigates to page ${attachment.effect.page}, which the console does not show.`);
        }
      }
    }
    return [{ screenId, row, page }];
  });
}

// The flows `content` lists, each copied as it is now, for its publication. Each must still exist,
// and every step must be a screen the console shows, so whoever can open the published console can
// render every step of a flow it offers; otherwise nothing is published.
function publishedFlows(storage: Pick<OverseerStorage, "flows">, content: OperateConsoleContent): OperateFlow[] {
  let screens = new Set(consoleScreens(content));
  return (content.flows ?? []).map(id => {
    let flow = storage.flows.get(id);
    if (!flow) throw new Error(`Console flow ${id} is not a flow in this workspace`);
    let outside = flow.steps.find(step => !screens.has(step));
    if (outside) throw new Error(`Console flow "${flow.title}" has step ${outside}, which the console does not show`);
    return { id: flow.id, revision: flow.revision, title: flow.title, steps: [...flow.steps] };
  });
}

/**
 * What `describeBoundView` reads through: the bound-view switch, the caller's console context, and
 * a draft entry's source.
 */
export type BoundViewPorts = {
  /** Whether bound views are on (`boundViewsEnabled`). */
  enabled(): boolean;
  /**
   * The console as the caller's own operate session shows it, from the requested source at the
   * requested revision and re-read through the caller's own access, with the workspace holding
   * it and the session's sequence number (which every session change raises); null when that
   * does not hold.
   */
  run(): Promise<{ workspaceId: string; console: OperateConsole; sessionSeq: number } | null>;
  /**
   * The draft entry's spec, read from its source at `commitId`, or else at its current commit,
   * through the caller's own build access (`Overseer.getConsoleBoundViewDraft`).
   */
  readDraft(workspaceId: string, commitId: string | undefined): Promise<Pick<BoundViewDescription, "commitId" | "specText">>;
};

/**
 * Bound view `entryId` of console `ref` as plain data (`OperateSession.getConsoleBoundView`).
 * Refused while bound views are off, and unless `ports.run` shows the console with that entry and
 * a host board for each of its requirements. A publication delivers only its frozen spec, and only
 * at the frozen commit when `options.commitId` names one. A draft reads its source through
 * `ports.readDraft` and then runs the guard again, refusing a context that moved meanwhile, even
 * one that left and came back (a new `sessionSeq`). The spec is re-parsed with the v1 parser and
 * must read exactly the entry's requirements.
 */
export async function describeBoundView(ref: ConsoleRef, entryId: string, options: { commitId?: string },
    ports: BoundViewPorts): Promise<BoundViewDescription> {
  let refused = () => new Error(
    `Console ${ref.consoleId} at revision ${ref.revision} is not open in your operate session with bound view ${entryId}.`);
  let context = async () => {
    if (!ports.enabled()) throw new Error(BOUND_VIEWS_OFF);
    let run = await ports.run();
    let entry = run?.console.boundViews?.find(candidate => candidate.id === entryId);
    let boards = new Map((run?.console.hostBoards ?? []).map(board => [board.requirement.name, board.id]));
    let requirements = (entry?.requirements ?? []).map(name => ({ name, hostBoardEntryId: boards.get(name) ?? "" }));
    if (!run || !entry || requirements.some(requirement => !requirement.hostBoardEntryId)) throw refused();
    // `sessionSeq` too, as the host boards' guard compares it: leaving the console and returning
    // to it during the draft read shows the same console but is a different visit.
    return { workspaceId: run.workspaceId, sessionSeq: run.sessionSeq, entry, requirements };
  };
  let before = await context();
  let source: Pick<BoundViewDescription, "commitId" | "specText"> | undefined = before.entry.frozen;
  if (ref.source === "draft") {
    source = await ports.readDraft(before.workspaceId, options.commitId);
    if (JSON.stringify(await context()) !== JSON.stringify(before)) throw refused();
  } else if (!source || (options.commitId !== undefined && options.commitId !== source.commitId)) {
    throw refused();
  }
  if (!ports.enabled()) throw new Error(BOUND_VIEWS_OFF);
  let parsed = parseBoundViewSpec(source.specText);
  let names = parsed.ok ? parsed.spec.requirements : [];
  if (names.length !== before.entry.requirements.length || names.some(name => !before.entry.requirements.includes(name))) {
    throw new Error(`Bound view ${entryId}'s spec is not valid.`);
  }
  return { consoleRef: { consoleId: ref.consoleId, source: ref.source, revision: ref.revision }, entryId,
    commitId: source.commitId, specText: source.specText, requirements: before.requirements };
}

/**
 * A workspace's authored consoles, reachable only through a build-capable Overseer session and
 * under the same installation flags as its canvases, which a console's views reference. Editing
 * changes a console's draft; `publish` makes the draft, with copies of its screens, what operators
 * use (see `OperateConsole`).
 */
export class WorkspaceConsoleStore {
  constructor(private durableStorage: DurableObjectStorage, private storage: ConsoleStorage,
      private env: Pick<Cloudflare.Env, "COMPOSABLE_VIEWS" | "DURABLE_VIEWS" | "INFEROPS_HOST_BOARDS" | "INFEROPS_BOUND_VIEWS" | "INFEROPS_ENABLED" | "CONSOLE_TOOLS">,
      private frozen?: FrozenInstalls) {}

  #requireEnabled(): void {
    if (this.env.COMPOSABLE_VIEWS !== "true" || this.env.DURABLE_VIEWS !== "true") {
      throw new Error("Durable views are disabled for this installation");
    }
  }

  // Omitted means keep: editors that predate host boards, bound views or flows send no
  // `hostBoards`, `boundViews` or `flows`, and replacing through them must not delete saved
  // entries. An explicit list (`[]` included) replaces them. The saved entries are merged in before
  // parsing, so the combined registry limit and the requirement names apply.
  #inherit(content: OperateConsoleContent, current?: OperateConsole): OperateConsoleContent {
    return { ...content,
      ...(content.hostBoards === undefined && current?.hostBoards !== undefined ? { hostBoards: current.hostBoards } : {}),
      ...(content.boundViews === undefined && current?.boundViews !== undefined ? { boundViews: current.boundViews } : {}),
      ...(content.flows === undefined && current?.flows !== undefined ? { flows: current.flows } : {}) };
  }

  // A console may only be saved over screens and flows that exist; one deleted later shows as
  // unavailable, and a flow is checked again at publication (see `publishedFlows`). Its widgets and
  // bound views are checked now, against `commits`, and again at publication, since screens and
  // gadgets change.
  #parse(content: OperateConsoleContent, commits: SourceCommits | undefined, current?: OperateConsole): OperateConsoleContent {
    let parsed = parseOperateConsoleContent(this.#inherit(content, current));
    let missing = consoleScreens(parsed).find(screen => !this.storage.canvases.get(screen));
    if (missing) throw new Error(`Console screen ${missing} is not a screen in this workspace`);
    let missingFlow = parsed.flows?.find(flow => !this.storage.flows.get(flow));
    if (missingFlow) throw new Error(`Console flow ${missingFlow} is not a flow in this workspace`);
    checkConsoleWidgets(this.storage, parsed, commits);
    let hostBoards = parsed.hostBoards === undefined ? undefined : this.#hostBoards(parsed.hostBoards, current);
    let boundViews = parsed.boundViews === undefined ? undefined : this.#boundViews(parsed.boundViews, commits, current);
    for (let entry of [...parsed.widgets ?? [], ...hostBoards ?? [], ...boundViews ?? []]) {
      if (jsonBytes(entry) > CONSOLE_SIZE_LIMITS.entry) {
        throw new Error(`Console entry "${entry.label}" is over ${CONSOLE_SIZE_LIMITS.entry} bytes.`);
      }
    }
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
  // pass `boundViewRefusal`, so bound views are saved only given the commits it checks.
  #boundViews(entries: BoundViewEntry[], commits: SourceCommits | undefined, current?: OperateConsole): BoundViewEntry[] {
    if (entries.some(entry => entry.id === undefined) && !boundViewsEnabled(this.env)) throw new Error(BOUND_VIEWS_OFF);
    if (entries.length > 0 && !commits) throw new Error("This console's bound views cannot be saved here.");
    let known = new Map<string, BoundViewEntry>();
    for (let entry of [...current?.boundViews ?? [], ...current?.published?.content.boundViews ?? []]) {
      if (entry.id !== undefined) known.set(entry.id, entry);
    }
    return entries.map(entry => {
      if (entry.id !== undefined && known.get(entry.id)?.gadgetId !== entry.gadgetId) {
        throw new Error(`Bound view ${entry.id} is not this console's, or its gadget changed; add a new entry instead.`);
      }
      let saved = entry.id === undefined ? { ...entry, id: crypto.randomUUID() } : entry;
      let refusal = boundViewRefusal(this.storage, saved, commits!);
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

  // The workspace's widget installs: permanent, unfrozen gadgets installed from a widget blueprint.
  #widgetInstalls() {
    return Array.from(this.storage.gadgets.list()).flatMap(record =>
      record.type === "gadget" && !record.pending && !record.frozenFor && record.installedFrom?.kind === "widget"
        ? [{ record, installed: record.installedFrom }] : []);
  }

  /** The current commits `widgetCandidates` describes, to read first (see `SourceCommits`). */
  widgetCandidateCommitIds(): string[] {
    this.#requireEnabled();
    return this.#widgetInstalls().flatMap(({ record }) => record.commitId ?? []);
  }

  /**
   * Every widget install of this workspace as a console registry candidate (`ConsoleWidgetCandidate`),
   * checked by `consoleWidgetRefusal` against `commits`, which `widgetCandidateCommitIds` names. An
   * install that moved since they were read is refused with `CONSOLE_CHANGED`, as a save would be.
   */
  widgetCandidates(commits: SourceCommits): ConsoleWidgetCandidate[] {
    this.#requireEnabled();
    return this.#widgetInstalls().map(({ record, installed }) => {
      let entry: ConsoleWidgetEntry = { gadgetId: record.id, blueprintId: installed.blueprintId,
        version: installed.version, label: "", state: "resettable" };
      let refusal: string | null;
      try {
        refusal = consoleWidgetRefusal(this.storage, entry, commits);
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err);
      }
      let commit = record.commitId === undefined ? undefined : commits.get(record.commitId);
      let fileClass = commit?.classification.class;
      let runs = fileClass === "visualWidget" || fileClass === "callableTools" || fileClass === "callableCombined";
      return { gadgetId: record.id, blueprintId: entry.blueprintId, version: entry.version,
        versionId: consoleWidgetVersionId(entry), commitId: record.commitId ?? null,
        surfaces: runs ? { ui: fileClass !== "callableTools", tools: commit!.tools?.map(tool => tool.name) ?? [],
          states: commit!.states?.states ?? null } : null,
        refusal };
    });
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
    if (source === "draft") return readCanvasDefinition(this.storage, screenId);
    return this.storage.consoleScreens.get(consoleScreenKey(consoleId, screenId))?.screen ?? null;
  }

  /**
   * The page of one console's screen: as its publication froze it, or (for the draft) the page the
   * screen stands for now (see `currentPage`). Null if that revision of the console doesn't show
   * the screen. A publication made before pages were frozen gives its version 1 copy by conversion.
   */
  page(consoleId: string, screenId: string, source: ConsoleSource): CanvasPage | null {
    let shown = this.get(consoleId, source);
    if (!shown || !consoleScreens(shown).includes(screenId)) return null;
    if (source === "draft") {
      let row = this.storage.canvases.get(screenId);
      return row ? nestedPage(this.storage, row) ?? canvasPageFromDefinition(row) : null;
    }
    let snapshot = this.storage.consoleScreens.get(consoleScreenKey(consoleId, screenId));
    return snapshot ? snapshot.page ?? canvasPageFromDefinition(snapshot.screen) : null;
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
   * The app `gadgetId` as console `consoleId`'s published revision `revision` fenced it (FAC-89
   * part 2): its entry in `ConsolePublication.apps`. Throws if the console is no longer published at
   * `revision`, like a stale console move; if that revision does not place the app (or placed it
   * before apps were fenced, or when it had no commit); and, in words for the operator, once the
   * app's current commit is no longer the one published, until a builder publishes the console
   * again. Never offers the app's mainline in its place, nor any older commit.
   */
  offeredApp(consoleId: string, revision: string, gadgetId: WorkpieceId): ConsolePublishedApp {
    let shown = this.get(consoleId, "published");
    if (!shown) throw new Error(`Console ${consoleId} is not published.`);
    if (shown.revision !== revision) throw new Error(`Console ${consoleId} has changed since it was opened.`);
    let app = shown.published?.apps?.find(candidate => candidate.gadgetId === gadgetId);
    if (!app) throw new Error(`Console ${consoleId} does not offer app ${gadgetId}.`);
    let record = this.storage.gadgets.get(gadgetId);
    if (!isApp(record) || record.commitId !== app.commitId) {
      throw new Error(appChanged(isApp(record) ? record : undefined, gadgetId, shown.title));
    }
    return app;
  }

  /**
   * Whether a published console of this workspace places the app `gadgetId` on a screen it shows
   * (any publication, including one made before apps were fenced): such an app is opened only
   * through that console (`offeredApp`), never directly by an operator.
   */
  placedByPublishedConsole(gadgetId: WorkpieceId): boolean {
    for (let snapshot of this.storage.consoleScreens.list()) {
      if (snapshotGadgets(snapshot).includes(gadgetId)) return isApp(this.storage.gadgets.get(gadgetId));
    }
    return false;
  }

  // The draft's bound view `entryId` at `revision`, whose source must still pass the install checks.
  #draftBoundView(id: string, revision: string, entryId: string): BoundViewEntry {
    this.#requireEnabled();
    let entry = this.#current(id, revision).boundViews?.find(candidate => candidate.id === entryId);
    if (!entry) throw new Error(`Console ${id} has no bound view ${entryId}.`);
    let refusal = installRefusal(this.storage, entry);
    if (refusal) throw new Error(`Console bound view "${entry.label}": ${refusal}`);
    return entry;
  }

  /**
   * The commit a preview of draft bound view `entryId` of console `id` at `revision` reads when it
   * pins none: its source's current one. Refused unless the draft is at `revision` with that entry,
   * and its source passes the install checks of `boundViewRefusal`.
   */
  draftBoundViewCommit(id: string, revision: string, entryId: string): string {
    let commitId = (this.storage.gadgets.get(this.#draftBoundView(id, revision, entryId).gadgetId) as GadgetRecord).commitId;
    if (commitId === undefined) throw new Error(`Bound view ${entryId}'s gadget has no commit yet.`);
    return commitId;
  }

  /**
   * The spec a preview of draft bound view `entryId` of console `id` at `revision` shows, from
   * `commit` (read as `SourceCommits` are, from the commit the preview pins or
   * `draftBoundViewCommit`): checked as `draftBoundViewCommit` checks the entry, and the commit as
   * `boundViewRefusal` checks a source's.
   */
  draftBoundViewSpec(id: string, revision: string, entryId: string, commit: SourceCommit): string {
    let entry = this.#draftBoundView(id, revision, entryId);
    let refusal = viewRefusal(entry, commit);
    if (refusal) throw new Error(`Console bound view "${entry.label}": ${refusal}`);
    return commit.viewText!;
  }

  /**
   * The tool named `tool` of the widget `gadgetId`, as console `consoleId`'s published revision
   * `revision` offers it (see `offeredWidget`): one of the declarations its entry froze at
   * publication. Throws while console tools are off, or if the widget is not offered or declares
   * no such tool. The tool name is the caller's, so no message repeats it.
   */
  offeredTool(consoleId: string, revision: string, gadgetId: WorkpieceId, tool: string)
      : { entry: ConsoleWidgetEntry; tool: WidgetToolDeclaration } {
    if (!consoleToolsEnabled(this.env)) throw new Error(CONSOLE_TOOLS_OFF);
    let entry = this.offeredWidget(consoleId, revision, gadgetId);
    let declared = entry.frozen?.tools?.find(candidate => candidate.name === tool);
    if (!declared) throw new Error(`Widget ${gadgetId} of console ${consoleId} offers no tool by that name.`);
    return { entry, tool: declared };
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
   * and its sources must still be as captured (else `CONSOLE_CHANGED`); widgets and bound views
   * are published only that way, each widget entry freezing its commit's surfaces (with no tools
   * while console tools are off) and each bound view its captured commit's spec.
   */
  publish(id: string, expectedRevision: string, capture?: ConsoleCapture, commits?: SourceCommits): OperateConsole {
    this.#requireEnabled();
    return this.durableStorage.transactionSync(() => {
      let current = this.#current(id, expectedRevision);
      if (capture && JSON.stringify(captureConsole(this.storage, current)) !== JSON.stringify(capture)) {
        throw new Error(CONSOLE_CHANGED);
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
      let surfaces = commits && (consoleToolsEnabled(this.env) ? commits : withoutTools(commits));
      return publishConsoleRecord(this.storage, raised, new Date().toISOString(), this.frozen, capture && surfaces);
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

// `commits` with no tools: what publication freezes while console tools are off.
function withoutTools(commits: SourceCommits): SourceCommits {
  return new Map([...commits].map(([commitId, commit]) => [commitId, { ...commit, tools: null }]));
}
