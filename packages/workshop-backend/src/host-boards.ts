// Host boards: a console's host-rendered board, read by each operator through a connection they
// selected themselves, in their own operate session workspace (see docs/architecture/operate-mode.md,
// "Host boards"). This module is the operate workspace's side, the `HostBoardDesk`: the durable
// selection protocol and the fenced read. The overseer gives it its ports (storage, the gatekeeper
// facet through `getGatekeeperFacet`, the owner's user DO); `server.ts` gives each call a guard that
// re-reads the caller's session and the console through the caller's own access.
//
// - Selection is idempotent per `requestKey`: the request is stored with its payload and state
//   (`pending`, `committed`, `failed`, `superseded`) before anything is created, and the
//   connection it creates is stamped with the request (`HostBoardMint`) at creation, so a retry
//   after a lost response or a restart finds it rather than creating another. Of two intents for
//   one target only the latest reserved epoch can commit. A loser removes only the connection
//   stamped with its own request, and only once no committed selection names it.
// - A read has one deadline, 10 s from its start. Past it the call answers `unavailable`, and the
//   read's continuation can no longer pin, audit or return anything: every host-owned effect is in
//   one synchronous compare-and-set (`#commit`) that checks the call's token and the deadline first.
//   Diagnostics the adapter writes on its own are outside that claim.
// - The compare-and-set validates the latest remotely checked state (the account's provenance, the
//   session and the console, each re-read after the provider answered); it is not a lock across the
//   user, console and gatekeeper Durable Objects. A revocation those commit after the last check can
//   let that one snapshot through, bounded by the client's expiry of what it shows.

import type { HostBoardConnectionFence, HostBoardFence, HostBoardReader, HostBoardScope, HOST_BOARD_LIMITS, HostBoardGroup, HostBoardPriority } from "@gadgets/gatekeeper-kit/host-board";
import { HOST_BOARD_RESOURCE, HOST_BOARD_SNAPSHOT_LIMITS, type ConsoleSource, type HostBoardReadAudit, type HostBoardSelection, type HostBoardView, type HostBoardViewGroup, type HostBoardViewIssue, type HostBoardViewPriority, type HostBoardViewSnapshot } from "@gadgets/workshop-shared/operate-console";
import type { HostBoardAccount } from "./user";

// The kernel projects with the provider's own bounds and enums; these fail to compile if they drift.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const SAME_LIMITS: Equal<Omit<typeof HOST_BOARD_LIMITS, "bytes" | "errorBytes">, typeof HOST_BOARD_SNAPSHOT_LIMITS> = true;
const SAME_GROUPS: Equal<HostBoardGroup, HostBoardViewGroup> = true;
const SAME_PRIORITIES: Equal<HostBoardPriority, HostBoardViewPriority> = true;
void [SAME_LIMITS, SAME_GROUPS, SAME_PRIORITIES];

/** The whole read's deadline, from its start (`readAt`). */
export const HOST_BOARD_READ_DEADLINE_MS = 10_000;

/** The message every call refused by the switch carries. */
export const HOST_BOARDS_OFF = "Host boards are turned off for this installation.";

/**
 * Whether host boards are on: `INFEROPS_HOST_BOARDS` exactly `"true"`, and only while the InferOps
 * integration is (unset `INFEROPS_ENABLED` counts as on, as in the gatekeeper). Checked at
 * registration and publication, selection, acquisition and every read.
 */
export function hostBoardsEnabled(env: Pick<Cloudflare.Env, "INFEROPS_HOST_BOARDS" | "INFEROPS_ENABLED">): boolean {
  return env.INFEROPS_HOST_BOARDS === "true" &&
      (env.INFEROPS_ENABLED === undefined || env.INFEROPS_ENABLED === "true");
}

/** Who created a host-board connection, for which request: stamped on its gatekeeper record at creation. */
export type HostBoardMint = {
  /** The operate workspace's owner. */
  by: string;
  /** The selection request that created it. */
  requestKey: string;
  /** The kernel's numeric connected-account id it was minted from. */
  accountId: number;
  /** That account's incarnation when the class was resolved (see `HostBoardAccount`). */
  incarnation: string;
};

/** What a selection request is bound to, beyond its caller. */
export type HostBoardSelectionPayload = {
  workspaceId: string;
  consoleId: string;
  source: ConsoleSource;
  revision: string;
  entryId: string;
  accountId: number;
};

/** A stored selection request, keyed by its `requestKey`. A settled one is kept as its tombstone. */
export type HostBoardRequestRecord = {
  requestKey: string;
  owner: string;
  payload: HostBoardSelectionPayload;
  target: string;
  /** The intent epoch reserved for it. */
  epoch: number;
  state: "pending" | "committed" | "failed" | "superseded";
};

/** The owner's selection for one target, keyed by the target. */
export type HostBoardSelectionRecord = {
  target: string;
  owner: string;
  resource: typeof HOST_BOARD_RESOURCE;
  /** The latest intent epoch reserved for this target; only a request holding it may commit. */
  intentEpoch: number;
  /**
   * Rises on every change of the target's selection state (see `HostBoardSelectionState`): an
   * intent reserved, committed or settled, and the selection's removal. Distinct from the epochs,
   * so subscribers can order full-state updates. Absent on records written before it, read as 0.
   */
  changeSeq?: number;
  /** The request holding `intentEpoch`. */
  intentKey?: string;
  /** The committed selection, or null before the first. */
  selection: null | {
    gatekeeperId: number;
    mintedFor: HostBoardMint & {
      /** The adapter's own string account id (`HostBoardFence.accountId`), read once minted. */
      adapterAccountId: string;
    };
    /** The intent epoch it committed under; every commit has a new one. */
    selectionEpoch: number;
    /** The provider scope of the first successful read, compare-and-set. */
    pinned?: HostBoardScope;
  };
};

/** A stored audit record. */
export type HostBoardReadRecord = HostBoardReadAudit & { seq: number };

/** What the call's guard re-reads through the caller's own access: null when it no longer holds. */
export type HostBoardContext = {
  /** The entry's requirement target, as the console revision defines it. */
  target: string;
  /** The caller's operate session sequence: it rises on every event. */
  sessionSeq: number;
};

/** Re-reads the caller's context; given per call by `server.ts`. */
export type HostBoardGuard = () => Promise<HostBoardContext | null>;

/** One read, as the guarded handle names it. */
export type HostBoardReadRequest = {
  consoleId: string;
  entryId: string;
  requirementName: string;
  source: ConsoleSource;
  revision: string;
  /** When the read started, before any await, in epoch milliseconds. */
  readAt: number;
};

/** What the desk needs from the operate workspace it runs in. */
export type HostBoardPorts = {
  /** The workspace's owner. */
  ownerId: string;
  enabled(): boolean;
  selections: {
    get(target: string): HostBoardSelectionRecord | undefined;
    put(record: HostBoardSelectionRecord): void;
    list(): Iterable<HostBoardSelectionRecord>;
  };
  /** Runs `fn` as one storage transaction: a throw rolls every write in it back. */
  transaction<T>(fn: () => T): T;
  /** Runs `fn` once the current event has finished, so it sees only committed state. */
  defer(fn: () => void): void;
  requests: { get(requestKey: string): HostBoardRequestRecord | undefined; put(record: HostBoardRequestRecord): void };
  recordAudit(entry: HostBoardReadAudit): void;
  /** Gatekeeper `id`'s resource URL and mint stamp, or undefined when it does not exist. */
  connection(id: number): { resourceUrl?: string; mint?: HostBoardMint } | undefined;
  /** The gatekeeper stamped with `requestKey`, if one was created. */
  mintedBy(requestKey: string): number | undefined;
  /** Creates a connection for `target` from `accountId` through the chokepoint, stamped at creation. */
  mint(accountId: number, target: string, stamp: Pick<HostBoardMint, "by" | "requestKey">): Promise<void>;
  /** Removes candidate `id`, which the desk proved its own and uncommitted. */
  drop(id: number): void;
  facet(id: number): HostBoardReader & HostBoardConnectionFence;
  account(accountId: number): Promise<HostBoardAccount | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
};

const NOT_CONNECTED: HostBoardView = { status: "not-connected" };
const UNAVAILABLE: HostBoardView = { status: "unavailable" };
const STALE: HostBoardView = { status: "stale" };

const REQUEST_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/** Whether `value` is a usable request key. */
export function isHostBoardRequestKey(value: string): boolean {
  return REQUEST_KEY.test(value);
}

function samePayload(a: HostBoardSelectionPayload, b: HostBoardSelectionPayload): boolean {
  return a.workspaceId === b.workspaceId && a.consoleId === b.consoleId && a.source === b.source &&
      a.revision === b.revision && a.entryId === b.entryId && a.accountId === b.accountId;
}

function sameFence(a: HostBoardFence, b: HostBoardFence): boolean {
  return a.accountId === b.accountId && a.identity === b.identity && a.generation === b.generation;
}

function outcome(state: HostBoardRequestRecord["state"]): HostBoardSelection {
  return { status: state === "committed" ? "selected" : state === "superseded" ? "superseded" : "failed" };
}

/**
 * A target's selection state, as subscribers see it: `none` (no selection), `pending` (the latest
 * intent is still being made) or `selected`, with the order of the change (`changeSeq`) and the
 * committed selection's epoch. No account or snapshot data.
 */
export type HostBoardSelectionState = {
  state: "none" | "pending" | "selected";
  changeSeq: number;
  selectionEpoch: number | null;
};

/** Receives full selection states in change order. */
export type HostBoardSelectionSubscriber = (state: HostBoardSelectionState) => unknown;

/** One call's liveness: cleared when its deadline answers for it. */
type CallToken = { live: boolean; deadlineAt: number };

/**
 * The operate workspace's host boards: connection selection and the fenced read. One per
 * workspace instance; the in-flight selections it joins are in memory, and the requests behind
 * them are durable, so a restart resumes rather than repeats them.
 */
export class HostBoardDesk {
  #inflight = new Map<string, Promise<HostBoardSelection>>();

  constructor(private ports: HostBoardPorts) {}

  /**
   * Selects `payload.accountId`'s connection for the guard's target, idempotently per
   * `requestKey`. Throws when the switch is off, the key was used for another payload, or (for a
   * new key) the guard no longer holds.
   */
  async select(requestKey: string, payload: HostBoardSelectionPayload, guard: HostBoardGuard)
      : Promise<HostBoardSelection> {
    if (!this.ports.enabled()) throw new Error(HOST_BOARDS_OFF);
    if (!isHostBoardRequestKey(requestKey)) throw new Error("A request key must be 1-128 letters, digits, - or _.");
    let existing = this.#existing(requestKey, payload);
    if (existing) return this.#join(existing, guard);
    let context = await guard();
    if (!context) throw new Error("This console is not open in your operate session as it was.");
    let raced = this.#existing(requestKey, payload);
    if (raced) return this.#join(raced, guard);
    // Reserved synchronously, with the request stored, before anything is created.
    let slot = this.ports.selections.get(context.target) ??
        { target: context.target, owner: this.ports.ownerId, resource: HOST_BOARD_RESOURCE, intentEpoch: 0, selection: null };
    slot = { ...slot, intentEpoch: slot.intentEpoch + 1, intentKey: requestKey, changeSeq: (slot.changeSeq ?? 0) + 1 };
    let record: HostBoardRequestRecord = {
      requestKey, owner: this.ports.ownerId, payload, target: context.target, epoch: slot.intentEpoch, state: "pending",
    };
    let reserved = slot;
    this.ports.transaction(() => {
      this.ports.selections.put(reserved);
      this.ports.requests.put(record);
    });
    this.#notify(context.target);
    return this.#start(record, guard);
  }

  // A stored request under `requestKey`; one bound to another caller or payload is refused.
  #existing(requestKey: string, payload: HostBoardSelectionPayload): HostBoardRequestRecord | undefined {
    let record = this.ports.requests.get(requestKey);
    if (record && (record.owner !== this.ports.ownerId || !samePayload(record.payload, payload))) {
      throw new Error("This request key was already used for a different selection.");
    }
    return record;
  }

  // The original outcome, or the original attempt: joined while it runs here, resumed after a restart.
  #join(record: HostBoardRequestRecord, guard: HostBoardGuard): Promise<HostBoardSelection> {
    if (record.state !== "pending") return Promise.resolve(outcome(record.state));
    return this.#inflight.get(record.requestKey) ?? this.#start(record, guard);
  }

  #start(record: HostBoardRequestRecord, guard: HostBoardGuard): Promise<HostBoardSelection> {
    let run = this.#run(record, guard).finally(() => this.#inflight.delete(record.requestKey));
    this.#inflight.set(record.requestKey, run);
    return run;
  }

  #latest(record: HostBoardRequestRecord): boolean {
    return this.ports.selections.get(record.target)?.intentEpoch === record.epoch;
  }

  async #run(record: HostBoardRequestRecord, guard: HostBoardGuard): Promise<HostBoardSelection> {
    let candidate: number | undefined;
    try {
      // A resumed request finds the connection it already created by its stamp.
      candidate = this.ports.mintedBy(record.requestKey);
      if (candidate === undefined) {
        if (!this.#latest(record)) return this.#settle(record, "superseded");
        await this.ports.mint(record.payload.accountId, record.target,
            { by: record.owner, requestKey: record.requestKey });
        candidate = this.ports.mintedBy(record.requestKey);
        if (candidate === undefined) return this.#settle(record, "failed");
      }
      let identity = await this.ports.facet(candidate).connectionIdentity();
      let account = await this.ports.account(record.payload.accountId);
      let context = await guard();

      // From here to the return, nothing awaits: the final check and the commit are one step.
      let current = this.ports.requests.get(record.requestKey);
      if (current?.state !== "pending") return this.#settle(record, current?.state ?? "failed", candidate);
      if (!this.#latest(record)) return this.#settle(record, "superseded", candidate);
      let connection = this.ports.connection(candidate);
      let mint = connection?.mint;
      if (!identity || !account || !mint || !context || connection?.resourceUrl !== record.target ||
          context.target !== record.target || mint.accountId !== record.payload.accountId ||
          account.incarnation !== mint.incarnation) {
        return this.#settle(record, "failed", candidate);
      }
      let slot = this.ports.selections.get(record.target)!;
      let previous = slot.selection;
      let adapterAccountId = identity.accountId;
      // One transaction: a throw part way leaves no committed selection behind it.
      this.ports.transaction(() => {
        this.ports.selections.put({ ...slot, changeSeq: (slot.changeSeq ?? 0) + 1, selection: {
          gatekeeperId: candidate!,
          mintedFor: { ...mint, adapterAccountId },
          selectionEpoch: record.epoch,
        } });
        this.ports.requests.put({ ...current, state: "committed" });
        // The replaced selection's request becomes a tombstone.
        let replaced = previous && previous.gatekeeperId !== candidate
          ? this.ports.requests.get(previous.mintedFor.requestKey) : undefined;
        if (replaced) this.ports.requests.put({ ...replaced, state: "superseded" });
      });
      // Its connection goes once the commit stands.
      if (previous && previous.gatekeeperId !== candidate) {
        this.#drop(previous.gatekeeperId, previous.mintedFor.requestKey, record.target);
      }
      this.#notify(record.target);
      return { status: "selected" };
    } catch {
      return this.#settle(record, "failed", candidate);
    }
  }

  // Records a request's final state (if it is still pending) and removes its own candidate.
  #settle(record: HostBoardRequestRecord, state: HostBoardRequestRecord["state"], candidate?: number)
      : HostBoardSelection {
    let current = this.ports.requests.get(record.requestKey);
    if (current?.state === "pending" && state !== "pending") {
      this.ports.requests.put({ ...current, state });
      // The target leaves `pending` when its latest intent settles.
      let slot = this.ports.selections.get(record.target);
      if (slot?.intentEpoch === record.epoch) {
        this.ports.selections.put({ ...slot, changeSeq: (slot.changeSeq ?? 0) + 1 });
        this.#notify(record.target);
      }
    }
    if (candidate !== undefined) this.#drop(candidate, record.requestKey, record.target);
    return outcome(current?.state === "pending" ? state : current?.state ?? state);
  }

  // Removes connection `id` only when it is stamped with this owner's `requestKey` and no committed
  // selection for `target` names it. Never an unproven or committed connection.
  #drop(id: number, requestKey: string, target: string): void {
    let mint = this.ports.connection(id)?.mint;
    if (mint?.by !== this.ports.ownerId || mint.requestKey !== requestKey) return;
    if (this.ports.selections.get(target)?.selection?.gatekeeperId === id) return;
    try {
      this.ports.drop(id);
    } catch {
      // A candidate left behind is unreachable: no selection names it, and a read never looks one up.
    }
  }

  /**
   * A connection the workspace removed: a selection naming it is cleared (`none`). Called inside
   * the removal, which may be a transaction, so subscribers hear of it only after it committed.
   */
  connectionRemoved(id: number): void {
    for (let slot of Array.from(this.ports.selections.list())) {
      if (slot.owner !== this.ports.ownerId || slot.selection?.gatekeeperId !== id) continue;
      this.ports.selections.put({ ...slot, selection: null, changeSeq: (slot.changeSeq ?? 0) + 1 });
      this.#notify(slot.target);
    }
  }

  #subscribers = new Map<string, Set<HostBoardSelectionSubscriber>>();

  /** The target's full selection state now. */
  selectionState(target: string): HostBoardSelectionState {
    let slot = this.ports.selections.get(target);
    if (!slot || slot.owner !== this.ports.ownerId) return { state: "none", changeSeq: 0, selectionEpoch: null };
    let pending = slot.intentKey !== undefined && this.ports.requests.get(slot.intentKey)?.state === "pending";
    return {
      state: pending ? "pending" : slot.selection ? "selected" : "none",
      changeSeq: slot.changeSeq ?? 0,
      selectionEpoch: slot.selection?.selectionEpoch ?? null,
    };
  }

  /**
   * Subscribes to one target's selection state. Installing the subscriber and taking the initial
   * snapshot happen together, with no await between them, so no change can fall between the two:
   * the snapshot is returned, and every later committed change is delivered as a full state.
   * Returns the snapshot and the function that ends the subscription.
   */
  subscribe(target: string, subscriber: HostBoardSelectionSubscriber)
      : { snapshot: HostBoardSelectionState; unsubscribe: () => void } {
    if (!this.ports.enabled()) throw new Error(HOST_BOARDS_OFF);
    let set = this.#subscribers.get(target) ?? new Set();
    this.#subscribers.set(target, set);
    set.add(subscriber);
    let snapshot = this.selectionState(target);
    return { snapshot, unsubscribe: () => { set.delete(subscriber); } };
  }

  // Delivers the target's state after the current event, when it is committed; a subscriber that
  // fails is dropped, and it is the client's to clear to unknown and subscribe again.
  #notify(target: string): void {
    this.ports.defer(() => {
      let set = this.#subscribers.get(target);
      if (!set || set.size === 0) return;
      let state = this.selectionState(target);
      for (let subscriber of Array.from(set)) {
        Promise.resolve().then(() => subscriber(state)).catch(() => { set.delete(subscriber); });
      }
    });
  }

  /**
   * Reads the guard's target through the owner's selection. One deadline covers every step: when
   * it passes first, the answer is `unavailable` and the continuation can affect nothing.
   */
  async read(request: HostBoardReadRequest, guard: HostBoardGuard): Promise<HostBoardView> {
    let token: CallToken = { live: true, deadlineAt: request.readAt + HOST_BOARD_READ_DEADLINE_MS };
    let deadline = this.ports.sleep(Math.max(0, token.deadlineAt - this.ports.now()))
        .then(() => UNAVAILABLE);
    let work = this.#read(request, guard, token);
    // A late rejection is observed, and its cause is never logged.
    work.catch(() => {});
    try {
      return await Promise.race([work, deadline]);
    } catch {
      return UNAVAILABLE;
    } finally {
      token.live = false;
    }
  }

  async #read(request: HostBoardReadRequest, guard: HostBoardGuard, token: CallToken): Promise<HostBoardView> {
    if (!this.ports.enabled()) return UNAVAILABLE;
    let context = await guard();
    if (!context) return STALE;
    let slot = this.ports.selections.get(context.target);
    let selection = slot?.owner === this.ports.ownerId ? slot.selection : null;
    if (!selection) return this.#commit(request, token, "not-connected");
    let { gatekeeperId, mintedFor, selectionEpoch } = selection;
    let connection = this.ports.connection(gatekeeperId);
    if (connection?.resourceUrl !== context.target || connection.mint?.by !== mintedFor.by ||
        connection.mint.requestKey !== mintedFor.requestKey || connection.mint.accountId !== mintedFor.accountId) {
      return this.#notConnected(request, guard, token, context);
    }
    let facet = this.ports.facet(gatekeeperId);
    let account = await this.ports.account(mintedFor.accountId);
    if (!account || account.incarnation !== mintedFor.incarnation) return this.#notConnected(request, guard, token, context);
    let current = await facet.connectionIdentity();
    if (!current || current.accountId !== mintedFor.adapterAccountId) return this.#notConnected(request, guard, token, context);

    let answer = await facet.readHostBoardSnapshot().catch(() => null);
    // A facet call fails when its connection was removed under it (a newer selection's cleanup).
    if (!answer) return this.#selectionMoved(context.target, gatekeeperId, selectionEpoch) ? STALE : UNAVAILABLE;
    if (answer.status === "stale") return STALE;
    if (answer.status === "not-connected") return this.#notConnected(request, guard, token, context);
    if (answer.status === "unavailable" || answer.fence.accountId !== mintedFor.adapterAccountId) {
      return this.#settleAfterCheck(request, guard, token, context, "unavailable");
    }
    // The completion fence, against the attempt that answered (a token-refresh retry included).
    let after = await facet.connectionIdentity().catch(() => null);
    if (!after || !sameFence(after, answer.fence)) return STALE;
    let accountAfter = await this.ports.account(mintedFor.accountId);
    if (!accountAfter || accountAfter.incarnation !== mintedFor.incarnation || accountAfter.epoch !== account.epoch) {
      return STALE;
    }
    let contextAfter = await guard();
    if (!contextAfter || contextAfter.sessionSeq !== context.sessionSeq || contextAfter.target !== context.target) {
      return STALE;
    }
    let board = projectHostBoardSnapshot(answer.snapshot);
    if (!board) return this.#commit(request, token, "unavailable");
    return this.#commit(request, token, "ok", { target: context.target, gatekeeperId, selectionEpoch,
      scope: answer.scope, board });
  }

  #selectionMoved(target: string, gatekeeperId: number, selectionEpoch: number): boolean {
    let selection = this.ports.selections.get(target)?.selection;
    return selection?.gatekeeperId !== gatekeeperId || selection.selectionEpoch !== selectionEpoch;
  }

  // A not-connected (or unavailable) answer is audited only while the caller's context still holds.
  async #settleAfterCheck(request: HostBoardReadRequest, guard: HostBoardGuard, token: CallToken,
      context: HostBoardContext, status: "not-connected" | "unavailable"): Promise<HostBoardView> {
    let after = await guard();
    if (!after || after.sessionSeq !== context.sessionSeq || after.target !== context.target) return STALE;
    return this.#commit(request, token, status);
  }

  #notConnected(request: HostBoardReadRequest, guard: HostBoardGuard, token: CallToken, context: HostBoardContext)
      : Promise<HostBoardView> {
    return this.#settleAfterCheck(request, guard, token, context, "not-connected");
  }

  // The one final compare-and-set: no await from the token check to the return. It validates the
  // call's token and deadline, then (for `ok`) the selection and its epoch and the pin, and only
  // then commits the pin and the audit.
  #commit(request: HostBoardReadRequest, token: CallToken, status: "ok" | "not-connected" | "unavailable",
      read?: { target: string; gatekeeperId: number; selectionEpoch: number; scope: HostBoardScope;
               board: HostBoardViewSnapshot }): HostBoardView {
    if (!token.live || this.ports.now() >= token.deadlineAt) return UNAVAILABLE;
    let view: HostBoardView = status === "not-connected" ? NOT_CONNECTED : UNAVAILABLE;
    if (status === "ok" && read) {
      let slot = this.ports.selections.get(read.target);
      let selection = slot?.selection;
      if (!slot || !selection || selection.gatekeeperId !== read.gatekeeperId ||
          selection.selectionEpoch !== read.selectionEpoch) {
        return STALE;
      }
      let scope = { workspaceId: read.scope.workspaceId, projectId: read.scope.projectId };
      if (selection.pinned && (selection.pinned.workspaceId !== scope.workspaceId ||
          selection.pinned.projectId !== scope.projectId)) {
        // The target now resolves to another project (a reused slug or key): select again.
        status = "not-connected";
        view = NOT_CONNECTED;
      } else {
        if (!selection.pinned) this.ports.selections.put({ ...slot, selection: { ...selection, pinned: scope } });
        view = { status: "ok", board: read.board, readAt: new Date(request.readAt).toISOString(),
          publicationRevision: request.revision };
      }
    }
    this.ports.recordAudit({ kind: "host-board-read", consoleId: request.consoleId, entryId: request.entryId,
      requirementName: request.requirementName, status, at: new Date(this.ports.now()).toISOString() });
    return view;
  }
}

const GROUPS: readonly HostBoardViewGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];
const PRIORITIES: readonly HostBoardViewPriority[] = ["urgent", "high", "medium", "low", "none"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/**
 * The kernel's own projection of a snapshot the adapter returned: only the allowlisted fields,
 * every bound and enum checked again, or null when anything is malformed or over a bound.
 */
export function projectHostBoardSnapshot(snapshot: unknown): HostBoardViewSnapshot | null {
  let L = HOST_BOARD_SNAPSHOT_LIMITS;
  if (!isRecord(snapshot) || !isRecord(snapshot.project) || !Array.isArray(snapshot.columns)) return null;
  let { identifier, name } = snapshot.project;
  if (!boundedString(identifier, L.projectIdentifier) || !boundedString(name, L.projectName)) return null;
  if (snapshot.columns.length > L.columns) return null;
  let total = 0;
  let columns = [];
  for (let column of snapshot.columns) {
    if (!isRecord(column) || !boundedString(column.label, L.columnLabel) ||
        !GROUPS.includes(column.group as HostBoardViewGroup) || !Array.isArray(column.issues) ||
        column.issues.length > L.issuesPerColumn) {
      return null;
    }
    total += column.issues.length;
    if (total > L.issues) return null;
    let issues: HostBoardViewIssue[] = [];
    for (let issue of column.issues) {
      if (!isRecord(issue) || !boundedString(issue.identifier, L.issueIdentifier) ||
          !boundedString(issue.title, L.issueTitle) || !PRIORITIES.includes(issue.priority as HostBoardViewPriority) ||
          !(issue.targetDate === null || (typeof issue.targetDate === "string" && DATE.test(issue.targetDate))) ||
          typeof issue.blocked !== "boolean") {
        return null;
      }
      issues.push({ identifier: issue.identifier, title: issue.title, priority: issue.priority as HostBoardViewPriority,
        targetDate: issue.targetDate as string | null, blocked: issue.blocked });
    }
    columns.push({ label: column.label, group: column.group as HostBoardViewGroup, issues });
  }
  return { project: { identifier, name }, columns };
}
