/** Maximum UTF-8 bytes in an authored source path, with room below object-store key limits. */
export const maximumSourcePathBytes = 512;
const unsafePathCharacters = /[\u0000-\u001f\u007f-\u009f\u2044\u2024\u2215\uff0f]|\p{Cf}/u;

/** Shared path policy for the publication preflight and the isolated build validator. */
export function isValidAuthoredWidgetSourcePath(path: string): boolean {
  return new TextEncoder().encode(path).byteLength <= maximumSourcePathBytes &&
    !unsafePathCharacters.test(path) && !path.includes("..") &&
    !path.startsWith("/") && !/^[a-z]:/iu.test(path) && !path.includes("\\") &&
    !path.split("/").some(part => part === "" || part === ".") &&
    path !== "package.json" && !path.endsWith("/package.json") &&
    (path.endsWith(".tsx") || path.endsWith(".css"));
}
