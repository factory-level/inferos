// The recovery rehearsal's pure helpers (FAC-141), apart from rehearsal-operator.ts, which signs in
// through the Workshop's dev scripts, so that the offline test and scripts/tsconfig.json need none
// of the Workers types those bring.

/** One action as the rehearsal reads it. */
export type RehearsalAction = { id: number; state: string; type: string; failure?: string };

/** Whether `url` names a local stack; the operator signs in nowhere else. */
export function isLocalStackUrl(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The fields the rehearsal reports of an action log entry: its id, type, state and failure code, never its content. */
export function summarize(entry: { id: number; state: string; type: string; lastAttempt?: { outcome: string; code?: string } }): RehearsalAction {
  let failure = entry.lastAttempt ? entry.lastAttempt.code ?? entry.lastAttempt.outcome : undefined;
  return { id: entry.id, state: entry.state, type: entry.type, ...(failure ? { failure } : {}) };
}
