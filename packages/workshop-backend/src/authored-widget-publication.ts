import type { GitStore } from "./git-store.js";
import type { AuthoredWidgetBuildResult } from "./authored-widget-build.js";
import { validateAuthoredWidgetPreflight } from "./authored-widget-preflight.js";

const sourceFreeValidationMessages = new Set([
  "Invalid TypeScript syntax.",
  "Unapproved package import.",
  "Denied global.",
  "Dynamic import refused.",
  "import.meta refused.",
  "External CSS resources are not allowed.",
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
  compile(files: Readonly<Record<string, string>>): Promise<Pick<AuthoredWidgetBuildResult, "clientJs">>;
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

  let authoredSources = Object.fromEntries([...files].filter(([path]) =>
    path.endsWith(".tsx") || path.endsWith(".css")));
  // Reject malformed, oversized or unapproved source before allocating/calling the build DO.
  // The isolated compiler repeats validation so callers cannot bypass its own boundary.
  validateAuthoredWidgetPreflight(authoredSources);
  let build = builds.get(builds.newUniqueId());
  let startedAt = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: { clientJs: string };
  try {
    result = await Promise.race([
      build.compile(authoredSources),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("build deadline")), options.timeoutMs ?? 15_000);
      }),
    ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
  } catch (error) {
    onFailure(Math.round(performance.now() - startedAt));
    let message = error instanceof Error ? error.message : "";
    if (message === "build deadline" || message === "Build timed out." ||
        /Durable Object.*(?:reset|terminated)|(?:reset|terminated).*Durable Object/iu.test(message)) {
      throw new Error("Build failed: it ran out of resources; try fewer or smaller files.", { cause: error });
    }
    if (sourceFreeValidationMessages.has(message) || message.startsWith("Authored widget refused:")) {
      throw new Error(message, { cause: error });
    }
    throw new Error("Build failed: the widget could not be compiled.", { cause: error });
  }

  files.set("client.js", result.clientJs);
  return gitStore.writeFilesAsCommit(files, {
    parents: [sourceCommitId],
    author: await author(),
    message: "Build authored widget for publication",
    timestamp: new Date(),
  });
}
