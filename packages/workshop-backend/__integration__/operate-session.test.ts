import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import {
  getOperateSessionErrorCode,
  OPERATE_SESSION_ERROR_CODES,
  type OperateSessionUpdate,
  type PublicApi,
} from "@gadgets/workshop-shared/api";
import server from "../src/server";
import { describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const BOARD = { type: "screen", workspaceId: "ws1", screenId: "board" } as const;

async function connect(): Promise<RpcStub<PublicApi>> {
  // Invoke the handler directly so the WebSocket session shares the test's execution context.
  const response = await server.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }), env, createExecutionContext());
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(publicApi: RpcStub<PublicApi>): Promise<string> {
  const name = "operate" + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return token;
}

async function rejectionCode(value: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await value;
  } catch (error) {
    return getOperateSessionErrorCode(error);
  }
  throw new Error("Expected the call to reject.");
}

describe("operate session", () => {
  it("is one session per person, shared live by every connection", async () => {
    using first = await connect();
    const token = await createAccount(first);
    using second = await connect();
    using tabA = await first.authenticate(token);
    using tabB = await second.authenticate(token);
    using sessionA = await tabA.getOperateSession();
    using sessionB = await tabB.getOperateSession();

    const seen: OperateSessionUpdate[] = [];
    let sawFirstEvent = () => {};
    const delivered = new Promise<void>(resolve => { sawFirstEvent = resolve; });
    using _subscription = await sessionB.subscribe((update: OperateSessionUpdate) => {
      seen.push(update);
      if (update.seq === 1) sawFirstEvent();
    });

    const snapshot = await sessionA.dispatch({ type: "open", ref: BOARD }, 0);
    expect(snapshot.seq).toBe(1);
    expect(snapshot.state.focus).toEqual(BOARD);

    await delivered;
    expect(seen[0]).toMatchObject({ seq: 0, state: { workingSet: [] } });
    expect(seen.at(-1)).toMatchObject({
      seq: 1, state: { focus: BOARD }, record: { seq: 1, actor: "person", event: { type: "open" } },
    });
  });

  it("rejects a stale expected sequence number and an invalid event, changing nothing", async () => {
    using publicApi = await connect();
    using authenticated = await publicApi.authenticate(await createAccount(publicApi));
    using session = await authenticated.getOperateSession();

    await session.dispatch({ type: "open", ref: BOARD }, 0);
    expect(await rejectionCode(session.dispatch({ type: "setChatOpen", open: false }, 0)))
        .toBe(OPERATE_SESSION_ERROR_CODES.conflict);
    expect(await rejectionCode(session.dispatch(
        { type: "focus", ref: { type: "workspace", workspaceId: "not-open" } }, 1)))
        .toBe(OPERATE_SESSION_ERROR_CODES.invalidEvent);

    const log = await session.listEvents(0, 50);
    expect(log.map(record => record.seq)).toEqual([1]);
    expect((await session.dispatch({ type: "setChatOpen", open: false }, 1)).seq).toBe(2);
    expect((await session.listEvents(1, 50)).map(record => record.event.type)).toEqual(["setChatOpen"]);
  });

  it("has one hidden workspace for its operate chat", async () => {
    using publicApi = await connect();
    using authenticated = await publicApi.authenticate(await createAccount(publicApi));
    using session = await authenticated.getOperateSession();

    using workspace = await session.getWorkspace();
    const id = (await workspace.getMetadata()).id;
    using again = await (await authenticated.getOperateSession()).getWorkspace();
    expect((await again.getMetadata()).id).toBe(id);

    // Activity makes a workspace listable; the session workspace still stays out of the list.
    await workspace.newChat("operate chat", null);
    expect((await authenticated.listGadgets()).map(gadget => gadget.id)).not.toContain(id);
  });

  it("carries a running flow's step to every connection", async () => {
    using first = await connect();
    const token = await createAccount(first);
    using second = await connect();
    using tabA = await first.authenticate(token);
    using tabB = await second.authenticate(token);
    using sessionA = await tabA.getOperateSession();
    using sessionB = await tabB.getOperateSession();

    let sawStep = () => {};
    const stepped = new Promise<void>(resolve => { sawStep = resolve; });
    let latest: OperateSessionUpdate | undefined;
    using _subscription = await sessionB.subscribe((update: OperateSessionUpdate) => {
      latest = update;
      if (update.seq === 2) sawStep();
    });

    await sessionA.dispatch(
        { type: "startFlow", workspaceId: "ws1", flowId: "intake", title: "Intake", steps: ["a", "b"] }, 0);
    await sessionA.dispatch({ type: "goToStep", index: 1 }, 1);
    await stepped;
    expect(latest?.state.flow).toMatchObject({ flowId: "intake", index: 1, steps: ["a", "b"] });

    expect(await rejectionCode(sessionA.dispatch({ type: "goToStep", index: 2 }, 2)))
        .toBe(OPERATE_SESSION_ERROR_CODES.invalidEvent);
    expect((await sessionA.dispatch({ type: "exitFlow" }, 2)).state.flow).toBeNull();
  });
});
