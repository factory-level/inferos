// IL-28-11: Workers health read through the production gatekeeper binding, end to end in workerd.
//
// The sibling suites cover the API client (`observability-api.test.ts`) and the session's audit
// (`session.test.ts`) one layer at a time, each constructing its own client. This file drives the
// path the overseer uses: a binding's props and the bound user's *stored* credential go into
// `CloudflareObservabilityGatekeeper.startSession`, and every read reaches a deterministic stand-in
// for the live Workers Observability API. It asserts what the binding may read (one Worker or one
// account), what it refuses (no credential, a refused credential, a collaborator without access),
// how provider failures surface, and that a health value is always the provider's current answer:
// nothing is cached, and no telemetry is written to the user's storage.

import { env, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudflareObservabilitySession } from "../../src/types";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_PREFIX =
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/`;
const STATISTICS = { elapsed: 1, rows_read: 10, bytes_read: 100 };
const HEALTH_QUERY = { calculations: [{ operator: "count" as const, alias: "requests" }] };

type Observation = { title: string; description: string };

class TestApprovalQueue extends RpcTarget {
  readonly observations: Observation[] = [];

  async authorizeObservation(entry: Observation): Promise<void> {
    this.observations.push(entry);
  }
}

type ProviderCall = { url: string; authorization: string | null; body: any };

/** A deterministic provider: records every request and answers with the next scripted response. */
function provider(...responses: Array<(call: ProviderCall) => Response>) {
  const calls: ProviderCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const call = {
      url,
      authorization: new Headers(init.headers).get("authorization"),
      body: JSON.parse(String(init.body)),
    };
    calls.push(call);
    const respond = responses.length > 1 ? responses.shift()! : responses[0];
    if (!respond) throw new Error("No scripted provider response.");
    return respond(call);
  }));
  return calls;
}

function healthAnswer(value: number) {
  return () => Response.json({
    success: true,
    result: {
      statistics: STATISTICS,
      calculations: [{
        calculation: "count",
        alias: "requests",
        aggregates: [{ value, count: value, interval: 60, sampleInterval: 1 }],
        series: [],
      }],
    },
  });
}

function event(id: string, service: string) {
  return {
    dataset: "cloudflare-workers",
    timestamp: Date.now(),
    source: { message: "hello" },
    $metadata: { id, service, level: "error", traceId: `trace-${id}` },
  };
}

function eventsAnswer(count: number, ...events: ReturnType<typeof event>[]) {
  return () => Response.json({ success: true, result: { statistics: STATISTICS, events: { count, events } } });
}

function failure(status: number, body?: unknown) {
  return () => body === undefined ? new Response("unavailable", { status }) : Response.json(body, { status });
}

let users = 0;

/** A connected user whose stored access token is valid for an hour, so no refresh is attempted. */
async function connectedUser(token = "access-1"): Promise<string> {
  const id = env.USER_ACCOUNT.idFromName(`health-user-${users++}`);
  await runInDurableObject(env.USER_ACCOUNT.get(id), (_account, state) => {
    state.storage.kv.put("refreshToken", "refresh-1");
    state.storage.kv.put("accessToken", { token, expires: Date.now() + 3_600_000 });
    state.storage.kv.put("grantedScopes", ["workers-observability.read"]);
  });
  return id.toString();
}

/** A user object with no stored grant at all. */
function disconnectedUser(): string {
  return env.USER_ACCOUNT.idFromName(`health-user-${users++}`).toString();
}

async function storedKeys(userObjectId: string): Promise<string[]> {
  return runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId)),
    (_account, state) => [...state.storage.kv.list()].map(([key]) => key).toSorted());
}

const hooks = env.TEST_HOOKS.getByName("health-hooks");
let facets = 0;

/** The agent's session on a fresh binding; each facet name is used once, since facets are cached by name. */
async function bind(userObjectId: string, workerName?: string) {
  const queue = new TestApprovalQueue();
  const props = workerName
    ? { userObjectId, accountId: ACCOUNT_ID, workerName }
    : { userObjectId, accountId: ACCOUNT_ID };
  const session = await hooks.startSession(`health-${facets++}`, props,
    new RpcStub(queue) as unknown as ApprovalQueue) as unknown as CloudflareObservabilitySession;
  return { queue, session };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected a rejection.");
}

afterEach(() => vi.unstubAllGlobals());

describe("selected Worker and account scope", () => {
  it("a Worker binding reads that Worker's health from the live API with its stored credential", async () => {
    const calls = provider(healthAnswer(42));
    const { queue, session } = await bind(await connectedUser(), "api-worker");

    const result = await session.calculate(HEALTH_QUERY);

    expect(result.calculations[0]!.aggregates[0]!.value).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_PREFIX}query`);
    expect(calls[0]!.authorization).toBe("Bearer access-1");
    expect(calls[0]!.body.view).toBe("calculations");
    expect(calls[0]!.body.parameters.filters).toEqual([
      { kind: "filter", key: "$metadata.service", operation: "eq", type: "string", value: "api-worker" },
    ]);
    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]!.title).toBe("Calculate Workers metrics");
    expect(queue.observations[0]!.description).toContain("Worker api-worker");
  });

  it("an account binding reads account-wide health with no Worker condition", async () => {
    const calls = provider(healthAnswer(90));
    const { queue, session } = await bind(await connectedUser());

    const result = await session.calculate(HEALTH_QUERY);

    expect(result.calculations[0]!.aggregates[0]!.value).toBe(90);
    expect(calls[0]!.body.parameters.filters).toEqual([]);
    expect(queue.observations[0]!.description).toContain(`Cloudflare account ${ACCOUNT_ID}`);
  });

  it("keeps the binding's Worker condition when the caller asks for another Worker", async () => {
    const calls = provider(healthAnswer(0));
    const { session } = await bind(await connectedUser(), "api-worker");

    await session.calculate({
      ...HEALTH_QUERY,
      filter: {
        kind: "filter", key: "$metadata.service", operation: "eq", type: "string", value: "billing-worker",
      },
    });

    const filters = calls[0]!.body.parameters.filters;
    expect(calls[0]!.body.parameters.filterCombination).toBe("and");
    expect(filters[0]).toEqual(
      { kind: "filter", key: "$metadata.service", operation: "eq", type: "string", value: "api-worker" });
    expect(filters[1]).toMatchObject({ key: "$metadata.service", value: "billing-worker" });
  });

  it("returns none of another Worker's events when the provider ignores the scope", async () => {
    provider(eventsAnswer(2, event("own", "api-worker"), event("foreign", "billing-worker")));
    const { queue, session } = await bind(await connectedUser(), "api-worker");

    const page = await session.listEvents();

    expect(page.events.map(e => e.$metadata.id)).toEqual(["own"]);
    expect(JSON.stringify(page)).not.toContain("billing-worker");
    // The provider's count covers the foreign event, so it is withheld rather than reported.
    expect(page.count).toBeUndefined();
    expect(queue.observations[0]!.description).toContain("returned 1 events");
  });
});

describe("missing and refused access", () => {
  it("refuses a read for a user with no stored credential, without calling the provider", async () => {
    const calls = provider(healthAnswer(42));
    const { queue, session } = await bind(disconnectedUser(), "api-worker");

    expect(await rejection(session.calculate(HEALTH_QUERY))).toBe("Cloudflare credentials have expired.");
    expect(calls).toEqual([]);
    expect(queue.observations).toEqual([]);
  });

  it("surfaces a credential the provider refuses as an error and records nothing", async () => {
    provider(failure(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }));
    const { queue, session } = await bind(await connectedUser(), "api-worker");

    expect(await rejection(session.calculate(HEALTH_QUERY))).toBe("Authentication error");
    expect(queue.observations).toEqual([]);
  });

  it("the production verifier refuses a collaborator whose own credential is refused", async () => {
    const calls = provider(failure(403, { success: false, errors: [{ code: 10000, message: "denied" }] }));

    expect(await hooks.verifyObserver(await connectedUser("collaborator"), ACCOUNT_ID, "api-worker"))
      .toBe(false);
    expect(calls[0]!.authorization).toBe("Bearer collaborator");
  });

  it("the production verifier refuses a collaborator with no credential", async () => {
    const calls = provider(healthAnswer(1));

    // No token means the read fails as 401, which is a denial, not an infrastructure error.
    expect(await hooks.verifyObserver(disconnectedUser(), ACCOUNT_ID, "api-worker")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("the production verifier admits a collaborator whose own credential can read the Worker", async () => {
    const calls = provider(eventsAnswer(1, event("own", "api-worker")));

    expect(await hooks.verifyObserver(await connectedUser("collaborator"), ACCOUNT_ID, "api-worker"))
      .toBe(true);
    expect(calls[0]!.body.parameters.filters[0]).toMatchObject({ value: "api-worker" });
  });

  it("the production verifier fails loudly, not as a denial, when the provider is down", async () => {
    provider(failure(503));

    expect(await hooks.verifyObserver(await connectedUser(), ACCOUNT_ID, "api-worker"))
      .toBe("Cloudflare API request failed with status 503: invalid JSON response.");
  });
});

describe("provider errors", () => {
  it("retries one transient failure, then reports the error without a value", async () => {
    const calls = provider(failure(503));
    const { queue, session } = await bind(await connectedUser(), "api-worker");

    expect(await rejection(session.calculate(HEALTH_QUERY)))
      .toBe("Cloudflare API request failed with status 503: invalid JSON response.");
    expect(calls).toHaveLength(2);
    expect(queue.observations).toEqual([]);
  });

  it("refuses a malformed provider answer rather than reporting a partial value", async () => {
    provider(() => Response.json({ success: true, result: { statistics: STATISTICS, calculations: [{}] } }));
    const { queue, session } = await bind(await connectedUser(), "api-worker");

    expect(await rejection(session.calculate(HEALTH_QUERY)))
      .toBe("Cloudflare returned an invalid Workers Observability response.");
    expect(queue.observations).toEqual([]);
  });
});

describe("health stays live provider data", () => {
  it("never answers from an earlier value: each read asks the provider, and a failure is not masked", async () => {
    const calls = provider(healthAnswer(42), failure(400, { success: false, errors: [{ message: "bad" }] }),
      healthAnswer(7));
    const { queue, session } = await bind(await connectedUser(), "api-worker");

    expect((await session.calculate(HEALTH_QUERY)).calculations[0]!.aggregates[0]!.value).toBe(42);
    expect(await rejection(session.calculate(HEALTH_QUERY))).toBe("bad");
    expect((await session.calculate(HEALTH_QUERY)).calculations[0]!.aggregates[0]!.value).toBe(7);
    expect(calls).toHaveLength(3);
    expect(queue.observations).toHaveLength(2);
  });

  it("refuses a timeframe outside the provider's retention instead of returning old data", async () => {
    const calls = provider(healthAnswer(42));
    const { session } = await bind(await connectedUser(), "api-worker");
    const from = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);

    expect(await rejection(session.calculate({
      ...HEALTH_QUERY, timeframe: { from, to: new Date(from.valueOf() + 60_000) },
    }))).toMatch(/retention window/);
    expect(calls).toEqual([]);
  });

  it("writes no telemetry to the bound user's storage", async () => {
    provider(healthAnswer(42), eventsAnswer(1, event("own", "api-worker")));
    const userObjectId = await connectedUser();
    const before = await storedKeys(userObjectId);
    const { session } = await bind(userObjectId, "api-worker");

    await session.calculate(HEALTH_QUERY);
    await session.listEvents();

    expect(before).toEqual(["accessToken", "grantedScopes", "refreshToken"]);
    expect(await storedKeys(userObjectId)).toEqual(before);
  });
});
