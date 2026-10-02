import type { WorkspaceKind } from "./api";

// What each workspace kind produces. The kind is deterministic (see `WorkspaceKind`), and this
// module is what makes its output deterministic too: the rules the builder agent is given, the
// files a new gadget starts from, and the check that a gadget's files fit the kind. All three are
// pure, so the kernel, the agent and the UI agree.

/** The file holding a gadget's browser UI. A gadget without it has no UI. */
export const GADGET_UI_FILE = "client.js";

/** The file holding a gadget's server (its Durable Object class). */
export const GADGET_SERVER_FILE = "server.js";

/** One way a gadget's files fail to fit its workspace's kind. */
export type WorkspaceKindViolation = {
  /** Stable identifier for the rule that failed. */
  code: "missingUi" | "missingServer" | "unexpectedUi";
  /** One sentence for the person or the agent, naming the file and the kind. */
  message: string;
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
 * Checks one gadget's filenames against its workspace's kind. An app or widget needs its UI file,
 * a widget or workflow needs its server, and a workflow must have no UI. Returns every violation;
 * an empty list means the gadget fits.
 */
export function checkWorkspaceKind(
    kind: WorkspaceKind, filenames: Iterable<string>): WorkspaceKindViolation[] {
  let files = new Set(filenames);
  let label = LABELS[kind];
  let violations: WorkspaceKindViolation[] = [];
  if (kind === "workflow") {
    if (files.has(GADGET_UI_FILE)) {
      violations.push({
        code: "unexpectedUi",
        message: `A ${label} has no UI, but this gadget has ${GADGET_UI_FILE}.`,
      });
    }
  } else if (!files.has(GADGET_UI_FILE)) {
    violations.push({
      code: "missingUi",
      message: `${kind === "app" ? "An" : "A"} ${label} needs a UI, but this gadget has no ` +
          `${GADGET_UI_FILE}.`,
    });
  }
  if (kind !== "app" && !files.has(GADGET_SERVER_FILE)) {
    violations.push({
      code: "missingServer",
      message: `A ${label} needs a server, but this gadget has no ${GADGET_SERVER_FILE}.`,
    });
  }
  return violations;
}
