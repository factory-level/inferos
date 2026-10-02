import { RpcTarget } from 'capnweb';
import { validateRpc } from 'capnweb-validate';
import { z } from 'zod';
import type { OpenAiAssistantPluginApi } from '@gadgets/workshop-shared/openai-plugin';
import { errorSchema, flowSchema, isOpenAiPluginEnabled, modelsSchema, stateSchema,
  type PluginCommand } from '@gadgets/assistant-plugin-openai/protocol';

/** Construct only a deployment-configured loopback request; callers cannot redirect credentials. */
export function openAiBridgeRequest(env: Cloudflare.Env, owner: string, path: '/command' | '/responses',
    init: RequestInit): Promise<Response> {
  if (!isOpenAiPluginEnabled(env)) throw new Error('ChatGPT plan usage is disabled on this deployment.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer ' + env.OPENAI_ASSISTANT_PLUGIN_SECRET);
  headers.set('x-inferos-user', owner);
  headers.set('Content-Type', 'application/json');
  return fetch(new URL(path, env.OPENAI_ASSISTANT_PLUGIN_URL), { ...init, headers, redirect: 'error' });
}

/** Validate management replies before returning them over the Workshop RPC boundary. */
export async function openAiCommand<T>(env: Cloudflare.Env, owner: string,
    command: PluginCommand, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await openAiBridgeRequest(env, owner, '/command', {
      method: 'POST', body: JSON.stringify(command), signal: AbortSignal.timeout(60_000),
    });
  } catch { throw new Error('The local ChatGPT companion is unavailable. Check the local server.'); }
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: errorSchema }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error.message : 'The ChatGPT connection failed.');
  }
  return schema.parse(body);
}

/** User-scoped capability. Every operation rechecks the deployment's runtime switch. */
@validateRpc()
export class OpenAiAssistantPluginApiImpl extends RpcTarget implements OpenAiAssistantPluginApi {
  constructor(private readonly env: Cloudflare.Env, private readonly owner: string) { super(); }
  getState() { return openAiCommand(this.env, this.owner, { operation: 'state' }, stateSchema); }
  startSignIn(accountId?: string, consent?: boolean) {
    return openAiCommand(this.env, this.owner, { operation: 'start', accountId, consent }, flowSchema);
  }
  async completeSignIn(ticket: string, nonce: string): Promise<void> {
    await openAiCommand(this.env, this.owner, { operation: 'complete', ticket, nonce }, z.null());
  }
  async selectAccount(accountId: string): Promise<void> {
    await openAiCommand(this.env, this.owner, { operation: 'select', accountId }, z.null());
  }
  listModels(accountId: string) {
    return openAiCommand(this.env, this.owner, { operation: 'models', accountId }, modelsSchema);
  }
  signOut(accountId: string) {
    return openAiCommand(this.env, this.owner, { operation: 'sign-out', accountId }, z.object({ revoked: z.boolean() }));
  }
  async setBackgroundUsage(accountId: string, allowed: boolean): Promise<void> {
    await openAiCommand(this.env, this.owner, { operation: 'background', accountId, allowed }, z.null());
  }
  async retryPlanUsage(accountId: string): Promise<void> {
    await openAiCommand(this.env, this.owner, { operation: 'retry', accountId }, z.null());
  }
  async acknowledgeWelcome(): Promise<void> {
    await openAiCommand(this.env, this.owner, { operation: 'welcome' }, z.null());
  }
}
