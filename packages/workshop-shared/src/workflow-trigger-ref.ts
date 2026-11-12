// A published workflow's trigger, as InferOps' Dot names it when it proposes a run (FAC-120): the
// InferOps company and workspace the proposal was made in, the InferOS workspace and hook of the
// trigger, and the definition and revision the person saw. It names a target and authorizes
// nothing (inferops ADR 0011 N1): a run starts only after the person approves it here, as them, with
// every check of a run they start themselves.
//
// The format is InferOps' (`domain/ts/chatbot/backend/workflow-invoke.ts`, inferops#2627):
//   inferops://<company>.<workspace>/inferos/workflow-trigger/<inferosWorkspaceId>/<hookId>?definition="<id>"&revision="<n>"
// and this parser accepts exactly what that one does, nothing more.

/** The kind segment of a trigger reference. */
export const WORKFLOW_TRIGGER_KIND = "inferos/workflow-trigger";

/** What a trigger reference names, once well formed. Nothing in it grants anything. */
export type WorkflowTriggerRef = {
  /** The InferOps company slug the proposal was made in. */
  company: string;
  /** The InferOps workspace slug. */
  workspace: string;
  /** The InferOS workspace whose trigger it is. */
  inferosWorkspaceId: string;
  /** The trigger's hook, in that workspace. */
  hookId: number;
  /** The workflow definition the person saw. */
  definitionId: string;
  /** Its published revision the person saw, from 1. */
  revision: number;
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const HOOK = /^[1-9][0-9]{0,15}$/;
const REVISION = /^[1-9][0-9]{0,8}$/;
const QUOTED = /^"([^"]*)"$/;

/** `link` as a trigger reference, or null unless it is exactly one, well formed. */
export function parseWorkflowTriggerRef(link: unknown): WorkflowTriggerRef | null {
  if (typeof link !== "string" || link.length > 2000 || !link.startsWith("inferops://")) return null;
  let rest = link.slice("inferops://".length);
  let query = rest.indexOf("?");
  if (query < 0) return null;
  let [host, ...path] = rest.slice(0, query).split("/");
  let labels = host?.split(".") ?? [];
  if (labels.length !== 2 || !labels.every(label => SLUG.test(label))) return null;
  let [domain, kind, inferosWorkspaceId, hook, ...extra] = path;
  if (`${domain}/${kind}` !== WORKFLOW_TRIGGER_KIND || extra.length > 0) return null;
  if (!inferosWorkspaceId || !SEGMENT.test(inferosWorkspaceId) || !hook || !HOOK.test(hook)) return null;
  let params = new Map<string, string>();
  for (let pair of rest.slice(query + 1).split("&")) {
    let at = pair.indexOf("=");
    if (at < 0) return null;
    let name = pair.slice(0, at);
    let value = QUOTED.exec(pair.slice(at + 1))?.[1];
    if (value === undefined || params.has(name)) return null;
    params.set(name, value);
  }
  let definitionId = params.get("definition");
  let revision = params.get("revision");
  if (params.size !== 2 || !definitionId || !SEGMENT.test(definitionId) || !revision || !REVISION.test(revision)) {
    return null;
  }
  return {
    company: labels[0]!, workspace: labels[1]!, inferosWorkspaceId, hookId: Number(hook),
    definitionId, revision: Number(revision),
  };
}

/** A trigger's canonical reference, as InferOps formats one. */
export function workflowTriggerRef(ref: WorkflowTriggerRef): string {
  return `inferops://${ref.company}.${ref.workspace}/${WORKFLOW_TRIGGER_KIND}/${ref.inferosWorkspaceId}/${ref.hookId}` +
    `?definition="${ref.definitionId}"&revision="${ref.revision}"`;
}
