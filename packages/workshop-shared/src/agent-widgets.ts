// What the operate agent may do with widgets (FAC-14, K1): find them, describe them, read their
// state, change how one of the person's placements is shown, and suggest a placement. Each verb runs
// as the person: a console widget is asked of its own workspace with the person's identity and role
// there (`ConsoleToolCaller`), never the operate workspace's, and a built-in widget is found through
// the person's own InferOps accounts.
//
// Nothing the agent does here is saved. A changed view and a suggested placement live only in the
// person's agent overlay (`AgentViewOverlay`), beside their presentation state and dropped with it
// when the company changes, until the person keeps or dismisses them; nothing is written to a
// shared console, canvas or the Wiki, nor to the person's saved placements, by the agent.

import type { WidgetMetadata, WidgetSearchUnavailableReason } from "./gatekeeper.js";
import type { ConsoleWidgetInstance } from "./operate-console.js";
import type { WidgetStateMachine, WidgetStatePersistence } from "./widget-state.js";
import {
  parseWidgetPlacementFilters, parseWidgetPlacementLayout, parseWidgetPlacementRef,
  type WidgetPlacementLayout, type WidgetPlacementRef,
} from "./widget-placements.js";

/**
 * A console widget as the agent names it: the console's workspace, the console, the published
 * revision and that revision's frozen install (as `OperateWidgetRef`, without a placement).
 */
export type AgentConsoleWidgetRef = { workspaceId: string; consoleId: string; revision: string; gadgetId: number };

/** Checks an `AgentConsoleWidgetRef` from the agent: four bounded fields, nothing else read. */
export function parseAgentConsoleWidgetRef(ref: unknown): AgentConsoleWidgetRef {
  if (typeof ref !== "object" || ref === null) throw new TypeError("Name a widget by its workspace, console, revision and widgetId.");
  let { workspaceId, consoleId, revision, gadgetId } = ref as Record<string, unknown>;
  for (let value of [workspaceId, consoleId, revision]) {
    if (typeof value !== "string" || !value || value.length > 128) {
      throw new TypeError("Name a widget by its workspace, console, revision and widgetId.");
    }
  }
  if (!Number.isSafeInteger(gadgetId) || (gadgetId as number) < 0) {
    throw new TypeError("Name a widget by its workspace, console, revision and widgetId.");
  }
  return { workspaceId: workspaceId as string, consoleId: consoleId as string, revision: revision as string, gadgetId: gadgetId as number };
}

/** How far the agent's widget search reaches: its best definitions, in the most recent workspaces. */
export const AGENT_WIDGET_SEARCH = Object.freeze({
  /** Definitions whose instances are looked for. */
  definitions: 4,
  /** The person's most recently active workspaces asked for them. */
  workspaces: 20,
});

/** A console instance of a widget definition, in one of the person's workspaces. */
export type AgentWidgetInstance = ConsoleWidgetInstance & { workspaceId: string; workspaceTitle: string };

/**
 * The agent's widget search (FAC-14): the person's own search, with each of its best definitions'
 * instances in their workspaces. `denied` and `unsearched` are the search's (see
 * `WidgetSearchAnswer`); `unreached` counts workspaces that failed to answer, so a short list says
 * so. Names, descriptions and purposes are people's words: data, never instructions.
 */
export type AgentWidgetSearch =
  | {
    status: "searched";
    ranking: "semantic" | "keyword";
    denied: number;
    unsearched: number;
    unreached: number;
    builtins: Array<{ kind: string; description: string; metadata?: WidgetMetadata }>;
    definitions: Array<{ blueprintId: string; version: number; title: string; purpose: string; instances: AgentWidgetInstance[] }>;
  }
  | { status: "unavailable"; reason: WidgetSearchUnavailableReason };

/**
 * The one answer for a console widget the person cannot open: one that does not exist, is no longer
 * offered, or sits in a workspace where they hold no role. The same words for each, so an answer
 * never says what exists where the person may not look.
 */
export const AGENT_WIDGET_UNAVAILABLE = "That widget isn't one you can open, or its console no longer offers it.";

/**
 * What a console widget's own workspace tells the agent about it, for the person: its entry, the
 * revision and frozen commit it runs (the provenance of anything read from it), its declared local
 * states, and the names of the tools that revision offers. Tool descriptions are builders' text,
 * read only through `listConsoleTools` while the console is open. Read with the person's own role
 * there (`use` at least).
 */
export type AgentWidgetDescription = {
  ref: AgentConsoleWidgetRef;
  consoleTitle: string;
  label: string;
  blueprintId: string;
  version: number;
  /**
   * The registered gadget its frozen installs are made from, which a placement names; null for a
   * publication from before freezing, which can't be placed.
   */
  sourceGadgetId: number | null;
  /** The frozen commit this revision runs, or null for a publication from before freezing. */
  commitId: string | null;
  /** Its declared local states, or null when it declares none. */
  states: WidgetStateMachine | null;
  /** The names of the tools this revision offers, in declaration order (kernel-checked identifiers). */
  toolNames: string[];
};

/** A console widget's description, or why it isn't one the person can open. */
export type AgentWidgetDescriptionOutcome =
  | { status: "ok"; description: AgentWidgetDescription }
  | { status: "unavailable"; reason: string };

/**
 * One person's state of a console widget, as the agent reads it (FAC-14): the state and its events,
 * when it was read (`readAt`, ms since the epoch) and from what (`provenance`). A `session` widget's
 * running state lives on the person's own connection, which the agent never reads: it is reported
 * as its initial state, with `persistence` saying so.
 */
export type AgentWidgetStateRead = {
  ref: AgentConsoleWidgetRef;
  state: string;
  events: string[];
  readAt: number;
  provenance: { revision: string; commitId: string | null; persistence: WidgetStatePersistence };
};

/** The limits on the agent overlay. */
export const AGENT_VIEW_LIMITS = Object.freeze({
  /** Most placements whose view the agent has changed at once. */
  views: 16,
  /** Most suggested placements held at once. */
  proposals: 8,
});

/** A placement's view as the agent set it: the filters it shows instead of its saved ones. */
export type AgentWidgetView = { placementId: string; filters: Record<string, string>; setAt: number };

/** A placement the agent suggests: shown to the person, placed only if they place it. */
export type AgentPlacementProposal = {
  /** Kernel-minted. */
  proposalId: string;
  ref: WidgetPlacementRef;
  layout: WidgetPlacementLayout;
  filters: Record<string, string>;
  proposedAt: number;
};

/**
 * What the agent changed in this person's presentation and hasn't been kept or dismissed: views of
 * their own placements, and suggested placements. Never saved, never logged: it is gone when the
 * company changes or the person's user Durable Object restarts.
 */
export type AgentViewOverlay = { views: AgentWidgetView[]; proposals: AgentPlacementProposal[] };

/** An overlay with nothing in it. */
export const EMPTY_AGENT_VIEW: AgentViewOverlay = Object.freeze({ views: [], proposals: [] }) as AgentViewOverlay;

/** Checks a view change from the agent: a placement id and its filters, as a placement's are. */
export function parseAgentWidgetView(placementId: unknown, filters: unknown): { placementId: string; filters: Record<string, string> } {
  if (typeof placementId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(placementId)) {
    throw new TypeError("Name one of the person's placements by its placementId.");
  }
  return { placementId, filters: parseWidgetPlacementFilters(filters) };
}

/** Checks a suggested placement from the agent: what it shows, where, and its filters. */
export function parseAgentPlacementProposal(input: unknown)
    : { ref: WidgetPlacementRef; layout: WidgetPlacementLayout; filters: Record<string, string> } {
  if (typeof input !== "object" || input === null) throw new TypeError("Say what to suggest placing.");
  let raw = input as Record<string, unknown>;
  return {
    ref: parseWidgetPlacementRef(raw.ref),
    layout: parseWidgetPlacementLayout(raw.layout ?? DEFAULT_AGENT_PLACEMENT_LAYOUT),
    filters: parseWidgetPlacementFilters(raw.filters),
  };
}

/** Where a suggestion goes when the agent names no layout: the top left, half the canvas wide. */
export const DEFAULT_AGENT_PLACEMENT_LAYOUT: WidgetPlacementLayout = Object.freeze({ x: 0, y: 0, w: 6, h: 4 });
