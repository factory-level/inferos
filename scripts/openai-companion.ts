import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { installLocalSecrets } from './local-secrets.ts';

/** Start the optional Bun process and wait for its authenticated readiness check. */
export async function startOpenAiCompanion(root: string, workshopOrigin: string): Promise<{
  child: ChildProcess; url: string; cleanup: () => void;
}> {
  const secret = randomBytes(32).toString('hex');
  const child = spawn('bun', [join(root, 'assistant-plugins/openai/src/main.ts')], {
    cwd: root, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, OPENAI_ASSISTANT_PLUGIN_SECRET: secret, INFEROS_WORKSHOP_ORIGIN: workshopOrigin },
  });
  let url: string;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('ChatGPT companion startup timed out.')), 15_000);
      let buffer = '';
      const finish = (error?: Error, value?: number) => {
        clearTimeout(timeout);
        child.stdout?.off('data', data);
        child.off('error', failed);
        child.off('exit', exited);
        if (error) reject(error); else resolve(value!);
      };
      const failed = () => finish(new Error('ChatGPT plan usage requires Bun 1.3.11 or newer on PATH.'));
      const exited = () => finish(new Error('ChatGPT companion exited before becoming ready.'));
      const data = (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 4096) return finish(new Error('Invalid companion startup response.'));
        if (!buffer.includes('\n')) return;
        try {
          const message: unknown = JSON.parse(buffer.split('\n')[0]);
          const value = typeof message === 'object' && message !== null && 'port' in message ? message.port : null;
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error();
          finish(undefined, value);
        } catch { finish(new Error('Invalid companion startup response.')); }
      };
      child.stdout?.on('data', data);
      child.once('error', failed);
      child.once('exit', exited);
    });
    url = 'http://127.0.0.1:' + port;
    const health = await fetch(url + '/health', {
      headers: { Authorization: 'Bearer ' + secret }, signal: AbortSignal.timeout(5000),
    });
    if (!health.ok) throw new Error('ChatGPT companion readiness check failed.');
  } catch (error) { child.kill(); throw error; }

  // Wrangler marks .dev.vars values as secrets. Do not put the bridge credential in config.vars,
  // which Wrangler prints at startup. Preserve any pre-existing developer credentials verbatim.
  let cleanup: () => void;
  try {
    cleanup = installLocalSecrets(root, { OPENAI_ASSISTANT_PLUGIN_SECRET: secret });
  } catch (error) { child.kill(); throw error; }
  return { child, url, cleanup };
}
