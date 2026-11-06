// FAC-9 PR 3: a Tickets queue as a governed resource (`@gadgets/workshop-shared/governed-data`):
// describe, list with filters, one sort key and cursor pages, get by id, and its one declared
// command, a status change, proposed for approval like `setStatus`. Every read is an observation
// with no value repeated into it; a refused request returns nothing, logs nothing and submits
// nothing. Over the fake provider's seed: support holds T-1 (open), T-2 (pending), T-3 (closed);
// billing holds T-9.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BindingProps } from "./worker";

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function open() {
  const props: BindingProps = { accountId: crypto.randomUUID(), workspace: "demo", queueId: "support" };
  const hooks = env.TEST_HOOKS.getByName(props.accountId);
  return { props, hooks, session: hooks.startSession(props) };
}

describe("a Tickets queue as a governed resource (FAC-9)", () => {
  it("describes its fields, the statuses a ticket can take, and its one declared command", async () => {
    const { session, hooks } = open();
    expect(await session.describe()).toEqual({
      resource: "tickets/queue",
      fields: [
        { name: "title", label: "Title", type: "text", filterable: true, sortable: true },
        { name: "status", label: "Status", type: "text", filterable: true, sortable: true, options: ["open", "pending", "closed"] },
      ],
      commands: [{ name: "setStatus", label: "Change a ticket's status", fields: ["status"] }],
    });
    expect((await hooks.log()).observations).toEqual(["Describe Tickets queue support"]);
  });

  it("lists filtered, sorted and paged here, one observation per read, with no value repeated into the log", async () => {
    const { session, hooks } = open();
    const first = await session.list({ sort: { field: "title", order: "asc" }, pageSize: 2 });
    expect(first.rows.map(row => row.id)).toEqual(["T-1", "T-3"]);
    expect(first.rows[0]).toEqual({ id: "T-1", values: { title: "Cannot sign in", status: "open" }, revision: "1" });
    expect(first).toMatchObject({ total: 3, truncated: false });
    const rest = await session.list({ sort: { field: "title", order: "asc" }, pageSize: 2, cursor: first.nextCursor! });
    expect(rest.rows.map(row => row.id)).toEqual(["T-2"]);
    expect(rest.nextCursor).toBeNull();
    const signIn = await session.list({ filters: [{ field: "title", op: "contains", value: "SIGN" }] });
    expect(signIn.rows.map(row => row.id)).toEqual(["T-1"]);
    // Only the bound queue: billing's T-9 is never a row.
    expect([first, rest, signIn].flatMap(page => page.rows.map(row => row.id))).not.toContain("T-9");
    const log = await hooks.log();
    expect(log.observations).toEqual(Array(3).fill("List Tickets queue support"));
    expect(log.observationTexts.join("\n")).not.toMatch(/sign/i);
  });

  it("refuses an unknown field, a wrong-typed filter and any other key, returning and logging nothing", async () => {
    const { session, hooks } = open();
    for (const request of [
      { filters: [{ field: "revision", op: "eq", value: "1" }] },
      { filters: [{ field: "status", op: "eq", value: 1 }] },
      { sort: { field: "id", order: "asc" } },
      { meta: { url: "https://example.com/tickets" } },
      { pageSize: 51 },
    ]) {
      expect(await failure(session.list(request as never)), JSON.stringify(request)).toMatch(/^INVALID_REQUEST/);
    }
    expect((await hooks.log()).observations).toEqual([]);
  });

  it("gets one ticket of the bound queue, and a ticket of another queue, or none, as nothing", async () => {
    const { session, hooks } = open();
    expect(await session.get("T-2")).toEqual({
      id: "T-2", values: { title: "Invoice shows the wrong address", status: "pending" }, revision: "1",
    });
    expect(await session.get("T-9")).toBeNull();
    expect(await session.get("nope")).toBeNull();
    expect((await hooks.log()).observations).toEqual(["Read Tickets ticket T-2"]);
  });

  it("proposes its declared command for approval, applied only once approved", async () => {
    const { props, hooks, session } = open();
    expect(await session.command({ command: "setStatus", id: "T-1", values: { status: "closed" }, expectedRevision: "1" }))
      .toEqual({ outcome: "proposed" });
    const [action] = (await hooks.log()).actions;
    expect(action?.title).toBe("Set ticket T-1 to closed");
    expect(await session.get("T-1")).toMatchObject({ values: { status: "open" }, revision: "1" });
    expect(await hooks.apply(props, action!.id)).toBeNull();
    expect(await session.get("T-1")).toMatchObject({ values: { status: "closed" }, revision: "2" });
  });

  it("refuses an undeclared command, another field, a value it can't take, another queue's ticket or a closed one, submitting nothing", async () => {
    const { hooks, session } = open();
    const base = { command: "setStatus", id: "T-1", values: { status: "closed" }, expectedRevision: "1" };
    for (const [request, code] of [
      [{ ...base, command: "delete" }, "INVALID_REQUEST"],
      [{ ...base, values: { status: "closed", title: "Renamed" } }, "INVALID_REQUEST"],
      [{ ...base, values: { status: "done" } }, "INVALID_REQUEST"],
      // The session's declared types are checked on the way in, so a missing revision is refused
      // by the RPC validator before the governed check; either way nothing is submitted.
      [{ ...base, expectedRevision: undefined }, "(INVALID_REQUEST|capnweb-validate)"],
      [{ ...base, meta: { url: "https://example.com" } }, "INVALID_REQUEST"],
      [{ ...base, id: "T-9" }, "NOT_FOUND"],
      [{ ...base, id: "T-3", values: { status: "open" } }, "INVALID_STATE"],
    ] as const) {
      expect(await failure(session.command(request as never)), JSON.stringify(request)).toMatch(new RegExp(`^${code}`));
    }
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("stops with the account: after a revoke it refuses, and logs nothing", async () => {
    const { props, hooks, session } = open();
    await hooks.revokeAccount({ accountId: props.accountId });
    expect(await failure(session.describe())).toMatch(/^UNAUTHORIZED/);
    expect(await failure(session.list({}))).toMatch(/^UNAUTHORIZED/);
    expect(await failure(session.get("T-1"))).toMatch(/^UNAUTHORIZED/);
    const log = await hooks.log();
    expect(log.observations).toEqual([]);
    expect(log.actions).toEqual([]);
  });
});
