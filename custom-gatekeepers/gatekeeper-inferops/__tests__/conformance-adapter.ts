// The shared connection conformance suite (`@gadgets/gatekeeper-kit/conformance`) mapped onto the
// project-board gatekeeper: a DEMO board binding of a fresh auto-provisioned account, served by
// `MockInferOps` and driven through `TestHooks` as the overseer drives it. `connection.json`
// states which cases this covers; the HTTP client's own revocation and error mapping are covered by
// `account.test.ts` and `http-inferops.test.ts`.

import { env } from "cloudflare:workers";
import type { ConformanceAdapter } from "@gadgets/gatekeeper-kit/conformance";
import type { BindingProps } from "./worker";

const DEMO_1 = "30000000-0000-4000-8000-000000000001";
// An issue of the ENG project, which the same account holds but a DEMO binding must not reach.
const ENG_41 = "30000000-0000-4000-8000-000000000021";
const DONE = "20000000-0000-4000-8000-000000000003";

type Fixture = {
  props: BindingProps;
  hooks: DurableObjectStub<import("./worker").TestHooks>;
  mock: DurableObjectStub<import("./worker").MockInferOps>;
  session: ReturnType<DurableObjectStub<import("./worker").TestHooks>["startSession"]>;
  /** The title of the issue the last proposed write creates. */
  title?: string;
  /** The title the last stale-revision update proposed. */
  staleTitle?: string;
};

/** The message an RPC call failed with, or null when it succeeded. */
async function refusal(call: PromiseLike<unknown>): Promise<string | null> {
  try {
    await call;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A refusal with its RPC prefix dropped, so two refusals compare by what the agent is told. */
function told(message: string | null): string | null {
  return message?.replace(/^.*?(?=NOT_FOUND)/, "") ?? null;
}

/** The newest action the approval queue was given. */
async function lastActionId(hooks: Fixture["hooks"]): Promise<number> {
  const { actions } = await hooks.log();
  const last = actions.at(-1);
  if (!last) throw new Error("nothing was submitted to the approval queue");
  return last.id;
}

/** The InferOps project-board gatekeeper over the mock data source. */
export const inferOpsBoardAdapter: ConformanceAdapter<Fixture> = {
  name: "gatekeeper-inferops project/board",

  async setup() {
    const props: BindingProps = {
      accountId: crypto.randomUUID(), host: "demo.local", projectKey: "DEMO",
    };
    const hooks = env.TEST_HOOKS.getByName(props.accountId);
    const mock = env.MOCK_INFEROPS.getByName(`demo.local/${props.accountId}`);
    return { props, hooks, mock, session: hooks.startSession(props) };
  },

  async read({ session }) {
    await session.readBoard();
  },

  async observations({ hooks }) {
    const { excluded } = await hooks.log();
    return excluded.map(excludeObservers => ({ excludeObservers }));
  },

  async share({ props, hooks }, canSee) {
    // Strategy B: the binding is one project, so a collaborator is admitted or refused whole.
    return { id: "observer-1", admitted: await hooks.addObserver(props, canSee) === null };
  },

  async proposeWrite(fixture) {
    fixture.title = `Conformance ${crypto.randomUUID()}`;
    await fixture.session.createIssue({ title: fixture.title });
    return lastActionId(fixture.hooks);
  },

  async submittedActions({ hooks }) {
    return (await hooks.log()).actions.map(action => action.id);
  },

  apply({ props, hooks }, actionId) {
    return hooks.apply(props, actionId);
  },

  async effects({ mock, title }) {
    try {
      return (await mock.readProject("DEMO")).issues.filter(issue => issue.title === title).length;
    } catch (error) {
      // A revoked account's data is deleted, so nothing it wrote remains.
      if (String(error).includes("UNAUTHORIZED")) return 0;
      throw error;
    }
  },

  async revoke({ props, hooks }) {
    await hooks.revokeAccount({ accountId: props.accountId });
  },

  scope: {
    readOutOfScope: async ({ session }) => told(await refusal(session.openIssue(ENG_41))),
    readUnknown: async ({ session }) => told(await refusal(session.openIssue(crypto.randomUUID()))),
  },

  staleRevision: {
    async propose(fixture) {
      fixture.staleTitle = `Stale ${crypto.randomUUID()}`;
      await fixture.session.openIssue(DEMO_1).update({ title: fixture.staleTitle }, "1");
      return lastActionId(fixture.hooks);
    },
    async advanceBehind({ mock }) {
      await mock.transition("DEMO", DEMO_1, DONE, "1", `someone-else-${crypto.randomUUID()}`);
    },
    async landed({ mock, staleTitle }) {
      return (await mock.readIssue("DEMO", DEMO_1)).title === staleTitle;
    },
  },

  faults: {
    async failNextWrite({ mock }) {
      await mock.failNextWrite("unavailable");
    },
    async loseNextResponse({ mock }) {
      await mock.failNextWrite("lost");
    },
  },
};
