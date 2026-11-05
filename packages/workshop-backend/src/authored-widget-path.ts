/** Maximum UTF-8 bytes in an authored source path, with room below object-store key limits. */
export const maximumSourcePathBytes = 512;
// oxlint-disable-next-line no-control-regex -- paths must reject literal control characters.
const unsafePathCharacters = /[\u0000-\u001f\u007f-\u009f\u2044\u2024\u2215\uff0f]|\p{Cf}/u;

// The structural part of the path rule: bounded, no controls or ambiguous separators, relative,
// forward slashes only, no empty, `.` or `..` segments, and never a package manifest.
function isSafePath(path: string): boolean {
  return new TextEncoder().encode(path).byteLength <= maximumSourcePathBytes &&
    !unsafePathCharacters.test(path) && !path.includes("..") &&
    !path.startsWith("/") && !/^[a-z]:/iu.test(path) && !path.includes("\\") &&
    !path.split("/").some(part => part === "" || part === ".") &&
    path !== "package.json" && !path.endsWith("/package.json");
}

/** Shared path policy for the publication preflight and the isolated build validator. */
export function isValidAuthoredWidgetSourcePath(path: string): boolean {
  return isSafePath(path) && (path.endsWith(".tsx") || path.endsWith(".css"));
}

/**
 * The path policy for every file of a commit publication compiles, applied before any file is
 * chosen as a source: the same structural rule, and an authored source (`.tsx`, `.css`) or a
 * companion the commit carries alongside it (`.js`, such as `server.js`, or `.json`, such as
 * `blueprint.json`, `states.json`, `tools.json` or `view.json`). A path that only resembles a source
 * (`a.tsx.`, `a.tsx `), a directory (`a/`), a package manifest, or any other kind of file is refused,
 * so nothing reaches the build by falling outside the source filter.
 */
export function isValidAuthoredWidgetCommitPath(path: string): boolean {
  return isSafePath(path) && /\.(?:tsx|css|js|json)$/u.test(path);
}
