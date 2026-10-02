import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";
import type { OpenAiPluginState } from '@gadgets/workshop-shared/openai-plugin';

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const PROFILE = { type: "agent" as const, id: "my-model", name: "My Model" };
const CONFIG: AiModelConfig = {
  provider: "openai",
  model: "my-model",
  apiToken: "sk-secret",
  apiUrl: "https://proxy.example/v1",
  extraHeaders: { "X-Proxy-Key": "proxy-secret", "X-Empty": "" },
};

type ModelMethods = Pick<UserDurableObject, "addModel" | "getModelConfig" | "updateModel">;

let userCounter = 0;
async function userWithModel() {
  const stub = env.TEST_USER.getByName(`user-models-${++userCounter}`);
  // Calls go through runInDurableObject rather than the stub's RPC, whose rejections workerd
  // reports as uncaught exceptions even once the test has handled them.
  const inDo = <T>(f: (user: UserDurableObject) => Promise<T>) => runInDurableObject(stub, f);
  const user: ModelMethods = {
    addModel: (...args) => inDo(u => u.addModel(...args)),
    getModelConfig: (...args) => inDo(u => u.getModelConfig(...args)),
    updateModel: (...args) => inDo(u => u.updateModel(...args)),
  };
  const stored = (id: string) => inDo(async u =>
      (u as unknown as { storage: { aiModels: { get(id: string): unknown } } }).storage.aiModels.get(id));
  await user.addModel(PROFILE, CONFIG);
  return { user, stored };
}

describe("UserDurableObject model editing", () => {
  it("replaces secrets that are supplied, and drops headers that are omitted", async () => {
    const { user, stored } = await userWithModel();
    await user.updateModel(PROFILE, {
      ...CONFIG, apiToken: "sk-new", extraHeaders: { "X-Proxy-Key": null, "X-New": "v" },
    });
    expect(await stored(PROFILE.id)).toEqual({
      profile: PROFILE,
      config: { ...CONFIG, apiToken: "sk-new", extraHeaders: { "X-Proxy-Key": "proxy-secret", "X-New": "v" } },
    });
  });

  it("refuses to keep a secret for a header that isn't stored", async () => {
    const { user } = await userWithModel();
    await expect(user.updateModel(PROFILE, { ...CONFIG, extraHeaders: { "x-proxy-key": null } }))
        .rejects.toThrow("no stored");
  });

  it("refuses to keep secrets when the API URL changes", async () => {
    const { user, stored } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    await expect(user.updateModel(PROFILE, { ...config, apiUrl: "https://attacker.example" }))
        .rejects.toThrow("re-enter");
    await expect(user.updateModel(PROFILE, { ...config, apiUrl: undefined }))
        .rejects.toThrow("re-enter");
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });

    // Supplying every secret afresh is fine.
    const moved = { ...CONFIG, apiUrl: "https://other.example", apiToken: "sk-2", extraHeaders: {} };
    await user.updateModel(PROFILE, moved);
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: moved });
  });

  it("refuses to change the provider or model", async () => {
    const { user } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    await expect(user.updateModel(PROFILE, { ...config, model: "other" })).rejects.toThrow("can't be changed");
    await expect(user.updateModel(PROFILE, { ...CONFIG, provider: "anthropic" })).rejects.toThrow("can't be changed");
  });

  it("refuses to edit a model that doesn't exist", async () => {
    const { user } = await userWithModel();
    await expect(user.getModelConfig("nope")).rejects.toThrow("No such");
    await expect(user.updateModel({ ...PROFILE, id: "nope" }, CONFIG)).rejects.toThrow("No such");
  });

  it("copies withheld secrets when cloning to the same endpoint", async () => {
    const { user, stored } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await user.addModel(clone, { ...config, model: "clone" }, PROFILE.id);
    expect(await stored("clone")).toEqual({ profile: clone, config: { ...CONFIG, model: "clone" } });
  });

  it("refuses to clone secrets to another endpoint or over an existing model", async () => {
    const { user } = await userWithModel();
    const { config } = await user.getModelConfig(PROFILE.id);
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await expect(user.addModel(clone, { ...config, provider: "anthropic" }, PROFILE.id))
        .rejects.toThrow("re-enter");
    await expect(user.addModel(PROFILE, config, PROFILE.id)).rejects.toThrow("already exists");
    await expect(user.addModel(clone, config, "nope")).rejects.toThrow("No such");
  });

  it("refuses to add over an existing model", async () => {
    const { user, stored } = await userWithModel();
    await expect(user.addModel({ ...PROFILE, name: "Other" }, { ...CONFIG, apiToken: "sk-other" }))
        .rejects.toThrow("already exists");
    expect(await stored(PROFILE.id)).toEqual({ profile: PROFILE, config: CONFIG });
  });

  it("requires every secret when adding without a source", async () => {
    const { user } = await userWithModel();
    const clone = { type: "agent" as const, id: "clone", name: "Clone" };
    await expect(user.addModel(clone, { ...CONFIG, apiToken: null })).rejects.toThrow("required");
  });
});

describe('ChatGPT model ownership and disconnected fallback', () => {
  afterEach(() => vi.unstubAllGlobals());
  const plan = { provider: 'openai' as const, billing: 'chatgpt-plan' as const, model: 'gpt-test', registrationId: 'owned' };
  const profile = { type: 'agent' as const, id: 'plan', name: 'ChatGPT' };
  function inPlanUser(run: (user: UserDurableObject, config: Cloudflare.Env) => Promise<void>) {
    const stub = env.TEST_USER.getByName(`plan-models-${++userCounter}`);
    return runInDurableObject(stub, user => {
      const impl = user as unknown as { env: Cloudflare.Env };
      impl.env = { ...impl.env, DEV: true, ENABLE_OPENAI_ASSISTANT_PLUGIN: 'true',
        OPENAI_ASSISTANT_PLUGIN_URL: 'http://127.0.0.1:1456', OPENAI_ASSISTANT_PLUGIN_SECRET: 'test-bridge' };
      return run(user, impl.env);
    });
  }
  function mockCompanion(status: OpenAiPluginState['accounts'][number]['status'] = 'ready') {
    const state: OpenAiPluginState = { accounts: [{ id: 'owned', label: 'Owner', status, allowBackground: false }],
      activeAccountId: 'owned', needsWelcome: false };
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get('x-inferos-user')).toBe('user@example.com');
      if (command.operation === 'state') return Response.json(state);
      return command.accountId === 'owned' ? Response.json([{ slug: 'gpt-test', displayName: 'GPT Test' }])
        : Response.json({ error: { status: 404, code: 'account_not_found', message: 'ChatGPT account not found.', recovery: 'none' } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    return { state, fetch };
  }
  it('persists and edits plan models without secrets and rejects a foreign registration', () => inPlanUser(async user => {
    mockCompanion();
    await user.addModel(profile, plan);
    expect(await user.getModelConfig('plan')).toEqual({ profile: { ...profile, billing: 'chatgpt-plan' }, config: plan });
    await user.updateModel({ ...profile, name: 'Renamed' }, plan);
    await expect(user.addModel({ ...profile, id: 'foreign' }, { ...plan, registrationId: 'foreign' })).rejects.toThrow('not found');
    await expect(user.updateModel(profile, { ...CONFIG, model: plan.model })).rejects.toThrow("can't be changed");
  }));
  it.each(['apiToken', 'apiUrl', 'extraHeaders', 'accountId'])('rejects %s on a plan record', field => inPlanUser(async user => {
    mockCompanion();
    const invalid = { ...plan };
    Reflect.set(invalid, field, field === 'extraHeaders' ? { Authorization: 'secret' } : 'override');
    await expect(user.addModel(profile, invalid)).rejects.toThrow('cannot contain');
  }));
  it.each(['signed-out', 'missing'] as const)('uses only the selected API-key model when the account is %s', status => inPlanUser(async user => {
    const { state } = mockCompanion();
    await user.addModel(profile, plan);
    await user.addModel(PROFILE, CONFIG);
    await user.setChatGptFallback(PROFILE.id);
    if (status === 'missing') state.accounts = [];
    else state.accounts[0].status = status;
    const fallback = (await user.getChatContext('plan')).aiModel!;
    expect(fallback).toEqual({ profile: { ...PROFILE, fallbackForModelId: 'plan' }, config: { ...CONFIG, billing: 'api-key' } });
    expect((await user.getModelConfig('plan')).config).toEqual(plan);
    state.accounts = [{ id: 'owned', label: 'Connected', status: 'ready', allowBackground: false }];
    expect((await user.getChatContext(fallback.profile.fallbackForModelId!)).aiModel?.config).toEqual(plan);
    await user.setChatGptFallback(null);
    expect((await user.getChatContext('plan')).aiModel?.config).toEqual(plan);
  }));
  it.each(['ready', 'usage-paused', 'plan-disabled'] as const)('does not change billing for %s accounts', status => inPlanUser(async user => {
    const { state } = mockCompanion();
    await user.addModel(profile, plan);
    await user.addModel(PROFILE, CONFIG);
    await user.setChatGptFallback(PROFILE.id);
    state.accounts[0].status = status;
    expect((await user.getChatContext('plan')).aiModel?.config).toEqual(plan);
  }));
  it('does not treat a companion outage as a disconnected account', () => inPlanUser(async user => {
    const { fetch } = mockCompanion();
    await user.addModel(profile, plan);
    await user.addModel(PROFILE, CONFIG);
    await user.setChatGptFallback(PROFILE.id);
    fetch.mockRejectedValue(new Error('offline'));
    await expect(user.getChatContext('plan')).rejects.toThrow('unavailable');
  }));
  it('requires an existing keyed model and fails clearly if the selected fallback was deleted', () => inPlanUser(async user => {
    const { state } = mockCompanion();
    await user.addModel(profile, plan);
    await expect(user.setChatGptFallback('plan')).rejects.toThrow('API-key');
    await expect(user.setChatGptFallback('someone-elses-model')).rejects.toThrow('API-key');
    await user.addModel(PROFILE, CONFIG);
    await user.setChatGptFallback(PROFILE.id);
    await user.deleteModel(PROFILE.id);
    state.accounts[0].status = 'signed-out';
    await expect(user.getChatContext('plan')).rejects.toThrow('fallback is unavailable');
  }));
  it('offers the local Anthropic key only in DEV and never includes it in public metadata', () => inPlanUser(async (user, config) => {
    config.ANTHROPIC_API_KEY = 'local-private-key';
    const choices = await user.getChatGptFallback();
    expect(choices.models.length).toBeGreaterThan(0);
    expect(JSON.stringify(choices)).not.toContain('local-private-key');
    expect(choices.modelId).toBeNull();
    const id = choices.models[0].id;
    await user.setChatGptFallback(id);
    expect((await user.getChatContext(id)).aiModel?.config).toMatchObject({ provider: 'anthropic', apiToken: 'local-private-key', billing: 'api-key' });
    await expect(user.deleteModel(id)).rejects.toThrow('managed');
    config.DEV = false;
    expect((await user.getChatGptFallback()).models).toEqual([]);
  }));
});

describe("UserDurableObject hidden gateway models", () => {
  const HIDDEN_ID = "claude-opus-5";

  // Every call runs in one invocation, since the gateway env is only overridden on this instance.
  function inGatewayUser<T>(f: (user: UserDurableObject) => Promise<T>) {
    const stub = env.TEST_USER.getByName(`user-models-${++userCounter}`);
    return runInDurableObject(stub, user => {
      const impl = user as unknown as { env: Cloudflare.Env };
      impl.env = {
        ...impl.env,
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
        CF_AI_GATEWAY_API_TOKEN: "gateway-token",
        CF_AI_GATEWAY_PROVIDERS: "anthropic",
      };
      return f(user);
    });
  }

  it("refuses to add a model that a hidden gateway model would shadow", () => inGatewayUser(async user => {
    await expect(user.addModel({ ...PROFILE, id: HIDDEN_ID }, { ...CONFIG, model: HIDDEN_ID }))
        .rejects.toThrow("already exists");
  }));

  it("keeps an existing chat on a hidden model", () => inGatewayUser(async user => {
    const context = await user.getExternalMessageChatContext(HIDDEN_ID);
    expect(context.aiModel?.profile.id).toBe(HIDDEN_ID);
  }));

  it("starts a new conversation on the first offered model when the preference is hidden",
      () => inGatewayUser(async user => {
    await user.setPreferredModel(HIDDEN_ID);
    const [first] = await user.listModels();
    expect(first.id).not.toBe(HIDDEN_ID);
    const context = await user.getExternalMessageChatContext(null);
    expect(context.aiModel?.profile.id).toBe(first.id);
  }));
});
