// Node-only compiler for future authored React/Refine widgets. This module does not execute
// widget code, read environment variables, install packages, or write an artifact to storage.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { context as createBuildContext, transform, version as esbuildVersion } from "esbuild";
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
const maximumSourceFileBytes = 256 * 1024;
const maximumSourceFiles = 100;
const compileTimeoutMs = 10_000;
const compilerConfigVersion = 2;
const entryShim = `import Widget from "./client.tsx";\n` +
    `import { createElement } from "react";\n` +
    `import { createRoot } from "react-dom/client";\n` +
    `const root = document.createElement("div");\n` +
    `document.body.replaceChildren(root);\n` +
    `createRoot(root).render(createElement(Widget));\n`;
const cssWrapper = (css: string) =>
  `const style = document.createElement("style");` +
  `style.textContent = ${JSON.stringify(css)};document.head.append(style);`;
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
  const sources = await validateSources(authoredFiles);
  return compileValidatedWidget(sources, startedAt);
}

async function compileValidatedWidget(sources: Map<string, string>, startedAt: number): Promise<AuthoredWidgetArtifact> {
  const sourceHash = hashSourceFiles(sources);
  const dependencyLock = await readFile(lockfilePath, "utf8");
  const dependencyLockHash = hashAllowedLockEntries(dependencyLock);
  const compiler = { esbuild: esbuildVersion, node: process.versions.node };
  const buildInputHash = sha256(JSON.stringify({
    compilerConfigVersion,
    esbuildOptions: {
      bundle: true,
      format: "esm",
      jsx: "automatic",
      legalComments: "none",
      minify: true,
      platform: "browser",
      sourcemap: false,
      target: "es2022",
    },
    entryShim,
    cssWrapper: cssWrapper.toString(),
    sourceHash,
    dependencyLockHash,
    dependencyVersions: AUTHORED_WIDGET_DEPENDENCY_VERSIONS,
    compiler,
  }));

  let result;
  let buildContext: Awaited<ReturnType<typeof createBuildContext>> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    buildContext = await createBuildContext({
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
    result = await Promise.race([
      buildContext.rebuild(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void buildContext?.cancel();
          reject(new Error(`Authored widget compile refused: build exceeded ${compileTimeoutMs}ms.`));
        }, compileTimeoutMs);
      }),
    ]);
  } catch (error) {
    throw new Error(`Authored widget compile refused: ${errorMessage(error)}`, { cause: error });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await buildContext?.dispose();
  }

  const outputFiles = result.outputFiles;
  const metafile = result.metafile;
  if (!outputFiles || !metafile) {
    throw new Error("Authored widget compile failed: esbuild did not return in-memory output and metadata.");
  }
  const output = outputFiles[0];
  if (!output) throw new Error("Authored widget compile failed: no client JavaScript was emitted.");
  const externalImports = Object.values(metafile.outputs)
    .flatMap(file => file.imports)
    .filter(imported => imported.external);
  if (externalImports.length > 0) {
    const imports = [...new Set(externalImports.map(item => item.path))].toSorted().join(", ");
    throw new Error(`Authored widget compile refused: unresolved external imports: ${imports}`);
  }

  const clientJs = output.text;
  const unresolvedRequire = /(?:^|[^\w$.])__require\b|(?<![\w$.])require\s*\(/u.exec(clientJs);
  if (unresolvedRequire) {
    throw new Error(`Authored widget compile refused: output contains an unresolved CommonJS loader near ${
      JSON.stringify(clientJs.slice(Math.max(0, unresolvedRequire.index - 30), unresolvedRequire.index + 60))}.`);
  }
  const artifactBytes = Buffer.byteLength(clientJs, "utf8");
  return Object.freeze({
    clientJs,
    artifactHash: sha256(Buffer.from(clientJs)),
    sourceHash,
    dependencyLockHash,
    dependencyLockBytes: Buffer.byteLength(dependencyLock, "utf8"),
    buildInputHash,
    artifactBytes,
    dataUrlEncodedBytes: Buffer.byteLength(encodeURIComponent(clientJs), "utf8"),
    buildDurationMs: Math.max(0, performance.now() - startedAt),
    dependencyVersions: AUTHORED_WIDGET_DEPENDENCY_VERSIONS,
    compiler,
  });
}

async function validateSources(authoredFiles: Readonly<Record<string, string>>): Promise<Map<string, string>> {
  if (authoredFiles === null || typeof authoredFiles !== "object" || Array.isArray(authoredFiles)) {
    throw new Error("Authored widget refused: source must be a file map.");
  }
  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const [path, source] of Object.entries(authoredFiles)) {
    // eslint-disable-next-line no-control-regex -- paths must reject literal control bytes.
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(path)) {
      throw new Error("Authored widget refused: source paths cannot contain control characters.");
    }
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
    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (sourceBytes > maximumSourceFileBytes) {
      throw new Error(`Authored widget refused: ${JSON.stringify(path)} exceeds ${maximumSourceFileBytes} bytes.`);
    }
    if (files.size >= maximumSourceFiles) {
      throw new Error(`Authored widget refused: source exceeds ${maximumSourceFiles} files.`);
    }
    totalBytes += sourceBytes;
    if (totalBytes > maximumSourceBytes) {
      throw new Error(`Authored widget refused: source exceeds ${maximumSourceBytes} bytes.`);
    }
    files.set(path, source);
  }
  if (!files.has("client.tsx")) {
    throw new Error("Authored widget refused: client.tsx is required.");
  }
  for (const [path, source] of files) {
    if (path.endsWith(".css")) {
      await validateStylesheet(path, source);
      continue;
    }
    validateModule(path, source, files);
  }
  if (!hasDefaultExport(files.get("client.tsx")!)) {
    throw new Error("Authored widget refused: client.tsx must have a default React component export.");
  }
  return files;
}

async function validateStylesheet(path: string, source: string): Promise<void> {
  let normalized: string;
  try {
    ({ code: normalized } = await transform(source, { loader: "css", minify: true, legalComments: "none" }));
  } catch (error) {
    throw new Error(`Authored widget refused: ${path} has invalid CSS: ${errorMessage(error)}`, { cause: error });
  }
  if (/@import\b|\burl\s*\(|(?:-webkit-)?image-set\s*\(|\bimage\s*\(/iu.test(normalized)) {
    throw new Error(`Authored widget refused: ${path} contains a CSS network or external asset reference.`);
  }
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
        if (args.path === "@refinedev/core") {
          return { path: fileURLToPath(import.meta.resolve("@refinedev/core")), namespace: "refine-core" };
        }
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
            contents: entryShim,
            loader: "tsx",
            resolveDir: packageRoot,
          };
        }
        const contents = files.get(args.path);
        if (contents === undefined) return { errors: [{ text: `Unknown source ${args.path}.` }] };
        return { contents, loader: "tsx", resolveDir: packageRoot };
      });

      buildApi.onLoad({ filter: /.*/, namespace: "refine-core" }, async args => {
        const original = await readFile(args.path, "utf8");
        return {
          contents: stripRefineTelemetry(original),
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });

      buildApi.onLoad({ filter: /.*/, namespace: "widget-css" }, args => {
        const css = files.get(args.path);
        if (css === undefined) return { errors: [{ text: `Unknown stylesheet ${args.path}.` }] };
        return {
          contents: cssWrapper(css),
          loader: "js",
          resolveDir: packageRoot,
        };
      });
    },
  };
}

function stripRefineTelemetry(source: string): string {
  // @refinedev/core is exact-pinned. Fail closed if its bundled module shape changes.
  const telemetryStart = source.indexOf("// src/components/telemetry/index.tsx");
  const nextModuleStart = source.indexOf("// src/definitions/helpers/check-router-prop-misuse/index.ts", telemetryStart + 1);
  if (telemetryStart < 0 || nextModuleStart < 0) {
    throw new Error("Authored widget compile refused: pinned Refine telemetry module was not found.");
  }
  let stripped = source.slice(0, telemetryStart) + source.slice(nextModuleStart);
  const telemetryMount = "!disableTelemetryWithDefault && /* @__PURE__ */ React41.createElement(Telemetry, null)";
  if (!stripped.includes(telemetryMount)) {
    throw new Error("Authored widget compile refused: pinned Refine telemetry mount was not found.");
  }
  stripped = stripped.replace(telemetryMount, "false");
  if (/telemetry\.refine\.dev|useTelemetryData|\bTelemetry\b/u.test(stripped)) {
    throw new Error("Authored widget compile refused: Refine telemetry code remains after stripping.");
  }
  return stripped;
}

function hashSourceFiles(files: Map<string, string>): string {
  return sha256(JSON.stringify([...files].toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )));
}

export function hashAllowedLockEntries(lockfile: string): string {
  const sections = lockfile.split(/^snapshots:\s*$/mu);
  const [, packageSection] = sections[0]?.split(/^packages:\s*$/mu) ?? [];
  const snapshotSection = sections[1];
  if (!packageSection || !snapshotSection) throw new Error("Authored widget compile refused: pnpm lockfile has no package/snapshot sections.");
  const selectedPackages = new Map(lockSectionBlocks(packageSection));
  const selectedSnapshots = new Map(lockSectionBlocks(snapshotSection));
  const roots = Object.entries(AUTHORED_WIDGET_DEPENDENCY_VERSIONS).map(([name, version]) => {
    const packageId = `${name}@${version}`;
    if (!selectedPackages.has(packageId)) throw new Error(`Authored widget compile refused: ${packageId} is not pinned in the lockfile.`);
    const snapshots = [...selectedSnapshots.keys()].filter(key => key === packageId || key.startsWith(`${packageId}(`));
    if (snapshots.length === 0) throw new Error(`Authored widget compile refused: ${packageId} has no lockfile snapshot.`);
    return snapshots;
  });
  const closure = new Set<string>();
  const visit = (name: string): void => {
    if (closure.has(name)) return;
    closure.add(name);
    const snapshot = selectedSnapshots.get(name);
    const peerSuffix = name.indexOf("(");
    const pkgName = peerSuffix < 0 ? name : name.slice(0, peerSuffix);
    const pkg = selectedPackages.get(pkgName);
    if (!snapshot || !pkg) throw new Error(`Authored widget compile refused: locked dependency ${name} has no package/snapshot entry.`);
    for (const dependency of snapshotDependencies(snapshot)) {
      visit(`${dependency.name}@${dependency.version}`);
    }
  };
  for (const rootGroup of roots) for (const root of rootGroup) visit(root);
  return sha256([...closure].sort().map(name => {
    const packageId = name.slice(0, name.indexOf("(") < 0 ? name.length : name.indexOf("("));
    return `${name}\n${selectedPackages.get(packageId)}\n${selectedSnapshots.get(name)}`;
  }).join("\n"));
}

function lockSectionBlocks(section: string): [string, string][] {
  const blocks: [string, string][] = [];
  let currentName: string | undefined;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentName !== undefined) blocks.push([currentName, currentLines.join("\n")]);
  };
  for (const line of section.split("\n")) {
    const entry = line.match(/^  ('(?:[^']|'')+'|"(?:[^"]|"")+"|[^\s:#][^:]*):(?:[ \t]*\{\})?[ \t]*$/u);
    if (entry) {
      flush();
      currentName = unquoteLockKey(entry[1]!);
      currentLines = [line];
    } else if (currentName !== undefined) {
      currentLines.push(line);
    }
  }
  flush();
  return blocks;
}

function snapshotDependencies(snapshot: string): { name: string; version: string }[] {
  const dependencies: { name: string; version: string }[] = [];
  const lines = snapshot.split("\n");
  for (let index = 1; index < lines.length; index++) {
    if (!/^    (?:dependencies|optionalDependencies):[ \t]*$/u.test(lines[index]!)) continue;
    for (index++; index < lines.length && /^      \S/u.test(lines[index]!); index++) {
      const entry = lines[index]!.match(/^      ('(?:[^']|'')+'|"(?:[^"]|"")+"|[^:]+):[ \t]*(\S.*)$/u);
      if (entry) dependencies.push({ name: unquoteLockKey(entry[1]!), version: entry[2]! });
    }
    index--;
  }
  return dependencies;
}

function unquoteLockKey(key: string): string {
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1).replaceAll("''", "'");
  if (key.startsWith('"') && key.endsWith('"')) return key.slice(1, -1).replaceAll('""', '"');
  return key;
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
