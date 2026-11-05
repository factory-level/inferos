import { build, initialize, type Plugin } from "esbuild-wasm/esm/browser.js";
import { createWorkshopLogger } from "./observability.js";
import type { AuthoredWidgetBuildResult } from "./authored-widget-build.js";
import {
  allowedAuthoredWidgetImports as allowedImports,
  resolveSourcePath,
  validateAuthoredWidgetSources as validateSources,
  withBuildDeadline,
} from "./authored-widget-validation.js";
import {
  authoredWidgetDependencies as dependencies,
  authoredWidgetDependencyLockHash,
  authoredWidgetDependencyBytes,
  authoredWidgetWasmBytes,
} from "./generated/authored-widget-dependencies.js";

const logger = createWorkshopLogger("workshop.authored-widget-build");
const compileTimeoutMs = 10_000;
const entryShim = `import Widget from "./client.tsx";\n` +
  `import { createElement } from "react";\nimport { createRoot } from "react-dom/client";\n` +
  `const root = document.createElement("div");\ndocument.body.replaceChildren(root);\n` +
  `createRoot(root).render(createElement(Widget));\n`;
let initializePromise: Promise<void> | undefined;

/** Compiles a bounded source tree in its build Durable Object; same-Worker resources are shared. */
export async function compileAuthoredWidgetWithWasm(authoredFiles: Readonly<Record<string, string>>,
    wasmModule: WebAssembly.Module, deadlineMs = compileTimeoutMs): Promise<AuthoredWidgetBuildResult> {
    const startedAt = performance.now();
    let outcome = "failed";
    // Input refusals are fixed and source-free; let them cross the RPC boundary unchanged.
    const files = validateSources(authoredFiles);
    try {
      initializePromise ??= initialize({ wasmModule, worker: false });
      await initializePromise;
      const result = await withBuildDeadline(build({
          bundle: true,
          entryPoints: ["__gadget_entry__.tsx"],
          format: "esm",
          jsx: "automatic",
          legalComments: "none",
          metafile: true,
          minify: true,
          platform: "browser",
          sourcemap: false,
          target: "es2022",
          tsconfigRaw: {},
          write: false,
          logLevel: "silent",
          plugins: [authoredSourcesPlugin(files)],
        }), deadlineMs);
      const output = result.outputFiles[0];
      if (!output || !result.metafile) throw new Error("No output from compiler.");
      const external = Object.values(result.metafile.outputs).flatMap(file => file.imports)
        .filter(item => item.external);
      if (external.length > 0) throw new Error("Authored widget refused: unresolved dependency.");
      const clientJs = output.text;
      if (/(?:^|[^\w$.])__require\b|(?<![\w$.])require\s*\(/u.test(clientJs)) {
        throw new Error("Authored widget refused: unresolved CommonJS loader.");
      }
      outcome = "compiled";
      return Object.freeze({ clientJs, durationMs: performance.now() - startedAt,
        clientBytes: new TextEncoder().encode(clientJs).byteLength });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "compile timeout") throw new Error("Build timed out.", { cause: error });
      if (message.includes("Dependency outside the reviewed closure")) {
        throw new Error("Authored widget refused: dependency outside the reviewed closure.", { cause: error });
      }
      if (message.startsWith("Authored widget refused:")) throw new Error(message, { cause: error });
      throw new Error("Authored widget compile failed.", { cause: error });
    } finally {
      logger.info("authored widget compile finished", {
        event: "authored_widget.compile.finished",
        durationMs: Math.round(performance.now() - startedAt),
        outcome: outcome === "compiled" ? "ok" : "error",
        dependencyBytes: authoredWidgetDependencyBytes,
        dependencyLockHash: authoredWidgetDependencyLockHash,
        wasmBytes: authoredWidgetWasmBytes,
      });
    }
}

function authoredSourcesPlugin(files: Map<string, string>): Plugin {
  const vfs = dependencies as { files: Record<string, string>; resolutions: Record<string, string>; roots: Record<string, string> };
  return { name: "authored-widget-vfs", setup(api) {
    api.onResolve({ filter: /.*/ }, args => {
      if (args.kind === "entry-point") return { path: "__gadget_entry__.tsx", namespace: "widget" };
      if (args.namespace === "widget") {
        if (args.path.startsWith(".")) {
          const path = resolveSourcePath(args.importer || "client.tsx", args.path, files);
          return path && files.has(path) ? { path, namespace: "widget" } : { errors: [{ text: "Missing source file." }] };
        }
        if (!allowedImports.has(args.path) || !vfs.roots[args.path]) return { errors: [{ text: "Unapproved package import." }] };
        return { path: vfs.roots[args.path], namespace: "dependencies" };
      }
      if (args.namespace === "dependencies") {
        const resolved = vfs.resolutions[`${args.importer}::${args.path}`];
        return resolved ? { path: resolved, namespace: "dependencies" } : { errors: [{ text: "Dependency outside the reviewed closure." }] };
      }
      return undefined;
    });
    api.onLoad({ filter: /.*/, namespace: "widget" }, args => {
      const source = args.path === "__gadget_entry__.tsx" ? entryShim : files.get(args.path);
      if (source === undefined) return { errors: [{ text: "Missing source file." }] };
      return { contents: args.path.endsWith(".css") ? cssWrapper(source) : source,
        loader: args.path.endsWith(".css") ? "js" : "tsx", resolveDir: "/" };
    });
    api.onLoad({ filter: /.*/, namespace: "dependencies" }, args => {
      const contents = vfs.files[args.path];
      return contents === undefined ? { errors: [{ text: "Missing dependency file." }] } : {
        contents: args.path === vfs.roots["@refinedev/core"] ? stripRefineTelemetry(contents) : contents,
        loader: args.path.endsWith(".json") ? "json" : args.path.endsWith(".css") ? "css" : "js",
        resolveDir: "/",
      };
    });
  } };
}

function cssWrapper(css: string): string {
  return `const style=document.createElement("style");style.textContent=${JSON.stringify(css)};document.head.append(style);`;
}

function stripRefineTelemetry(source: string): string {
  const start = source.indexOf("// src/components/telemetry/index.tsx");
  const end = source.indexOf("// src/definitions/helpers/check-router-prop-misuse/index.ts", start + 1);
  const mount = "!disableTelemetryWithDefault && /* @__PURE__ */ React41.createElement(Telemetry, null)";
  if (start < 0 || end < 0 || !source.includes(mount)) throw new Error("Pinned Refine telemetry shape changed.");
  const stripped = source.slice(0, start) + source.slice(end).replace(mount, "false");
  if (/telemetry\.refine\.dev|useTelemetryData|\bTelemetry\b/u.test(stripped)) throw new Error("Refine telemetry remains.");
  return stripped;
}
