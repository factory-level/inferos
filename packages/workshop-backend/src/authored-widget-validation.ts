import ts from "typescript6";

const maximumSourceBytes = 1024 * 1024;
const maximumSourceFileBytes = 256 * 1024;
const maximumSourceFiles = 100;
/** Keep authored paths comfortably below GitStore and object-store key limits. */
export const maximumSourcePathBytes = 512;
/** Package imports available to authored widgets in the reviewed build closure. */
export const allowedAuthoredWidgetImports = new Set([
  "@refinedev/core", "@tanstack/react-query", "react", "react-dom/client", "react/jsx-runtime",
]);

/** Rejects a compile operation when its isolated-worker budget expires. */
export async function withBuildDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("compile timeout")), deadlineMs); }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
const deniedGlobals = new Set([
  "Bun", "Deno", "EventSource", "Function", "global", "globalThis", "localStorage", "navigator",
  "self", "sessionStorage", "WebSocket", "window", "XMLHttpRequest", "fetch", "process",
]);

/** Applies source, dependency, path and size limits before invoking the compiler. */
export function validateAuthoredWidgetSources(input: Readonly<Record<string, string>>): Map<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected source map.");
  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const [path, source] of Object.entries(input)) {
    if (new TextEncoder().encode(path).byteLength > maximumSourcePathBytes || [...path].some(character => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    }) || path.startsWith("/") || path.includes("\\") ||
        path.split("/").some(part => part === "" || part === "." || part === "..") ||
        path === "package.json" || path.endsWith("/package.json") ||
        (!path.endsWith(".tsx") && !path.endsWith(".css"))) throw new Error("Invalid source path.");
    if (typeof source !== "string") throw new Error("Expected UTF-8 source text.");
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > maximumSourceFileBytes || files.size >= maximumSourceFiles ||
        (totalBytes += bytes) > maximumSourceBytes) throw new Error("Source size limit exceeded.");
    files.set(path, source);
  }
  if (!files.has("client.tsx")) throw new Error("Missing client.tsx.");
  for (const [path, source] of files) {
    if (path.endsWith(".css")) {
      if (/@import\b|\burl\s*\(|(?:-webkit-)?image-set\s*\(|\bimage\s*\(/iu.test(source)) {
        throw new Error("External CSS resources are not allowed.");
      }
    } else validateModule(path, source, files);
  }
  const entry = ts.createSourceFile("client.tsx", files.get("client.tsx")!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (!entry.statements.some(statement => ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ||
      ts.isExportAssignment(statement))) throw new Error("client.tsx needs a default component export.");
  return files;
}

function validateModule(path: string, source: string, files: Map<string, string>): void {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error("Invalid TypeScript syntax.");
  const visit = (node: ts.Node): void => {
    let specifier: string | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)) specifier = node.argument.literal.text;
    if (specifier !== undefined) {
      if (specifier.startsWith("node:") || /^[a-z][a-z\d+.-]*:/iu.test(specifier)) throw new Error("Forbidden import.");
      if (specifier.startsWith(".")) {
        const target = resolveSourcePath(path, specifier, files);
        if (!target) throw new Error("Source import leaves the source tree.");
        if (!files.has(target)) throw new Error("Missing source import.");
      } else if (!allowedAuthoredWidgetImports.has(specifier)) throw new Error("Unapproved package import.");
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error("Dynamic import refused.");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ["require", "eval"].includes(node.expression.text)) throw new Error("Dynamic code loading refused.");
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) throw new Error("import.meta refused.");
    if (ts.isPropertyAccessExpression(node) && deniedGlobals.has(node.name.text)) throw new Error("Denied global.");
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) &&
        deniedGlobals.has(node.argumentExpression.text)) throw new Error("Denied global.");
    if (ts.isIdentifier(node) && deniedGlobals.has(node.text) && !isPropertyName(node)) throw new Error("Denied global.");
    ts.forEachChild(node, visit);
  };
  visit(file);
}

function isPropertyName(node: ts.Identifier): boolean {
  return (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
    (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
    (ts.isMethodDeclaration(node.parent) && node.parent.name === node);
}

/** Resolve a relative authored source import without allowing it to leave the source tree. */
export function resolveSourcePath(importer: string, specifier: string,
    files?: ReadonlyMap<string, string>): string | undefined {
  const parts = [...importer.split("/").slice(0, -1), ...specifier.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return undefined;
      normalized.pop();
    }
    else normalized.push(part);
  }
  const target = normalized.join("/");
  if (!files) return target;
  for (const candidate of [target, `${target}.tsx`, `${target}.css`, `${target}/index.tsx`]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}
