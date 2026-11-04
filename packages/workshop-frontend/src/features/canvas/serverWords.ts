/**
 * A client hint followed by the server's own words, so a refusal is never shown only in the
 * client's paraphrase (FAC-97). The hint alone when the server gave no message, or one the hint
 * already says. The words may be the gatekeeper's or InferOps', so they are attributed to neither.
 */
export const withServerWords = (hint: string, message: string | undefined): string => {
  const said = message?.trim() ?? ''
  return said === '' || hint.includes(said) ? hint : `${hint} The server said: ${said}`
}
