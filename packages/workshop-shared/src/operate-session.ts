// The operate session's page state machine: its state, its events, and the one pure function that
// applies an event. The kernel applies events with it before storing them, and clients and the
// operate agent use the same function, so every party derives the same page from the same log.
// See docs/design/operate-mode.md ("Sessions").

/** Longest workspace or screen id an operate reference may carry. */
export const MAX_OPERATE_ID_LENGTH = 128;

/** Longest subject reference (for example an `inferops://` URI) a session may hold. */
export const MAX_OPERATE_SUBJECT_LENGTH = 512;

/** Most references a session's working set holds; opening one more drops the oldest. */
export const MAX_OPERATE_WORKING_SET = 24;

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

/** The full page state of an operate session. */
export type OperatePageState = {
  /** What the session has open, in the order it was opened. */
  workingSet: OperateRef[];
  /** The reference shown in the main region, or null. Always a member of `workingSet`. */
  focus: OperateRef | null;
  /** The subject the page and the operate chat work on (for example a board), or null. */
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
};

/** A change to an operate session's page state. Events change presentation only. */
export type OperateEvent =
  /** Add a reference to the working set (if absent) and focus it. */
  | { type: "open"; ref: OperateRef }
  /** Remove a reference; focus moves to the most recently opened remaining one. */
  | { type: "close"; ref: OperateRef }
  /** Focus a reference already in the working set. */
  | { type: "focus"; ref: OperateRef }
  /** Set or clear the subject. */
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
  | { type: "approvalResolved"; approval: OperateApprovalRef; outcome: OperateApprovalOutcome };

/** Who appended an event to a session. */
export type OperateEventActor = "person" | "agent";

/** One entry of a session's event log. */
export type OperateEventRecord = {
  /** Position in the log, starting at 1. The page state after it is the replay through `seq`. */
  seq: number;
  event: OperateEvent;
  actor: OperateEventActor;
  at: Date;
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

function sameApproval(a: OperateApprovalRef, b: OperateApprovalRef): boolean {
  return a.workspaceId === b.workspaceId && a.actionId === b.actionId;
}

/**
 * Applies one event to a page state and returns the new state, leaving the input unchanged. Throws
 * `OperateEventError`, changing nothing, for an event that is invalid in `state`.
 */
export function applyOperateEvent(state: OperatePageState, event: OperateEvent): OperatePageState {
  switch (event.type) {
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
    case "setSubject": {
      if (event.subject !== null &&
          (event.subject.length === 0 || event.subject.length > MAX_OPERATE_SUBJECT_LENGTH)) {
        throw new OperateEventError(
            `A subject must be 1-${MAX_OPERATE_SUBJECT_LENGTH} characters, or null.`);
      }
      return { ...state, subject: event.subject };
    }
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
  }
}

/** Replays events over the initial page state. The state after a log is always this replay. */
export function replayOperateEvents(events: Iterable<OperateEvent>): OperatePageState {
  let state = INITIAL_OPERATE_PAGE;
  for (let event of events) state = applyOperateEvent(state, event);
  return state;
}
