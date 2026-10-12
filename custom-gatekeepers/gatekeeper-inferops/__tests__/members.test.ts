// Workspace members (MVP-18): a read-only, private-only resource kind over the mock's demo list.
// Grammar, the members switch, projection without email, every read an observation without a
// member's name or email in it, private-only admission, no actions, and revocation. The HTTP side
// (the exact request, the one refusal, strict answers, the bound-workspace fence) is in
// members-http.test.ts; a connected person's own sign-in is in account.test.ts.

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { membersUrl, parseMembersUrl, resourceKind } from "../src/resources";
import type { WorkspaceMembersRead } from "../src/inferops-client";
import type { MembersProps } from "./worker";

const MEMBERS_URL = "inferops://demo.local/portal/members";
const MEMBERS_PATTERN = "inferops://*/portal/members";
const EMAILS = ["dana@example.test", "vic@example.test", "@example.test", "email"];

type Vars = { INFEROPS_ENABLED?: string; INFEROPS_MEMBERS_ENABLED?: string };
const vars = env as unknown as Vars;
function set(name: keyof Vars, value: string | undefined) {
  if (value === undefined) delete vars[name];
  else vars[name] = value;
}
beforeEach(() => set("INFEROPS_MEMBERS_ENABLED", "true"));
afterEach(() => {
  set("INFEROPS_ENABLED", undefined);
  set("INFEROPS_MEMBERS_ENABLED", undefined);
});

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

/** A fresh demo account's members binding, its mock data and a session. */
function setup(accountId: string = crypto.randomUUID()) {
  const props: MembersProps = { accountId, host: "demo.local" };
  const hooks = env.TEST_HOOKS.getByName(accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${accountId}`);
  return { props, hooks, mock, session: hooks.startMembersSession(props) };
}

describe("the workspace members resource kind", () => {
  it("parses its grammar: a whole tenant.workspace host and nothing after members", () => {
    expect(parseMembersUrl("inferops://acme.operations/portal/members")).toEqual({
      host: "acme.operations", tenant: "acme", workspace: "operations",
    });
    expect(parseMembersUrl("inferops://acme.operations/portal/members/").host).toBe("acme.operations");
    expect(membersUrl({ host: "demo.local" })).toBe(MEMBERS_URL);
    expect(resourceKind(MEMBERS_URL)).toBe("members");
    for (const url of [
      "inferops://acme/portal/members", "inferops://acme.ops:1/portal/members",
      "inferops://user@acme.ops/portal/members", "inferops://acme.ops/portal/members/extra",
      "inferops://acme.ops/portal/members?all=1", "inferops://acme.ops/portal/member",
      "inferops://Acme.ops/portal/members",
    ]) {
      expect(() => parseMembersUrl(url), url).toThrow(/portal\/members/);
    }
  });

  it("is offered, pickable and bindable only while workspace members are on", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    expect(await hooks.supportedPatterns(account)).toContain(MEMBERS_PATTERN);
    expect(await hooks.configuratorFor(account, MEMBERS_PATTERN)).toBeNull();
    expect(await hooks.bindAccount("on", account, MEMBERS_URL)).toBeNull();
    expect(await hooks.describeBound("on")).toMatchObject({ url: MEMBERS_URL, tsType: "InferOpsMembersSession" });

    set("INFEROPS_MEMBERS_ENABLED", undefined);
    expect(await hooks.supportedPatterns(account)).not.toContain(MEMBERS_PATTERN);
    expect(await hooks.configuratorFor(account, MEMBERS_PATTERN)).toContain("Unsupported");
    expect(await hooks.bindAccount("off", account, MEMBERS_URL)).toContain("DISABLED");

    // Off for InferOps as a whole is off for members too, whatever the members switch says.
    set("INFEROPS_MEMBERS_ENABLED", "true");
    set("INFEROPS_ENABLED", "false");
    expect(await hooks.supportedPatterns(account)).not.toContain(MEMBERS_PATTERN);
  });

  it("refuses a host it does not serve with the one members message, never the stopgap", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    const elsewhere = await hooks.bindAccount("elsewhere", account, "inferops://acme.operations/portal/members");
    expect(elsewhere).toContain("No InferOps member list is available to you on acme.operations.");
  });
});

describe("the workspace members session", () => {
  it("lists members in InferOps' order with exactly the allowed fields, and no email", async () => {
    const { session, hooks } = setup();
    const result = await session.listMembers();
    expect(result).toEqual({
      workspace: {
        workspaceId: "00000000-0000-4000-8000-0000000000d0", workspaceName: "Demo Operations", product: "inferops",
      },
      members: [
        { principalId: "00000000-0000-4000-8000-0000000000d1", type: "user", name: "Dana Demo", role: "owner", deniedPermissions: [] },
        { principalId: "00000000-0000-4000-8000-0000000000d2", type: "user", name: "Vic Viewer", role: "viewer", deniedPermissions: [] },
        { principalId: "00000000-0000-4000-8000-0000000000d3", type: "service_account", name: "demo-agent", role: "operations", deniedPermissions: ["billing:*"] },
      ],
    });
    for (const member of result.members) {
      expect(Object.keys(member).toSorted()).toEqual(["deniedPermissions", "name", "principalId", "role", "type"]);
    }
    // Not an email, nor a key or marker saying one was left out.
    const shown = JSON.stringify(result);
    for (const trace of EMAILS) expect(shown).not.toContain(trace);
    const log = await hooks.log();
    expect(log.observations).toEqual(["List InferOps workspace members"]);
    expect(log.actions).toEqual([]);
  });

  it("logs a count and the workspace, never a member's name, id or email", async () => {
    const { session, hooks } = setup();
    await session.listMembers();
    const text = (await hooks.log()).observationTexts.join("\n");
    expect(text).toContain("3 members");
    expect(text).toContain("Demo Operations");
    for (const trace of ["Dana", "Vic", "demo-agent", "0000000000d1", ...EMAILS]) expect(text).not.toContain(trace);
  });

  it("passes every member through without inventing or dropping one", async () => {
    const { session, mock } = setup();
    const changed: WorkspaceMembersRead = {
      workspace: { workspaceId: "00000000-0000-4000-8000-0000000000e0", workspaceName: "Other", product: "inferops" },
      members: [{
        principalId: "00000000-0000-4000-8000-0000000000e1", type: "user", name: "Only One",
        email: "only@example.test", role: "member", deniedPermissions: ["member:read"],
      }],
    };
    await mock.setMembers(changed);
    const result = await session.listMembers();
    expect(result.members).toEqual([{
      principalId: "00000000-0000-4000-8000-0000000000e1", type: "user", name: "Only One",
      role: "member", deniedPermissions: ["member:read"],
    }]);
    expect(JSON.stringify(result)).not.toContain("only@example.test");
  });

  it("stops with the switch and resumes with it, and ends with the account", async () => {
    const { session, props, hooks } = setup();
    set("INFEROPS_MEMBERS_ENABLED", "false");
    expect(await failure(session.listMembers())).toMatch(/DISABLED/);
    set("INFEROPS_MEMBERS_ENABLED", "true");
    expect((await session.listMembers()).members).toHaveLength(3);
    await hooks.revokeAccount({ accountId: props.accountId });
    expect(await failure(session.listMembers())).toMatch(/UNAUTHORIZED/);
  });
});

describe("the workspace members binding", () => {
  it("admits no collaborator, even one who could read the list", async () => {
    const { props, hooks } = setup();
    expect(await hooks.addMembersObserver(props)).toContain("private to the person who connected it");
  });

  it("has no actions, and describes itself as one workspace's members", async () => {
    const { props, hooks } = setup();
    const results = await hooks.membersActions(props);
    expect(results).toHaveLength(3);
    for (const result of results) expect(result).toContain("read-only");
    expect(await hooks.describeMembers(props)).toMatchObject({
      url: MEMBERS_URL, suggestedBindingName: "INFEROPS_MEMBERS", tsType: "InferOpsMembersSession",
    });
  });
});
