import { getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES } from '@gadgets/workshop-shared/api'

/**
 * What a person is told when the operate session refuses a change. A `consoleChanged` refusal has
 * already re-read the saved consoles (see `OperateSessionProvider`), so the page now shows the
 * latest revision and offers to reopen it (see `ConsolePage`).
 */
export const refusalMessage = (caught: unknown): string => {
  switch (getOperateSessionErrorCode(caught)) {
    case OPERATE_SESSION_ERROR_CODES.consoleChanged:
      return 'This console has changed since it was opened. Reopen it to continue on the latest version.'
    case OPERATE_SESSION_ERROR_CODES.boardUnavailable:
      return 'That board is not connected for you or is no longer available. Choose another board or connect it.'
    default:
      return 'That change could not be applied to your session.'
  }
}
