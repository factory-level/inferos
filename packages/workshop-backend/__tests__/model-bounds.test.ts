// A deployment's bounds on the platform's own models (FAC-152): MODEL_ALLOWLIST limits and orders
// the models offered, through AI Gateway and the local developer key, so its first entry is the
// default; DAILY_AGENT_TURN_LIMIT caps agent turns per owner per day while the Cloudflare limits
// flow is off, with a message that offers nothing to top up. The allowlist holds on the model a
// platform-funded request names, not only on the catalog's ids, and a capped deployment refuses
// platform-funded Gadget model bindings, which the turn cap can't count.
import { describe, expect, it } from "vitest";
import { SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { AiGatewayConfig } from "../src/ai-gateway.js";
import { checkPlatformTurn, checkUsageAndBalance } from "../src/ai-gateway-billing/limits/usage-checker.js";
import { localApiModels } from "../src/local-api-models.js";
import {
  applyModelAllowlist, drawsOnPlatformAllowance, getDailyAgentTurnCap, modelAllowlist, modelBindingRefusal,
} from "../src/model-allowlist.js";

function gatewayEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway", CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
    CF_AI_GATEWAY_PROVIDERS: "anthropic", WORKERS_AI: {} as Ai, ...overrides,
  } as Cloudflare.Env;
}

describe("the model allowlist", () => {
  it("is unset by default, and parsed in order without blanks or repeats", () => {
    expect(modelAllowlist({})).toBeNull();
    expect(modelAllowlist({ MODEL_ALLOWLIST: " , " })).toBeNull();
    expect(modelAllowlist({ MODEL_ALLOWLIST: " b, a ,b," })).toEqual(["b", "a"]);
    expect(applyModelAllowlist(["a", "b", "c"], id => id, ["c", "a"])).toEqual(["c", "a"]);
    expect(applyModelAllowlist(["a", "b"], id => id, null)).toEqual(["a", "b"]);
  });

  it("knows Claude Haiku 5.5, with both limits stated", () => {
    expect(SUGGESTED_MODELS.anthropic["claude-haiku-5-5"]).toMatchObject({ contextWindow: 200000, outputLimit: 16000 });
  });

  it("offers every Anthropic gateway model without it, starting with the costliest", () => {
    expect(new AiGatewayConfig(gatewayEnv()).getModelList()[0]?.id).toBe("claude-opus-5-5");
  });

  it("offers only Haiku 5.5 through the gateway when it's the only allowed model, so it's the default", () => {
    const config = new AiGatewayConfig(gatewayEnv({ MODEL_ALLOWLIST: "claude-haiku-5-5" }));
    expect(config.getModelList().map(model => model.id)).toEqual(["claude-haiku-5-5"]);
    expect(config.resolveModel("claude-haiku-5-5")?.config.model).toBe("claude-haiku-5-5");
  });

  it("doesn't resolve a model it leaves out, so a stored choice can't reach it", () => {
    const config = new AiGatewayConfig(gatewayEnv({ MODEL_ALLOWLIST: "claude-haiku-5-5" }));
    expect(config.resolveModel("claude-opus-5-5")).toBeUndefined();
    expect(config.resolveModel("claude-opus-5")).toBeUndefined();
  });

  it("orders the gateway list as the allowlist does", () => {
    const config = new AiGatewayConfig(gatewayEnv({ MODEL_ALLOWLIST: "claude-haiku-5-5,claude-sonnet-5-5" }));
    expect(config.getModelList().map(model => model.id)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  });

  it("limits the local developer key the same way", () => {
    const local = { DEV: true, ANTHROPIC_API_KEY: "test-key-not-real" } as unknown as Cloudflare.Env;
    expect(localApiModels(local).length).toBeGreaterThan(1);
    const bounded = localApiModels({ ...local, MODEL_ALLOWLIST: "claude-haiku-5-5" } as Cloudflare.Env);
    expect(bounded.map(model => model.profile.id)).toEqual(["local:anthropic:claude-haiku-5-5"]);
    expect(bounded[0]?.config).toMatchObject({ model: "claude-haiku-5-5", outputLimit: 16000 });
  });
});

/** A user object with the real counter's rule: it counts only while within the limit. */
function counter() {
  let used = 0;
  return {
    async consumeDailyLlmCall(limit: number) {
      if (used >= limit) return { withinLimits: false, remaining: 0, limit, used, resetAt: "2026-11-04T00:00:00.000Z" };
      used += 1;
      return { withinLimits: true, remaining: limit - used, limit, used, resetAt: "2026-11-04T00:00:00.000Z" };
    },
    get used() { return used; },
  };
}

describe("the daily agent turn cap", () => {
  const check = (env: Partial<Cloudflare.Env>, user: ReturnType<typeof counter>) =>
    checkUsageAndBalance(env as Cloudflare.Env, user as never);

  it("counts gateway turns, the local developer key only under the plain cap, and never a person's own key", () => {
    const off = {} as Cloudflare.Env;
    const on = { ENABLE_CLOUDFLARE_LIMITS: "true" } as Cloudflare.Env;
    const gateway = { config: {}, profile: {} };
    const local = { config: { billing: "api-key" }, profile: { managed: true } };
    const own = { config: { billing: "api-key" }, profile: {} };
    const plan = { config: { billing: "chatgpt-plan" }, profile: {} };
    expect(drawsOnPlatformAllowance(off, gateway)).toBe(true);
    expect(drawsOnPlatformAllowance(on, gateway)).toBe(true);
    expect(drawsOnPlatformAllowance(off, local)).toBe(true);
    expect(drawsOnPlatformAllowance(on, local)).toBe(false);
    expect(drawsOnPlatformAllowance(off, own)).toBe(false);
    expect(drawsOnPlatformAllowance(off, plan)).toBe(false);
  });

  it("reads only a positive integer", () => {
    expect(getDailyAgentTurnCap({})).toBeNull();
    for (const bad of ["0", "-1", "1.5", "abc", " "]) expect(getDailyAgentTurnCap({ DAILY_AGENT_TURN_LIMIT: bad }), bad).toBeNull();
    expect(getDailyAgentTurnCap({ DAILY_AGENT_TURN_LIMIT: " 40 " })).toBe(40);
  });

  it("allows everything and counts nothing without a cap", async () => {
    const user = counter();
    expect((await check({}, user)).allowed).toBe(true);
    expect(user.used).toBe(0);
  });

  it("allows the cap's turns, then refuses with a plain message and no top-up", async () => {
    const user = counter();
    const env = { DAILY_AGENT_TURN_LIMIT: "2" };
    expect((await check(env, user)).allowed).toBe(true);
    expect((await check(env, user)).allowed).toBe(true);
    const refused = await check(env, user);
    expect(refused).toMatchObject({ allowed: false, errorCode: "daily_turn_limit", shouldUseByok: false, remaining: 0 });
    expect(refused.reason).toBe("This environment allows 2 agent turns a day, and they're used up. They reset at midnight UTC.");
    expect(refused.reason).not.toMatch(/Cloudflare|credits/);
    expect(user.used).toBe(2);
  });
});

describe("the allowlist on the model a platform-funded request names", () => {
  const bounded = (overrides: Partial<Cloudflare.Env> = {}) =>
    new AiGatewayConfig(gatewayEnv({ MODEL_ALLOWLIST: "claude-haiku-5-5", ...overrides }));
  const anthropic = (model: string) => ({ provider: "anthropic" as const, model, apiToken: "" });

  it("offers a listed catalog model, and nothing else", () => {
    const config = bounded();
    expect(config.offersModel(anthropic("claude-haiku-5-5"))).toBe(true);
    expect(config.offersModel(anthropic("claude-opus-5-5"))).toBe(false);
    expect(config.offersModel(anthropic("claude-fake-model"))).toBe(false);
  });

  it("matches the id exactly, under the provider that lists it", () => {
    const config = bounded();
    for (const model of ["Claude-Haiku-5-5", "CLAUDE-HAIKU-5-5", " claude-haiku-5-5", "anthropic/claude-haiku-5-5"]) {
      expect(config.offersModel(anthropic(model)), model).toBe(false);
    }
    expect(config.offersModel({ provider: "openai", model: "claude-haiku-5-5", apiToken: "" })).toBe(false);
  });

  it("keeps the platform's own quick model, which titles chats", () => {
    const config = bounded({ CF_AI_GATEWAY_PROVIDERS: "anthropic,cloudflare" });
    expect(config.offersModel(config.getQuickModelConfig()!)).toBe(true);
    expect(config.offersModel({ provider: "cloudflare", model: "@cf/meta/llama-4-scout-17b-16e-instruct", apiToken: "" }))
        .toBe(false);
  });

  it("offers everything without an allowlist", () => {
    expect(new AiGatewayConfig(gatewayEnv()).offersModel(anthropic("claude-opus-5-5"))).toBe(true);
  });
});

describe("the turn gate", () => {
  const env = (overrides: Partial<Cloudflare.Env> = {}) =>
    gatewayEnv({ MODEL_ALLOWLIST: "claude-haiku-5-5", DAILY_AGENT_TURN_LIMIT: "2", ...overrides });
  const gatewayModel = (model: string) =>
    ({ config: { provider: "anthropic" as const, model, apiToken: "" }, profile: {} });

  it("refuses a stored gateway model the allowlist leaves out, before counting the turn", async () => {
    const user = counter();
    const refused = await checkPlatformTurn(env(), gatewayModel("claude-opus-5-5"), user as never);
    expect(refused).toMatchObject({ allowed: false, errorCode: "model_not_offered", shouldUseByok: false });
    expect(refused.reason).toBe("This environment doesn't offer the model \"claude-opus-5-5\". Choose one it offers.");
    expect(user.used).toBe(0);
  });

  it("refuses a listed id in another case, uncounted", async () => {
    const user = counter();
    expect((await checkPlatformTurn(env(), gatewayModel("Claude-Haiku-5-5"), user as never)).allowed).toBe(false);
    expect(user.used).toBe(0);
  });

  it("allows and counts an offered model, up to the cap", async () => {
    const user = counter();
    expect((await checkPlatformTurn(env(), gatewayModel("claude-haiku-5-5"), user as never)).allowed).toBe(true);
    expect((await checkPlatformTurn(env(), gatewayModel("claude-haiku-5-5"), user as never)).allowed).toBe(true);
    expect(await checkPlatformTurn(env(), gatewayModel("claude-haiku-5-5"), user as never))
        .toMatchObject({ allowed: false, errorCode: "daily_turn_limit" });
    expect(user.used).toBe(2);
  });

  it("leaves models alone without an allowlist", async () => {
    const user = counter();
    const result = await checkPlatformTurn(env({ MODEL_ALLOWLIST: undefined }), gatewayModel("claude-opus-5-5"), user as never);
    expect(result.allowed).toBe(true);
    expect(user.used).toBe(1);
  });
});

describe("Gadget model bindings on a capped deployment", () => {
  const capped = { DAILY_AGENT_TURN_LIMIT: "40" } as Cloudflare.Env;
  const platform = { config: { provider: "anthropic" }, profile: {} };
  const localKey = { config: { provider: "anthropic", billing: "api-key" }, profile: { managed: true } };
  const ownKey = { config: { provider: "anthropic", billing: "api-key" }, profile: {} };
  const plan = { config: { provider: "openai", billing: "chatgpt-plan" }, profile: {} };

  it("refuses a binding on the platform's models, which the turn cap can't count", () => {
    expect(modelBindingRefusal(capped, platform)).toMatch(/can't use the platform's models/);
    expect(modelBindingRefusal(capped, localKey)).toMatch(/can't use the platform's models/);
  });

  it("allows a binding on a person's own key or plan", () => {
    expect(modelBindingRefusal(capped, ownKey)).toBeNull();
    expect(modelBindingRefusal(capped, plan)).toBeNull();
  });

  it("allows every binding without the plain cap", () => {
    expect(modelBindingRefusal({} as Cloudflare.Env, platform)).toBeNull();
    expect(modelBindingRefusal({ ...capped, ENABLE_CLOUDFLARE_LIMITS: "true" } as Cloudflare.Env, platform)).toBeNull();
  });
});
