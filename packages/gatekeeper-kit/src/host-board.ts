/**
 * The kernel-only host-board facet contract: how the Workshop kernel, and nothing else, reads the
 * one board a gatekeeper binding is fixed to, together with the scope it was read in and the
 * connection fence of the provider attempt that answered.
 *
 * Why only the kernel can reach it: these methods live on the gatekeeper's Durable Object facet
 * (the `Gatekeeper` class the account minted), never on the session `startSession()` returns.
 * Only the overseer holds a facet stub (`getGatekeeperFacet`); agents, gadgets and widgets hold
 * sessions, which are separate `RpcTarget`s with their own methods, and the advertised agent types
 * (`getTypeScriptTypes()`) do not name this contract. A kernel caller views the facet through these
 * interfaces the way it views the optional `gitPull`/`getAgentCatalog` methods.
 *
 * Neither method takes a target: the account and the board come only from the binding's immutable
 * props. Neither records an observation; the kernel owns any audit of what it shows.
 *
 * Every result is normalized: no provider message, cause, payload, URL or credential is ever
 * returned, only a status and, for `unavailable`, a bounded reason.
 *
 * Deadline: an implementation may time out each provider request, but this contract does not put
 * the credential fetch, a refresh and its retry, and the completion fence under one deadline. A
 * total deadline is the kernel caller's to impose.
 */

/** The published bounds of a snapshot. String lengths are UTF-16 code units (JS `length`). */
export const HOST_BOARD_LIMITS = {
  /** Columns on the board. */
  columns: 20,
  /** Issues in any one column. */
  issuesPerColumn: 200,
  /** Issues on the whole board. */
  issues: 500,
  /** The project's identifier. */
  projectIdentifier: 32,
  /** The project's name. */
  projectName: 200,
  /** A column's label. */
  columnLabel: 100,
  /** An issue's identifier (`ENG-123`). */
  issueIdentifier: 32,
  /** An issue's title. */
  issueTitle: 500,
  /** The UTF-8 byte length of the whole successful response body: 256 KiB. */
  bytes: 256 * 1024,
  /** The UTF-8 byte length of an error response body read for its envelope: 4 KiB. */
  errorBytes: 4 * 1024,
} as const;

/** A column's workflow group. */
export type HostBoardGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

/** An issue's priority. */
export type HostBoardPriority = "urgent" | "high" | "medium" | "low" | "none";

/** One card face: no id, assignee, lease, run, revision or blocked-reason text. */
export type HostBoardIssue = {
  /** `<KEY>-<n>`. */
  identifier: string;
  title: string;
  priority: HostBoardPriority;
  /** `yyyy-mm-dd`, or null. */
  targetDate: string | null;
  /** Whether the issue carries a blocked reason; the reason itself is never returned. */
  blocked: boolean;
};

/** One column: its label and group, and its issues in board order. */
export type HostBoardColumn = { label: string; group: HostBoardGroup; issues: HostBoardIssue[] };

/** The bounded board itself. */
export type HostBoardSnapshot = {
  project: { identifier: string; name: string };
  columns: HostBoardColumn[];
};

/** The provider scope the snapshot was read in: kernel-only material, never shown to sessions. */
export type HostBoardScope = { workspaceId: string; projectId: string };

/**
 * The connection a provider attempt ran under: the binding's account, and the credential identity
 * fence and connection generation of that attempt (`CredentialRead`), for comparison with a fresh
 * `connectionIdentity()` later. Kernel-only material.
 */
export type HostBoardFence = {
  /**
   * The gatekeeper adapter's own string account id (its binding props), distinct from the
   * kernel's numeric connected-account id: map between them, never compare them.
   */
  accountId: string;
  identity: string;
  generation: string;
};

/** Why a host board is unavailable, without anything the provider said. */
export type HostBoardUnavailableReason =
  /** The deployment has the lane (or the integration) turned off. */
  | "disabled"
  /** The binding's fixed target is not a board this lane reads. */
  | "invalid-target"
  /** The provider has no such board for this person, or one they may read. */
  | "not-found"
  /** The provider refused the person the read. */
  | "forbidden"
  /** The board exceeds a published bound; nothing partial is returned. */
  | "too-large"
  /** The provider was unreachable or answered outside the contract. */
  | "provider";

/**
 * One host-board read:
 * - `ok`: the snapshot, the scope it was read in, and the fence of the provider attempt that
 *   answered, which still held after the answer arrived.
 * - `not-connected`: the binding has no live connected person (never connected, signed out,
 *   revoked before the read, or a demo binding).
 * - `unavailable`: refused or failed, with a bounded reason.
 * - `stale`: the connection changed (a reconnect, a revoke, a replaced session) while the read was
 *   in flight, so the answer was discarded. Reading again reports the connection's real state.
 */
export type HostBoardRead =
  | { status: "ok"; scope: HostBoardScope; snapshot: HostBoardSnapshot; fence: HostBoardFence }
  | { status: "not-connected" }
  | { status: "unavailable"; reason: HostBoardUnavailableReason }
  | { status: "stale" };

/** A facet that reads the one board its binding is fixed to. Kernel-only; see the module comment. */
export interface HostBoardReader {
  /**
   * Reads the binding's fixed board. Takes no target: the account and board come from the
   * binding's props alone. Records no observation.
   * @returns The normalized read; never throws for a provider or connection failure.
   */
  readHostBoardSnapshot(): Promise<HostBoardRead>;
}

/** A facet that reports its binding's current connection fence. Kernel-only; see the module comment. */
export interface HostBoardConnectionFence {
  /**
   * The binding's account and its connection's current identity and generation, read fresh, to
   * compare with an earlier read's `fence`.
   * @returns The current fence, or null when the lane is off or no connected person backs the
   * binding.
   */
  connectionIdentity(): Promise<HostBoardFence | null>;
}
