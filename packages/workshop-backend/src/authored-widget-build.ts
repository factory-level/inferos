import { DurableObject } from "cloudflare:workers";

/** Immutable compiled output returned to the publishing Overseer. */
export interface AuthoredWidgetBuildResult {
  /** Bundled client JavaScript. */
  clientJs: string;
  /** Build duration in milliseconds; source text is never included. */
  durationMs: number;
  /** UTF-8 byte length of the built client module. */
  clientBytes: number;
}

/** Per-build Durable Object in the Worker. It separates the compile call path from the Overseer,
 * but objects on one Worker can still share an isolate, memory and thread. */
export class AuthoredWidgetBuildDurableObject extends DurableObject {
  /** Compile validated source to a self-contained client module, refusing every invalid input. */
  async compile(authoredFiles: Readonly<Record<string, string>>): Promise<AuthoredWidgetBuildResult> {
    // Keep esbuild, its dependency VFS, and the wasm module out of the ordinary Worker graph.
    const { compileAuthoredWidget } = await import("./authored-widget-build-runtime.js");
    return compileAuthoredWidget(authoredFiles);
  }
}
