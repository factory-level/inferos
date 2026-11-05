// Node-only compiler for future authored React/Refine widgets. This module does not execute
// widget code, read environment variables, install packages, or write an artifact to storage.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { build, version as esbuildVersion } from "esbuild";
import ts from "typescript6";
import { scanModule } from "./scan.ts";

/** The only package versions authored source may import directly. */
export const AUTHORED_WIDGET_DEPENDENCY_VERSIONS = Object.freeze({
  "@refinedev/core": "5.0.12",
  "@tanstack/react-query": "5.105.3",
  react: "19.2.8",
  "react-dom": "19.2.8",
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const lockfilePath = join(repositoryRoot, "pnpm-lock.yaml");
const maximumSourceBytes = 1024 * 1024;
const allowedImports = new Set([
  "@refinedev/core",
  "@tanstack/react-query",
  "react",
  "react-dom/client",
  "react/jsx-runtime",
]);
const deniedGlobals = new Set([
  "Bun",
  "Deno",
  "EventSource",
  "Function",
  "global",
  "globalThis",
  "localStorage",
  "navigator",
  "self",
  "sessionStorage",
  "WebSocket",
  "window",
  "XMLHttpRequest",
  "fetch",
  "process",
]);

/** A successful, self-contained client artifact and the inputs needed to reproduce it. */
export interface AuthoredWidgetArtifact {
  /** Bundled ES module to store as an immutable Gadget client artifact. */
  clientJs: string;
  /** SHA-256 of the emitted client module. */
  artifactHash: string;
  /** SHA-256 of the normalized TSX and CSS source files. */
  sourceHash: string;
  /** SHA-256 of the repository package lock used to resolve pinned dependencies. */
  dependencyLockHash: string;
  /** UTF-8 byte count of the repository package lock. */
  dependencyLockBytes: number;
  /** SHA-256 of source, lock, curated dependencies, compiler, and Node version. */
  buildInputHash: string;
  /** UTF-8 bytes in clientJs. */
  artifactBytes: number;
  /** Bytes after the Gadget loader's encodeURIComponent(clientJs) step. */
  dataUrlEncodedBytes: number;
  /** Wall clock duration of this compile, excluded from all hashes. */
  buildDurationMs: number;
  /** Direct package versions selected by the server-owned dependency manifest. */
  dependencyVersions: Readonly<Record<string, string>>;
  /** The exact local compiler/runtime versions used for this build. */
  compiler: { esbuild: string; node: string };
}

export type AuthoredWidgetRevisionResult =
  | { status: "compiled"; artifact: AuthoredWidgetArtifact }
  | { status: "failed"; artifact: AuthoredWidgetArtifact | null; error: Error };

/** Compile a replacement revision while retaining the selected immutable artifact on failure. */
export async function compileAuthoredWidgetRevision(
  authoredFiles: Readonly<Record<string, string>>,
  lastGoodArtifact: AuthoredWidgetArtifact | null,
): Promise<AuthoredWidgetRevisionResult> {
  try {
    return Object.freeze({ status: "compiled", artifact: await compileAuthoredWidget(authoredFiles) });
  } catch (error) {
    return Object.freeze({
      status: "failed",
      artifact: lastGoodArtifact,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Compile editable React/Refine TSX into one deterministic, self-contained Gadget module. */
export async function compileAuthoredWidget(
  authoredFiles: Readonly<Record<string, string>>,
): Promise<AuthoredWidgetArtifact> {
  const startedAt = performance.now();
  const sources = validateSources(authoredFiles);
  const sourceHash = hashSourceFiles(sources);
  const dependencyLock = await readFile(lockfilePath);
  const dependencyLockHash = sha256(dependencyLock);
  const compiler = { esbuild: esbuildVersion, node: process.versions.node };
  const buildInputHash = sha256(JSON.stringify({
    sourceHash,
    dependencyLockHash,
    dependencyLockBytes: dependencyLock.byteLength,
    dependencyVersions: AUTHORED_WIDGET_DEPENDENCY_VERSIONS,
    compiler,
  }));

  let result;
  try {
    result = await build({
      absWorkingDir: packageRoot,
      bundle: true,
      entryPoints: ["__gadget_entry__.tsx"],
      format: "esm",
      jsx: "automatic",
      legalComments: "none",
      metafile: true,
      minify: true,
      nodePaths: [join(packageRoot, "node_modules")],
      platform: "browser",
      sourcemap: false,
      target: "es2022",
      tsconfigRaw: {},
      write: false,
      logLevel: "silent",
      plugins: [authoredSourcesPlugin(sources)],
    });
  } catch (error) {
    throw new Error(`Authored widget compile refused: ${errorMessage(error)}`, { cause: error });
  }

  const output = result.outputFiles[0];
  if (!output) throw new Error("Authored widget compile failed: no client JavaScript was emitted.");
  const externalImports = Object.values(result.metafile.outputs)
    .flatMap(file => file.imports)
    .filter(imported => imported.external);
  if (externalImports.length > 0) {
    const imports = [...new Set(externalImports.map(item => item.path))].toSorted().join(", ");
    throw new Error(`Authored widget compile refused: unresolved external imports: ${imports}`);
  }

  const clientJs = output.text;
  const artifactBytes = Buffer.byteLength(clientJs, "utf8");
  return Object.freeze({
    clientJs,
    artifactHash: sha256(Buffer.from(clientJs)),
    sourceHash,
    dependencyLockHash,
    dependencyLockBytes: dependencyLock.byteLength,
    buildInputHash,
    artifactBytes,
    dataUrlEncodedBytes: Buffer.byteLength(encodeURIComponent(clientJs), "utf8"),
    buildDurationMs: Math.max(0, performance.now() - startedAt),
    dependencyVersions: AUTHORED_WIDGET_DEPENDENCY_VERSIONS,
    compiler,
  });
}

function validateSources(authoredFiles: Readonly<Record<string, string>>): Map<string, string> {
  if (authoredFiles === null || typeof authoredFiles !== "object" || Array.isArray(authoredFiles)) {
    throw new Error("Authored widget refused: source must be a file map.");
  }
  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const [path, source] of Object.entries(authoredFiles)) {
    if (path === "package.json" || path.endsWith("/package.json")) {
      throw new Error("Authored widget refused: authored package.json files are not accepted.");
    }
    if (path !== posix.normalize(path) || path.startsWith("/") || path.includes("\\") ||
        path.split("/").some(part => part === ".." || part === "." || part === "")) {
      throw new Error(`Authored widget refused: unsafe source path ${JSON.stringify(path)}.`);
    }
    if (!path.endsWith(".tsx") && !path.endsWith(".css")) {
      throw new Error(`Authored widget refused: unsupported source file ${JSON.stringify(path)}.`);
    }
    if (typeof source !== "string") {
      throw new Error(`Authored widget refused: ${JSON.stringify(path)} must be UTF-8 text.`);
    }
    totalBytes += Buffer.byteLength(source, "utf8");
    if (totalBytes > maximumSourceBytes) {
      throw new Error(`Authored widget refused: source exceeds ${maximumSourceBytes} bytes.`);
    }
    files.set(path, source);
  }
  if (!files.has("client.tsx")) {
    throw new Error("Authored widget refused: client.tsx is required.");
  }
  for (const [path, source] of files) {
    if (path.endsWith(".css")) continue;
    validateModule(path, source, files);
  }
  if (!hasDefaultExport(files.get("client.tsx")!)) {
    throw new Error("Authored widget refused: client.tsx must have a default React component export.");
  }
  return files;
}

function validateModule(path: string, source: string, files: Map<string, string>): void {
  const scan = scanModule(path, source);
  if (scan.dynamic) {
    throw new Error(`Authored widget refused: ${path} contains a non-literal ${scan.dynamic}().`);
  }
  if (scan.rebindsRequire) {
    throw new Error(`Authored widget refused: ${path} binds require, which is unsupported.`);
  }
  for (const specifier of scan.specifiers) {
    if (specifier.startsWith("node:") || /^[a-z][a-z\d+.-]*:/iu.test(specifier)) {
      throw new Error(`Authored widget refused: ${path} imports forbidden module ${JSON.stringify(specifier)}.`);
    }
    if (specifier.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!files.has(target)) {
        throw new Error(`Authored widget refused: ${path} imports missing source ${JSON.stringify(specifier)}.`);
      }
      continue;
    }
    if (!allowedImports.has(specifier)) {
      throw new Error(`Authored widget refused: ${path} imports unapproved package ${JSON.stringify(specifier)}.`);
    }
  }

  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0]!;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    throw new Error(`Authored widget refused: ${path} has unsupported syntax: ${message}`);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`Authored widget refused: ${path} uses import(), which is unsupported.`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        (node.expression.text === "require" || node.expression.text === "eval")) {
      throw new Error(`Authored widget refused: ${path} calls ${node.expression.text}(), which is unsupported.`);
    }
    if (ts.isPropertyAccessExpression(node) && deniedGlobals.has(node.name.text)) {
      throw new Error(`Authored widget refused: ${path} accesses denied capability ${node.name.text}.`);
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) && deniedGlobals.has(node.argumentExpression.text)) {
      throw new Error(`Authored widget refused: ${path} accesses denied capability ${node.argumentExpression.text}.`);
    }
    if (ts.isIdentifier(node) && deniedGlobals.has(node.text) && !isPropertyName(node)) {
      throw new Error(`Authored widget refused: ${path} references denied capability ${node.text}.`);
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`Authored widget refused: ${path} uses import.meta, which is unsupported.`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

function isPropertyName(node: ts.Identifier): boolean {
  return (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
      (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
      (ts.isMethodDeclaration(node.parent) && node.parent.name === node);
}

function hasDefaultExport(source: string): boolean {
  const file = ts.createSourceFile("client.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return file.statements.some(statement =>
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isVariableStatement(statement) || ts.isExportAssignment(statement)) &&
    (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier =>
      modifier.kind === ts.SyntaxKind.DefaultKeyword) || ts.isExportAssignment(statement)) ||
    ts.isExportDeclaration(statement) && statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some(element =>
        element.name.text === "default"),
  );
}

function authoredSourcesPlugin(files: Map<string, string>) {
  return {
    name: "authored-widget-sources",
    setup(buildApi: import("esbuild").PluginBuild) {
      buildApi.onResolve({ filter: /.*/ }, args => {
        if (args.kind === "entry-point") return { path: args.path, namespace: "widget" };
        if (args.namespace !== "widget") return undefined;
        if (!args.path.startsWith(".")) return undefined;
        const importer = args.importer || "client.tsx";
        const target = posix.normalize(posix.join(posix.dirname(importer), args.path));
        if (target.startsWith("../") || target === ".." || target.startsWith("/")) {
          return { errors: [{ text: `Source import ${JSON.stringify(args.path)} leaves the source tree.` }] };
        }
        if (target.endsWith(".css") && files.has(target)) {
          return { path: target, namespace: "widget-css" };
        }
        if (files.has(target)) return { path: target, namespace: "widget" };
        return { errors: [{ text: `Source import ${JSON.stringify(args.path)} is not an input file.` }] };
      });

      buildApi.onLoad({ filter: /.*/, namespace: "widget" }, args => {
        if (args.path === "__gadget_entry__.tsx") {
          return {
            contents: `import Widget from "./client.tsx";\n` +
                `import { createElement } from "react";\n` +
                `import { createRoot } from "react-dom/client";\n` +
                `const root = document.createElement("div");\n` +
                `document.body.replaceChildren(root);\n` +
                `createRoot(root).render(createElement(Widget));\n`,
            loader: "tsx",
            resolveDir: packageRoot,
          };
        }
        const contents = files.get(args.path);
        if (contents === undefined) return { errors: [{ text: `Unknown source ${args.path}.` }] };
        return { contents, loader: "tsx", resolveDir: packageRoot };
      });

      buildApi.onLoad({ filter: /.*/, namespace: "widget-css" }, args => {
        const css = files.get(args.path);
        if (css === undefined) return { errors: [{ text: `Unknown stylesheet ${args.path}.` }] };
        return {
          contents: `const style = document.createElement("style");` +
              `style.textContent = ${JSON.stringify(css)};document.head.append(style);`,
          loader: "js",
          resolveDir: packageRoot,
        };
      });
    },
  };
}

function hashSourceFiles(files: Map<string, string>): string {
  const hash = createHash("sha256");
  for (const [path, source] of [...files].toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    hash.update(path).update("\0").update(source).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
