// Parsers for the Wrangler output `scripts/stage/stage.ts` reads back, kept pure so the tests can
// feed them recorded output.

/** One KV namespace as `wrangler kv namespace list` reports it. */
interface ListedNamespace {
  id?: unknown;
  title?: unknown;
}

/**
 * `wrangler kv namespace list` output -> title => id. Wrangler prints the JSON array after any
 * informational lines, so the array is located rather than assumed to be the whole of stdout. Two
 * namespaces sharing a title is an error: a stage finds its namespaces by title, and picking one
 * of two would bind whichever the API happened to list first.
 */
export function parseKvNamespaceList(stdout: string): Map<string, string> {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error("wrangler kv namespace list printed no JSON array");
  const listed = JSON.parse(stdout.slice(start)) as ListedNamespace[];
  if (!Array.isArray(listed)) throw new Error("wrangler kv namespace list did not print an array");
  const byTitle = new Map<string, string>();
  for (const { id, title } of listed) {
    if (typeof id !== "string" || typeof title !== "string") continue;
    if (byTitle.has(title)) throw new Error(`two KV namespaces are titled "${title}"; remove one before deploying`);
    byTitle.set(title, id);
  }
  return byTitle;
}

/**
 * The `targets` of the `deploy` entries in a Wrangler output file (`WRANGLER_OUTPUT_FILE_PATH`,
 * one JSON object per line), or null when the file holds no deploy entry, which means the deploy
 * did not get as far as publishing a version.
 */
export function parseDeployTargets(outputFile: string): string[] | null {
  let targets: string[] | null = null;
  for (const line of outputFile.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; targets?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "deploy") continue;
    targets = [...(targets ?? []), ...(Array.isArray(entry.targets) ? entry.targets.map(String) : [])];
  }
  return targets;
}

/**
 * Why a worker's deploy targets are wrong, or null. A worker with a hostname (the router, and the
 * InferOps gatekeeper's sign-in proxy) must be reachable at exactly that hostname, and nothing else
 * may be reachable at all: a workers.dev URL or a stray route is a way around Access.
 */
export function deployTargetProblem(workerName: string, targets: readonly string[], expectedHost: string | null): string | null {
  if (expectedHost === null) {
    return targets.length === 0 ? null :
      `${workerName} is reachable at ${targets.join(", ")}, but it must have no URL`;
  }
  const hosts = targets.map((target) => target.replace(/^https?:\/\//, "").split(/[\s/]/)[0]);
  if (hosts.length === 0) return `${workerName} reported no targets; expected ${expectedHost}`;
  const stray = targets.filter((_, i) => hosts[i] !== expectedHost);
  return stray.length === 0 ? null :
    `${workerName} is reachable at ${stray.join(", ")} besides ${expectedHost}; only the custom domain is allowed`;
}

/** How long a first deploy waits for its new custom domain to resolve before probing it. */
const DNS_WAIT_MS = 5 * 60_000;

/** True when `err` is a name-resolution failure (the custom domain's record is not visible yet). */
export function isDnsNotReady(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) {
    const code = (e as Error & { code?: string }).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo (ENOTFOUND|EAI_AGAIN)/.test(e.message)) return true;
  }
  return false;
}

/**
 * Runs `request`, retrying while the hostname does not resolve yet: a first deploy creates the
 * router's custom-domain record moments before the probe, so `ENOTFOUND` there means "not yet",
 * not "broken". Any other error, or still no record after {@link DNS_WAIT_MS}, is thrown.
 */
export async function retryWhileDnsPending<T>(request: () => Promise<T>, waitMs = DNS_WAIT_MS,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (let delay = 2_000; ; delay = Math.min(delay * 2, 30_000)) {
    try {
      return await request();
    } catch (err) {
      if (!isDnsNotReady(err) || Date.now() + delay > deadline) throw err;
      console.log(`waiting for DNS (${(err as Error).message}); retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}
