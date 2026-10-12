/** Maximum durable generation; never wrap or restore an older boundary. */
export const MAX_READ_GENERATION = 18_446_744_073_709_551_615n;

/** Safe endpoint errors, shared by HTTP, RPC and durable admission. */
export const READ_RUN_ERROR_STATUS = {
  READ_RUN_UPGRADE_REQUIRED: 409,
  RUN_GENERATION_RETIRED: 409,
  RUN_GENERATION_INVALID: 409,
  RUN_ALREADY_RESERVED: 409,
  RUN_CAPACITY_EXHAUSTED: 429,
  UNSUPPORTED_READ_INPUT: 400,
  READ_RUN_STORAGE_REFUSED: 503,
} as const;

/** Classifies only the bounded public error messages; never returns raw exceptions. */
export function readRunError(error: unknown): keyof typeof READ_RUN_ERROR_STATUS | undefined {
  return error instanceof Error && Object.hasOwn(READ_RUN_ERROR_STATUS, error.message)
    ? error.message as keyof typeof READ_RUN_ERROR_STATUS : undefined;
}

/** True only for selectors admitted by the retired, pre-generation endpoint. */
export function isLegacyReadSelector(value: string): boolean {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

/** Parse a canonical uint64 generation-qualified selector; IDs themselves grant no authority. */
export function parseReadSelector(value: string, kind: "t" | "r"): bigint {
  const match = typeof value === "string" && value.length <= 128
    ? /^or2:([1-9][0-9]{0,19}):([tr]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(value) : null;
  if (!match || match[2] !== kind || BigInt(match[1]) > MAX_READ_GENERATION) {
    throw new Error("UNSUPPORTED_READ_INPUT");
  }
  return BigInt(match[1]);
}

/** Validate both selectors without rewriting a submitted request or accepting legacy admission. */
export function parseReadRunSelectors(threadId: string, runId: string): bigint {
  if (isLegacyReadSelector(threadId) && isLegacyReadSelector(runId)) {
    throw new Error("READ_RUN_UPGRADE_REQUIRED");
  }
  const generation = parseReadSelector(threadId, "t");
  if (parseReadSelector(runId, "r") !== generation) throw new Error("RUN_GENERATION_INVALID");
  return generation;
}

/** Make fresh selectors for a new explicit caller intent, never for an uncertain automatic retry. */
export function newReadRunSelectors(generation: bigint): {threadId: string; runId: string} {
  if (generation < 1n || generation > MAX_READ_GENERATION) throw new Error("READ_RUN_STORAGE_REFUSED");
  return {threadId: `or2:${generation}:t:${crypto.randomUUID()}`, runId: `or2:${generation}:r:${crypto.randomUUID()}`};
}
