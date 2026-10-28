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
 * Why a worker's deploy targets are wrong, or null. The router must be reachable at exactly the
 * stage's hostname, and nothing else may be reachable at all: a workers.dev URL or a second route
 * on any worker is a way around the Access application in front of the hostname.
 */
export function deployTargetProblem(workerName: string, targets: readonly string[], expectedHost: string | null): string | null {
  if (expectedHost === null) {
    return targets.length === 0 ? null :
      `${workerName} is reachable at ${targets.join(", ")}, but only the router may have a URL`;
  }
  const hosts = targets.map((target) => target.replace(/^https?:\/\//, "").split(/[\s/]/)[0]);
  if (hosts.length === 0) return `${workerName} reported no targets; expected ${expectedHost}`;
  const stray = targets.filter((_, i) => hosts[i] !== expectedHost);
  return stray.length === 0 ? null :
    `${workerName} is reachable at ${stray.join(", ")} besides ${expectedHost}; only the custom domain is allowed`;
}
