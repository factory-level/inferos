import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { installLocalSecrets } from './local-secrets.ts';

test('protects existing files and preserves independent edits and other runtime secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inferos-local-secrets-'));
  try {
    await mkdir(join(root, 'packages/workshop-backend'), { recursive: true });
    const path = join(root, 'packages/workshop-backend/.dev.vars');
    await writeFile(path, 'ORIGINAL=keep\n', { mode: 0o644 });
    const cleanBridge = installLocalSecrets(root, { OPENAI_ASSISTANT_PLUGIN_SECRET: 'bridge' });
    const cleanKey = installLocalSecrets(root, { ANTHROPIC_API_KEY: 'key-with-#-character' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(parseEnv(await readFile(path, 'utf8')).ANTHROPIC_API_KEY, 'key-with-#-character');
    await writeFile(path, (await readFile(path, 'utf8')) + 'NEW_SETTING=keep-too\n');
    cleanBridge(); cleanBridge(); cleanKey();
    assert.equal(await readFile(path, 'utf8'), 'ORIGINAL=keep\nNEW_SETTING=keep-too\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('removes a newly created secrets file and refuses symlink destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inferos-local-secrets-'));
  try {
    await mkdir(join(root, 'packages/workshop-backend'), { recursive: true });
    const path = join(root, 'packages/workshop-backend/.dev.vars');
    const cleanup = installLocalSecrets(root, { KEY: 'temporary' });
    cleanup();
    await assert.rejects(access(path));
    const target = join(root, 'target');
    await writeFile(target, 'unchanged');
    await symlink(target, path);
    assert.throws(() => installLocalSecrets(root, { KEY: 'secret' }), /non-regular/);
    assert.equal(await readFile(target, 'utf8'), 'unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});
