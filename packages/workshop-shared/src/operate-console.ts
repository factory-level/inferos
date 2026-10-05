import { MAX_OPERATE_ID_LENGTH, type OperateConsoleRun, type OperateEvent } from "./operate-session.js";

// An authored console: everything one operator role works in, as a menu of views over one
// workspace's screens (canvas ids), stored in that workspace beside its screens and flows. Opening
// one copies what the page needs into the opener's operate session (see `openConsole` in
// operate-session.ts); the console itself holds references, order and settings only, and grants
// nothing. See docs/architecture/operate-mode.md and its Obsidian design references ("Role consoles").

/** Most consoles one workspace stores. */
export const MAX_WORKSPACE_CONSOLES = 16;

/** Most views one console's menu holds. */
export const MAX_CONSOLE_VIEWS = 12;

/** Most screens one rollup view summarizes. */
export const MAX_ROLLUP_SCREENS = 12;

/** Longest console or view title. */
export const MAX_CONSOLE_TITLE_LENGTH = 120;

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
};

/** A stored console. */
export type OperateConsole = OperateConsoleContent & {
  /** Server-minted id, stable for the console's life. */
  id: string;
  /** Decimal revision, starting at "0" and raised by one on each replacement. */
  revision: string;
};

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
    ...(customization === undefined ? {} : { customization }) };
}

const CONSOLE_CUSTOMIZATION_KEYS = Object.keys(DEFAULT_CONSOLE_CUSTOMIZATION) as (keyof ConsoleCustomization)[];

/**
 * Checks a console navigation event against the console's current definition, since a session
 * copies a console in when it opens and the definition may change after. `openConsole` must name
 * one of `saved`'s views and its current full chat setting; `openView` one of its views; and
 * `showScreen` a screen of the view `run` shows (a rollup's screens, or a screen view's one), or
 * null. Returns why the event no longer fits, or null when it does or is not a console navigation
 * event. `saved` is the console the event addresses: the one being opened, else `run`'s.
 */
export function consoleEventMismatch(saved: OperateConsole, run: OperateConsoleRun | null,
    event: OperateEvent): string | null {
  let view = (id: string) => saved.views.find(candidate => candidate.id === id);
  switch (event.type) {
    case "openConsole":
      if (!view(event.viewId)) return `View ${event.viewId} is not part of console ${saved.id}.`;
      if (event.fullChat !== saved.fullChat) return `Console ${saved.id}'s full chat setting has changed.`;
      return null;
    case "openView":
      return view(event.viewId) ? null : `View ${event.viewId} is not part of console ${saved.id}.`;
    case "showScreen": {
      if (event.screenId === null || !run) return null;
      let shown = view(run.viewId);
      if (!shown) return `View ${run.viewId} is no longer part of console ${saved.id}.`;
      let screens = shown.type === "rollup" ? shown.screens : [shown.screen];
      return screens.includes(event.screenId) ? null : `Screen ${event.screenId} is not part of view ${shown.id}.`;
    }
    default:
      return null;
  }
}
