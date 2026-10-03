// What the local operator scripts (dev-setup.ts, dev-verify.ts) share: how they reach a local
// Workshop over the same Cap'n Web API the browser uses, derive the browser's password hash, and
// find the things `pnpm local seed` prepares. Node-only; nothing here runs in a Worker.

import { argon2Sync } from "node:crypto";
import { newWebSocketRpcSession, RpcStub, RpcTarget } from "capnweb";
import type {
  ActionLogEntry, AuthenticatedApi, ConnectedAccountsSubscriber, GadgetMetadataWithTimestamps,
  Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import type {
  AccountDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { SERVICE_SALT } from "@gadgets/workshop-shared/password-salt";

/** The workspace `pnpm dev:setup --screen` and `pnpm local seed` prepare, found by title. */
export const DEMO_WORKSPACE_TITLE = "InferOps Canvas demo";

/** The InferOps gatekeeper's vendor id (the `GATEKEEPER_INFEROPS` binding suffix, lowercased). */
export const INFEROPS_VENDOR_ID = "inferops";

/** The board the mock InferOps data source serves; a live connection names its own host. */
export const DEMO_BOARD_URL = "inferops://demo.local/project/board/DEMO";

/** The host of the mock data source, which is what a board URL names when nothing live is set. */
export const DEMO_HOST = "demo.local";

/**
 * Parse a Workshop URL, refusing any host but localhost: these scripts create accounts and send
 * sessions to the target, so they are deliberately local-only.
 */
export function localWorkshopUrl(url: string): URL {
  const base = new URL(url);
  if (base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
    throw new Error("Only a local Workshop (localhost or 127.0.0.1) is targeted");
  }
  return base;
}

/** The browser's password hash (see `PublicApi.login()`), derived with Node's own Argon2id. */
export function passwordHash(username: string, password: string): Uint8Array {
  const salt = Buffer.concat([SERVICE_SALT, Buffer.from(username, "utf8")]);
  return new Uint8Array(argon2Sync("argon2id",
    { message: password, nonce: salt, parallelism: 1, passes: 3, memory: 65536, tagLength: 32 }));
}

/**
 * An RPC session on a Workshop's `/api`. The socket is opened here rather than by capnweb so a
 * server that never answers (a port nothing listens on, or something that is not a Workshop)
 * fails the pending calls after `timeoutMs` instead of hanging the script.
 */
export function connectWorkshop(base: URL, timeoutMs = 15_000): {
  api: RpcStub<PublicApi>;
  close(): void;
} {
  const wsUrl = new URL("/api", base);
  wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl.toString());
  const api = newWebSocketRpcSession<PublicApi>(socket);
  const timeout = setTimeout(() => socket.close(), timeoutMs);
  return {
    api,
    close() {
      clearTimeout(timeout);
      api[Symbol.dispose]();
      socket.close();
    },
  };
}

/** One connected account as `subscribeConnectedAccounts` reports it. */
export type ConnectedAccount = {
  id: number;
  vendorId: string;
  description: AccountDescription;
  credentialsValid: boolean;
};

/** The user's connected accounts, read by driving `subscribeConnectedAccounts()` to `ready()`. */
export async function listConnectedAccounts(
    user: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount[]> {
  const accounts: ConnectedAccount[] = [];
  const ready = Promise.withResolvers<void>();
  class Subscriber extends RpcTarget implements ConnectedAccountsSubscriber {
    add(id: number, description: AccountDescription, _vendor: VendorDescription,
        _resources: SupportedResource[], credentialsValid: boolean, vendorId: string): void {
      accounts.push({ id, vendorId, description, credentialsValid });
    }
    remove(id: number): void {
      const at = accounts.findIndex(account => account.id === id);
      if (at >= 0) accounts.splice(at, 1);
    }
    ready(): void {
      ready.resolve();
    }
  }
  using subscriber = new RpcStub(new Subscriber());
  using _subscription = await user.subscribeConnectedAccounts(subscriber);
  await ready.promise;
  return accounts;
}

/** The user's workspace titled `title`, if any. */
export async function findWorkspace(user: RpcStub<AuthenticatedApi>, title: string)
    : Promise<GadgetMetadataWithTimestamps | undefined> {
  return (await user.listGadgets()).find(workspace => workspace.title === title);
}

/**
 * Open the workspace titled `title`, creating it when absent. A new workspace stays provisional
 * (hidden, and eventually reaped) until it has activity; a chat with no agent is the lightest
 * activity that keeps it. The caller disposes the returned overseer.
 */
export async function ensureWorkspace(user: RpcStub<AuthenticatedApi>, title: string, createdBy: string)
    : Promise<{ overseer: RpcStub<Overseer>; created: boolean }> {
  const existing = await findWorkspace(user, title);
  if (existing) return { overseer: user.openGadget(existing.id), created: false };
  const overseer = user.newGadget();
  await overseer.setTitle(title);
  await overseer.newChat(`Workspace prepared by ${createdBy}.`, null);
  return { overseer, created: true };
}

// Pages of action history to walk when looking for a connection. A demo workspace's log is short;
// the cap only keeps a runaway history from turning a readiness check into a long walk.
const MAX_HISTORY_PAGES = 20;

/**
 * The gatekeeper (connection) workpiece bound to `resourceUrl` in this workspace, found through
 * the native action log: every read through the connection is recorded as an observation carrying
 * the connection's id and resource URL. Connections are not listed anywhere else, and this needs
 * no file of its own -- the log lives with the state a reset clears. Null when nothing has read
 * through such a connection yet.
 */
export async function findConnectionByResourceUrl(
    overseer: RpcStub<Overseer>, resourceUrl: string): Promise<number | null> {
  let beforeId: number | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const { entries, nextBeforeId } = await overseer.listActions({ beforeId, filter: "all" });
    const match = entries.find((entry: ActionLogEntry) =>
        entry.gatekeeperId !== undefined && entry.resourceUrl === resourceUrl);
    if (match?.gatekeeperId !== undefined) return match.gatekeeperId;
    if (nextBeforeId === undefined) return null;
    beforeId = nextBeforeId;
  }
  return null;
}
