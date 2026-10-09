import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub } from "capnweb";
import type { OperateSessionUpdate } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

let userCounter = 0;
function freshUser() {
  const stub = env.TEST_USER.getByName(`console-revision-notice-${++userCounter}`);
  return <T>(f: (user: UserDurableObject) => Promise<T>) => runInDurableObject(stub, f);
}

const openAt = (revision: string) => ({ type: "openConsole", workspaceId: "ws1", consoleId: "c1", title: "Console A",
  source: "published", revision, fullChat: "off", viewId: "board" } as const);

// Two publishes fan out independently, so the first one's notice can land after the session has
// already reopened the console at the second revision.
it("passes on only a notice newer than the open revision, or a deletion", async () => {
  const inDo = freshUser();
  const notices: OperateSessionUpdate[] = [];
  const subscription = await inDo(async user => {
    await user.dispatchOperateEvent(openAt("2"), null, "person");
    return user.subscribeOperateSession(new RpcStub((update: OperateSessionUpdate) => {
      if (update.consoleRevision) notices.push(update);
    }));
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  await inDo(user => user.noticeConsoleRevision("ws1", "c1", "1"));  // older: R1's late notice
  await inDo(user => user.noticeConsoleRevision("ws1", "c1", "2"));  // the open revision itself
  await inDo(user => user.noticeConsoleRevision("ws1", "other", "9"));
  await settle();
  expect(notices).toEqual([]);

  await inDo(user => user.noticeConsoleRevision("ws1", "c1", "3"));
  await inDo(user => user.noticeConsoleRevision("ws1", "c1", null));
  await settle();
  expect(notices.map(notice => notice.consoleRevision?.revision)).toEqual(["3", null]);
  subscription[Symbol.dispose]();
});
