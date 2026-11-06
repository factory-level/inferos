/**
 * A page's configuration, traced (FAC-95): every setting with the level that owns its value, every
 * page hook (an attachment, FAC-94) with the page or node that holds it, and every workspace hook
 * (a gatekeeper's, read-only here) with what it starts, each with its permitted effect in plain
 * words. Pure: the kernel gathers the inputs with the caller's own access. Nothing in a trace grants
 * anything; it says what each piece of configuration may do and who owns it.
 */
import { formatCanvasTarget, type CanvasAttachment, type CanvasPage } from "./canvas-model";
import { resolveWorkspaceSettings, type WorkspaceSettingKey, type WorkspaceSettingOwner, type WorkspaceSettings } from "./workspace-settings";

/** A workspace hook as the trace shows it: delivered by a gatekeeper, waking a gadget. */
export type TracedWorkspaceHookInput = {
  hookId: number;
  title: string;
  enabled: boolean;
  gatekeeperId: number;
  gadgetId: number;
  /** The workflow definition revision the hook is pinned to, or null. */
  pinned: { definitionId: string; revision: number } | null;
};

/** One traced piece of configuration. */
export type ConfigurationTraceEntry =
  | {
      kind: "setting";
      key: WorkspaceSettingKey;
      value: boolean | string;
      /** Whether the page overrides it, the workspace sets it, or it is the default. */
      owner: WorkspaceSettingOwner;
      permits: string;
    }
  | {
      kind: "page-hook";
      /** The page or node that holds the attachment, as `formatCanvasTarget` writes it. */
      owner: string;
      /** The attachment itself, as `formatCanvasTarget` writes it. */
      target: string;
      on: string;
      effect: CanvasAttachment["effect"]["kind"];
      permits: string;
    }
  | {
      kind: "workspace-hook";
      hookId: number;
      title: string;
      enabled: boolean;
      /** Who owns it: the gatekeeper that delivers it and the gadget it wakes. */
      owner: { gatekeeperId: number; gadgetId: number };
      pinned: { definitionId: string; revision: number } | null;
      permits: string;
    };

// What an attachment's effect may do, in plain words.
function attachmentPermits(attachment: CanvasAttachment): string {
  let { effect } = attachment;
  switch (effect.kind) {
    case "navigate": return `Moves the person's own page to ${effect.page}. It grants nothing.`;
    case "raise-event": return `Raises "${effect.event}" on ${effect.target}, within this page. It grants nothing.`;
    case "request-action": return `Asks for "${effect.action}" on ${effect.target}; it runs only with the person's own grant and approval.`;
  }
}

/**
 * Trace `page`'s configuration (or the workspace's alone, with no page): its settings as `page`
 * resolves them against `workspace`, its page hooks in page order (the page's own, then each node's),
 * and the workspace's hooks, read-only, in the order given.
 */
export function traceConfiguration(workspace: WorkspaceSettings, page: CanvasPage | null,
    hooks: readonly TracedWorkspaceHookInput[] = []): ConfigurationTraceEntry[] {
  let entries: ConfigurationTraceEntry[] = resolveWorkspaceSettings(workspace, page?.settings)
    .map(({ key, value, owner, permits }) => ({ kind: "setting", key, value, owner, permits }));
  if (page) {
    let holders = [
      { owner: formatCanvasTarget({ kind: "page", pageId: page.id }), attachments: page.attachments },
      ...page.nodes.map(node => ({ owner: formatCanvasTarget({ kind: "node", pageId: page.id, nodeId: node.id }), attachments: node.attachments })),
    ];
    for (let { owner, attachments } of holders) {
      for (let attachment of attachments) {
        entries.push({ kind: "page-hook", owner,
          target: formatCanvasTarget({ kind: "attachment", pageId: page.id, attachmentId: attachment.id }),
          on: attachment.on, effect: attachment.effect.kind, permits: attachmentPermits(attachment) });
      }
    }
  }
  for (let hook of hooks) {
    entries.push({ kind: "workspace-hook", hookId: hook.hookId, title: hook.title, enabled: hook.enabled,
      owner: { gatekeeperId: hook.gatekeeperId, gadgetId: hook.gadgetId }, pinned: hook.pinned,
      permits: hook.pinned
        ? "Starts its pinned workflow when the service delivers the event, as its trigger is configured. Read-only here."
        : "Wakes its gadget when the service delivers the event. Read-only here." });
  }
  return entries;
}
