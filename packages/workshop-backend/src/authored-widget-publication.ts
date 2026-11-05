import type { GitStore } from "./git-store.js";
import type { AuthoredWidgetBuildResult } from "./authored-widget-build.js";
import { isValidAuthoredWidgetCommitPath } from "./authored-widget-path.js";
import { validateAuthoredWidgetPreflight } from "./authored-widget-preflight.js";

/** Maximum wait for one authored-widget build operation. */
export const AUTHORED_WIDGET_BUILD_TIMEOUT_MS = 15_000;
/** Maximum UTF-8 bytes returned by a non-persistent authored-widget preview. */
export const MAX_AUTHORED_WIDGET_PREVIEW_BYTES = 2 * 1024 * 1024;

const sourceFreeValidationMessages = new Set([
  "Invalid TypeScript syntax.",
  "Unapproved package import.",
  "Denied global.",
  "Dynamic import refused.",
  "import.meta refused.",
  "External CSS resources are not allowed.",
  "Invalid source path.",
]);

/** Minimal build namespace contract used by the authored-widget publication boundary. */
export interface AuthoredWidgetBuildNamespace {
  /** Return an isolated build stub for one publication attempt. */
  get(id: unknown): AuthoredWidgetBuildStub;
  /** Allocate a unique build object id. */
  newUniqueId(): unknown;
}

/** Build RPC contract consumed by publication. */
export interface AuthoredWidgetBuildStub {
  /** Compile the bounded authored TSX/CSS source map. */
  compile(files: Readonly<Record<string, string>>): Promise<Pick<AuthoredWidgetBuildResult, "clientJs" | "durationMs" | "clientBytes">>;
}

/** Build already selected and path-checked sources with the isolated, bounded compiler. */
export async function compileAuthoredWidgetSources(options: {
  sources: Readonly<Record<string, string>>;
  builds: AuthoredWidgetBuildNamespace;
  onFailure: (durationMs: number) => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<Pick<AuthoredWidgetBuildResult, "clientJs" | "durationMs" | "clientBytes">> {
  validateAuthoredWidgetPreflight(options.sources);
  let build = options.builds.get(options.builds.newUniqueId());
  let startedAt = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    let result = await Promise.race([
      build.compile(options.sources),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("build deadline")), options.timeoutMs ?? AUTHORED_WIDGET_BUILD_TIMEOUT_MS);
      }),
    ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    if (options.maxOutputBytes !== undefined &&
        new TextEncoder().encode(result.clientJs).byteLength > options.maxOutputBytes) {
      throw new Error("Build output size limit exceeded.");
    }
    return result;
  } catch (error) {
    options.onFailure(Math.round(performance.now() - startedAt));
    let message = error instanceof Error ? error.message : "";
    if (message === "Build output size limit exceeded.") throw new Error(message, { cause: error });
    if (message === "build deadline" || message === "Build timed out." ||
        /Durable Object.*(?:reset|terminated)|(?:reset|terminated).*Durable Object/iu.test(message)) {
      throw new Error("Build failed: it ran out of resources; try fewer or smaller files.", { cause: error });
    }
    if (sourceFreeValidationMessages.has(message) || message.startsWith("Authored widget refused:")) {
      throw new Error(message, { cause: error });
    }
    throw new Error("Build failed: the widget could not be compiled.", { cause: error });
  }
}

/** Dependencies for compiling and storing an authored widget publication commit. */
export interface CompileAuthoredWidgetPublicationOptions {
  enabled: boolean;
  sourceCommitId: string;
  gitStore: Pick<GitStore, "readCommitFiles" | "writeFilesAsCommit">;
  builds: AuthoredWidgetBuildNamespace;
  author: () => Promise<Parameters<GitStore["writeFilesAsCommit"]>[1]["author"]>;
  onFailure: (durationMs: number) => void;
  timeoutMs?: number;
}

/** Build authored client TSX in an isolated DO and store its output as a child commit. */
export async function compileAuthoredWidgetPublication(
    options: CompileAuthoredWidgetPublicationOptions): Promise<string> {
  let { enabled, sourceCommitId, gitStore, builds, author, onFailure } = options;
  if (!enabled) return sourceCommitId;
  let files = await gitStore.readCommitFiles(sourceCommitId);
  if (!files.has("client.tsx")) return sourceCommitId;

  // Every path of the commit is checked before any is chosen as a source, so a path that only
  // resembles one (or isn't one at all) can't skip validation by falling outside the filter below.
  for (let path of files.keys()) {
    if (!isValidAuthoredWidgetCommitPath(path)) throw new Error("Invalid source path.");
  }
  let authoredSources = Object.fromEntries([...files].filter(([path]) =>
    path.endsWith(".tsx") || path.endsWith(".css")));
  // Reject malformed, oversized or unapproved source before allocating/calling the build DO.
  // The isolated compiler repeats validation so callers cannot bypass its own boundary.
  let result = await compileAuthoredWidgetSources({
    sources: authoredSources, builds, onFailure, timeoutMs: options.timeoutMs,
  });

  files.set("client.js", result.clientJs);
  return gitStore.writeFilesAsCommit(files, {
    parents: [sourceCommitId],
    author: await author(),
    message: "Build authored widget for publication",
    timestamp: new Date(),
  });
}
