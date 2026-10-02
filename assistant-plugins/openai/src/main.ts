import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialStore } from './credentialStore.ts';
import { OssDynamicRegistrationProvider } from './authProvider.ts';
import { OpenAiCompanion } from './companion.ts';

const directory = process.env.INFEROS_CONFIG_DIR ?? join(homedir(), '.config', 'inferos');
const store = new FileCredentialStore(directory);
const release = await store.initialize();
if (process.argv[2] === '--import') {
  try {
    if (!process.argv[3]) throw new Error('Pass the protected registration file to import.');
    await store.importRegistration(process.argv[3]);
    process.stdout.write('Registration imported; the VM host identity was preserved.\n');
  } finally { await release(); }
  process.exit(0);
}
let companion: OpenAiCompanion;
try {
  companion = new OpenAiCompanion(store, new OssDynamicRegistrationProvider(), {
    bridgeSecret: process.env.OPENAI_ASSISTANT_PLUGIN_SECRET ?? '',
    workshopOrigin: process.env.INFEROS_WORKSHOP_ORIGIN ?? 'http://localhost:8787',
  });
  const port = companion.start();
  // Machine-readable supervisor handshake: no tokens, account details, or authorization URLs.
  process.stdout.write(JSON.stringify({ port }) + '\n');
} catch (error) { await release(); throw error; }

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await companion.stop();
  await release();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
