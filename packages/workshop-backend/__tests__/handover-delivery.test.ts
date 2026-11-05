// FAC-88: what a handover's sender learns when it can't be delivered. A recipient in another
// company, or one whose company can't be told just now, both read as "no such person here", so the
// sender learns nothing about the recipient's company or accounts.
import { describe, expect, it } from "vitest";
import {
  createOperateSessionError, getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES,
} from "@gadgets/workshop-shared/api";
import { INITIAL_OPERATE_PAGE, type OperateHandover } from "@gadgets/workshop-shared/operate-session";
import { deliverHandover, type HandoverRecipient } from "../src/handover-delivery";

const HANDOVER: OperateHandover = {
  id: "h1", from: { id: "alice", name: "Alice" }, to: { id: "bob", name: "Bob" },
  boardRef: "inferops://acme.operations/project/board/ENG", issueId: null, note: "Yours",
};

const refusing = (error: unknown): HandoverRecipient => ({ receiveHandover: async () => { throw error; } });
const codeOf = (delivery: Promise<unknown>) =>
  delivery.then(() => "delivered", (error: unknown) => getOperateSessionErrorCode(error) ?? String(error));

describe("delivering a handover", () => {
  it("passes the sender's company to the recipient and returns their page", async () => {
    let seen: string[] = [];
    let recipient: HandoverRecipient = {
      receiveHandover: async (_handover, company) => { seen.push(company); return { seq: 1, state: INITIAL_OPERATE_PAGE }; },
    };
    expect((await deliverHandover(recipient, HANDOVER, "tenant-a")).seq).toBe(1);
    expect(seen).toEqual(["tenant-a"]);
  });

  it("reads a recipient in another company, or one whose company can't be told, as no one there", async () => {
    for (let code of [OPERATE_SESSION_ERROR_CODES.recipientUnavailable, OPERATE_SESSION_ERROR_CODES.companyUnavailable]) {
      expect(await codeOf(deliverHandover(refusing(createOperateSessionError(code)), HANDOVER, "tenant-a")))
        .toBe(OPERATE_SESSION_ERROR_CODES.recipientUnavailable);
    }
  });

  it("passes any other failure on unchanged", async () => {
    let invalid = createOperateSessionError(OPERATE_SESSION_ERROR_CODES.invalidEvent);
    expect(await codeOf(deliverHandover(refusing(invalid), HANDOVER, "tenant-a"))).toBe(OPERATE_SESSION_ERROR_CODES.invalidEvent);
    expect(await codeOf(deliverHandover(refusing(new Error("storage down")), HANDOVER, "tenant-a"))).toBe("Error: storage down");
  });
});
