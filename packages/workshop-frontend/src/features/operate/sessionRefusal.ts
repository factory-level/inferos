import { getOperateSessionErrorCode, OPERATE_SESSION_ERROR_CODES } from '@gadgets/workshop-shared/api'

/**
 * What a person is told when the operate session refuses a change. A `consoleChanged` refusal has
 * already re-read the saved consoles (see `OperateSessionProvider`), so the page now shows the
 * console as it is saved: a removed view is gone from the sidebar, and a removed current view says so.
 */
export const refusalMessage = (caught: unknown): string => {
  switch (getOperateSessionErrorCode(caught)) {
    case OPERATE_SESSION_ERROR_CODES.consoleChanged:
      return 'This console has changed since it was loaded. It now shows as it is saved.'
    case OPERATE_SESSION_ERROR_CODES.boardUnavailable:
      return 'That board is not connected for you or is no longer available. Choose another board or connect it.'
    default:
      return 'That change could not be applied to your session.'
  }
}
