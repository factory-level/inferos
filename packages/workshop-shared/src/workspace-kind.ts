import type { WorkspaceKind } from "./api";
import { BOUND_VIEW_FILE, formatBoundViewProblems, parseBoundViewSpec } from "./bound-view";

// What each workspace kind produces. The kind is deterministic (see `WorkspaceKind`), and this
// module is what makes its output deterministic too: the rules the builder agent is given, the
// files a new gadget starts from, and the check that a gadget's files fit the kind. All three are
// pure, so the kernel, the agent and the UI agree.

/** The file holding a gadget's browser UI. A gadget without it has no UI. */
export const GADGET_UI_FILE = "client.js";

/** The file holding a gadget's server (its Durable Object class). */
export const GADGET_SERVER_FILE = "server.js";

/**
 * Whether a gadget's file is one of its JavaScript modules: what the gadget loader hands the
 * Worker as code, and what makes a widget with `view.json` a `mixedView`.
 */
export function isGadgetModule(path: string): boolean {
  return path.endsWith(".js");
}

/** The file holding a view-only widget's bound view: a declarative spec with no code. */
export const GADGET_VIEW_FILE = BOUND_VIEW_FILE;

/** The file declaring a callable widget's tools, which its server implements. */
export const GADGET_TOOLS_FILE = "tools.json";

/**
 * Stable identifier for one rule a gadget's files can fail, as `classifyGadgetFiles` reports it:
 * - `missingUi`: an app, or a widget with no view or tools, has no `client.js`;
 * - `missingServer`: a workflow, or a widget with no view or tools, has no `server.js`;
 * - `unexpectedUi`: a workflow has `client.js`;
 * - `mixedView`: a widget has `view.json` together with any `.js` file or `tools.json`;
 * - `unexpectedView` / `unexpectedTools`: an app or workflow has `view.json` / `tools.json`;
 * - `invalidView` / `invalidTools`: a widget's `view.json` / `tools.json` does not parse;
 * - `toolsWithoutServer`: a widget has `tools.json` but no `server.js`.
 */
export type GadgetFileViolationCode =
  | "missingUi" | "missingServer" | "unexpectedUi" | "mixedView" | "unexpectedView"
  | "invalidView" | "invalidTools" | "toolsWithoutServer" | "unexpectedTools";

/** One way a gadget's files fail to fit its workspace's kind. */
export type WorkspaceKindViolation = {
  /** Stable identifier for the rule that failed. */
  code: GadgetFileViolationCode;
  /** One sentence for the person or the agent, naming the file and the kind. */
  message: string;
};

/**
 * What a gadget's files make when they fit its kind: an `app`, a `workflow`, or one of the widget
 * classes. A `visualWidget` has `client.js` and `server.js`; a `callableTools` widget has
 * `server.js` and `tools.json` with no UI, and a `callableCombined` one has all three; a `viewOnly`
 * widget has `view.json` and no code at all.
 */
export type GadgetFileClass =
  | "app" | "workflow" | "visualWidget" | "callableTools" | "callableCombined" | "viewOnly";

/** `classifyGadgetFiles`' result: the class when nothing failed, and every violation. */
export type GadgetFileClassification = {
  /** What the files make, or `null` when any rule failed. */
  class: GadgetFileClass | null;
  /** Every rule that failed, in a fixed order; empty when the files fit the kind. */
  violations: WorkspaceKindViolation[];
};

/**
 * The parsers that decide whether a widget's `view.json` and `tools.json` are valid. Each takes the
 * file's text and throws when it does not parse; what it returns is ignored.
 */
export type GadgetFileParsers = {
  /** Parses `view.json`. */
  view(text: string): unknown;
  /** Parses `tools.json`. */
  tools(text: string): unknown;
};

const LABELS: Record<WorkspaceKind, string> = { app: "App", widget: "Widget", workflow: "Workflow" };

/**
 * The rules for building in a workspace of this kind, as a section of the builder agent's system
 * prompt. An app has none: it is what the agent builds by default.
 */
export function workspaceKindContract(kind: WorkspaceKind): string | null {
  switch (kind) {
    case "app":
      return null;
    case "widget":
      return "# This workspace builds a Widget\n\n" +
          "This workspace's kind is Widget. What it produces is one small Gadget that is placed " +
          "on screens beside other widgets, not opened on its own. Build exactly that:\n" +
          `* \`createGadget\` here starts the Gadget from the widget starter (${GADGET_UI_FILE} ` +
          `and ${GADGET_SERVER_FILE}). Read both, then edit them; keep both files.\n` +
          "* The UI is a single compact panel that fills the tile it is given, at any width " +
          "from 280px up. No page chrome, navigation, routes, sidebars or full-page layouts.\n" +
          "* Show one thing well: a status, a short list, one form. Read its data from the " +
          "Gadget's server, which reads from bindings.\n" +
          "* Keep to one Gadget. If the request needs a full application, say that the " +
          "workspace's kind should be switched to App instead of building one here.";
    case "workflow":
      return "# This workspace builds a Workflow\n\n" +
          "This workspace's kind is Workflow. What it produces is one Gadget with no UI, whose " +
          "work runs when a trigger fires: on a schedule, or when an event arrives. Build " +
          "exactly that:\n" +
          `* \`createGadget\` here starts the Gadget from the workflow starter ` +
          `(${GADGET_SERVER_FILE}). Read it, then edit it.\n` +
          `* Never write ${GADGET_UI_FILE}; the file tools refuse it here. The work's results ` +
          "are recorded by the server and reported in chat.\n" +
          "* Put the work in the server's `run(input)` method and keep it idempotent: a " +
          "trigger may deliver the same run more than once.\n" +
          "* Wire at least one trigger that calls `run`: a scheduled task for timed work, or " +
          "a binding hook for an event. A workflow with no trigger never runs, so say so if " +
          "you could not add one.\n" +
          "* Keep to one Gadget. If the request needs a screen people use, say that the " +
          "workspace's kind should be switched to App or Widget instead.";
  }
}

const WIDGET_SERVER = `import { DurableObject } from "cloudflare:workers";

// A widget's server: reads what the widget shows. Replace summary() with a read from a binding.
export class Gadget extends DurableObject {
  summary() {
    return { title: "Widget", value: "Nothing to show yet" };
  }
}
`;

const WIDGET_CLIENT = `// A widget's UI: one compact panel that fills the tile it is placed in. No page chrome.
const root = document.createElement("section");
root.style.cssText =
    "box-sizing:border-box;height:100%;min-width:0;padding:12px;font:14px system-ui;" +
    "display:flex;flex-direction:column;gap:4px;overflow:auto";
const title = document.createElement("h2");
title.style.cssText = "margin:0;font-size:12px;font-weight:600;opacity:.7";
const value = document.createElement("p");
value.style.cssText = "margin:0;font-size:20px";
root.append(title, value);
document.body.style.margin = "0";
document.body.appendChild(root);

const summary = await gadget.summary();
title.textContent = summary.title;
value.textContent = summary.value;
`;

const WORKFLOW_SERVER = `import { DurableObject } from "cloudflare:workers";

// A workflow's server: no UI. A trigger (a scheduled task or a binding hook) calls run().
export class Gadget extends DurableObject {
  // The workflow's work. Idempotent: a trigger may deliver the same run more than once.
  async run(input) {
    const record = { at: Date.now(), input: input ?? null };
    await this.ctx.storage.put("lastRun", record);
    return record;
  }

  // The most recent run, for reporting in chat.
  async lastRun() {
    return (await this.ctx.storage.get("lastRun")) ?? null;
  }
}
`;

/**
 * The files a new gadget starts from in a workspace of this kind, by filename, so its structure
 * is fixed by code rather than by the model. An app starts empty, as gadgets always have.
 */
export function workspaceKindStarter(kind: WorkspaceKind): Record<string, string> | null {
  switch (kind) {
    case "app":
      return null;
    case "widget":
      return { [GADGET_SERVER_FILE]: WIDGET_SERVER, [GADGET_UI_FILE]: WIDGET_CLIENT };
    case "workflow":
      return { [GADGET_SERVER_FILE]: WORKFLOW_SERVER };
  }
}

/** Whether a gadget in a workspace of this kind may have this file. Only a workflow forbids one. */
export function workspaceKindAllowsFile(kind: WorkspaceKind, filename: string): boolean {
  return !(kind === "workflow" && filename === GADGET_UI_FILE);
}

/**
 * Checks one gadget's filenames against its workspace's kind: `classifyGadgetFiles` without file
 * contents. An app or widget needs its UI file, a widget or workflow needs its server, and a
 * workflow must have no UI. Returns every violation; an empty list means the gadget fits.
 */
export function checkWorkspaceKind(
    kind: WorkspaceKind, filenames: Iterable<string>): WorkspaceKindViolation[] {
  let files = new Map<string, string | null>();
  for (let filename of filenames) files.set(filename, null);
  return classifyGadgetFiles(kind, files).violations;
}

// `parseBoundViewSpec` as a classifier parser: throws its problems as one line, with the rename
// hint, since a widget may ship a root view.json that is a data file. The stand-in for the tools
// parser that has not landed yet refuses every file, so nothing callable can be published before
// it does; `parseWidgetTools` (widget-tools.ts) replaces parseWidgetToolsPending.
function parseBoundView(text: string): void {
  let result = parseBoundViewSpec(text);
  if (!result.ok) {
    throw new Error(`${formatBoundViewProblems(result.problems)}; if ${GADGET_VIEW_FILE} is a ` +
        "data file, rename it to publish this gadget");
  }
}
function parseWidgetToolsPending(): never {
  throw new Error(`callable widgets are not supported yet; if ${GADGET_TOOLS_FILE} is a data ` +
      "file, rename it to publish this gadget");
}

const GADGET_FILE_PARSERS: GadgetFileParsers = {
  view: parseBoundView,
  tools: parseWidgetToolsPending,
};

// Whether `text` parses: total, so any throw (or text that could not be read) is a refusal.
function parseProblem(parse: (text: string) => unknown, text: string | null): string | null {
  if (text === null) return "it is not UTF-8 text";
  try {
    parse(text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "it does not parse";
  }
}

/**
 * Classifies one gadget's files for its workspace's kind, reporting every rule that fails (see
 * `GadgetFileViolationCode`). `files` holds every path in the gadget, with the text of the files
 * the classifier parses: a widget's `view.json` and `tools.json`, read as strict UTF-8. A `null`
 * there (unread, or not UTF-8) fails to parse; other paths' values are ignored. Nothing is parsed
 * outside a widget: an app or workflow with either file is refused on its presence alone.
 *
 * In a widget, a present `view.json` or `tools.json` stands in for `client.js`, and `view.json`
 * for `server.js` too; `tools.json` needs `server.js`, reported as `toolsWithoutServer` in place
 * of `missingServer`. `parsers` defaults to the kernel's; tests inject their own.
 */
export function classifyGadgetFiles(
    kind: WorkspaceKind, files: ReadonlyMap<string, string | null>,
    parsers: GadgetFileParsers = GADGET_FILE_PARSERS): GadgetFileClassification {
  let label = LABELS[kind];
  let article = kind === "app" ? "An" : "A";
  let hasUi = files.has(GADGET_UI_FILE);
  let hasServer = files.has(GADGET_SERVER_FILE);
  let hasView = files.has(GADGET_VIEW_FILE);
  let hasTools = files.has(GADGET_TOOLS_FILE);
  let isWidget = kind === "widget";
  let violations: WorkspaceKindViolation[] = [];
  let report = (code: GadgetFileViolationCode, message: string) =>
    violations.push({ code, message });

  // In a widget, a view or tools file stands in for client.js and server.js: a view needs no
  // server, and tools without one are reported as toolsWithoutServer instead.
  let standsIn = isWidget && (hasView || hasTools);
  if (kind === "workflow") {
    if (hasUi) {
      report("unexpectedUi", `A ${label} has no UI, but this gadget has ${GADGET_UI_FILE}.`);
    }
  } else if (!hasUi && !standsIn) {
    report("missingUi",
        `${article} ${label} needs a UI, but this gadget has no ${GADGET_UI_FILE}.`);
  }
  if (kind !== "app" && !hasServer && !standsIn) {
    report("missingServer",
        `A ${label} needs a server, but this gadget has no ${GADGET_SERVER_FILE}.`);
  }
  if (isWidget) {
    let code = [...files.keys()].filter(isGadgetModule).toSorted();
    if (hasView && (code.length > 0 || hasTools)) {
      let others = hasTools ? [...code, GADGET_TOOLS_FILE] : code;
      report("mixedView", `A ${label} with ${GADGET_VIEW_FILE} is a view with no code, but ` +
          `this gadget also has ${others.join(", ")}.`);
    }
    let viewProblem = hasView
        ? parseProblem(parsers.view, files.get(GADGET_VIEW_FILE) ?? null) : null;
    if (viewProblem !== null) {
      report("invalidView",
          `This gadget's ${GADGET_VIEW_FILE} is not a valid view: ${viewProblem}.`);
    }
    let toolsProblem = hasTools
        ? parseProblem(parsers.tools, files.get(GADGET_TOOLS_FILE) ?? null) : null;
    if (toolsProblem !== null) {
      report("invalidTools",
          `This gadget's ${GADGET_TOOLS_FILE} is not a valid tool list: ${toolsProblem}.`);
    }
    if (hasTools && !hasServer) {
      report("toolsWithoutServer", `A ${label}'s ${GADGET_TOOLS_FILE} is served by its ` +
          `${GADGET_SERVER_FILE}, but this gadget has none.`);
    }
  } else {
    for (let file of [GADGET_VIEW_FILE, GADGET_TOOLS_FILE]) {
      if (!files.has(file)) continue;
      report(file === GADGET_VIEW_FILE ? "unexpectedView" : "unexpectedTools",
          `${article} ${label} does not use ${file}; rename this gadget's ${file} to publish it.`);
    }
  }

  if (violations.length > 0) return { class: null, violations };
  let fileClass: GadgetFileClass = !isWidget ? kind as "app" | "workflow"
      : hasView ? "viewOnly"
      : hasTools ? (hasUi ? "callableCombined" : "callableTools")
      : "visualWidget";
  return { class: fileClass, violations };
}

/**
 * The violations that refuse publishing a blueprint version of this kind. A widget is refused on
 * every one. An app or workflow is refused only on `unexpectedView` and `unexpectedTools`: its
 * other rules were never enforced at publish, and still are not.
 */
export function blueprintPublishRefusals(
    kind: WorkspaceKind, violations: readonly WorkspaceKindViolation[]): WorkspaceKindViolation[] {
  if (kind === "widget") return [...violations];
  return violations.filter(({ code }) => code === "unexpectedView" || code === "unexpectedTools");
}
