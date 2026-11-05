const maxBytes = 1024 * 1024;
const maxFileBytes = 256 * 1024;
const maxFiles = 100;
const maxSourcePathBytes = 512;
const allowedImports = new Set([
  "@refinedev/core", "@tanstack/react-query", "react", "react-dom/client", "react/jsx-runtime",
]);

/** A small parent-side guard; the build DO repeats full AST validation before compiling. */
export function validateAuthoredWidgetPreflight(input: Readonly<Record<string, string>>): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected source map.");
  const entries = Object.entries(input);
  if (entries.length > maxFiles) throw new Error("Source size limit exceeded.");
  let totalBytes = 0;
  for (const [path, source] of entries) {
    if (new TextEncoder().encode(path).byteLength > maxSourcePathBytes ||
        (!path.endsWith(".tsx") && !path.endsWith(".css")) || path.startsWith("/") ||
        path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("Invalid source path.");
    }
    if (typeof source !== "string") throw new Error("Expected UTF-8 source text.");
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > maxFileBytes || (totalBytes += bytes) > maxBytes) {
      throw new Error("Source size limit exceeded.");
    }
    if (path.endsWith(".tsx")) validateImportSpecifiers(source);
  }
  if (!Object.hasOwn(input, "client.tsx")) throw new Error("Missing client.tsx.");
}

function validateImportSpecifiers(source: string): void {
  // This scanner is intentionally conservative: it is a fast gate, not a TS parser. The isolated
  // build DO remains authoritative and performs AST-based import validation before compilation.
  const imports = /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{},\s]+?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(imports)) {
    const specifier = match[1] ?? match[2];
    if (specifier.startsWith(".") || allowedImports.has(specifier)) continue;
    throw new Error("Import is not approved.");
  }
}
