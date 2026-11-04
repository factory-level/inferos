/**
 * A console's widgets in the deployment's widget index (FAC-11 slice 2, inferops ADR 0013 W10).
 *
 * When a builder publishes a console, each widget its live publication registers is listed in the
 * widget index of the deployment's shared-configuration service (InferOps' `widget.publish`), and a
 * version no published console of the workspace lists any more is withdrawn (`widget.withdraw`).
 * Every write is the publishing person's own, through their own connected account of the vendor
 * `SHARED_CONFIGURATION_GATEKEEPER` names, synchronously from the build-role `publishConsole` and
 * `deleteConsole` only: no gadget, agent, use-role or operate session reaches it, and it never goes
 * through the approval queue, since the person's own publish is what a person would approve (see
 * `docs/adr/0016-console-widget-index-writes.md`). The service decides live or refused against the
 * person's own grant, and its answer is recorded as it gave it.
 *
 * The local publication never waits on the index: it is already committed, and operators get it
 * whatever the service answers. What the service answered is kept beside the console
 * (`ConsoleWidgetIndexRecord`) for the builder to read (`ConsoleWidgetIndexReport`). The target
 * workspace is explicit: the only one where the person may list widgets, or the one chosen for the
 * console; never moved to another without the builder choosing it.
 */
import type { WidgetIndexEntry, WidgetIndexOutcome } from "@gadgets/workshop-shared/gatekeeper";
import { consoleWidgetVersionId, type ConsoleWidgetEntry, type ConsoleWidgetIndexReport } from "@gadgets/workshop-shared/operate-console";

/** One console's index state, stored by console id; kept after a delete while a withdraw is pending. */
export type ConsoleWidgetIndexRecord = ConsoleWidgetIndexReport & {
  consoleId: string;
  /** The publication revision each version was last written for, so a retried publish writes once. */
  writtenAt: Record<string, string>;
};

/** What the deployment offers the index, as the person publishing sees it. */
export type WidgetIndexPorts = {
  /** The person's workspaces where they may list widgets, each with their account that may. */
  workspaces(): Promise<{ accountId: number; workspaceId: string; name: string }[]>;
  register(accountId: number, workspaceId: string, entry: WidgetIndexEntry): Promise<WidgetIndexOutcome>;
  withdraw(accountId: number, workspaceId: string, sourceId: string, sourceVersion: number): Promise<WidgetIndexOutcome>;
  /** The blueprint's own description, when it has one: the rest of a widget's purpose. */
  description(blueprintId: string): Promise<string | null>;
};

/** Why nothing was written: no workspace where the person may list widgets. */
export const WIDGET_INDEX_NO_WORKSPACE =
  "Not listed for your company: you can't publish shared configuration in any InferOps workspace you're signed in to.";
/** Why nothing was written: more than one workspace qualifies, and none was chosen. */
export const WIDGET_INDEX_CHOOSE =
  "Not listed for your company: choose the InferOps workspace for this console in its settings.";

/** Why nothing was written: the chosen workspace no longer qualifies. */
export function widgetIndexTargetLost(name: string): string {
  return `Not listed for your company: you can no longer publish shared configuration in ${name}. Choose another workspace in this console's settings.`;
}

/** An empty record for `consoleId`. */
export function emptyWidgetIndexRecord(consoleId: string): ConsoleWidgetIndexRecord {
  return { consoleId, target: null, blocked: null, widgets: [], pendingWithdraws: [], writtenAt: {} };
}

/** A record as the builder reads it. */
export function widgetIndexReport(record: ConsoleWidgetIndexRecord): ConsoleWidgetIndexReport {
  let { consoleId: _, writtenAt: __, ...report } = record;
  return report;
}

/**
 * The writes one publication (or, with `published` null, one delete) of a console calls for: each
 * version the live publication lists that wasn't already written for `revision`, and each version
 * the console no longer lists (or whose earlier withdraw is pending) that no other published
 * console of the workspace lists (`listedElsewhere`). A version the console still lists is never
 * withdrawn.
 */
export function widgetIndexPlan(previous: ConsoleWidgetIndexRecord, published: readonly ConsoleWidgetEntry[] | null,
    revision: string | null, listedElsewhere: ReadonlySet<string>)
    : { register: ConsoleWidgetEntry[]; withdraw: string[] } {
  let current = new Map((published ?? []).map(entry => [consoleWidgetVersionId(entry), entry]));
  let register = [...current.entries()].flatMap(([versionId, entry]) => {
    let done = previous.writtenAt[versionId] === revision &&
        previous.widgets.find(widget => widget.versionId === versionId)?.outcome.status === "applied";
    return done ? [] : [entry];
  });
  let candidates = new Set([...previous.widgets.map(widget => widget.versionId),
    ...previous.pendingWithdraws.map(pending => pending.versionId)]);
  let withdraw = [...candidates].filter(versionId => !current.has(versionId) && !listedElsewhere.has(versionId)).toSorted();
  return { register, withdraw };
}

/** Splits a version id into its Blueprint id and version. */
function pointer(versionId: string): { sourceId: string; sourceVersion: number } {
  let at = versionId.lastIndexOf("@");
  return { sourceId: versionId.slice(0, at), sourceVersion: Number(versionId.slice(at + 1)) };
}

// At most `max` code points of `value`, trimmed.
function clip(value: string, max: number): string {
  return Array.from(value.trim()).slice(0, max).join("");
}

/**
 * Brings `previous` up to date with the console's live publication (`published`, null after a
 * delete) through `ports`, as the person publishing, and returns the new record. Never throws: a
 * failure to resolve the target or to write becomes `blocked`, an outcome or a pending withdraw.
 */
export async function indexConsoleWidgets(previous: ConsoleWidgetIndexRecord,
    published: { revision: string; widgets: readonly ConsoleWidgetEntry[] } | null,
    listedElsewhere: ReadonlySet<string>, ports: WidgetIndexPorts): Promise<ConsoleWidgetIndexRecord> {
  let record: ConsoleWidgetIndexRecord = { ...previous, writtenAt: { ...previous.writtenAt } };
  let plan = widgetIndexPlan(previous, published?.widgets ?? null, published?.revision ?? null, listedElsewhere);
  let listedHere = (versionId: string) => (published?.widgets ?? []).some(entry => consoleWidgetVersionId(entry) === versionId);
  // Unchanged but for what no longer applies: a widget the publication no longer lists, and an
  // owed withdrawal of a version this or another published console now lists (nothing to remove).
  let keepUnchanged = () => ({ ...record,
    widgets: record.widgets.filter(widget => listedHere(widget.versionId)),
    pendingWithdraws: record.pendingWithdraws.filter(item => !listedHere(item.versionId) && !listedElsewhere.has(item.versionId)) });
  if (plan.register.length === 0 && plan.withdraw.length === 0) return { ...keepUnchanged(), blocked: null };

  let workspaces: Awaited<ReturnType<WidgetIndexPorts["workspaces"]>>;
  try {
    workspaces = await ports.workspaces();
  } catch {
    return { ...keepUnchanged(), blocked: "Not listed for your company: InferOps couldn't say where you may publish. Try publishing again." };
  }
  let target = record.target;
  if (!target) {
    if (workspaces.length === 0) return { ...keepUnchanged(), blocked: WIDGET_INDEX_NO_WORKSPACE };
    if (workspaces.length > 1) return { ...keepUnchanged(), blocked: WIDGET_INDEX_CHOOSE };
    target = { workspaceId: workspaces[0]!.workspaceId, name: workspaces[0]!.name };
    record.target = target;
  }
  let account = workspaces.find(workspace => workspace.workspaceId === target.workspaceId);
  if (!account) return { ...keepUnchanged(), blocked: widgetIndexTargetLost(target.name) };

  let widgets: ConsoleWidgetIndexReport["widgets"] = [];
  for (let entry of published?.widgets ?? []) {
    let versionId = consoleWidgetVersionId(entry);
    let earlier = record.widgets.find(widget => widget.versionId === versionId);
    if (!plan.register.includes(entry) && earlier) {
      widgets.push(earlier);
      continue;
    }
    let description = await ports.description(entry.blueprintId).catch(() => null);
    let outcome: WidgetIndexOutcome;
    try {
      outcome = await ports.register(account.accountId, target.workspaceId, {
        sourceId: entry.blueprintId, sourceVersion: entry.version, title: clip(entry.label, 120),
        purpose: clip(description ? `${entry.label}: ${description}` : entry.label, 2000),
      });
    } catch {
      outcome = { status: "unavailable", reason: "InferOps couldn't be reached. Publish again to retry." };
    }
    if (outcome.status === "applied") record.writtenAt[versionId] = published!.revision;
    widgets.push({ versionId, label: entry.label, outcome });
  }

  let pending = record.pendingWithdraws.filter(item => !plan.withdraw.includes(item.versionId) &&
      !(published?.widgets ?? []).some(entry => consoleWidgetVersionId(entry) === item.versionId) &&
      !listedElsewhere.has(item.versionId));
  for (let versionId of plan.withdraw) {
    let { sourceId, sourceVersion } = pointer(versionId);
    let outcome: WidgetIndexOutcome;
    try {
      outcome = await ports.withdraw(account.accountId, target.workspaceId, sourceId, sourceVersion);
    } catch {
      outcome = { status: "unavailable", reason: "InferOps couldn't be reached." };
    }
    if (outcome.status === "applied") delete record.writtenAt[versionId];
    else pending.push({ versionId, reason: outcome.reason });
  }
  return { ...record, blocked: null, widgets, pendingWithdraws: pending };
}
