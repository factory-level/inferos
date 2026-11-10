// FAC-119 K2: what a person deciding an action may know of where it came from, and reconnecting a
// connection whose sign-in expired. An action's context is computed from its record alone and is
// reference-only: a workflow run's trigger and run (assigned or requested), who asked, and the
// trigger's label, or an agent's turn; never the credential reference, the delivery, the write key
// or the chat. Reconnecting resolves the connection's account on the server, for the caller's own
// account only: another person's connection (another company's included) and one that records no
// account are refused, with nothing started.
import { describe, expect, it, vi } from "vitest";
import {
  GATEKEEPER_RECONNECT_REFUSED, type ActionLogEntry,
} from "@gadgets/workshop-shared/api";
import { actionContextOf, actionRecordToLog, type ActionRecord } from "../src/overseer.js";
import { makeActionStorage, openFakeOverseer, putAction } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const record = (patch: Partial<ActionRecord & { type: "action" }>) => {
  const storage = makeActionStorage();
  putAction(storage, 1);
  const base = storage.actions.get(1)! as ActionRecord & { type: "action" };
  return { ...base, ...patch } as ActionRecord & { type: "action" };
};

describe("an action's context", () => {
  it("names an assigned run's trigger, run, who asked and its label, and nothing of its credential", () => {
    const assigned = record({ executedAs: { hookId: 7, deliveryId: 3, credentialRef: "secret-ref", runId: "run-1",
      requestedBy: "ada-profile", writeKey: "k" }, caller: { from: "systemRun" } as never })
    const entry = actionRecordToLog(assigned, hookId => (hookId === 7 ? "Refund customer" : undefined)) as Extract<ActionLogEntry, { type: "action" }>
    expect(entry.context).toEqual({ kind: "workflow-run", hookId: 7, assigned: true, runId: "run-1",
      requestedBy: "ada-profile", triggerLabel: "Refund customer" })
    expect(JSON.stringify(entry)).not.toContain("secret-ref")
    expect(JSON.stringify(entry.context)).not.toMatch(/deliveryId|writeKey|credential/)
  })

  it("names a requested run's trigger, and a trigger that fired itself as asked by nobody", () => {
    expect(actionContextOf(record({ workflowRun: { runId: "run-2", hookId: 8, deliveryId: 4, attempt: 1 } })))
      .toEqual({ kind: "workflow-run", hookId: 8, assigned: false, runId: "run-2" })
    expect(actionContextOf(record({ executedAs: { hookId: 9, deliveryId: 5, credentialRef: "r", requestedBy: null } })))
      .toEqual({ kind: "workflow-run", hookId: 9, assigned: true, requestedBy: null })
  })

  it("says an agent's turn asked, never which chat, and nothing more for a person or a gadget", () => {
    const entry = actionRecordToLog(record({ caller: { from: "agent", chatId: 42 } as never })) as Extract<ActionLogEntry, { type: "action" }>
    expect(entry.context).toEqual({ kind: "agent-turn" })
    expect(JSON.stringify(entry)).not.toContain("42")
    expect(actionContextOf(record({ caller: { from: "user" } as never }))).toBeUndefined()
    expect(actionContextOf(record({ caller: { from: "gadget", gadgetId: 3 } as never }))).toBeUndefined()
  })
})

/** A workspace whose owner, `owner-id`, holds connections `gatekeepers`, and whose reconnects are recorded. */
async function workspace(gatekeepers: Record<number, object>,
    opts: { role?: "build" | "use"; userId?: string; reconnect?: () => Promise<object> } = {}) {
  const storage = makeActionStorage() as ReturnType<typeof makeActionStorage> & { gatekeepers: unknown }
  Object.assign(storage, { gatekeepers: { get: (id: number) => gatekeepers[id] } })
  const reconnectAccount = vi.fn(opts.reconnect ?? (async () => ({ url: "https://connect.example/again", nonce: "n" })))
  const client = await openFakeOverseer(storage, { role: opts.role, userId: opts.userId, impl: {
    users: { idFromString: (id: string) => id, get: () => ({
      whoami: async () => ({ id: "profile-id", name: "Ada" }), recordSharedGadgetOpen: async () => {}, reconnectAccount,
    }) },
  } })
  return { client, reconnectAccount }
}

describe("reconnecting a connection", () => {
  it("starts reconnecting the caller's own account, resolved on the server", async () => {
    const { client, reconnectAccount } = await workspace({ 4: { id: 4, connectedBy: { userId: "owner-id", accountId: 12 } } })
    expect(await client.reconnectGatekeeper(4)).toEqual({ url: "https://connect.example/again", nonce: "n" })
    expect(reconnectAccount).toHaveBeenCalledWith(12)
  })

  it("reconnects a host board's connection by the account it was minted from", async () => {
    const { client, reconnectAccount } = await workspace({ 5: { id: 5, hostBoardMint: { by: "owner-id", requestKey: "r", accountId: 13, incarnation: "i" } } })
    await client.reconnectGatekeeper(5)
    expect(reconnectAccount).toHaveBeenCalledWith(13)
  })

  it("reconnects an ambient connection for the workspace's owner, whose account it always is, and no one else", async () => {
    const ambient = { 6: { id: 6, creationSpec: { type: "ambient", vendorId: "inferops", accountId: 14 } } }
    const owner = await workspace(ambient)
    await owner.client.reconnectGatekeeper(6)
    expect(owner.reconnectAccount).toHaveBeenCalledWith(14)
    const other = await workspace(ambient, { userId: "builder-2" })
    await expect(other.client.reconnectGatekeeper(6)).rejects.toThrow(GATEKEEPER_RECONNECT_REFUSED)
    expect(other.reconnectAccount).not.toHaveBeenCalled()
  })

  it("refuses another person's connection, another company's included, starting nothing", async () => {
    const { client, reconnectAccount } = await workspace({ 4: { id: 4, connectedBy: { userId: "someone-else", accountId: 12 } } })
    await expect(client.reconnectGatekeeper(4)).rejects.toThrow(GATEKEEPER_RECONNECT_REFUSED)
    expect(reconnectAccount).not.toHaveBeenCalled()
  })

  it("refuses, in the same words, a connection that records no account, one that doesn't exist, and an account since removed", async () => {
    const { client, reconnectAccount } = await workspace({ 4: { id: 4 } })
    await expect(client.reconnectGatekeeper(4)).rejects.toThrow(GATEKEEPER_RECONNECT_REFUSED)
    await expect(client.reconnectGatekeeper(99)).rejects.toThrow(GATEKEEPER_RECONNECT_REFUSED)
    expect(reconnectAccount).not.toHaveBeenCalled()
    const removed = await workspace({ 4: { id: 4, connectedBy: { userId: "owner-id", accountId: 12 } } },
      { reconnect: async () => { throw new Error("No such account.") } })
    await expect(removed.client.reconnectGatekeeper(4)).rejects.toThrow(GATEKEEPER_RECONNECT_REFUSED)
  })

  it("is not available to the use role", async () => {
    const { client, reconnectAccount } = await workspace({ 4: { id: 4, connectedBy: { userId: "viewer-id", accountId: 12 } } }, { role: "use" })
    await expect(client.reconnectGatekeeper(4)).rejects.toThrow("Unauthorized")
    expect(reconnectAccount).not.toHaveBeenCalled()
  })
})

describe("a new connection", () => {
  it("records whose account it uses, so only they can reconnect it", async () => {
    const storage = makeActionStorage()
    const addGatekeeper = vi.fn(async () => ({ getId: async () => 9 }))
    const client = await openFakeOverseer(storage, { impl: {
      addGatekeeper, recordGadgetAnalytics: () => {},
      users: { idFromString: (id: string) => id, get: () => ({
        id: { toString: () => "owner-id" },
        whoami: async () => ({ id: "profile-id", name: "Ada" }), recordSharedGadgetOpen: async () => {},
        getGatekeeperClassFor: async () => ({ class: {}, vendorId: "inferops", typeUrlPattern: "inferops://*/project/board/*", mock: false }),
      }) },
    } })
    await client.newGatekeeper(12, "inferops://acme.operations/project/board/ENG")
    expect(addGatekeeper.mock.calls[0]![7]).toEqual({ userId: "owner-id", accountId: 12 })
  })
})
