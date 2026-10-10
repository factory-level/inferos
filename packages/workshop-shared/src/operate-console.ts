import type { WorkpieceId } from "./api.js";
import { MAX_OPERATE_ID_LENGTH, type OperateConsoleRun, type OperateEvent } from "./operate-session.js";

// An authored console: everything one operator role works in, as a menu of views over one
// workspace's screens (canvas ids), stored in that workspace beside its screens and flows. Opening
// one copies what the page needs into the opener's operate session (see `openConsole` in
// operate-session.ts); the console itself holds references, order and settings only, and grants
// nothing. See docs/design/operate-mode.md ("Role consoles").
//
// A console is edited as a draft and reaches operators only when a builder publishes it: the
// stored record's top-level content is the draft, and `published` holds the content (and, in the
// store, the screens) operators use. Saving or previewing a draft never changes what operators see.

/** Most consoles one workspace stores. */
export const MAX_WORKSPACE_CONSOLES = 16;

/** Most views one console's menu holds. */
export const MAX_CONSOLE_VIEWS = 12;

/** Most screens one rollup view summarizes. */
export const MAX_ROLLUP_SCREENS = 12;

/** Longest console or view title. */
export const MAX_CONSOLE_TITLE_LENGTH = 120;

/** Most entries one console's registry offers: widgets, host boards and bound views together. */
export const MAX_CONSOLE_WIDGETS = 16;

/** Most host-board requirements one bound view reads. */
export const MAX_BOUND_VIEW_REQUIREMENTS = 4;

/**
 * Whether a console offers the full chat presentation: `off` (never; the default), `available`
 * (the person may switch to it), `default` (it opens in full chat) or `only` (it is chat-only).
 */
export type ConsoleFullChat = "off" | "available" | "default" | "only";

/** Every `ConsoleFullChat` value, in order of how much full chat it offers. */
export const CONSOLE_FULL_CHAT_MODES: readonly ConsoleFullChat[] = ["off", "available", "default", "only"];

/**
 * One entry of a console's view menu: a `rollup` that summarizes several screens on one page, or
 * a single `screen`. Screens are canvas ids of the console's workspace.
 */
export type ConsoleView =
  | { id: string; title: string; type: "rollup"; screens: string[] }
  | { id: string; title: string; type: "screen"; screen: string };

/** Opt-in customization policy; these flags never grant workspace or resource capabilities. */
export type ConsoleCustomization = {
  /** Whether users may create personal, shareable screens for this console. */
  screens: boolean;
  /** Whether users may add custom widgets to their console experience. */
  widgets: boolean;
  /** Whether users may add application tools to their console experience. */
  tools: boolean;
  /** Whether users may add custom skills to their console experience. */
  skills: boolean;
};

/** Existing consoles permit no personal customization unless explicitly configured. */
export const DEFAULT_CONSOLE_CUSTOMIZATION: Readonly<ConsoleCustomization> = {
  screens: false, widgets: false, tools: false, skills: false,
};

/**
 * What a registered widget's local state may do across publications. Only `resettable` exists: the
 * builder declares that the widget may start with empty state whenever its console is published,
 * since each published revision runs its own frozen install (see `ConsoleWidgetEntry`).
 */
export type ConsoleWidgetState = "resettable";

/** Where a published registry entry's frozen install came from. */
export type ConsoleWidgetFreeze = {
  /** The registered gadget the frozen install was made from. */
  sourceGadgetId: WorkpieceId;
  /** The commit, of the registered gadget at publication, that the frozen install runs. */
  commitId: string;
};

/**
 * One widget a console offers its operators: a gadget of the console's workspace, installed from a
 * widget blueprint at a pinned version, with no bindings. In a draft, `gadgetId` is the registered
 * install. Publishing gives each entry a frozen install, a separate gadget that runs the registered
 * gadget's code as it was then and that nothing can edit, bind or upgrade; in the published
 * content, `gadgetId` is that frozen install and `frozen` says where it came from. Registration
 * offers the widget only; it grants no data or action.
 */
export type ConsoleWidgetEntry = {
  /** The registered install (draft) or its frozen install (published). */
  gadgetId: WorkpieceId;
  /** The blueprint the install came from; must match its `installedFrom`. */
  blueprintId: string;
  /** The blueprint version the install runs; must match its `installedFrom`. */
  version: number;
  /** The name operators see. 1 to `MAX_CONSOLE_TITLE_LENGTH` characters. */
  label: string;
  /** The builder's declaration about the widget's local state. */
  state: ConsoleWidgetState;
  /** Set by publication only; a client-supplied value is dropped. */
  frozen?: ConsoleWidgetFreeze;
};

/** The one resource a host board requires: an InferOps board, read as a bounded snapshot. */
export const HOST_BOARD_RESOURCE = "inferops-board";

/**
 * What a host board reads: one requirement with a name, a resource kind and one canonical fixed
 * target, frozen into the published content. The target identifies the board; it never authorizes
 * a read (ADR 0005). Each operator reads it through a connection they selected themselves.
 */
export type HostBoardRequirement = {
  /** The name the host reads it by (`ConsoleHostBoard.readRequirement`): 1 to 64 letters, digits, - or _. */
  name: string;
  /** The resource kind; only `HOST_BOARD_RESOURCE`. */
  resource: typeof HOST_BOARD_RESOURCE;
  /** `inferops://<tenant>.<workspace>/project/board/<KEY>`, canonical (see `canonicalHostBoardTarget`). */
  target: string;
};

/**
 * One host-rendered board a console offers: trusted host code renders it from a bounded snapshot
 * that each operator reads with a connection of their own. It has no authored code, no install and
 * no server, so publication freezes its requirement and creates nothing. Refused unless the
 * installation turns host boards on (`INFEROPS_HOST_BOARDS`).
 */
export type HostBoardEntry = {
  /** The entry's tag. */
  kind: "host-board";
  /**
   * Server-minted at first save and stable for the entry's life; a new entry omits it. An entry
   * naming an id must be one the console already holds, with exactly that requirement.
   */
  id?: string;
  /** The name operators see. 1 to `MAX_CONSOLE_TITLE_LENGTH` characters. */
  label: string;
  /** What it reads. Immutable once the entry has an id. */
  requirement: HostBoardRequirement;
};

/** Where a published bound view came from, and the spec it shows. */
export type BoundViewFreeze = {
  /** The registered view-only widget install the spec was read from. */
  sourceGadgetId: WorkpieceId;
  /** The commit of that install whose `view.json` was read, at publication. */
  commitId: string;
  /** That commit's `view.json`, as validated at publication. Re-parsed wherever it is used. */
  specText: string;
};

/**
 * One bound view a console offers: a view-only widget install's `view.json` (see `bound-view.ts`),
 * which trusted host code renders from each operator's own reads of the console's host boards. It
 * runs no code and creates no install. In a draft it is read from the registered install at
 * preview; publishing copies the spec into `frozen`, and the published entry shows only that, so
 * later edits to the install, or its deletion, change nothing until the next publication. Refused
 * unless the installation turns bound views on (`INFEROPS_BOUND_VIEWS`).
 */
export type BoundViewEntry = {
  /** The entry's tag. */
  kind: "bound-view";
  /**
   * Server-minted at first save and stable for the entry's life; a new entry omits it. An entry
   * naming an id must be one the console already holds, with the same `gadgetId`.
   */
  id?: string;
  /** The registered view-only widget install, in the draft and in the publication alike. */
  gadgetId: WorkpieceId;
  /** The blueprint the install came from; must match its `installedFrom`. */
  blueprintId: string;
  /** The blueprint version the install runs; must match its `installedFrom`. */
  version: number;
  /** The name operators see. 1 to `MAX_CONSOLE_TITLE_LENGTH` characters. */
  label: string;
  /**
   * The host-board requirement names the view reads: 1 to `MAX_BOUND_VIEW_REQUIREMENTS`, unique,
   * each exactly the requirement name of one of the same console's `hostBoards`, and equal as a
   * set to the spec's own `requirements`.
   */
  requirements: string[];
  /** Set by publication only; a client-supplied value is dropped. */
  frozen?: BoundViewFreeze;
};

/** The authored part of a console. */
export type OperateConsoleContent = {
  /** The console's name, shown on its tile and in the Operate sidebar. 1 to `MAX_CONSOLE_TITLE_LENGTH` characters. */
  title: string;
  /** The view menu, in order; the first view opens first. 1 to `MAX_CONSOLE_VIEWS`, with unique ids. */
  views: ConsoleView[];
  /** Whether the console offers full chat. */
  fullChat: ConsoleFullChat;
  /** Optional for older consoles; omitted flags default to disabled. */
  customization?: ConsoleCustomization;
  /**
   * The widgets this console offers, at most `MAX_CONSOLE_WIDGETS` with unique gadgets. Absent
   * means none. Every widget install placed on the console's screens must be registered here.
   */
  widgets?: ConsoleWidgetEntry[];
  /**
   * The host boards this console offers, with unique ids and requirement names. Absent means
   * none. Together with `widgets` and `boundViews`, at most `MAX_CONSOLE_WIDGETS` entries.
   */
  hostBoards?: HostBoardEntry[];
  /**
   * The bound views this console offers, with unique ids. Absent means none. Each names only
   * requirements of this content's `hostBoards`.
   */
  boundViews?: BoundViewEntry[];
};

/**
 * Which revision of a console to read or open: the `published` one operators use, or the `draft`
 * a builder edits and previews. Reading or opening a draft needs build access.
 */
export type ConsoleSource = "published" | "draft";

/** Every `ConsoleSource` value. */
export const CONSOLE_SOURCES: readonly ConsoleSource[] = ["published", "draft"];

/** The revision of a console operators use, frozen when a builder published it. */
export type ConsolePublication = {
  /** The draft revision that was published. */
  revision: string;
  /** When it was published, as an ISO 8601 timestamp. */
  publishedAt: string;
  /** The console's content as published. */
  content: OperateConsoleContent;
};

/**
 * A stored console. Its content is the draft; `published` is what operators use, or null until a
 * builder first publishes it. The draft has unpublished changes when `published?.revision` differs
 * from `revision`.
 */
export type OperateConsole = OperateConsoleContent & {
  /** Server-minted id, stable for the console's life. */
  id: string;
  /** Decimal draft revision, starting at "0" and raised by one on each replacement. */
  revision: string;
  /** The published revision, or null if the console has never been published. */
  published: ConsolePublication | null;
};

/**
 * A console as operators see it: its published content and revision in place of the draft's, or
 * null if it has never been published.
 */
export function publishedConsole(stored: OperateConsole): OperateConsole | null {
  let published = stored.published;
  if (!published) return null;
  return { ...published.content, id: stored.id, revision: published.revision, published };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function title(value: string, what: string): string {
  let trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CONSOLE_TITLE_LENGTH) {
    throw new TypeError(`A ${what} title must be 1-${MAX_CONSOLE_TITLE_LENGTH} characters.`);
  }
  return trimmed;
}

function screenId(value: string): string {
  if (!ID.test(value) || value.length > MAX_OPERATE_ID_LENGTH) {
    throw new TypeError("A console screen must be a canvas id.");
  }
  return value;
}

/** The ids of every screen a console's views reference, each once, in menu order. */
export function consoleScreens(content: Pick<OperateConsoleContent, "views">): string[] {
  let screens = content.views.flatMap(view => view.type === "rollup" ? view.screens : [view.screen]);
  return [...new Set(screens)];
}

/**
 * Checks a console's content against its limits and returns a trimmed copy. Throws a `TypeError`
 * naming the first problem. It does not check that the screens exist; the store does.
 */
export function parseOperateConsoleContent(content: OperateConsoleContent): OperateConsoleContent {
  let views = content.views;
  if (views.length === 0 || views.length > MAX_CONSOLE_VIEWS) {
    throw new TypeError(`A console must have 1-${MAX_CONSOLE_VIEWS} views.`);
  }
  if (!CONSOLE_FULL_CHAT_MODES.includes(content.fullChat)) {
    throw new TypeError("A console's full chat must be off, available, default or only.");
  }
  let ids = new Set<string>();
  let parsed = views.map((view): ConsoleView => {
    if (!ID.test(view.id)) throw new TypeError("A view id must be 1-64 letters, digits, - or _.");
    if (ids.has(view.id)) throw new TypeError(`View id ${view.id} is used twice.`);
    ids.add(view.id);
    let viewTitle = title(view.title, "view");
    if (view.type === "screen") {
      return { id: view.id, title: viewTitle, type: "screen", screen: screenId(view.screen) };
    }
    if (view.screens.length === 0 || view.screens.length > MAX_ROLLUP_SCREENS) {
      throw new TypeError(`A rollup must summarize 1-${MAX_ROLLUP_SCREENS} screens.`);
    }
    return { id: view.id, title: viewTitle, type: "rollup", screens: view.screens.map(screenId) };
  });
  let widgets = content.widgets === undefined ? undefined : parseWidgets(content.widgets);
  let hostBoards = content.hostBoards === undefined ? undefined : parseHostBoards(content.hostBoards);
  let boundViews = content.boundViews === undefined ? undefined : parseBoundViews(content.boundViews, hostBoards ?? []);
  if ((widgets?.length ?? 0) + (hostBoards?.length ?? 0) + (boundViews?.length ?? 0) > MAX_CONSOLE_WIDGETS) {
    throw new TypeError(`A console offers at most ${MAX_CONSOLE_WIDGETS} widgets, host boards and bound views.`);
  }
  let customization = content.customization;
  if (customization !== undefined) {
    let flags = customization;
    if (typeof flags !== "object" || flags === null ||
        CONSOLE_CUSTOMIZATION_KEYS.some(key => typeof flags[key] !== "boolean")) {
      throw new TypeError("Console customization settings must be booleans.");
    }
    customization = { screens: flags.screens, widgets: flags.widgets, tools: flags.tools, skills: flags.skills };
  }
  return { title: title(content.title, "console"), views: parsed, fullChat: content.fullChat,
    ...(customization === undefined ? {} : { customization }),
    ...(widgets === undefined ? {} : { widgets }),
    ...(hostBoards === undefined ? {} : { hostBoards }),
    ...(boundViews === undefined ? {} : { boundViews }) };
}

function parseWidgets(entries: ConsoleWidgetEntry[]): ConsoleWidgetEntry[] {
  if (entries.length > MAX_CONSOLE_WIDGETS) {
    throw new TypeError(`A console offers at most ${MAX_CONSOLE_WIDGETS} widgets.`);
  }
  let gadgets = new Set<WorkpieceId>();
  return entries.map(entry => {
    if (!Number.isSafeInteger(entry.gadgetId) || entry.gadgetId < 0) {
      throw new TypeError("A console widget must name a gadget id.");
    }
    if (gadgets.has(entry.gadgetId)) throw new TypeError(`Gadget ${entry.gadgetId} is registered twice.`);
    gadgets.add(entry.gadgetId);
    if (!Number.isSafeInteger(entry.version) || entry.version < 1) {
      throw new TypeError("A console widget's version must be a blueprint version number.");
    }
    if (entry.state !== "resettable") {
      throw new TypeError("A console widget must declare its state resettable: each publication " +
          "starts it with empty local state.");
    }
    // `frozen` is publication's to set, so a client's is dropped rather than trusted.
    return { gadgetId: entry.gadgetId, blueprintId: entry.blueprintId, version: entry.version,
      label: title(entry.label, "widget"), state: entry.state };
  });
}

// InferOps' own project identifier bound (uppercase, at most ten characters), narrower than the
// board grammar's, and lowercase tenant and workspace slugs, exactly as the gatekeeper describes a
// board binding, so a target compares equal to the connection's resource URL.
const HOST_BOARD_TARGET =
    /^inferops:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/project\/board\/([A-Z][A-Z0-9]{0,9})\/?$/;

/**
 * The canonical form of a host board's target, `inferops://<tenant>.<workspace>/project/board/<KEY>`
 * with lowercase slugs and an uppercase key of at most ten characters, or null when `value` is not
 * one. A trailing slash and surrounding space are dropped. Pure; it identifies and grants nothing.
 */
export function canonicalHostBoardTarget(value: string): string | null {
  let match = typeof value === "string" ? HOST_BOARD_TARGET.exec(value.trim()) : null;
  return match ? `inferops://${match[1]}/project/board/${match[2]}` : null;
}

function parseHostBoards(entries: HostBoardEntry[]): HostBoardEntry[] {
  let ids = new Set<string>();
  let names = new Set<string>();
  return entries.map(entry => {
    if (entry.kind !== "host-board") throw new TypeError("A host board entry must be of kind host-board.");
    if (entry.id !== undefined) {
      if (!ID.test(entry.id)) throw new TypeError("A host board id must be 1-64 letters, digits, - or _.");
      if (ids.has(entry.id)) throw new TypeError(`Host board ${entry.id} is listed twice.`);
      ids.add(entry.id);
    }
    let { name, resource, target } = entry.requirement;
    if (!ID.test(name)) throw new TypeError("A host board requirement name must be 1-64 letters, digits, - or _.");
    if (names.has(name)) throw new TypeError(`Host board requirement ${name} is named twice.`);
    names.add(name);
    if (resource !== HOST_BOARD_RESOURCE) throw new TypeError(`A host board must require ${HOST_BOARD_RESOURCE}.`);
    let canonical = canonicalHostBoardTarget(target);
    if (!canonical) {
      throw new TypeError("A host board's target must be inferops://<tenant>.<workspace>/project/board/<KEY>, " +
          "with an uppercase key of at most 10 letters and digits.");
    }
    return { kind: "host-board", ...(entry.id === undefined ? {} : { id: entry.id }),
      label: title(entry.label, "host board"), requirement: { name, resource, target: canonical } };
  });
}

/**
 * Checks a console's bound view entries and returns trimmed copies, without `frozen`, which only
 * publication sets. Each needs a unique id when it has one, a gadget id, a string blueprint id, a
 * blueprint version, and an array of 1 to `MAX_BOUND_VIEW_REQUIREMENTS` unique string requirement
 * names, each exactly the name of one of `hostBoards`. Throws a `TypeError` naming the first problem. Whether the gadget is a view-only
 * install with that spec is the store's check.
 */
export function parseBoundViews(entries: BoundViewEntry[], hostBoards: readonly HostBoardEntry[]): BoundViewEntry[] {
  let ids = new Set<string>();
  let boards = new Set(hostBoards.map(board => board.requirement.name));
  return entries.map(entry => {
    if (entry.kind !== "bound-view") throw new TypeError("A bound view entry must be of kind bound-view.");
    if (entry.id !== undefined) {
      if (!ID.test(entry.id)) throw new TypeError("A bound view id must be 1-64 letters, digits, - or _.");
      if (ids.has(entry.id)) throw new TypeError(`Bound view ${entry.id} is listed twice.`);
      ids.add(entry.id);
    }
    if (!Number.isSafeInteger(entry.gadgetId) || entry.gadgetId < 0) {
      throw new TypeError("A bound view must name a gadget id.");
    }
    if (typeof entry.blueprintId !== "string") throw new TypeError("A bound view must name a blueprint id.");
    if (!Number.isSafeInteger(entry.version) || entry.version < 1) {
      throw new TypeError("A bound view's version must be a blueprint version number.");
    }
    let names: unknown = entry.requirements;
    if (!Array.isArray(names) || !names.every((name): name is string => typeof name === "string")) {
      throw new TypeError("A bound view's requirements must be a list of requirement names.");
    }
    if (names.length === 0 || names.length > MAX_BOUND_VIEW_REQUIREMENTS) {
      throw new TypeError(`A bound view reads 1-${MAX_BOUND_VIEW_REQUIREMENTS} host-board requirements.`);
    }
    if (new Set(names).size !== names.length) throw new TypeError("A bound view names a requirement twice.");
    // Exact and case-sensitive, like the spec's own names: a near miss is a different requirement.
    let unknown = names.find(name => !boards.has(name));
    if (unknown !== undefined) {
      throw new TypeError(`Bound view requirement ${unknown} is not the name of one of this console's host boards.`);
    }
    return { kind: "bound-view", ...(entry.id === undefined ? {} : { id: entry.id }), gadgetId: entry.gadgetId,
      blueprintId: entry.blueprintId, version: entry.version, label: title(entry.label, "bound view"),
      requirements: [...names] };
  });
}

const CONSOLE_CUSTOMIZATION_KEYS = Object.keys(DEFAULT_CONSOLE_CUSTOMIZATION) as (keyof ConsoleCustomization)[];

/**
 * Checks a console navigation event against the console's current definition, since a session
 * copies a console in when it opens and the definition may change after. `saved` is the revision
 * the event addresses (the published one, or the draft when previewing), read for the console
 * being opened, else `run`'s. The event or `run` must name `saved`'s revision, so a session moves
 * onto a newly published revision by reopening. `openConsole` must also name one of `saved`'s
 * views and its full chat setting; `openView` one of its views; and `showScreen` a screen of the
 * view `run` shows (a rollup's screens, or a screen view's one), or null. Returns why the event no
 * longer fits, or null when it does or is not a console navigation event.
 */
export function consoleEventMismatch(saved: OperateConsole, run: OperateConsoleRun | null,
    event: OperateEvent): string | null {
  let view = (id: string) => saved.views.find(candidate => candidate.id === id);
  let changed = `Console ${saved.id} has changed since it was opened.`;
  switch (event.type) {
    case "openConsole":
      if (event.revision !== saved.revision) return changed;
      if (!view(event.viewId)) return `View ${event.viewId} is not part of console ${saved.id}.`;
      if (event.fullChat !== saved.fullChat) return `Console ${saved.id}'s full chat setting has changed.`;
      return null;
    case "openView":
      if (run && run.revision !== saved.revision) return changed;
      return view(event.viewId) ? null : `View ${event.viewId} is not part of console ${saved.id}.`;
    case "showScreen": {
      if (event.screenId === null || !run) return null;
      if (run.revision !== saved.revision) return changed;
      let shown = view(run.viewId);
      if (!shown) return `View ${run.viewId} is no longer part of console ${saved.id}.`;
      let screens = shown.type === "rollup" ? shown.screens : [shown.screen];
      return screens.includes(event.screenId) ? null : `Screen ${event.screenId} is not part of view ${shown.id}.`;
    }
    default:
      return null;
  }
}

/**
 * One console revision a host board is read through: the `published` one an operator has open, or
 * the `draft` a builder previews. Bound explicitly: the caller's own operate session must show that
 * console, from that source, at exactly that revision.
 */
export type ConsoleRef = {
  /** The console's id. Its workspace is the one the caller's open console run names. */
  consoleId: string;
  /** Which revision: a draft needs build access. */
  source: ConsoleSource;
  /** The published revision, or the draft revision being previewed. */
  revision: string;
};

/** The bounds of a host board snapshot, as InferOps publishes them. String lengths are UTF-16 code units. */
export const HOST_BOARD_SNAPSHOT_LIMITS = {
  /** Columns on the board. */
  columns: 20,
  /** Issues in any one column. */
  issuesPerColumn: 200,
  /** Issues on the whole board. */
  issues: 500,
  /** The project's identifier. */
  projectIdentifier: 32,
  /** The project's name. */
  projectName: 200,
  /** A column's label. */
  columnLabel: 100,
  /** An issue's identifier. */
  issueIdentifier: 32,
  /** An issue's title. */
  issueTitle: 500,
} as const;

/** A board column's workflow group. */
export type HostBoardViewGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

/** An issue's priority. */
export type HostBoardViewPriority = "urgent" | "high" | "medium" | "low" | "none";

/** One card face of a host board: no id, assignee, lease, run, revision or blocked reason. */
export type HostBoardViewIssue = {
  /** `<KEY>-<n>`. */
  identifier: string;
  /** The issue's title. */
  title: string;
  /** The issue's priority. */
  priority: HostBoardViewPriority;
  /** `yyyy-mm-dd`, or null. */
  targetDate: string | null;
  /** Whether the issue is blocked; the reason is never sent. */
  blocked: boolean;
};

/** One column of a host board, its issues in board order. */
export type HostBoardViewColumn = {
  /** The state's name. */
  label: string;
  /** The state's workflow group. */
  group: HostBoardViewGroup;
  /** The column's issues. */
  issues: HostBoardViewIssue[];
};

/** A host board as trusted host code renders it: bounded, with no ids or provider scope. */
export type HostBoardViewSnapshot = {
  /** The project's display key and name. */
  project: { identifier: string; name: string };
  /** The board's columns in order. */
  columns: HostBoardViewColumn[];
};

/**
 * One read of a host board's requirement, normalized:
 * - `ok`: the snapshot, when the read started (`readAt`, ISO 8601; expiry counts from it), and the
 *   console revision it was read for.
 * - `not-connected`: the caller has no current connection of their own selected for the target.
 * - `unavailable`: refused, failed or timed out; nothing of the cause is given.
 * - `stale`: the connection, selection, console or session changed while the read was in flight,
 *   so its answer was discarded.
 */
export type HostBoardView =
  | { status: "ok"; board: HostBoardViewSnapshot; readAt: string; publicationRevision: string }
  | { status: "not-connected" }
  | { status: "unavailable" }
  | { status: "stale" };

/** What a connection selection for a host board came to. */
export type HostBoardSelection =
  /** The connection is the caller's selection for the target. */
  | { status: "selected" }
  /** A later selection for the same target took its place first. */
  | { status: "superseded" }
  /** It could not be made (the account, console or context no longer fits); nothing was kept. */
  | { status: "failed" };

/**
 * One audited host-board read, kept in the reader's own operate session workspace only. It names
 * no target, title, identifier, count or cause.
 */
export type HostBoardReadAudit = {
  /** The record's kind. */
  kind: "host-board-read";
  /** The console the board was read through. */
  consoleId: string;
  /** The host board entry. */
  entryId: string;
  /** The requirement read. */
  requirementName: string;
  /** What the read came to. Timed-out and superseded reads are never audited. */
  status: "ok" | "not-connected" | "unavailable";
  /** When it was recorded, as an ISO 8601 timestamp. */
  at: string;
};

/**
 * A host board's selection state, delivered in full (see `ConsoleHostBoard.subscribeSelection`):
 * `none`, `pending` (a selection is being made) or `selected`, ordered by `changeSeq`, which rises
 * with every committed change; a client ignores a duplicate or an older one. `unknown` means the
 * subscription no longer reflects the caller's context and has ended: show nothing as current until
 * a fresh subscription and a fresh read. It never carries an account, a target or board data.
 */
export type HostBoardSelectionUpdate =
  | { state: "none" | "pending" | "selected"; changeSeq: number; selectionEpoch: number | null }
  | { state: "unknown" };
