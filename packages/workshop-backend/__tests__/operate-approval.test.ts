import { describe, it, expect, vi } from "vitest";
import { makeActionStorage, openFakeOverseer, putAction } from "./fixtures";
import { approvalCorrelation, approvalSnapshot } from "../src/operate-approval";
import type { ApprovalProposal } from "@gadgets/workshop-shared/operate-approval";
vi.mock("capnweb-validate", () => ({validateRpc: () => () => undefined}));
const proposal: ApprovalProposal = {scope: "inferops://acme.operations/project/board/ENG",
  args: {toStateId: "done"}, expectedRevision: "1", fingerprint: "original", idempotencyKey: "key-1",
  simulation: {issueId: "issue-1", fromStateId: "todo", toStateId: "done"}};
const input = {actionId: 1, threadId: "thread", runId: "initial"};
function setup() {
  const storage = makeActionStorage();
  putAction(storage, 1);
  const record = storage.actions.get(1)!;
  if (record.type !== "action") throw new Error("fixture");
  record.aguiApproval = approvalCorrelation("owner-id", input, proposal);
  storage.actions.put(record);
  const apply = vi.fn();
  const impl = {getGatekeeperFacet: () => ({getApprovalProposal: async () => proposal}), applyPendingAction: apply};
  const answer = {actionId: 1, threadId: "thread", runId: "answer",
    answer: {interruptId: record.aguiApproval.interruptId, payload: {approved: true}}};
  return {storage, record, impl, apply, answer};
}
describe("durable approval fencing", () => {
  it("expired answers fail before apply; reload reports expiry and retains the original deadline", async () => {
    const f = setup();
    f.record.aguiApproval!.expiresAt = Date.now() - 1;
    f.storage.actions.put(f.record);
    const client = await openFakeOverseer(f.storage, {impl: f.impl});
    await expect(client.operateApproval(f.answer)).rejects.toThrow("no longer pending");
    expect((await client.operateApproval(input)).status).toBe("expired");
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("an expiry crossed during proposal verification still refuses before apply", async () => {
    const f = setup();
    const clock = vi.spyOn(Date, "now");
    try {
      const client = await openFakeOverseer(f.storage, {impl: {...f.impl,
        getGatekeeperFacet: () => ({getApprovalProposal: async () => {
          clock.mockReturnValue(f.record.aguiApproval!.expiresAt + 1);
          return proposal;
        }})}});
      await expect(client.operateApproval(f.answer)).rejects.toThrow("refused");
      expect(f.apply).not.toHaveBeenCalled();
    } finally {clock.mockRestore();}
  });
  it("another person, thread, action or interrupt cannot reuse the stored answer", async () => {
    const f = setup();
    const client = await openFakeOverseer(f.storage, {impl: f.impl});
    for (const request of [{...f.answer, threadId: "foreign"}, {...f.answer, actionId: 99},
      {...f.answer, answer: {...f.answer.answer, interruptId: "foreign"}}]) {
      await expect(client.operateApproval(request)).rejects.toThrow("refused");
    }
    f.record.aguiApproval!.person = "someone-else";
    f.storage.actions.put(f.record);
    await expect(client.operateApproval(f.answer)).rejects.toThrow("refused");
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("a changed fingerprint is refused before invoking the existing approval path", async () => {
    const f = setup();
    const client = await openFakeOverseer(f.storage, {impl: {...f.impl,
      getGatekeeperFacet: () => ({getApprovalProposal: async () => ({...proposal, fingerprint: "changed"})})}});
    await expect(client.operateApproval(f.answer)).rejects.toThrow("refused");
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("one person/thread cannot select a second queued action", async () => {
    const f = setup();
    putAction(f.storage, 2);
    const client = await openFakeOverseer(f.storage, {impl: f.impl});
    await expect(client.operateApproval({...input, actionId: 2})).rejects.toThrow("Thread already has an action");
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("unknown application survives rejection and expiry rather than asserting no effect", () => {
    const f = setup();
    f.record.state = "rejected";
    f.record.aguiApproval!.expiresAt = 0;
    f.record.lastAttempt = {outcome: "unknown", message: "lost", retryable: false, at: new Date()};
    expect(approvalSnapshot(f.record)).toMatchObject({status: "unknown", failure: {outcome: "unknown"}});
  });
});
