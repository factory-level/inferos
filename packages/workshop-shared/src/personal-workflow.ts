// A person's personal workflows (FAC-134, capability 2): a short, ordered list of published console
// commands, each with a fixed input, created only by the person's own approval of an action that
// declared it (`ActionDescription.personalWorkflow`) and kept in their own operate session. It is
// not a workflow definition: it has no code and no connection of its own, it can't be published,
// shared, pinned or duplicated, and it expires. Running one is a second approval
// (`ActionDescription.personalWorkflowRun`): each step then asks the console's own workspace, which
// checks everything a console command request checks (FAC-14) except that the console is open on
// the person's page, and places the step's write as that console's pending request, decided by its
// builders. Nothing here grants a command, a connection or a permission.
//
// The references are InferOps' (inferops `domain/ts/chatbot/backend/personal-workflow.ts` and
// `workflow-invoke.ts`), and these parsers accept exactly what those do:
//   inferops://<company>.<workspace>/inferos/console-command/<workspace>/<console>/<widget>/<command>?revision="<n>"
//   inferops://<company>.<workspace>/inferos/personal-workflow/<workspace>/<id>

import { commandInputProblem, isPlainLine, type WidgetCommandName } from "./widget-tools";

/** The kind segment of a console command reference. */
export const CONSOLE_COMMAND_KIND = "inferos/console-command";

/** The kind segment of a personal workflow reference. */
export const PERSONAL_WORKFLOW_KIND = "inferos/personal-workflow";

/** The bounds of a personal workflow, as InferOps holds them too where it can. */
export const PERSONAL_WORKFLOW_LIMITS = Object.freeze({
  /** Steps in one personal workflow. */
  steps: 10,
  /** A title's length, in UTF-16 code units, after trimming. */
  titleChars: 120,
  /** Personal workflows one operate session keeps at once. */
  workflows: 20,
});

/** What a console command reference names, once well formed. Nothing in it grants anything. */
export type ConsoleCommandRef = {
  /** The InferOps company slug the proposal was made in. */
  company: string;
  /** The InferOps workspace slug. */
  workspace: string;
  /** The InferOS workspace whose console it is. */
  workspaceId: string;
  /** The console. */
  consoleId: string;
  /** Its published revision the person saw: the console store's decimal counter. */
  revision: string;
  /** The widget the console offers, by its frozen install. */
  gadgetId: number;
  /** The command's name, as the widget's `tools.json` declares it. */
  command: string;
};

/** What a personal workflow reference names, once well formed. Nothing in it grants anything. */
export type PersonalWorkflowRef = {
  /** The InferOps company slug. */
  company: string;
  /** The InferOps workspace slug. */
  workspace: string;
  /** The operate session workspace that keeps it. */
  sessionWorkspaceId: string;
  /** The personal workflow's id there. */
  personalWorkflowId: string;
};

/**
 * One step of a personal workflow, as stored: the command it names and the fixed input the person
 * approved. The input never carries the issue's revision (the lead's D2): the step reads the issue's
 * current revision when it runs, and its request is decided against the issue as it is then.
 */
export type PersonalWorkflowStep = {
  /** The canonical console command reference. */
  reference: string;
  workspaceId: string;
  consoleId: string;
  revision: string;
  gadgetId: number;
  command: string;
  /** The transition's input, without `expectedRevision`. */
  input: { issueId: string; toStateId: string };
};

/** A personal workflow, as its owner reads it in their own operate session. */
export type PersonalWorkflow = {
  id: string;
  title: string;
  steps: PersonalWorkflowStep[];
  createdAt: Date;
  /** After this, it can't be run, and the sweep removes it (a run in progress finishes). */
  expiresAt: Date;
  /** The approved action that created it. */
  fromAction: number;
};

/** What `ActionDescription.personalWorkflow` declares, once checked. */
export type PersonalWorkflowDeclaration = {
  title: string;
  steps: { reference: string; input: { issueId: string; toStateId: string } }[];
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const WIDGET = /^[1-9][0-9]{0,15}$/;
const COMMAND = /^[a-z][A-Za-z0-9]{0,47}$/;
const CONSOLE_REVISION = /^(0|[1-9][0-9]{0,18})$/;
const QUOTED = /^"([^"]*)"$/;

// `link` split as an inferops:// reference of kind `kind`: its two host labels, the path after the
// kind, and its quoted parameters. Null unless it is exactly that shape.
function splitRef(link: unknown, kind: string)
    : { labels: [string, string]; path: string[]; params: Map<string, string> } | null {
  if (typeof link !== "string" || link.length > 2000 || !link.startsWith("inferops://")) return null;
  let rest = link.slice("inferops://".length);
  let query = rest.indexOf("?");
  let [host, ...path] = (query < 0 ? rest : rest.slice(0, query)).split("/");
  let labels = host?.split(".") ?? [];
  if (labels.length !== 2 || !labels.every(label => SLUG.test(label))) return null;
  let [domain, segment, ...after] = path;
  if (`${domain}/${segment}` !== kind) return null;
  let params = new Map<string, string>();
  if (query >= 0) {
    for (let pair of rest.slice(query + 1).split("&")) {
      let at = pair.indexOf("=");
      if (at < 0) return null;
      let name = pair.slice(0, at);
      let value = QUOTED.exec(pair.slice(at + 1))?.[1];
      if (value === undefined || params.has(name)) return null;
      params.set(name, value);
    }
  }
  return { labels: [labels[0]!, labels[1]!], path: after, params };
}

/** `link` as a console command reference, or null unless it is exactly one, well formed. */
export function parseConsoleCommandRef(link: unknown): ConsoleCommandRef | null {
  let split = splitRef(link, CONSOLE_COMMAND_KIND);
  if (!split) return null;
  let [workspaceId, consoleId, widget, command, ...extra] = split.path;
  let revision = split.params.get("revision");
  if (extra.length > 0 || split.params.size !== 1 || revision === undefined || !CONSOLE_REVISION.test(revision)) return null;
  if (!workspaceId || !SEGMENT.test(workspaceId) || !consoleId || !SEGMENT.test(consoleId)) return null;
  if (!widget || !WIDGET.test(widget) || !command || !COMMAND.test(command)) return null;
  return {
    company: split.labels[0], workspace: split.labels[1], workspaceId, consoleId, revision,
    gadgetId: Number(widget), command,
  };
}

/** A console command's canonical reference, as InferOps formats one. */
export function consoleCommandRef(ref: ConsoleCommandRef): string {
  return `inferops://${ref.company}.${ref.workspace}/${CONSOLE_COMMAND_KIND}/${ref.workspaceId}/${ref.consoleId}/` +
    `${ref.gadgetId}/${ref.command}?revision="${ref.revision}"`;
}

/** `link` as a personal workflow reference, or null unless it is exactly one, well formed. */
export function parsePersonalWorkflowRef(link: unknown): PersonalWorkflowRef | null {
  let split = splitRef(link, PERSONAL_WORKFLOW_KIND);
  if (!split) return null;
  let [sessionWorkspaceId, personalWorkflowId, ...extra] = split.path;
  if (extra.length > 0 || split.params.size > 0) return null;
  if (!sessionWorkspaceId || !SEGMENT.test(sessionWorkspaceId)) return null;
  if (!personalWorkflowId || !SEGMENT.test(personalWorkflowId)) return null;
  return { company: split.labels[0], workspace: split.labels[1], sessionWorkspaceId, personalWorkflowId };
}

/** A personal workflow's canonical reference, as InferOps formats one. */
export function personalWorkflowRef(ref: PersonalWorkflowRef): string {
  return `inferops://${ref.company}.${ref.workspace}/${PERSONAL_WORKFLOW_KIND}/${ref.sessionWorkspaceId}/${ref.personalWorkflowId}`;
}

/**
 * Why `input` is not a personal workflow step's input for `command`, or null when it is: the
 * command's own input (`commandInputProblem`) without the issue's revision, which the step reads
 * when it runs (D2). A step that names a revision is refused, so no approved step can carry a stale
 * one. Like `commandInputProblem`, it names a field, never a value.
 */
export function personalWorkflowStepInputProblem(command: WidgetCommandName | string, input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "it is not an object";
  if (Object.hasOwn(input, "expectedRevision")) return `"expectedRevision" is read when the step runs`;
  return commandInputProblem(command as WidgetCommandName, { ...input, expectedRevision: "0" });
}

/**
 * `value` as a personal workflow declaration (`ActionDescription.personalWorkflow`), or a thrown
 * error naming what is wrong (never a value): a title of 1 to `PERSONAL_WORKFLOW_LIMITS.titleChars`
 * characters on one line of plain text (`isPlainLine`) and 1 to `PERSONAL_WORKFLOW_LIMITS.steps` steps, each exactly `{reference, input}`, a
 * console command reference and the transition's input without its revision. Only the shape is
 * checked here: whether each command is offered to the approver is checked at approval, in each
 * console's own workspace.
 */
export function parsePersonalWorkflowDeclaration(value: unknown): PersonalWorkflowDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("A declared personal workflow is an object.");
  }
  let { title, steps, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length > 0) throw new Error("A declared personal workflow has only a title and steps.");
  if (typeof title !== "string" || title.trim().length === 0 || title.trim().length > PERSONAL_WORKFLOW_LIMITS.titleChars) {
    throw new Error(`A personal workflow's title is 1 to ${PERSONAL_WORKFLOW_LIMITS.titleChars} characters.`);
  }
  // Refused, never flattened: the kernel's own field quotes it, so it is one line of plain text or
  // the declaration isn't valid (a title with a line break could add lines in InferOS's voice).
  if (!isPlainLine(title)) throw new Error("A personal workflow's title is one line of plain text.");
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > PERSONAL_WORKFLOW_LIMITS.steps) {
    throw new Error(`A personal workflow has 1 to ${PERSONAL_WORKFLOW_LIMITS.steps} steps.`);
  }
  let checked = steps.map((step: unknown, index) => {
    if (typeof step !== "object" || step === null || Array.isArray(step)) throw new Error(`Step ${index + 1} is not an object.`);
    let { reference, input, ...rest } = step as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new Error(`Step ${index + 1} has only a reference and an input.`);
    let ref = parseConsoleCommandRef(reference);
    if (!ref) throw new Error(`Step ${index + 1} must name an InferOS console command reference.`);
    // The only template there is (WIDGET_COMMANDS); approval checks the command's own again.
    let problem = personalWorkflowStepInputProblem("inferops.issue.transition", input);
    if (problem !== null) throw new Error(`Step ${index + 1}'s input does not fit: ${problem}.`);
    let { issueId, toStateId } = input as { issueId: string; toStateId: string };
    return { reference: consoleCommandRef(ref), input: { issueId, toStateId } };
  });
  return { title: title.trim(), steps: checked };
}

/**
 * The kernel's own words for a declared personal workflow, every step and its input, as the field
 * it appends to the action (`PERSONAL_WORKFLOW_FIELD_LABEL`): what the person's approval creates,
 * whatever the gatekeeper's text says.
 */
export function personalWorkflowFieldValue(declaration: PersonalWorkflowDeclaration): string {
  let lines = declaration.steps.map((step, index) => {
    let ref = parseConsoleCommandRef(step.reference)!;
    return `${index + 1}. Command ${ref.command} of widget ${ref.gadgetId}, console ${ref.consoleId} at revision ` +
      `${ref.revision}, workspace ${ref.workspaceId}: move issue ${step.input.issueId} to state ${step.input.toStateId}.`;
  });
  return [`"${declaration.title}", ${declaration.steps.length} step${declaration.steps.length === 1 ? "" : "s"}:`, ...lines,
    "For each step, the issue's revision is read when it runs, and the step only places a request " +
    "that the console's builders decide. It is kept only in your operate session, and it expires."].join("\n");
}
