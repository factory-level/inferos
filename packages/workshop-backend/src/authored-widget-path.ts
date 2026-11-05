/** Maximum UTF-8 bytes in an authored source path, with room below object-store key limits. */
export const maximumSourcePathBytes = 512;
// oxlint-disable-next-line no-control-regex -- paths must reject literal control characters.
const unsafePathCharacters = /[\u0000-\u001f\u007f-\u009f\u2044\u2024\u2215\uff0f]|\p{Cf}/u;

// The structural part of the path rule: bounded, no controls or ambiguous separators, relative,
// forward slashes only, no empty, `.` or `..` segments, and no trailing dot or space.
function isSafePath(path: string): boolean {
  return new TextEncoder().encode(path).byteLength <= maximumSourcePathBytes &&
    !unsafePathCharacters.test(path) && !path.includes("..") &&
    !path.startsWith("/") && !/^[a-z]:/iu.test(path) && !path.includes("\\") &&
    !path.split("/").some(part => part === "" || part === ".") &&
    !path.endsWith(".") && !path.endsWith(" ");
}

/** Shared path policy for the publication preflight and the isolated build validator. */
export function isValidAuthoredWidgetSourcePath(path: string): boolean {
  return isSafePath(path) && (path.endsWith(".tsx") || path.endsWith(".css"));
}

/**
 * The path policy for every file of a commit publication compiles, applied before any file is
 * chosen as a source: the same structural rule, and any companion file type. Safe auxiliary files,
 * including package manifests and files without an extension, are retained unchanged but never sent
 * to the compiler unless they end in `.tsx` or `.css`.
 */
export function isValidAuthoredWidgetCommitPath(path: string): boolean {
  return isSafePath(path);
}
