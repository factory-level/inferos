import { z } from 'zod';

/** Stable error envelope exchanged with the local Worker; contains no provider credentials. */
export const errorSchema = z.object({
  status: z.number().int(), code: z.string(), message: z.string(),
  recovery: z.enum(['sign-in', 'consent', 'usage', 'retry', 'configuration', 'none']),
  requestId: z.string().optional(), param: z.string().optional(),
});

/** Validated account state shared by the companion and its Worker bridge. */
export const stateSchema = z.object({
  accounts: z.array(z.object({
    id: z.string(), label: z.string(), email: z.string().optional(),
    status: z.enum(['ready', 'signed-out', 'plan-disabled', 'usage-paused']),
    allowBackground: z.boolean(),
    error: errorSchema.optional(),
  })),
  activeAccountId: z.string().nullable(), error: errorSchema.optional(), needsWelcome: z.boolean(),
});

/** Current account-specific model catalog. */
export const modelsSchema = z.array(z.object({ slug: z.string(), displayName: z.string() }));

/** Browser handoff values, not OAuth tokens. */
export const flowSchema = z.object({ url: z.string().url(), nonce: z.string().regex(/^[0-9a-f]{64}$/) });

/** Allowed requests on the authenticated, loopback-only management endpoint. */
export const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('state') }),
  z.object({ operation: z.literal('start'), accountId: z.string().optional(), consent: z.boolean().optional() }),
  z.object({ operation: z.literal('complete'), ticket: z.string(), nonce: z.string() }),
  z.object({ operation: z.literal('select'), accountId: z.string() }),
  z.object({ operation: z.literal('models'), accountId: z.string() }),
  z.object({ operation: z.literal('sign-out'), accountId: z.string() }),
  z.object({ operation: z.literal('background'), accountId: z.string(), allowed: z.boolean() }),
  z.object({ operation: z.literal('retry'), accountId: z.string() }),
  z.object({ operation: z.literal('welcome') }),
]);

/** Command accepted by the companion's management endpoint. */
export type PluginCommand = z.infer<typeof commandSchema>;

/** Explicit, deployment-controlled capability; UI flags never authorize the bridge. */
export function isOpenAiPluginEnabled(env: {
  ENABLE_OPENAI_ASSISTANT_PLUGIN?: string;
  OPENAI_ASSISTANT_PLUGIN_URL?: string;
  OPENAI_ASSISTANT_PLUGIN_SECRET?: string;
}): boolean {
  if (env.ENABLE_OPENAI_ASSISTANT_PLUGIN !== 'true' || !env.OPENAI_ASSISTANT_PLUGIN_SECRET) return false;
  try {
    const url = new URL(env.OPENAI_ASSISTANT_PLUGIN_URL ?? '');
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}
