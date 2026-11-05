import {
  createOperateSessionError, getOpenGadgetErrorCode, OPERATE_SESSION_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

/**
 * Decides a flow navigation's destination (FAC-87) from one read of its screen through the
 * caller's own access, failing closed either way:
 * - the screen is missing, or the workspace refuses the caller (a coded open failure: not found,
 *   access denied, share links disabled): `flowPageUnavailable`, since the page is not theirs to
 *   open now;
 * - anything else (an unreachable workspace, a failed call): `flowNavigationFailed`, which is
 *   transient, so the runner can offer to try again.
 * Neither error names the page, the screen or the workspace.
 */
export async function checkFlowDestination(readScreen: () => Promise<unknown>): Promise<void> {
  let screen: unknown;
  try {
    screen = await readScreen();
  } catch (error) {
    throw createOperateSessionError(getOpenGadgetErrorCode(error) === undefined
      ? OPERATE_SESSION_ERROR_CODES.flowNavigationFailed : OPERATE_SESSION_ERROR_CODES.flowPageUnavailable);
  }
  if (screen === null || screen === undefined) {
    throw createOperateSessionError(OPERATE_SESSION_ERROR_CODES.flowPageUnavailable);
  }
}
