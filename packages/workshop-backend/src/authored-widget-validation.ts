import { Parser } from "acorn";
import { transform } from "esbuild-wasm/esm/browser.js";
import { isValidAuthoredWidgetSourcePath } from "./authored-widget-path.js";
export { maximumSourcePathBytes } from "./authored-widget-path.js";

const maximumSourceBytes = 1024 * 1024;
const maximumSourceFileBytes = 256 * 1024;
const maximumSourceFiles = 100;
const deniedGlobals = new Set([
  "Bun", "Deno", "EventSource", "Function", "global", "globalThis", "localStorage", "navigator",
  "self", "sessionStorage", "WebSocket", "window", "XMLHttpRequest", "fetch", "process",
]);
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
/** Applies path, size and CSS resource limits before invoking the compiler. */
export function validateAuthoredWidgetSources(input: Readonly<Record<string, string>>): Map<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected source map.");
  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const [path, source] of Object.entries(input)) {
    if (!isValidAuthoredWidgetSourcePath(path)) throw new Error("Invalid source path.");
    if (typeof source !== "string") throw new Error("Expected UTF-8 source text.");
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > maximumSourceFileBytes || files.size >= maximumSourceFiles ||
        (totalBytes += bytes) > maximumSourceBytes) throw new Error("Source size limit exceeded.");
    if (path.endsWith(".css") &&
        /@import\b|\burl\s*\(|(?:-webkit-)?image-set\s*\(|\bimage\s*\(/iu.test(source)) {
      throw new Error("External CSS resources are not allowed.");
    }
    files.set(path, source);
  }
  if (!files.has("client.tsx")) throw new Error("Missing client.tsx.");
  return files;
}

/** Parse each TSX source with the existing Worker-safe compiler and apply source refusals. */
export async function validateAuthoredWidgetCode(files: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, source] of files) {
    if (path.endsWith(".css")) continue;
    let javascript: string;
    try {
      ({ code: javascript } = await transform(source, {
        loader: "tsx",
        target: "es2022",
        tsconfigRaw: {},
      }));
    } catch {
      throw new Error("Invalid TypeScript syntax.");
    }
    let ast: Node;
    try {
      ast = Parser.parse(javascript, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Node;
    } catch {
      throw new Error("Invalid TypeScript syntax.");
    }
    validateParsedModule(ast);
    if (path === "client.tsx" && !hasDefaultExport(ast)) {
      throw new Error("Missing default component export.");
    }
  }
}

type Node = { type: string; [key: string]: unknown };
function validateParsedModule(root: Node): void {
  const stack: Array<{ node: Node; parent?: Node }> = [{ node: root }];
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    if (node.type === "ImportExpression") throw new Error("Dynamic import refused.");
    if (node.type === "MetaProperty" && (node.meta as Node | undefined)?.name === "import") {
      throw new Error("import.meta refused.");
    }
    if (node.type === "CallExpression" && (node.callee as Node | undefined)?.type === "Identifier" &&
        ["eval", "require"].includes(String((node.callee as Node).name))) {
      throw new Error("Dynamic code loading refused.");
    }
    if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") {
      const source = node.source as Node | null | undefined;
      if (source && typeof source.value === "string") validateSpecifier(source.value);
    }
    if (node.type === "MemberExpression") {
      const object = node.object as Node | undefined;
      const property = node.property as Node | undefined;
      if (property && (!node.computed || property.type === "Literal") &&
          deniedGlobals.has(String(property.name ?? property.value))) {
        throw new Error("Denied global.");
      }
      if (object?.type === "Identifier" && object.name === "document" && node.computed &&
          property?.type !== "Literal") {
        throw new Error("Denied global.");
      }
      if (object?.type === "Identifier" && object.name === "document" &&
          (property?.name === "defaultView" || property?.value === "defaultView")) {
        throw new Error("Denied global.");
      }
    }
    if (node.type === "Identifier" && deniedGlobals.has(String(node.name)) && !isPropertyKey(node, parent)) {
      throw new Error("Denied global.");
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) stack.push({ node: child, parent: node });
      } else if (isNode(value)) stack.push({ node: value, parent: node });
    }
  }
}

function validateSpecifier(specifier: string): void {
  if (specifier.startsWith("node:") || /^[a-z][a-z\d+.-]*:/iu.test(specifier)) {
    throw new Error("Unapproved package import.");
  }
  if (!specifier.startsWith(".") && !allowedAuthoredWidgetImports.has(specifier)) {
    throw new Error("Unapproved package import.");
  }
}

function isPropertyKey(node: Node, parent?: Node): boolean {
  if (parent?.type === "MemberExpression") return parent.property === node && !parent.computed;
  if (parent?.type === "Property") return parent.key === node && !parent.computed && parent.shorthand !== true;
  return parent?.type === "MethodDefinition" && parent.key === node && !parent.computed;
}

function hasDefaultExport(root: Node): boolean {
  const body = root.body as Node[];
  return body.some(statement => statement.type === "ExportDefaultDeclaration" ||
    (statement.type === "ExportNamedDeclaration" &&
      (statement.specifiers as Node[] | undefined)?.some(specifier => {
        const exported = specifier.exported as Node | undefined;
        return (exported?.name ?? exported?.value) === "default";
      })));
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === "object" && typeof (value as Node).type === "string";
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
