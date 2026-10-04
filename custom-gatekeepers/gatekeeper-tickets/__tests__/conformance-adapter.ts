// The shared connection conformance suite (`@gadgets/gatekeeper-kit/conformance`) mapped onto the
// queue gatekeeper: a `support` binding of a fresh account over the fake provider, driven
// through `TestHooks` as the overseer drives it. `connection.json` states which cases this covers.

import { env } from "cloudflare:workers";
import type { ConformanceAdapter } from "@gadgets/gatekeeper-kit/conformance";
import type { BindingProps, TestHooks, TestProvider } from "./worker";

// An open ticket of the bound queue; every case starts from a fresh account, so it is open.
const QUEUE = "support";
const TICKET = "T-1";
// A ticket of another queue the same account holds, which a support binding must not reach.
const OTHER_QUEUE_TICKET = "T-9";

type Fixture = {
  props: BindingProps;
  hooks: DurableObjectStub<TestHooks>;
  provider: DurableObjectStub<TestProvider>;
  session: ReturnType<DurableObjectStub<TestHooks>["startSession"]>;
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
  const last = (await hooks.log()).actions.at(-1);
  if (!last) throw new Error("nothing was submitted to the approval queue");
  return last.id;
}

/** Proposes moving TICKET to pending at the revision it has now. */
async function proposePending({ session, hooks }: Fixture): Promise<number> {
  const ticket = await session.readTicket(TICKET);
  await session.setStatus(TICKET, "pending", ticket.revision);
  return lastActionId(hooks);
}

/** The queue gatekeeper over the fake provider. */
export const queueAdapter: ConformanceAdapter<Fixture> = {
  name: "gatekeeper-tickets queue",

  async setup() {
    const props: BindingProps = { accountId: crypto.randomUUID(), workspace: "demo", queueId: QUEUE };
    const hooks = env.TEST_HOOKS.getByName(props.accountId);
    const provider = env.FAKE_PROVIDER.getByName(props.accountId);
    return { props, hooks, provider, session: hooks.startSession(props) };
  },

  async read({ session }) {
    await session.listTickets();
  },

  async observations({ hooks }) {
    return (await hooks.log()).excluded.map(excludeObservers => ({ excludeObservers }));
  },

  async share({ props, hooks }, canSee) {
    // Strategy B: the binding is one queue, so a collaborator is admitted or refused whole.
    return { id: "observer-1", admitted: await hooks.addObserver(props, canSee) === null };
  },

  proposeWrite(fixture) {
    return proposePending(fixture);
  },

  async submittedActions({ hooks }) {
    return (await hooks.log()).actions.map(action => action.id);
  },

  apply({ props, hooks }, actionId) {
    return hooks.apply(props, actionId);
  },

  effects({ provider }) {
    // Each case's account is fresh, so every applied write is the case's own.
    return provider.appliedWrites();
  },

  async revoke({ props, hooks }) {
    await hooks.revokeAccount({ accountId: props.accountId });
  },

  scope: {
    readOutOfScope: async ({ session }) => told(await refusal(session.readTicket(OTHER_QUEUE_TICKET))),
    readUnknown: async ({ session }) => told(await refusal(session.readTicket(crypto.randomUUID()))),
  },

  staleRevision: {
    propose(fixture) {
      return proposePending(fixture);
    },
    async advanceBehind({ provider }) {
      await provider.advance(QUEUE, TICKET);
    },
    async landed({ provider }) {
      return (await provider.peek(QUEUE, TICKET))?.status === "pending";
    },
  },

  faults: {
    async failNextWrite({ provider }) {
      await provider.failNextWrite("unavailable");
    },
    async loseNextResponse({ provider }) {
      await provider.failNextWrite("lost");
    },
  },
};
