// A person's personal workflows and their runs (FAC-134, capability 2; personal-workflow.ts), in
// their own operate session workspace. A workflow is created only by the kernel, for the person's
// own approval of an action that declared it, once per action; it expires FAC-124's TTL after it is
// created, and the sweep removes only expired workflow records, never a run in progress, which
// keeps its own copy of the steps. A run records each step's result in order, and a step marked as
// sending when its request is in flight: one found still sending after a restart is `step-unknown`,
// never sent again, so a step's request is placed at most once. Nothing here is shared, published
// or reachable from another workspace.

import {
  PERSONAL_WORKFLOW_LIMITS,
  type PersonalWorkflow,
  type PersonalWorkflowDeclaration,
  type PersonalWorkflowStep,
  parseConsoleCommandRef,
} from "@gadgets/workshop-shared/personal-workflow";
import type { OverseerStorage } from "./overseer";

/** A personal workflow as stored: as its owner reads it. */
export type StoredPersonalWorkflow = PersonalWorkflow;

/** What one step of a run came to, kept only in its owner's own record. */
export type PersonalWorkflowStepResult =
  /** Its request was placed, pending the console builders' decision. */
  | { status: "requested" }
  /** The issue was already in that state: nothing was requested. */
  | { status: "unchanged" }
  /** It was refused, with nothing sent: which check, in kernel words. */
  | { status: "refused"; detail: string }
  /** Its request may or may not have been placed. */
  | { status: "unknown"; detail: string };

/** A personal workflow's run, as stored. */
export type StoredPersonalWorkflowRun = {
  runId: string;
  workflowId: string;
  /** The approved action that started it, whose gatekeeper is told its outcome. */
  actionId: number;
  /** The InferOps profile of the person who approved it: the session's owner. */
  ownerProfileId: string;
  /** The steps as they were when it started. */
  steps: PersonalWorkflowStep[];
  /** One result per step done, in order. */
  results: PersonalWorkflowStepResult[];
  /** The step whose request is in flight, set before it is asked and cleared after. */
  sending?: number;
  state: "running" | "succeeded" | "failed" | "uncertain";
  reason?: "step-refused" | "step-unknown";
  reportOutcome: boolean;
  /** When its outcome is next due to be reported, while it is owed; how many tries so far. */
  reportDue?: number;
  reportTries: number;
  startedAt: Date;
  endedAt?: Date;
};

/** How the store tells time, how long a workflow lasts, and whom to tell when what is due changes. */
export type PersonalWorkflowRetention = {
  now: () => number;
  ttlMs: () => number;
  onChange?: () => void;
};

/** Ended runs kept, newest first; older ones are deleted by the sweep. */
export const PERSONAL_WORKFLOW_RUNS_KEPT = 100;

/** The words for a run that can't start because its workflow is gone or expired. */
export const PERSONAL_WORKFLOW_GONE = "That personal workflow is no longer here.";

/** The personal workflows of one operate session workspace; its caller checks whose session it is. */
export class PersonalWorkflowStore {
  constructor(private durableStorage: DurableObjectStorage,
      private storage: Pick<OverseerStorage, "personalWorkflows" | "personalWorkflowRuns">,
      private retention: PersonalWorkflowRetention) {}

  #changed(): void {
    this.retention.onChange?.();
  }

  /**
   * Creates the personal workflow `declaration` describes, for action `actionId`: once per action,
   * so a retried apply returns the workflow the first created. Expired workflows are swept first, in
   * the same transaction, and at most `PERSONAL_WORKFLOW_LIMITS.workflows` are kept.
   */
  create(declaration: PersonalWorkflowDeclaration, actionId: number): StoredPersonalWorkflow {
    let ttl = this.retention.ttlMs();
    let created = this.durableStorage.transactionSync(() => {
      let now = this.retention.now();
      this.#sweepAt(now);
      for (let existing of this.storage.personalWorkflows.list()) {
        if (existing.fromAction === actionId) return existing;
      }
      if (Array.from(this.storage.personalWorkflows.list({ limit: PERSONAL_WORKFLOW_LIMITS.workflows })).length
          >= PERSONAL_WORKFLOW_LIMITS.workflows) {
        throw new Error(`You already have ${PERSONAL_WORKFLOW_LIMITS.workflows} personal workflows here.`);
      }
      let workflow: StoredPersonalWorkflow = {
        id: crypto.randomUUID(),
        title: declaration.title,
        steps: declaration.steps.map(step => {
          let ref = parseConsoleCommandRef(step.reference)!;
          return {
            reference: step.reference, workspaceId: ref.workspaceId, consoleId: ref.consoleId,
            revision: ref.revision, gadgetId: ref.gadgetId, command: ref.command,
            input: { issueId: step.input.issueId, toStateId: step.input.toStateId },
          };
        }),
        createdAt: new Date(now),
        expiresAt: new Date(now + ttl),
        fromAction: actionId,
      };
      this.storage.personalWorkflows.put(workflow);
      return workflow;
    });
    this.#changed();
    return created;
  }

  /** Workflow `id`, or undefined when it isn't here or has expired. */
  get(id: string): StoredPersonalWorkflow | undefined {
    let stored = this.storage.personalWorkflows.get(id);
    return stored && this.retention.now() < stored.expiresAt.getTime() ? stored : undefined;
  }

  /** Every workflow not yet expired, oldest first. */
  list(): StoredPersonalWorkflow[] {
    let now = this.retention.now();
    return Array.from(this.storage.personalWorkflows.list())
      .filter(workflow => now < workflow.expiresAt.getTime())
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Starts a run of workflow `workflowId` for action `actionId`, with a copy of its steps: once per
   * action, so a retried apply returns the run the first started. Undefined when the workflow is gone
   * or expired.
   */
  startRun(workflowId: string, actionId: number, ownerProfileId: string, reportOutcome: boolean)
      : StoredPersonalWorkflowRun | undefined {
    let run = this.durableStorage.transactionSync(() => {
      for (let existing of this.storage.personalWorkflowRuns.list()) {
        if (existing.actionId === actionId) return existing;
      }
      let workflow = this.get(workflowId);
      if (!workflow) return undefined;
      let started: StoredPersonalWorkflowRun = {
        runId: crypto.randomUUID(), workflowId, actionId, ownerProfileId, steps: workflow.steps, results: [],
        state: "running", reportOutcome, reportTries: 0, startedAt: new Date(this.retention.now()),
      };
      this.storage.personalWorkflowRuns.put(started);
      return started;
    });
    if (run) this.#changed();
    return run;
  }

  /** Run `runId`, as stored. */
  getRun(runId: string): StoredPersonalWorkflowRun | undefined {
    return this.storage.personalWorkflowRuns.get(runId);
  }

  /** The runs still going, or with an outcome still owed. */
  activeRuns(): StoredPersonalWorkflowRun[] {
    return Array.from(this.storage.personalWorkflowRuns.list())
      .filter(run => run.state === "running" || run.reportDue !== undefined);
  }

  /** Writes `run` back. */
  putRun(run: StoredPersonalWorkflowRun): void {
    this.storage.personalWorkflowRuns.put(run);
    this.#changed();
  }

  /**
   * Deletes the workflows past their expiry, and ended runs beyond the latest
   * `PERSONAL_WORKFLOW_RUNS_KEPT` with no outcome still owed. A run in progress is never touched: it
   * has its own copy of the steps.
   */
  sweepExpired(): number {
    let swept = this.durableStorage.transactionSync(() => this.#sweepAt(this.retention.now()));
    if (swept > 0) this.#changed();
    return swept;
  }

  #sweepAt(now: number): number {
    let swept = 0;
    for (let workflow of Array.from(this.storage.personalWorkflows.list())) {
      if (now >= workflow.expiresAt.getTime()) {
        this.storage.personalWorkflows.delete(workflow.id);
        swept++;
      }
    }
    let ended = Array.from(this.storage.personalWorkflowRuns.list())
      .filter(run => run.state !== "running" && run.reportDue === undefined)
      .toSorted((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0));
    for (let run of ended.slice(PERSONAL_WORKFLOW_RUNS_KEPT)) this.storage.personalWorkflowRuns.delete(run.runId);
    return swept;
  }

  /** The next time a workflow expires, if any does. */
  nextExpiry(): number | undefined {
    let next: number | undefined;
    for (let workflow of this.storage.personalWorkflows.list()) {
      let at = workflow.expiresAt.getTime();
      if (next === undefined || at < next) next = at;
    }
    return next;
  }
}
