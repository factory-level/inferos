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

/** Most widgets one console's registry offers. */
export const MAX_CONSOLE_WIDGETS = 16;

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
    ...(widgets === undefined ? {} : { widgets }) };
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
