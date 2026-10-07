import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { GATEKEEPER_SECRET_VARS, splitGatekeeperSecrets, withoutLocalOverrides } from './gatekeeper-dev-secrets.ts';
import { dotenvQuoted, installDevVarsSecrets } from './local-secrets.ts';

// A synthetic value only: no real credential is ever used here.
const sentinel = () => `SENTINEL-not-a-real-token-${randomUUID()}`;

test('moves every credential out of the printed vars and keeps the rest', () => {
  const token = sentinel();
  const { vars, secrets } = splitGatekeeperSecrets({
    BASE_URL: 'http://localhost:8787/gatekeeper/x', INFEROPS_BASE_URL: 'http://localhost:8080',
    INFEROPS_API_TOKEN: token, MCP_PORTAL_TOKEN: token, CLIENT_ID: 'id', CLIENT_SECRET: token,
    INFEROPS_ENABLED: 'true', SKIPPED: undefined,
  });
  assert.deepEqual(Object.keys(secrets).toSorted(), [...GATEKEEPER_SECRET_VARS].toSorted());
  assert.ok(Object.values(secrets).every(value => value === token));
  assert.equal(JSON.stringify({ name: 'gatekeeper', vars }).includes(token), false);
  assert.deepEqual(vars, { BASE_URL: 'http://localhost:8787/gatekeeper/x', INFEROPS_BASE_URL: 'http://localhost:8080',
    CLIENT_ID: 'id', INFEROPS_ENABLED: 'true', SKIPPED: undefined });
});

// The dotenv parse Wrangler 4.138 bundles (wrangler-dist/cli.js), copied verbatim in behavior so
// the serializer is checked against the parser that actually reads `.dev.vars`.
const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
function wranglerParse(src: string): Record<string, string> {
  const obj: Record<string, string> = {};
  const lines = src.replace(/\r\n?/mg, '\n');
  let match: RegExpExecArray | null;
  LINE.lastIndex = 0;
  while ((match = LINE.exec(lines)) != null) {
    let value = (match[2] || '').trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2');
    if (maybeQuote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    obj[match[1]!] = value;
  }
  return obj;
}

test('serializes every value Wrangler can hold exactly as Wrangler reads it back', () => {
  const s = sentinel();
  const values = [
    s, `${s} # not a comment`, `${s} "double"`, `${s}\nsecond line`, `${s} back\\slash \\n not a newline`,
    `${s} it's`, `${s} it's\nmultiline \\ with backslash`, `${s} it's \`tick\``, `  ${s} padded  `, '',
  ];
  for (const value of values) {
    const text = `BEFORE=keep\nKEY=${dotenvQuoted('KEY', value)}\nAFTER=keep\n`;
    assert.deepEqual(wranglerParse(text), { BEFORE: 'keep', KEY: value, AFTER: 'keep' }, JSON.stringify(value));
  }
});

test('refuses, before writing anything, a value Wrangler would read back differently', async () => {
  const s = sentinel();
  for (const value of [`${s}\r`, `${s}\r\nCRLF`, `${s} it's \`tick\` and \\`, `${s} it's \`tick\` and "double"`]) {
    assert.throws(() => dotenvQuoted('KEY', value), /cannot be written/, JSON.stringify(value));
  }
  const dir = await mkdtemp(join(tmpdir(), 'inferos-gatekeeper-secrets-'));
  try {
    const path = join(dir, '.dev.vars');
    await writeFile(path, 'MINE=keep\n');
    assert.throws(() => installDevVarsSecrets(path, { CLIENT_SECRET: `${s}\r` }), /carriage return/);
    assert.equal(await readFile(path, 'utf8'), 'MINE=keep\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a key the gatekeeper\'s own .dev.vars already sets keeps the developer\'s value', () => {
  const shared = sentinel();
  const local = 'CLIENT_ID=local-id\nCLIENT_SECRET=local-secret\n';
  const generated = withoutLocalOverrides(local, { CLIENT_SECRET: shared, INFEROPS_API_TOKEN: shared });
  assert.deepEqual(generated, { INFEROPS_API_TOKEN: shared });
  // Written after the developer's lines, the remaining generated secret doesn't touch their pair.
  const text = local + Object.entries(generated).map(([key, value]) => `${key}=${dotenvQuoted(key, value)}`).join('\n');
  assert.deepEqual(wranglerParse(text), { CLIENT_ID: 'local-id', CLIENT_SECRET: 'local-secret', INFEROPS_API_TOKEN: shared });
  assert.deepEqual(withoutLocalOverrides(null, { CLIENT_SECRET: shared }), { CLIENT_SECRET: shared });
});

test('writes values needing quotes beside the config, keeping the developer\'s own settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inferos-gatekeeper-secrets-'));
  try {
    const path = join(dir, '.dev.vars');
    await writeFile(path, 'MINE=keep\n');
    const awkward = `${sentinel()} with "quotes" # and a hash\nand a newline`;
    const cleanup = installDevVarsSecrets(path, { INFEROPS_API_TOKEN: awkward });
    assert.equal(parseEnv(await readFile(path, 'utf8')).INFEROPS_API_TOKEN, awkward);
    await writeFile(path, (await readFile(path, 'utf8')) + 'ADDED_MEANWHILE=keep-too\n');
    cleanup();
    assert.equal(await readFile(path, 'utf8'), 'MINE=keep\nADDED_MEANWHILE=keep-too\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an interrupted server still removes the secrets it wrote', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inferos-gatekeeper-secrets-'));
  try {
    const path = join(dir, '.dev.vars');
    await writeFile(path, 'MINE=keep\n');
    const token = sentinel();
    // The same cleanup path run-dev-server.ts takes: SIGINT exits, and the exit handler cleans up.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { installDevVarsSecrets } from ${JSON.stringify(new URL('./local-secrets.ts', import.meta.url).href)};
      const cleanup = installDevVarsSecrets(${JSON.stringify(path)}, { INFEROPS_API_TOKEN: ${JSON.stringify(token)} });
      process.on('exit', cleanup);
      process.on('SIGINT', () => process.exit(130));
      console.log('ready');
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
    assert.ok((await readFile(path, 'utf8')).includes(token));
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    child.kill('SIGINT');
    assert.equal(await exited, 130);
    assert.equal(await readFile(path, 'utf8'), 'MINE=keep\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
