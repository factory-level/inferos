import wasm from "esbuild-wasm/esbuild.wasm";
import type { AuthoredWidgetBuildResult } from "./authored-widget-build.js";
import { compileAuthoredWidgetWithWasm } from "./authored-widget-build-compiler.js";

/** Compile in this build DO with the Worker-bundled esbuild WASM module. */
export function compileAuthoredWidget(authoredFiles: Readonly<Record<string, string>>,
    deadlineMs?: number): Promise<AuthoredWidgetBuildResult> {
  return compileAuthoredWidgetWithWasm(authoredFiles, wasm, deadlineMs);
}
