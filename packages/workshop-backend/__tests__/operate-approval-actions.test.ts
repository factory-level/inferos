// FAC-119: the AG-UI approval bridge for every supported action, not only a board transition. A
// gatekeeper that projects nothing of its own gets a proposal the kernel derives from the action's
// journal record, which can be approved or rejected, never edited. A background pending decision (an
// agent's, a workflow run's assigned write) is correlated with a thread whenever it is pending, and
// decided through the same approveAction / rejectAction path as any other surface. An interrupt has
// no deadline of its own. A failure says what kind of reason it was, and every refusal has its own
// code: a policy refusal, a general error and an expired sign-in are never one outcome.
import { describe, it, expect, vi } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { createOperateApprovalError, type OperateApprovalSnapshot } from "@gadgets/workshop-shared/operate-approval";
import { makeActionStorage, openFakeOverseer, putAction } from "./fixtures";
import { approvalSnapshot } from "../src/operate-approval";
import { handleOperateApproval } from "../src/operate-agui-approval";
vi.mock("capnweb-validate", () => ({validateRpc: () => () => undefined}));

const input = {actionId: 1, threadId: "thread", runId: "initial"};
const CONNECTION = {id: 1, creationSpec: {type: "gatekeeper", vendorId: "test", resourceUrl: "test://things/a", typeUrlPattern: "test://*"}};

/** A workspace with one pending action 1, whose gatekeeper projects `projection` (null: nothing). */
function workspace(opts: {projection?: unknown; executedAs?: boolean; apply?: (record: unknown) => unknown;
                          shared?: {holds: boolean}} = {}) {
  const storage = makeActionStorage() as ReturnType<typeof makeActionStorage> & {gatekeepers: unknown};
  putAction(storage, 1);
  const record = storage.actions.get(1)!;
  if (record.type !== "action") throw new Error("fixture");
  record.description = {...record.description, title: "Create issue ENG-9", description: "Creates one issue.",
    fields: [{kind: "text", label: "Title", value: "Broken login"}], descriptionIsComplete: true} as never;
  if (opts.executedAs) {
    (record as unknown as {executedAs: object}).executedAs = {hookId: 7, deliveryId: 3, credentialRef: "ref", runId: "run"};
  }
  storage.actions.put(record);
  Object.assign(storage, {gatekeepers: {get: (id: number) => (id === 1 ? CONNECTION : undefined)}});
  const asked = vi.fn(async () => opts.projection ?? null);
  const apply = vi.fn(async (action: unknown) => opts.apply?.(action));
  // The person's shared-configuration answer: yes as the session opens, then `shared.holds`.
  let opening = true;
  const impl = {
    getGatekeeperFacet: () => ({getApprovalProposal: asked}), applyPendingAction: apply, drainAutoApprovals: () => {},
    ctx: {id: {toString: () => "workspace-id"}, exports: {}, waitUntil: () => {}},
    ...(opts.shared ? {env: {SHARED_CONFIGURATION_GATEKEEPER: "inferops"}, isSharedConfiguration: async () => true,
      users: {idFromString: (id: string) => id, get: () => ({whoami: async () => ({type: "user", id: "owner-profile", name: "Ada"}),
        recordSharedGadgetOpen: async () => {}, holdsSharedConfiguration: async () => opening || opts.shared!.holds})}} : {}),
  };
  return {storage, record, impl, asked, apply, opened: () => { opening = false; }};
}

const opened = async (w: ReturnType<typeof workspace>) => {
  const client = await openFakeOverseer(w.storage, {impl: w.impl});
  w.opened();
  return client;
};
const answerOf = (snapshot: OperateApprovalSnapshot, payload: object) =>
  ({...input, runId: "answer", answer: {interruptId: snapshot.interruptId, payload}});

describe("any supported action (acceptance 1)", () => {
  it("derives the proposal from the action's record when its gatekeeper projects none, and decides that action", async () => {
    const w = workspace();
    const client = await opened(w);
    const first = await client.operateApproval(input);
    expect(first).toMatchObject({actionId: 1, status: "pending", editable: false, expiresAt: null, proposal: {
      kind: "action", scope: "test://things/a", title: "Create issue ENG-9", description: "Creates one issue.",
      fields: [{kind: "text", label: "Title", value: "Broken login"}], descriptionIsComplete: true}});
    // It can't be edited.
    await expect(client.operateApproval(answerOf(first, {approved: true, editedArgs: {toStateId: "done"}})))
      .rejects.toThrow("APPROVAL_REFUSED");
    // Approving resumes exactly this action, through the one approval path.
    await client.operateApproval(answerOf(first, {approved: true}));
    expect(w.apply).toHaveBeenCalledOnce();
    expect((w.apply.mock.calls[0]![0] as {id: number}).id).toBe(1);
  });

  it("derives it too from a gatekeeper without the method, and rejects through the one rejection path", async () => {
    const w = workspace();
    w.impl.getGatekeeperFacet = () => ({getApprovalProposal: async () => {
      throw new Error('The RPC receiver does not implement the method "getApprovalProposal".');
    }}) as never;
    const client = await opened(w);
    const first = await client.operateApproval(input);
    expect(first.proposal.kind).toBe("action");
  });

  it("refuses, as unavailable, a gatekeeper that fails to project, deciding nothing", async () => {
    const w = workspace();
    w.impl.getGatekeeperFacet = () => ({getApprovalProposal: async () => { throw new Error("UNAVAILABLE: down"); }}) as never;
    const client = await opened(w);
    await expect(client.operateApproval(input)).rejects.toThrow("APPROVAL_UNAVAILABLE");
    expect(w.storage.actions.get(1)).not.toHaveProperty("aguiApproval");
  });
});

describe("background pending decisions", () => {
  it("correlates an assigned run's write from a later thread, never asks the connection's facet, and decides it the usual way", async () => {
    const w = workspace({executedAs: true});
    const client = await opened(w);
    const first = await client.operateApproval(input);
    expect(w.asked).not.toHaveBeenCalled();
    expect(first).toMatchObject({status: "pending", editable: false, proposal: {kind: "action"}});
    await client.operateApproval(answerOf(first, {approved: true}));
    expect(w.apply).toHaveBeenCalledOnce();
  });

  it("has no deadline of its own: a decision a day later still applies", async () => {
    const w = workspace();
    const client = await opened(w);
    const first = await client.operateApproval(input);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 3_600_000);
    try {
      expect((await client.operateApproval({...input, runId: "later"})).status).toBe("pending");
      await client.operateApproval(answerOf(first, {approved: true}));
      expect(w.apply).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });
});

describe("distinct outcomes (acceptance 2)", () => {
  it("reports each failure kind the record holds, and an older record's as unavailable", () => {
    const w = workspace();
    w.record.aguiApproval = {person: "owner-id", threadId: "thread", runId: "initial", interruptId: "i",
      proposal: {kind: "action", scope: "s", title: "t", description: "d", descriptionIsComplete: true}};
    const kinds = ["policy", "permission", "sign-in", "conflict", "invalid", "unavailable"] as const;
    for (const kind of kinds) {
      w.record.lastAttempt = {outcome: "notApplied", message: "m", retryable: kind === "sign-in", kind, at: new Date()};
      expect(approvalSnapshot(w.record).failure?.kind).toBe(kind);
    }
    w.record.lastAttempt = {outcome: "notApplied", message: "m", retryable: false, at: new Date()};
    expect(approvalSnapshot(w.record).failure?.kind).toBe("unavailable");
  });

  it("answers an apply the provider refused with its snapshot and kind, never as a refusal of the request", async () => {
    for (const kind of ["policy", "sign-in", "unavailable"] as const) {
      const w = workspace({apply: () => {
        const current = w.storage.actions.get(1)!;
        if (current.type !== "action") return;
        current.lastAttempt = {outcome: "notApplied", message: `refused (${kind})`, retryable: kind === "sign-in", kind, at: new Date()};
        if (kind !== "sign-in") current.state = "failed";
        w.storage.actions.put(current);
        throw new Error(`refused (${kind})`);
      }});
      const client = await opened(w);
      const first = await client.operateApproval(input);
      const answered = await client.operateApproval(answerOf(first, {approved: true}));
      expect(answered.failure?.kind).toBe(kind);
      // An expired sign-in leaves it pending, to approve again once reconnected; the others end it.
      expect(answered.status).toBe(kind === "sign-in" ? "pending" : "failed");
    }
  });

  it("calls an apply that failed with nothing recorded unavailable, not refused", async () => {
    const w = workspace({apply: () => { throw new Error("socket hang up"); }});
    const client = await opened(w);
    const first = await client.operateApproval(input);
    await expect(client.operateApproval(answerOf(first, {approved: true}))).rejects.toThrow("APPROVAL_UNAVAILABLE");
  });
});

describe("another company (acceptance 3)", () => {
  it("refuses a decider the deployment's shared configuration doesn't admit, applying nothing", async () => {
    // holdsSharedConfiguration answers no for a person whose InferOps company isn't this workspace's.
    const w = workspace({shared: {holds: false}});
    const client = await opened(w);
    const first = await client.operateApproval(input);
    await expect(client.operateApproval(answerOf(first, {approved: true}))).rejects.toThrow("APPROVAL_REFUSED");
    await expect(client.operateApproval(answerOf(first, {approved: true}))).rejects.toThrow("APPROVAL_");
    expect(w.apply).not.toHaveBeenCalled();
    expect(w.storage.actions.get(1)?.state).toBe("pending");
  });
});

const apiAnswering = (operateApproval: () => Promise<OperateApprovalSnapshot>, open = true) => ({
  openGadget: async () => {
    if (!open) throw new Error("no access");
    return {operateApproval, [Symbol.dispose]: () => {}};
  },
}) as unknown as AuthenticatedApi;

describe("the HTTP bridge", () => {
  const body = {threadId: "thread", runId: "initial", messages: [], forwardedProps: {approval: {workspaceId: "a".repeat(64), actionId: 1}}};
  const post = () => new Request("https://x/api/operate/agui/approval", {method: "POST", body: JSON.stringify(body)});
  const pending: OperateApprovalSnapshot = {actionId: 1, interruptId: "i", expiresAt: null, editable: false, status: "pending",
    proposal: {kind: "action", scope: "s", title: "Create issue ENG-9", description: "d", descriptionIsComplete: true}};

  it("answers each refusal with its own status and code, and anything untyped as unavailable", async () => {
    for (const [code, status] of [["APPROVAL_REFUSED", 403], ["APPROVAL_NOT_PENDING", 409], ["APPROVAL_CONFLICT", 409],
        ["APPROVAL_UNAVAILABLE", 503]] as const) {
      const response = await handleOperateApproval(post(), apiAnswering(async () => { throw createOperateApprovalError(code, "x"); }));
      expect([response.status, await response.json()]).toEqual([status, {error: code}]);
    }
    const untyped = await handleOperateApproval(post(), apiAnswering(async () => { throw new Error("boom"); }));
    expect([untyped.status, await untyped.json()]).toEqual([503, {error: "APPROVAL_UNAVAILABLE"}]);
    const noAccess = await handleOperateApproval(post(), apiAnswering(async () => pending, false));
    expect([noAccess.status, await noAccess.json()]).toEqual([403, {error: "APPROVAL_REFUSED"}]);
  });

  it("interrupts on any pending action, with no deadline and no edit, and finishes an applied one without asking", async () => {
    const text = await (await handleOperateApproval(post(), apiAnswering(async () => pending))).text();
    const finished = JSON.parse(text.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).at(-1)!);
    const interrupt = finished.outcome.interrupts[0];
    expect(interrupt.message).toBe("Approve: Create issue ENG-9?");
    expect(interrupt).not.toHaveProperty("expiresAt");
    expect(interrupt.responseSchema.properties).not.toHaveProperty("editedArgs");
    // An action an auto-approval rule applied at submit: reported applied, nothing to decide.
    const applied = await (await handleOperateApproval(post(), apiAnswering(async () => ({...pending, status: "applied"})))).text();
    const done = JSON.parse(applied.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).at(-1)!);
    expect(done.outcome).toEqual({type: "success"});
  });
});
