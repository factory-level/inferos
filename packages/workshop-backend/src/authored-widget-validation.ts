import { isValidAuthoredWidgetSourcePath } from "./authored-widget-path.js";
export { maximumSourcePathBytes } from "./authored-widget-path.js";

const maximumSourceBytes = 1024 * 1024;
const maximumSourceFileBytes = 256 * 1024;
const maximumSourceFiles = 100;
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
