// INFEROPS_ENABLED, the deployment switch for the integration: off refuses new bindings and every
// call through an existing binding or session with DISABLED, including applying a queued move; on
// again, the same binding and session work, and nothing new was granted in between.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { inferOpsEnabled } from "../src/enablement";
import type { BindingProps } from "./worker";

const READY = "20000000-0000-4000-8000-000000000001";
const WORKING = "20000000-0000-4000-8000-000000000002";
const DEMO_1 = "30000000-0000-4000-8000-000000000001";
const DEMO_URL = "inferops://demo.local/project/board/DEMO";

// The switch is a deployment var, read when each call is made. Workers share one env object per
// isolate, so the suite flips it as a redeploy with a changed var would.
const mutableEnv = env as unknown as { INFEROPS_ENABLED?: string };
const turn = (value: "true" | "false" | undefined) => {
  if (value === undefined) delete mutableEnv.INFEROPS_ENABLED;
  else mutableEnv.INFEROPS_ENABLED = value;
};
afterEach(() => turn(undefined));

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

function setup() {
  const props: BindingProps = { accountId: crypto.randomUUID(), host: "demo.local", projectKey: "DEMO" };
  const hooks = env.TEST_HOOKS.getByName(props.accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${props.accountId}`);
  return { props, hooks, mock };
}

describe("inferOpsEnabled", () => {
  it("is on when unset or \"true\", and off for anything else", () => {
    expect(inferOpsEnabled({})).toBe(true);
    expect(inferOpsEnabled({ INFEROPS_ENABLED: "true" })).toBe(true);
    expect(inferOpsEnabled({ INFEROPS_ENABLED: "false" })).toBe(false);
    expect(inferOpsEnabled({ INFEROPS_ENABLED: "TRUE" })).toBe(false);
    expect(inferOpsEnabled({ INFEROPS_ENABLED: "" })).toBe(false);
  });
});

describe("INFEROPS_ENABLED", () => {
  it("refuses a new binding while off", async () => {
    const { hooks } = setup();
    turn("false");

    const refused = await hooks.bindAccount("off", { accountId: crypto.randomUUID() }, DEMO_URL);

    expect(refused).toContain("DISABLED: InferOps is turned off for this deployment.");
  });

  it("refuses every call of an existing session while off, and serves it again once on", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    expect(await hooks.bindAccount("kept", account, DEMO_URL)).toBeNull();
    const session = hooks.startBoundSession("kept");
    const issue = session.openIssue(DEMO_1);
    expect((await session.readBoard()).project.identifier).toBe("DEMO");

    turn("false");
    expect(await failure(session.readBoard())).toContain("DISABLED: InferOps is turned off");
    expect(await failure(session.openIssue(DEMO_1))).toContain("DISABLED");
    expect(await failure(issue.read())).toContain("DISABLED");
    expect(await failure(issue.transition(WORKING, "1"))).toContain("DISABLED");
    // A session opened on the existing binding while off is refused the same way.
    expect(await failure(hooks.startBoundSession("kept").readBoard())).toContain("DISABLED");

    turn("true");
    expect((await session.readBoard()).project.identifier).toBe("DEMO");
    expect(await issue.read()).toMatchObject({ stateId: READY, revision: "1" });
    // Nothing was proposed while off.
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("never applies a queued move while off, and applies it once on", async () => {
    const { props, hooks, mock } = setup();
    await hooks.startSession(props).openIssue(DEMO_1).transition(WORKING, "1");
    const actionId = (await hooks.log()).actions[0]!.id;

    turn("false");
    expect(await hooks.apply(props, actionId)).toContain("InferOps is turned off for this deployment");
    expect(await hooks.revert(props, actionId)).toBe("This change was never applied, so there is nothing to revert.");
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: READY, revision: "1" });

    turn("true");
    expect(await hooks.apply(props, actionId)).toBeNull();
    expect(await mock.readIssue("DEMO", DEMO_1)).toMatchObject({ stateId: WORKING, revision: "2" });
  });

  it("still lets an account delete its own data while off", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    turn("false");

    await hooks.revokeAccount(account);
  });

  it("refuses an observer while off rather than admitting or denying them", async () => {
    const { hooks } = setup();
    const owner = { accountId: crypto.randomUUID() };
    expect(await hooks.bindAccount("observed", owner, DEMO_URL)).toBeNull();

    turn("false");
    expect(await hooks.addObserverFrom("observed", { accountId: crypto.randomUUID() })).toContain("DISABLED");
  });

  it("treats an explicit \"true\" like the unset default", async () => {
    const { hooks } = setup();
    turn("true");

    expect(await hooks.bindAccount("on", { accountId: crypto.randomUUID() }, DEMO_URL)).toBeNull();
  });
});
