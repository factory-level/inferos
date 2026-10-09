// Host boards: the kernel-only read of the one InferOps board a project-board binding is fixed to,
// through InferOps' `project.board_snapshot` (`GET /project/board-snapshot?ref=<canonical ref>`).
//
// - The lane has its own switch, `INFEROPS_HOST_BOARDS`: off unless set to "true", and only while
//   `INFEROPS_ENABLED` is on, whose own meaning it leaves untouched. It is checked on every call.
// - The target is never an argument. The canonical reference is built from the binding's props
//   (`host` and `projectKey`), and a key outside InferOps' own identifier bound (an uppercase
//   letter, then up to nine uppercase letters or digits) is refused before anything is sent.
// - The contract the kernel sees (`HostBoardReader`, `HostBoardConnectionFence`) is in
//   `@gadgets/gatekeeper-kit/host-board`; the facet methods that implement it are on
//   `InferOpsProjectGatekeeper` (inferops.ts), and the HTTP read and its strict parser are in
//   http-inferops.ts.

import type { HostBoardRead, HostBoardUnavailableReason } from "@gadgets/gatekeeper-kit/host-board";
import { inferOpsEnabled } from "./enablement";
import { parseHost } from "./resources";

/** InferOps' project identifier, as this lane reads it: uppercase only, at most ten characters. */
const HOST_BOARD_KEY = /^[A-Z][A-Z0-9]{0,9}$/;

type HostBoardsEnv = Pick<Cloudflare.Env, "INFEROPS_ENABLED" | "INFEROPS_HOST_BOARDS">;

/** Whether host boards are on: only `"true"`, and only while InferOps itself is on. */
export function hostBoardsEnabled(env: HostBoardsEnv): boolean {
  return env.INFEROPS_HOST_BOARDS === "true" && inferOpsEnabled(env);
}

/**
 * The canonical `inferops://<tenant>.<workspace>/project/board/<KEY>` of a binding's fixed target,
 * or null when its host or key is not one this lane reads. Pure: makes no request.
 */
export function hostBoardRef(host: string, projectKey: string): string | null {
  if (!parseHost(host) || !HOST_BOARD_KEY.test(projectKey)) return null;
  return `inferops://${host}/project/board/${projectKey}`;
}

/** The one `not-connected` answer. */
export const HOST_BOARD_NOT_CONNECTED: HostBoardRead = { status: "not-connected" };

/** The one `stale` answer. */
export const HOST_BOARD_STALE: HostBoardRead = { status: "stale" };

/** An `unavailable` answer with its bounded reason. */
export function unavailable(reason: HostBoardUnavailableReason): HostBoardRead {
  return { status: "unavailable", reason };
}
