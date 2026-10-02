import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { parseEnv } from 'node:util';
import { startOpenAiCompanion } from './openai-companion.ts';

test('supervisor authenticates Bun readiness and restores the protected Wrangler secret file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inferos-supervisor-'));
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const previousDirectory = process.env.INFEROS_CONFIG_DIR;
  process.env.INFEROS_CONFIG_DIR = join(root, 'profile');
  await mkdir(join(root, 'packages/workshop-backend'), { recursive: true });
  await symlink(join(repo, 'assistant-plugins'), join(root, 'assistant-plugins'), 'dir');
  const varsPath = join(root, 'packages/workshop-backend/.dev.vars');
  const original = 'EXISTING_SETTING=test-value\n';
  await writeFile(varsPath, original, { mode: 0o600 });
  let running: Awaited<ReturnType<typeof startOpenAiCompanion>> | undefined;
  try {
    running = await startOpenAiCompanion(root, 'http://localhost:3000');
    assert.equal(new URL(running.url).hostname, '127.0.0.1');
    assert.equal((await fetch(running.url + '/health')).status, 401);
    const secretFile = await readFile(varsPath, 'utf8');
    const secret = parseEnv(secretFile).OPENAI_ASSISTANT_PLUGIN_SECRET;
    assert.ok(secret);
    assert.equal((await stat(varsPath)).mode & 0o777, 0o600);
    assert.equal((await fetch(running.url + '/health', { headers: { authorization: 'Bearer ' + secret } })).status, 200);
    const exited = once(running.child, 'exit');
    running.child.kill('SIGTERM');
    await exited;
    running.cleanup();
    assert.equal(await readFile(varsPath, 'utf8'), original);
    await assert.rejects(access(join(root, 'profile/companion.lock')));
  } finally {
    running?.child.kill();
    running?.cleanup();
    if (previousDirectory === undefined) delete process.env.INFEROS_CONFIG_DIR;
    else process.env.INFEROS_CONFIG_DIR = previousDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

test('startup failure leaves the developer secret file intact and releases its store lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inferos-supervisor-failure-'));
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const previousDirectory = process.env.INFEROS_CONFIG_DIR;
  process.env.INFEROS_CONFIG_DIR = join(root, 'profile');
  try {
    await mkdir(join(root, 'packages/workshop-backend'), { recursive: true });
    await symlink(join(repo, 'assistant-plugins'), join(root, 'assistant-plugins'), 'dir');
    const varsPath = join(root, 'packages/workshop-backend/.dev.vars');
    await writeFile(varsPath, 'KEEP=original\n', { mode: 0o600 });
    await assert.rejects(startOpenAiCompanion(root, 'http://localhost:3000/invalid-path'), /exited before/);
    assert.equal(await readFile(varsPath, 'utf8'), 'KEEP=original\n');
    await assert.rejects(access(join(root, 'profile/companion.lock')));
  } finally {
    if (previousDirectory === undefined) delete process.env.INFEROS_CONFIG_DIR;
    else process.env.INFEROS_CONFIG_DIR = previousDirectory;
    await rm(root, { recursive: true, force: true });
  }
});
