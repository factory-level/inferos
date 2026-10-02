import { chmodSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Append local runtime secrets to Wrangler's protected file and remove only this addition on exit. */
export function installLocalSecrets(root: string, values: Record<string, string>): () => void {
  const path = join(root, 'packages/workshop-backend/.dev.vars');
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
  const addition = '\n' + Object.entries(values).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n';
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
