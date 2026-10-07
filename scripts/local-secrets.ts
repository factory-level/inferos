import { chmodSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Append local runtime secrets to Wrangler's protected file and remove only this addition on exit. */
export function installLocalSecrets(root: string, values: Record<string, string>): () => void {
  return installDevVarsSecrets(join(root, 'packages/workshop-backend/.dev.vars'), values);
}

/**
 * Append `values` to the `.dev.vars` file at `path`, which Wrangler loads as secrets for the worker
 * whose config sits beside it and lists as hidden. An existing file is kept and protected (0600); a
 * symlink or other non-regular file is refused. The returned cleanup removes only this addition, so
 * edits made meanwhile survive, and deletes the file only if this call created it and nothing else
 * was added since.
 */
export function installDevVarsSecrets(path: string, values: Record<string, string>): () => void {
  let original: string | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing to write secrets to a non-regular file.');
    original = readFileSync(path, 'utf8');
    // Protect an existing file before writing a secret into it.
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const addition = '\n' + Object.entries(values).map(([key, value]) => key + '=' + dotenvQuoted(key, value)).join('\n') + '\n';
  writeFileSync(path, (original ?? '') + addition, { mode: 0o600 });
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    try {
      const current = readFileSync(path, 'utf8');
      if (current === addition && original === undefined) unlinkSync(path);
      else writeFileSync(path, current.replace(addition, ''), { mode: 0o600 });
    } catch { /* The developer may have removed the temporary secrets file. */ }
  };
}

// A dotenv value Wrangler reads back exactly: the first quote the value doesn't contain. Single
// quotes keep `#` and `"` literally; backticks also allow newlines; JSON is the last resort, for a
// single-line value with both other quotes. A value no quote can hold is refused, not mangled.
function dotenvQuoted(key: string, value: string): string {
  if (!/['\r\n]/.test(value)) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  if (!/["\r\n]/.test(value)) return JSON.stringify(value);
  throw new Error(`${key} cannot be written to a .dev.vars file: it holds every kind of quote.`);
}
