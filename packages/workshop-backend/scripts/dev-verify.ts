// Readiness of a running local Workshop, checked the way an agent would experience it: sign in
// over the authenticated RPC, confirm the InferOps account is connected, read the demo board
// through the gatekeeper connection, and reach the approval queue. An open port proves nothing;
// this does.
//
//   node packages/workshop-backend/scripts/dev-verify.ts [--url http://localhost:8787]
//        [--user dev] [--password devpassword] [--board inferops://demo.local/project/board/DEMO]
//        [--ensure-board] [--approval-scenario]
//
// Without `--ensure-board` nothing is created: a missing account, workspace or connection fails
// the check and names what `pnpm local seed` would prepare. With it (what `seed` passes) the demo
// workspace's board connection is created if absent, and `--approval-scenario` additionally
// proposes one issue move so the approval queue holds a pending action to review. Both are
// idempotent: the connection is found again through the action log, and a move is only proposed
// while none is pending.
//
// Prints one JSON report. Exit 1 when a check failed, 2 on bad usage. Never prints the session.

import { parseArgs } from "node:util";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import type {
  Board, InferOpsProjectSession,
} from "../../../custom-gatekeepers/gatekeeper-inferops/src/types";
import {
  connectWorkshop, DEMO_BOARD_URL, DEMO_HOST, DEMO_WORKSPACE_TITLE, ensureWorkspace,
  findConnectionByResourceUrl, findWorkspace, INFEROPS_VENDOR_ID, listConnectedAccounts,
  localWorkshopUrl, passwordHash,
} from "./dev-workshop.ts";

const SEED_HINT = "run `pnpm local seed` with the stack running";

let options: {
  url: string; user: string; password: string; board: string;
  "ensure-board": boolean; "approval-scenario": boolean;
};
try {
  ({ values: options } = parseArgs({
    options: {
      url: { type: "string", default: `http://${process.env.VITE_BACKEND_HOST ?? "localhost:8787"}` },
      user: { type: "string", default: process.env.VITE_DEV_USERNAME ?? "dev" },
      password: { type: "string", default: process.env.VITE_DEV_PASSWORD ?? "devpassword" },
      board: { type: "string", default: DEMO_BOARD_URL },
      "ensure-board": { type: "boolean", default: false },
      "approval-scenario": { type: "boolean", default: false },
    },
  }));
} catch (error) {
  console.error(`dev-verify: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
// The host is what tells mock from live; the gatekeeper validates the rest when the board is bound.
const boardHost = /^inferops:\/\/([^/?#]+)\/project\/board\/[^/?#]+$/.exec(options.board)?.[1];
if (!boardHost) {
  console.error(`dev-verify: --board must look like ${DEMO_BOARD_URL}`);
  process.exit(2);
}

/** A readiness failure: the report names the step and the fix instead of a stack trace. */
class CheckFailed extends Error {
  step: string;
  constructor(step: string, message: string) {
    super(message);
    this.step = step;
  }
}

/** What an agent sees of the local stack. Every field is a report, never a grant. */
type AgentView = {
  /** The ambient InferOps account: present when the user has opted into the gatekeeper. */
  inferops: { connected: boolean; accountId?: number; displayName?: string; mode?: "mock" | "live" };
  /** The demo board as read through the gatekeeper connection (`env.INFEROPS_BOARD` in a chat). */
  board: {
    url: string; connectionId?: number; bindingName?: string; tsType?: string;
    readable: boolean; project?: string; host?: string; states?: number; issues?: number;
  };
  /** The workspace's action log, where observations and pending moves land. */
  approvalQueue: { reachable: boolean; pending?: number; proposed?: string };
};

async function signIn(api: RpcStub<PublicApi>): Promise<string> {
  const token = await api.login(options.user, passwordHash(options.user, options.password));
  if (!token) throw new CheckFailed("signIn", `No local account "${options.user}" (or a different password); ${SEED_HINT}`);
  return token;
}

async function ensureConnection(
    overseer: RpcStub<Overseer>, accountId: number): Promise<{ id: number; created: boolean }> {
  const existing = await findConnectionByResourceUrl(overseer, options.board);
  if (existing !== null) return { id: existing, created: false };
  if (!options["ensure-board"]) {
    throw new CheckFailed("board", `No connection to ${options.board} in "${DEMO_WORKSPACE_TITLE}"; ${SEED_HINT}`);
  }
  using connection = await overseer.newGatekeeper(accountId, options.board);
  if (!connection) throw new CheckFailed("board", `The InferOps account cannot open ${options.board}`);
  return { id: await connection.getId(), created: true };
}

/** The first issue with a next state in its own workflow, as a repeatable move to propose. */
function proposableMove(board: Board): { issueId: string; identifier: string; toStateId: string; revision: string; toState: string } | null {
  for (const [index, column] of board.columns.entries()) {
    const next = board.columns.slice(index + 1).find(candidate =>
        candidate.state.workflow === column.state.workflow && candidate.state.group !== "cancelled");
    const issue = column.issues[0];
    if (next && issue) {
      return { issueId: issue.id, identifier: issue.identifier, toStateId: next.state.id,
        revision: issue.revision, toState: next.state.name };
    }
  }
  return null;
}

async function verify(): Promise<{ ok: true; url: string; user: string; workspace: { id: string; title: string }; connectionCreated: boolean; agentView: AgentView }> {
  const base = localWorkshopUrl(options.url);
  const { api, close } = connectWorkshop(base);
  try {
    const token = await signIn(api);
    using user: RpcStub<AuthenticatedApi> = await api.authenticate(token);

    const account = (await listConnectedAccounts(user))
      .find(candidate => candidate.vendorId === INFEROPS_VENDOR_ID);
    if (!account) throw new CheckFailed("inferops", `The InferOps account is not connected for "${options.user}"; ${SEED_HINT}`);
    const inferops: AgentView["inferops"] = {
      connected: true, accountId: account.id, displayName: account.description.displayName,
      mode: boardHost === DEMO_HOST ? "mock" : "live",
    };

    if (!options["ensure-board"] && !await findWorkspace(user, DEMO_WORKSPACE_TITLE)) {
      throw new CheckFailed("workspace", `No "${DEMO_WORKSPACE_TITLE}" workspace; ${SEED_HINT}`);
    }
    using overseer: RpcStub<Overseer> = (await ensureWorkspace(user, DEMO_WORKSPACE_TITLE, "pnpm local seed")).overseer;
    const workspace = await overseer.getMetadata();

    const { id: connectionId, created } = await ensureConnection(overseer, account.id);
    using connection = await overseer.getGatekeeperById(connectionId);
    const description = await connection.describe();
    using session = await connection.openSession() as RpcStub<InferOpsProjectSession>;
    const board = await session.readBoard();
    const boardView: AgentView["board"] = {
      url: options.board, connectionId, bindingName: description.suggestedBindingName,
      tsType: description.tsType, readable: true, project: board.project.identifier,
      host: boardHost, states: board.columns.length,
      issues: board.columns.reduce((sum, column) => sum + column.issues.length, 0),
    };

    const pending = await overseer.listActions({ filter: "pending" });
    const approvalQueue: AgentView["approvalQueue"] = { reachable: true, pending: pending.entries.length };
    if (options["approval-scenario"]) {
      const alreadyPending = pending.entries.some(entry => entry.gatekeeperId === connectionId);
      const move = alreadyPending ? null : proposableMove(board);
      if (move) {
        using issue = await session.openIssue(move.issueId);
        await issue.transition(move.toStateId, move.revision);
        approvalQueue.proposed = `Move ${move.identifier} to ${move.toState}`;
        approvalQueue.pending = (await overseer.listActions({ filter: "pending" })).entries.length;
      }
    }

    return {
      ok: true, url: base.toString(), user: options.user,
      workspace: { id: workspace.id, title: workspace.title },
      connectionCreated: created,
      agentView: { inferops, board: boardView, approvalQueue },
    };
  } finally {
    close();
  }
}

try {
  console.log(JSON.stringify(await verify(), null, 2));
} catch (error) {
  const step = error instanceof CheckFailed ? error.step : "connect";
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ ok: false, url: options.url, step, error: message }, null, 2));
  process.exitCode = 1;
}
