// The operate session's page state machine: its state, its events, and the one pure function that
// applies an event. The kernel applies events with it before storing them, and clients and the
// operate agent use the same function, so every party derives the same page from the same log.
// See docs/design/operate-mode.md ("Sessions").

import type { ConsoleFullChat } from "./operate-console.js";

/** Longest workspace or screen id an operate reference may carry. */
export const MAX_OPERATE_ID_LENGTH = 128;

/** Longest subject reference (for example an `inferops://` URI) a session may hold. */
export const MAX_OPERATE_SUBJECT_LENGTH = 512;

/** Most references a session's working set holds; opening one more drops the oldest. */
export const MAX_OPERATE_WORKING_SET = 24;

/** Longest note a handover carries. */
export const MAX_OPERATE_HANDOVER_NOTE_LENGTH = 2000;

/** Most received handovers a session keeps; receiving one more drops the oldest. */
export const MAX_OPERATE_HANDOVERS = 20;

/** Most steps a flow run holds. */
export const MAX_OPERATE_FLOW_STEPS = 32;

/** Longest flow title a session holds. */
export const MAX_OPERATE_FLOW_TITLE_LENGTH = 120;

/**
 * An approval named by the page: one entry of a workspace's action log. Action ids count up per
 * workspace (`ActionLogEntry.id`), so the workspace is part of the name. Naming an approval grants
 * nothing and resolves nothing.
 */
export type OperateApprovalRef = {
  workspaceId: string;
  /** The action's `ActionLogEntry.id` in that workspace: a non-negative integer. */
  actionId: number;
};

/**
 * How a reviewed approval ended, as the page reports it: `applied` (approved, and the gatekeeper
 * applied it), `rejected`, or `failed` (approved, but the gatekeeper's apply failed).
 */
export type OperateApprovalOutcome = "applied" | "rejected" | "failed";

/**
 * Something opened in an operate session, by reference only. A reference identifies a target but
 * grants nothing: it is rendered through the viewer's own access, and shows as unavailable if the
 * viewer can no longer open it.
 */
export type OperateRef =
  | { type: "screen"; workspaceId: string; screenId: string }
  | { type: "workspace"; workspaceId: string };

/** How an open app workspace is presented: the app itself, or the chat beside it. */
export type OperateAppPresentation = "app" | "chat";

/**
 * A flow being run: an ordered list of one workspace's screens, shown one at a time across the
 * whole page. The steps are copied in when the flow starts, so the run is unaffected by later
 * edits to the flow and the reducer needs nothing but the event.
 */
export type OperateFlowRun = {
  workspaceId: string;
  /** The flow this run was started from. */
  flowId: string;
  title: string;
  /** The screen ids to show, in order. Never empty. */
  steps: string[];
  /** The step being shown: an index into `steps`. */
  index: number;
};

/**
 * How the page presents the open console: its `canvas` (views and screens, with the operate chat
 * beside them) or `chat` (the operate conversation filling the page).
 */
export type OperatePresentation = "canvas" | "chat";

/**
 * The console open in a session. What later events are checked against (its full chat setting) is
 * copied in when it opens, like a flow's steps, so the reducer needs nothing but the event.
 */
export type OperateConsoleRun = {
  workspaceId: string;
  consoleId: string;
  title: string;
  /** The console's full chat setting when it was opened. */
  fullChat: ConsoleFullChat;
  /** The id of the view shown from the console's menu. */
  viewId: string;
  /** A screen opened from that view (for example from a rollup's tile), or null to show the view. */
  screenId: string | null;
};

/**
 * A board opened in a session, by its canonical reference and the workspace whose connection reads
 * it: the session's own workspace (a board the operate agent or a use-role operator opened through
 * their own connection), or a console's workspace (a builder's). It names a target only: the board
 * is read through the viewer's own access to that workspace's connection, and shows as unavailable
 * when that no longer reaches it.
 */
export type OperateBoardRef = {
  workspaceId: string;
  /** The board's canonical reference, as its gatekeeper reports it (an `inferops://` URI). */
  boardRef: string;
};

/** The board a session shows, and the issue opened from it (an InferOps issue id), if any. */
export type OperateBoardView = OperateBoardRef & {
  /** The issue shown over the board, or null. Like the board, a reference only. */
  issueId: string | null;
};

/** A person named by a handover: their user id, and their display name when it was sent. */
export type OperatePerson = { id: string; name: string };

/**
 * A subject one person handed into another person's session (`OperateSession.handOver`): the board
 * and issue the sender had open, and a note. It names a target only. The recipient opens it with
 * `openBoard` through their own access, exactly as if they had found the board themselves, so a
 * handover never grants anything.
 */
export type OperateHandover = {
  /** Unique id, the same in the sender's and the recipient's log. */
  id: string;
  from: OperatePerson;
  to: OperatePerson;
  /** The board's canonical reference (an `inferops://` URI). */
  boardRef: string;
  /** The issue the sender had open over the board, or null. */
  issueId: string | null;
  /** Up to `MAX_OPERATE_HANDOVER_NOTE_LENGTH` characters; may be empty. */
  note: string;
};

/** The full page state of an operate session. */
export type OperatePageState = {
  /** What the session has open, in the order it was opened. */
  workingSet: OperateRef[];
  /** The reference shown in the main region, or null. Always a member of `workingSet`. */
  focus: OperateRef | null;
  /**
   * The subject the page and the operate chat work on: the shown board's reference, or null.
   * Derived from `board` by `applyOperateEvent` after every event, so it is never set on its own
   * and can't disagree with what the page shows.
   */
  subject: string | null;
  /** Whether the operate chat panel is open. */
  chatOpen: boolean;
  /** How a focused app workspace is presented. */
  appPresentation: OperateAppPresentation;
  /**
   * The flow being run, or null. While set, the page shows only the flow's current step (the "full
   * canvas" state); the working set and focus are kept, and return when the flow is exited.
   */
  flow: OperateFlowRun | null;
  /**
   * The pending approval the page shows for review, or null. Presentation only: the action's real
   * state is in its workspace's action log.
   */
  reviewing: OperateApprovalRef | null;
  /**
   * The outcome of the last approval the page reported resolved, or null. Presentation only: it is
   * what the page displays, not a record of what happened to the action.
   */
  lastApprovalOutcome: (OperateApprovalRef & { outcome: OperateApprovalOutcome }) | null;
  /** The console being worked in, or null for the console mosaic. */
  console: OperateConsoleRun | null;
  /** How the open console is presented. Always `canvas` when no console is open. */
  presentation: OperatePresentation;
  /**
   * The board shown over the page, or null. Opening a console, another view or screen, or going
   * home closes it, so a board never outlives the context it was opened in. The board is the
   * session's subject (see `subject`).
   */
  board: OperateBoardView | null;
  /** Handovers received and not yet dismissed, oldest first. */
  handovers: OperateHandover[];
};

/** A change to an operate session's page state. Events change presentation only. */
export type OperateEvent =
  /** Return to the console home, keeping the working set and conversation available. */
  | { type: "showHome" }
  /** Add a reference to the working set (if absent) and focus it. */
  | { type: "open"; ref: OperateRef }
  /** Remove a reference; focus moves to the most recently opened remaining one. */
  | { type: "close"; ref: OperateRef }
  /** Focus a reference already in the working set. */
  | { type: "focus"; ref: OperateRef }
  /**
   * Superseded: the subject is now the shown board, opened with `openBoard` and closed with
   * `closeBoard`. Kept so logs recorded before still read; the reducer refuses it.
   */
  | { type: "setSubject"; subject: string | null }
  /** Open or close the operate chat panel. */
  | { type: "setChatOpen"; open: boolean }
  /** Present a focused app workspace as the app or as its chat. */
  | { type: "setAppPresentation"; presentation: OperateAppPresentation }
  /** Start running a flow at its first step, replacing any flow already running. */
  | { type: "startFlow"; workspaceId: string; flowId: string; title: string; steps: string[] }
  /** Show another step of the running flow. */
  | { type: "goToStep"; index: number }
  /** Stop running the flow and return to the working set. */
  | { type: "exitFlow" }
  /**
   * Show a pending approval for review, replacing any approval already under review. Presentation
   * only: it never approves, rejects or applies anything.
   */
  | { type: "reviewApproval"; approval: OperateApprovalRef }
  /**
   * Record how an approval ended, for display, and stop reviewing it if it is under review. It
   * resolves nothing: an action is resolved only through its workspace's `approveAction` /
   * `rejectAction`, and the gatekeeper's apply result is the truth this event reports.
   */
  | { type: "approvalResolved"; approval: OperateApprovalRef; outcome: OperateApprovalOutcome }
  /**
   * Open a console at one of its views, replacing any console already open. The presentation
   * becomes `chat` when the console's full chat is `default` or `only`, and `canvas` otherwise.
   */
  | {
    type: "openConsole"; workspaceId: string; consoleId: string; title: string;
    fullChat: ConsoleFullChat; viewId: string;
  }
  /** Show another view of the open console. */
  | { type: "openView"; viewId: string }
  /** Open a screen from the shown view, or return to the view itself with null. */
  | { type: "showScreen"; screenId: string | null }
  /** Close the console and return to the console mosaic. */
  | { type: "closeConsole" }
  /** Present the open console as its canvas or as full chat, as its full chat setting allows. */
  | { type: "setPresentation"; presentation: OperatePresentation }
  /**
   * Show a board, replacing any board already shown. The kernel accepts it only when the named
   * workspace, opened with the sender's own access, holds a connection to exactly that reference.
   */
  | { type: "openBoard"; board: OperateBoardRef }
  /** Stop showing the board. */
  | { type: "closeBoard" }
  /** Show one issue of the shown board, replacing any issue already shown. */
  | { type: "openIssue"; issueId: string }
  /** Stop showing the issue and return to its board. */
  | { type: "closeIssue" }
  /**
   * A handover from another person, appended by the kernel only (`OperateSession.handOver`); a
   * dispatch that sends it is refused. Adds it to `handovers`, dropping the oldest past
   * `MAX_OPERATE_HANDOVERS`. Recorded with the actor `person`; `handover.from` names the sender.
   */
  | { type: "handoverReceived"; handover: OperateHandover }
  /**
   * The sender's record of a handover, appended by the kernel only. It changes nothing on the page.
   */
  | { type: "handoverSent"; handover: OperateHandover }
  /** Remove a received handover from `handovers`. Opening its board is a separate `openBoard`. */
  | { type: "dismissHandover"; id: string };

/** Who appended an event to a session. */
export type OperateEventActor = "person" | "agent";

/** One entry of a session's event log. */
export type OperateEventRecord = {
  /** Position in the log, starting at 1. The page state after it is the replay through `seq`. */
  seq: number;
  event: OperateEvent;
  actor: OperateEventActor;
  at: Date;
  /**
   * The subject the event concerned (see `operateEventSubject`), which the per-subject audit
   * filters on. Absent for an event on no subject, and on records stored before subjects.
   */
  subject?: string;
};

/** A session's page state as of an event sequence number (0 before any event). */
export type OperateSessionSnapshot = {
  seq: number;
  state: OperatePageState;
};

/** The page state of a session that has no events yet. */
export const INITIAL_OPERATE_PAGE: OperatePageState = {
  workingSet: [],
  focus: null,
  subject: null,
  chatOpen: true,
  appPresentation: "app",
  flow: null,
  reviewing: null,
  lastApprovalOutcome: null,
  console: null,
  presentation: "canvas",
  board: null,
  handovers: [],
};

/** Thrown by `applyOperateEvent` for an event that is invalid in the current state. */
export class OperateEventError extends Error {
  override name = "OperateEventError";
}

/** Whether two references name the same target. */
export function sameOperateRef(a: OperateRef, b: OperateRef): boolean {
  if (a.type !== b.type || a.workspaceId !== b.workspaceId) return false;
  return a.type !== "screen" || a.screenId === (b as typeof a).screenId;
}

function checkRef(ref: OperateRef): void {
  checkIds(ref.type === "screen" ? [ref.workspaceId, ref.screenId] : [ref.workspaceId]);
}

function checkIds(ids: string[]): void {
  for (let id of ids) {
    if (id.length === 0 || id.length > MAX_OPERATE_ID_LENGTH) {
      throw new OperateEventError(`Reference ids must be 1-${MAX_OPERATE_ID_LENGTH} characters.`);
    }
  }
}

function checkApproval(approval: OperateApprovalRef): void {
  checkIds([approval.workspaceId]);
  if (!Number.isSafeInteger(approval.actionId) || approval.actionId < 0) {
    throw new OperateEventError("An action id must be a non-negative integer.");
  }
}

function checkHandover(handover: OperateHandover): void {
  let { id, from, to, boardRef, issueId, note } = handover;
  checkIds([id, from.id, to.id, ...(issueId === null ? [] : [issueId])]);
  checkBoardRef(boardRef);
  for (let name of [from.name, to.name]) {
    if (name.length > MAX_OPERATE_SUBJECT_LENGTH) {
      throw new OperateEventError(`A name must be at most ${MAX_OPERATE_SUBJECT_LENGTH} characters.`);
    }
  }
  if (note.length > MAX_OPERATE_HANDOVER_NOTE_LENGTH) {
    throw new OperateEventError(
        `A handover note must be at most ${MAX_OPERATE_HANDOVER_NOTE_LENGTH} characters.`);
  }
}

function checkBoardRef(boardRef: string): void {
  if (boardRef.length === 0 || boardRef.length > MAX_OPERATE_SUBJECT_LENGTH) {
    throw new OperateEventError(
        `A board reference must be 1-${MAX_OPERATE_SUBJECT_LENGTH} characters.`);
  }
}

function checkTitle(title: string): void {
  if (title.length === 0 || title.length > MAX_OPERATE_FLOW_TITLE_LENGTH) {
    throw new OperateEventError(`A title must be 1-${MAX_OPERATE_FLOW_TITLE_LENGTH} characters.`);
  }
}

function requireConsole(state: OperatePageState): OperateConsoleRun {
  if (!state.console) throw new OperateEventError("No console is open in this session.");
  return state.console;
}

const FULL_CHAT_MODES: readonly string[] = ["off", "available", "default", "only"];

function sameApproval(a: OperateApprovalRef, b: OperateApprovalRef): boolean {
  return a.workspaceId === b.workspaceId && a.actionId === b.actionId;
}

/**
 * Applies one event to a page state and returns the new state, leaving the input unchanged. Throws
 * `OperateEventError`, changing nothing, for an event that is invalid in `state`. The result's
 * `subject` is always its board's reference.
 */
export function applyOperateEvent(state: OperatePageState, event: OperateEvent): OperatePageState {
  let next = applyEvent(state, event);
  return { ...next, subject: next.board?.boardRef ?? null };
}

/**
 * The subject an event concerned, for the per-subject audit: a handover's board, else the board
 * shown after the event, else the one shown before it (so the event that closed a board counts
 * toward it). Null when no board was involved.
 */
export function operateEventSubject(event: OperateEvent, before: OperatePageState,
                                    after: OperatePageState): string | null {
  if (event.type === "handoverReceived" || event.type === "handoverSent") {
    return event.handover.boardRef;
  }
  return after.board?.boardRef ?? before.board?.boardRef ?? null;
}

function applyEvent(state: OperatePageState, event: OperateEvent): OperatePageState {
  switch (event.type) {
    case "showHome":
      return { ...state, console: null, focus: null, flow: null, presentation: "canvas", board: null };
    case "open": {
      checkRef(event.ref);
      let workingSet = state.workingSet.some(ref => sameOperateRef(ref, event.ref))
          ? state.workingSet
          : [...state.workingSet, event.ref].slice(-MAX_OPERATE_WORKING_SET);
      return { ...state, workingSet, focus: event.ref };
    }
    case "close": {
      let workingSet = state.workingSet.filter(ref => !sameOperateRef(ref, event.ref));
      if (workingSet.length === state.workingSet.length) {
        throw new OperateEventError("That reference is not open in this session.");
      }
      let focus = state.focus && sameOperateRef(state.focus, event.ref)
          ? workingSet.at(-1) ?? null
          : state.focus;
      return { ...state, workingSet, focus };
    }
    case "focus": {
      if (!state.workingSet.some(ref => sameOperateRef(ref, event.ref))) {
        throw new OperateEventError("Only a reference open in this session can be focused.");
      }
      return { ...state, focus: event.ref };
    }
    case "setSubject":
      throw new OperateEventError("The subject is the shown board: use openBoard or closeBoard.");
    case "setChatOpen":
      return { ...state, chatOpen: event.open };
    case "setAppPresentation":
      return { ...state, appPresentation: event.presentation };
    case "startFlow": {
      let { workspaceId, flowId, title, steps } = event;
      checkIds([workspaceId, flowId, ...steps]);
      if (steps.length === 0 || steps.length > MAX_OPERATE_FLOW_STEPS) {
        throw new OperateEventError(`A flow must have 1-${MAX_OPERATE_FLOW_STEPS} steps.`);
      }
      if (title.length === 0 || title.length > MAX_OPERATE_FLOW_TITLE_LENGTH) {
        throw new OperateEventError(
            `A flow title must be 1-${MAX_OPERATE_FLOW_TITLE_LENGTH} characters.`);
      }
      return { ...state, flow: { workspaceId, flowId, title, steps: [...steps], index: 0 } };
    }
    case "goToStep": {
      if (!state.flow) throw new OperateEventError("No flow is running in this session.");
      if (!Number.isInteger(event.index) || event.index < 0 ||
          event.index >= state.flow.steps.length) {
        throw new OperateEventError("That step is not part of the running flow.");
      }
      return { ...state, flow: { ...state.flow, index: event.index } };
    }
    case "exitFlow": {
      if (!state.flow) throw new OperateEventError("No flow is running in this session.");
      return { ...state, flow: null };
    }
    case "reviewApproval": {
      checkApproval(event.approval);
      let { workspaceId, actionId } = event.approval;
      return { ...state, reviewing: { workspaceId, actionId } };
    }
    case "approvalResolved": {
      checkApproval(event.approval);
      let { workspaceId, actionId } = event.approval;
      let reviewing = state.reviewing && sameApproval(state.reviewing, event.approval)
          ? null
          : state.reviewing;
      return {
        ...state, reviewing, lastApprovalOutcome: { workspaceId, actionId, outcome: event.outcome },
      };
    }
    case "openConsole": {
      let { workspaceId, consoleId, title, fullChat, viewId } = event;
      checkIds([workspaceId, consoleId, viewId]);
      checkTitle(title);
      if (!FULL_CHAT_MODES.includes(fullChat)) {
        throw new OperateEventError("A console's full chat must be off, available, default or only.");
      }
      let presentation: OperatePresentation =
          fullChat === "default" || fullChat === "only" ? "chat" : "canvas";
      return {
        ...state, presentation, board: null,
        console: { workspaceId, consoleId, title, fullChat, viewId, screenId: null },
      };
    }
    case "openView": {
      let open = requireConsole(state);
      checkIds([event.viewId]);
      return { ...state, board: null, console: { ...open, viewId: event.viewId, screenId: null } };
    }
    case "showScreen": {
      let open = requireConsole(state);
      if (event.screenId !== null) checkIds([event.screenId]);
      return { ...state, board: null, console: { ...open, screenId: event.screenId } };
    }
    case "closeConsole": {
      requireConsole(state);
      return { ...state, console: null, presentation: "canvas", board: null };
    }
    case "setPresentation": {
      let open = requireConsole(state);
      if (event.presentation === "chat" && open.fullChat === "off") {
        throw new OperateEventError("This console does not offer full chat.");
      }
      if (event.presentation === "canvas" && open.fullChat === "only") {
        throw new OperateEventError("This console is chat-only.");
      }
      return { ...state, presentation: event.presentation };
    }
    case "openBoard": {
      let { workspaceId, boardRef } = event.board;
      checkIds([workspaceId]);
      checkBoardRef(boardRef);
      return { ...state, board: { workspaceId, boardRef, issueId: null } };
    }
    case "closeBoard": {
      if (!state.board) throw new OperateEventError("No board is shown in this session.");
      return { ...state, board: null };
    }
    case "openIssue": {
      if (!state.board) throw new OperateEventError("No board is shown in this session.");
      checkIds([event.issueId]);
      return { ...state, board: { ...state.board, issueId: event.issueId } };
    }
    case "closeIssue": {
      if (!state.board?.issueId) throw new OperateEventError("No issue is shown in this session.");
      return { ...state, board: { ...state.board, issueId: null } };
    }
    case "handoverReceived": {
      checkHandover(event.handover);
      let others = state.handovers.filter(handover => handover.id !== event.handover.id);
      return { ...state, handovers: [...others, event.handover].slice(-MAX_OPERATE_HANDOVERS) };
    }
    case "handoverSent":
      checkHandover(event.handover);
      return state;
    case "dismissHandover": {
      let handovers = state.handovers.filter(handover => handover.id !== event.id);
      if (handovers.length === state.handovers.length) {
        throw new OperateEventError("No such handover is waiting in this session.");
      }
      return { ...state, handovers };
    }
  }
}

/** Replays events over the initial page state. The state after a log is always this replay. */
export function replayOperateEvents(events: Iterable<OperateEvent>): OperatePageState {
  let state = INITIAL_OPERATE_PAGE;
  for (let event of events) state = applyOperateEvent(state, event);
  return state;
}
