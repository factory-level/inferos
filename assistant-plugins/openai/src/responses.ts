import { z } from 'zod';
import type { OpenAiPlanModel } from '@gadgets/workshop-shared/openai-plugin';
import { RESOURCE } from './authProvider.ts';
import { fail, object, PlanError, providerError, safeError } from './errors.ts';
import type { TokenManager } from './tokenManager.ts';

import { validatePlanRequest } from './payload.ts';

const catalogSchema = z.object({ models: z.array(z.object({
  slug: z.string().min(1), display_name: z.string(), visibility: z.string(),
})) });

/** Token-owning Responses client. Only it contacts OpenAI for model catalogs and inference. */
export class PlanUsageResponsesClient {
  #catalogs = new Map<string, { models: OpenAiPlanModel[]; expiresAt: number }>();
  constructor(readonly tokens: TokenManager, private readonly report: (owner: string, id: string, error: PlanError) => void,
    private readonly request: typeof fetch = fetch,
    private readonly delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}

  invalidate(id: string): void { this.#catalogs.delete(id); }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(url, { ...init, redirect: 'error' });
        if (response.ok) return response;
        const body: unknown = await response.json().catch(() => null);
        const error = providerError(response.status, body, response.headers.get('x-request-id') ?? undefined);
        if (error.detail.recovery !== 'retry' || attempt >= 2) throw error;
      } catch (error) {
        if (init.signal?.aborted) throw error;
        if (error instanceof PlanError || attempt >= 2) throw safeError(error);
      }
      await this.delay(250 * 2 ** attempt);
      init.signal?.throwIfAborted();
    }
  }

  async models(owner: string, id: string, fresh = true): Promise<OpenAiPlanModel[]> {
    const token = await this.tokens.access(owner, id, false);
    const cached = this.#catalogs.get(id);
    if (!fresh && cached && cached.expiresAt > Date.now()) return cached.models;
    const response = await this.#fetch(RESOURCE + '/models', {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20_000),
    });
    const catalog = catalogSchema.safeParse(await response.json());
    if (!catalog.success) fail('invalid_model_catalog', 'OpenAI returned an invalid model catalog.', 'configuration');
    const models = catalog.data.models.filter(model => model.visibility === 'list')
      .map(model => ({ slug: model.slug, displayName: model.display_name }));
    this.#catalogs.set(id, { models, expiresAt: Date.now() + 60_000 });
    return models;
  }

  async stream(owner: string, id: string, value: unknown, background: boolean, signal: AbortSignal): Promise<Response> {
    const payload = validatePlanRequest(value);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const untrack = this.tokens.track(id, controller);
    const cleanup = () => { untrack(); signal.removeEventListener('abort', cancel); };
    try {
      await this.tokens.access(owner, id, background);
      const models = await this.models(owner, id, false);
      if (!models.some(model => model.slug === payload.model)) fail('model_unavailable', 'Choose a model available to the selected ChatGPT account.', 'configuration');
      const token = await this.tokens.access(owner, id, background);
      controller.signal.throwIfAborted();
      const response = await this.#fetch(RESOURCE + '/responses', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (!response.body) fail('missing_stream', 'OpenAI returned no response stream.', 'retry', 502);
      return new Response(this.#validatedStream(response.body, owner, id, requestId, controller, cleanup), {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
          ...(requestId && { 'x-request-id': requestId }) },
      });
    } catch (error) {
      cleanup();
      const safe = safeError(error);
      if (!controller.signal.aborted) await this.#record(owner, id, safe);
      throw safe;
    }
  }

  async #record(owner: string, id: string, error: PlanError): Promise<void> {
    this.report(owner, id, error);
    if (error.detail.recovery === 'usage') await this.tokens.mutate(owner, id, account => { account.paused = true; });
  }

  #validatedStream(body: ReadableStream<Uint8Array>, owner: string, id: string,
    requestId: string | undefined, controller: AbortController, cleanup: () => void): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let completed = false;
    let ended = false;
    return new ReadableStream({
      pull: async output => {
        try {
          while (!ended) {
            const boundary = /\r?\n\r?\n/.exec(buffer);
            if (boundary) {
              const frame = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary[0].length);
              const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart()).join('\n');
              if (!data || data === '[DONE]') continue;
              const event = object(JSON.parse(data));
              if (event.type === 'response.failed' || event.type === 'error') {
                throw providerError(200, event.type === 'error' ? { error: event } : object(event.response), requestId);
              }
              if (event.type === 'response.incomplete') {
                throw new PlanError({ status: 200, code: 'response_incomplete', recovery: 'none',
                  message: 'ChatGPT returned an incomplete response. No unfinished tools were executed.', requestId }, event);
              }
              if (event.type === 'response.completed') {
                if (object(event.response).status !== 'completed') fail('invalid_completion', 'ChatGPT did not complete this response.', 'none', 502);
                completed = true;
              }
              output.enqueue(encoder.encode('data: ' + data + '\n\n'));
              if (completed) {
                ended = true;
                output.close();
                cleanup();
                await reader.cancel().catch(() => {});
              }
              return;
            }
            const chunk = await reader.read();
            if (chunk.done) {
              ended = true;
              if (!completed) fail('stream_interrupted', 'The ChatGPT stream ended before completion. Retry explicitly.', 'none', 502);
              cleanup();
              output.close();
              return;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 4 * 1024 * 1024) fail('invalid_stream', 'ChatGPT returned an oversized stream event.', 'none', 502);
          }
        } catch (error) {
          ended = true;
          const safe = safeError(error);
          if (!controller.signal.aborted) await this.#record(owner, id, safe);
          if (!controller.signal.aborted) {
            output.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'error', ...safe.detail }) + '\n\n'));
            output.close();
          } else output.error(new Error('ChatGPT request cancelled.'));
          controller.abort();
          await reader.cancel().catch(() => {});
          cleanup();
        }
      },
      async cancel() { ended = true; controller.abort(); cleanup(); await reader.cancel().catch(() => {}); },
    });
  }
}
