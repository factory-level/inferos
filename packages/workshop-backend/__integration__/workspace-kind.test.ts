import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { GadgetMetadata, PublicApi, WorkspaceKind } from "@gadgets/workshop-shared/api";
import server from "../src/server";
import { describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

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

async function signIn(publicApi: RpcStub<PublicApi>) {
  const name = "kind" + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return publicApi.authenticate(token);
}

describe("workspace kind", () => {
  it("defaults to app and changes only through setKind", async () => {
    using publicApi = await connect();
    using authenticated = await signIn(publicApi);
    using workspace = await authenticated.newGadget();
    const id = (await workspace.getMetadata()).id;

    expect((await workspace.getMetadata()).kind).toBe("app");

    await workspace.setKind("workflow");
    expect((await workspace.getMetadata()).kind).toBe("workflow");

    // The owner's list carries the kind, so it can be shown without opening each workspace. A
    // workspace is listed once it has been active; a chat message with no model makes it so.
    await workspace.newChat("list me", null);
    const listed = (await authenticated.listGadgets()).find(gadget => gadget.id === id);
    expect(listed?.kind).toBe("workflow");
  });

  it("pushes kind changes to metadata subscribers", async () => {
    using publicApi = await connect();
    using authenticated = await signIn(publicApi);
    using workspace = await authenticated.newGadget();

    const seen: (WorkspaceKind | undefined)[] = [];
    let notify: () => void = () => {};
    using _subscription = await workspace.subscribeToMetadata((metadata: GadgetMetadata) => {
      seen.push(metadata.kind);
      notify();
    });
    const changed = new Promise<void>(resolve => { notify = resolve; });

    await workspace.setKind("widget");
    await changed;
    expect(seen).toEqual(["app", "widget"]);
  });

  it("rejects a value that is not a kind", async () => {
    using publicApi = await connect();
    using authenticated = await signIn(publicApi);
    using workspace = await authenticated.newGadget();

    await expect(workspace.setKind("dashboard" as WorkspaceKind)).rejects.toThrow();
    expect((await workspace.getMetadata()).kind).toBe("app");
  });
});
