// Delivering a handover to its recipient's operate session (FAC-88). The recipient's own user DO
// decides, in one synchronous step with the append, whether the handover's company is the one
// they work in now (UserDurableObject.receiveHandover); this only turns what the sender may learn
// into one answer.

import {
  createOperateSessionError, getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES,
} from "@gadgets/workshop-shared/api";
import type { OperateHandover, OperateSessionSnapshot } from "@gadgets/workshop-shared/operate-session";

/** The recipient's side of a handover: their user DO's `receiveHandover`. */
export type HandoverRecipient = {
  receiveHandover(handover: OperateHandover, senderCompany: string): Promise<OperateSessionSnapshot>;
};

/**
 * Delivers `handover` from a sender who works in `senderCompany`. A recipient in another company,
 * or one whose company can't be told just now, is refused with `recipientUnavailable`, so the
 * sender learns nothing about the recipient's company or accounts. Any other failure is passed on.
 */
export async function deliverHandover(recipient: HandoverRecipient, handover: OperateHandover,
                                      senderCompany: string): Promise<OperateSessionSnapshot> {
  try {
    return await recipient.receiveHandover(handover, senderCompany);
  } catch (err) {
    let code = getOperateSessionErrorCode(err);
    if (code === OPERATE_SESSION_ERROR_CODES.companyUnavailable || code === OPERATE_SESSION_ERROR_CODES.recipientUnavailable) {
      throw Object.assign(createOperateSessionError(OPERATE_SESSION_ERROR_CODES.recipientUnavailable), { cause: err });
    }
    throw err;
  }
}
