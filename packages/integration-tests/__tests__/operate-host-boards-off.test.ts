// Host boards with the switch off (the default): the kernel refuses registration and publication,
// selection and acquisition, and reports the switch off to clients. The read checkpoint is covered
// by workshop-backend's host-boards.test.ts. Bound views, which need host boards, are refused at
// delivery too. Synthetic data only.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp } from "../src/rpc-client.js";

const ENG = "inferops://acme.operations/project/board/ENG";
let harness: Harness;
let publicApi: RpcStub<PublicApi>;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    patchWorkshop(config) {
      config.vars = { ...config.vars, COMPOSABLE_VIEWS: "true", DURABLE_VIEWS: "true" };
    },
  });
  publicApi = connect(harness.url);
});

afterAll(async () => {
  try {
    publicApi?.[Symbol.dispose]();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("refuses host boards at registration, selection and acquisition while the switch is off", async () => {
  expect(await publicApi.getServerConfig()).toMatchObject({ hostBoards: false, boundViews: false });
  const api = await signUp(publicApi, nextUsernames("hboff")[0]!);
  const ws = await api.newGadget();
  const screen = await ws.createCanvas({ title: "Floor", sections: [] });
  const views = [{ id: "floor", title: "Floor", type: "screen" as const, screen: screen.id }];
  const board = { kind: "host-board" as const, label: "Board", requirement: { name: "board", resource: "inferops-board" as const, target: ENG } };
  await expect(ws.createConsole({ title: "Floor", fullChat: "off", views, hostBoards: [board] })).rejects.toThrow(/turned off/);
  // A console without host boards is unaffected.
  const plain = await ws.createConsole({ title: "Floor", fullChat: "off", views });
  await expect(ws.replaceConsole(plain.id, plain.revision, { title: "Floor", fullChat: "off", views, hostBoards: [board] }))
    .rejects.toThrow(/turned off/);
  const published = await ws.publishConsole(plain.id, plain.revision);
  const session = await api.getOperateSession();
  const ref = { consoleId: published.id, source: "published" as const, revision: published.revision };
  await expect(session.selectHostBoardConnection(ref, "any", 0, "k1")).rejects.toThrow(/turned off/);
  await expect(session.getConsoleHostBoard(ref, "any")).rejects.toThrow(/turned off/);
  await expect(session.getConsoleBoundView(ref, "any")).rejects.toThrow(/Bound views are turned off/);
});
