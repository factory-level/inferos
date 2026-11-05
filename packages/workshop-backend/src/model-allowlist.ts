// A deployment's optional bounds on the platform's own models (FAC-152). MODEL_ALLOWLIST names the
// platform models offered, so a stage can offer one cheap model by default and nothing costlier: it
// covers the AI Gateway catalog, the local developer key, and every request the platform gateway
// funds (AiGatewayConfig.offersModel). DAILY_AGENT_TURN_LIMIT caps agent turns per owner per UTC
// day. Models a person adds with their own key or plan are theirs to pay for and aren't bounded.
// Kept free of the billing modules, so ai-models.ts can use it without an import cycle.
import { isCloudflareLimitsEnabled } from "./ai-gateway-billing/config.js";

/**
 * The model ids `MODEL_ALLOWLIST` names, in its order, or null when it's unset or empty, which
 * leaves every suggested model offered. The first id is the default for anyone with no stored choice.
 */
export function modelAllowlist(env: Pick<Cloudflare.Env, "MODEL_ALLOWLIST">): readonly string[] | null {
  const ids = (env.MODEL_ALLOWLIST ?? "").split(",").map(id => id.trim()).filter(id => id !== "");
  return ids.length > 0 ? [...new Set(ids)] : null;
}

/**
 * Keep only the entries whose model id the allowlist names, ordered as it lists them. With no
 * allowlist, every entry is returned as given.
 */
export function applyModelAllowlist<T>(entries: readonly T[], modelId: (entry: T) => string,
    allowlist: readonly string[] | null): T[] {
  if (!allowlist) return [...entries];
  return entries.filter(entry => allowlist.includes(modelId(entry)))
      .toSorted((a, b) => allowlist.indexOf(modelId(a)) - allowlist.indexOf(modelId(b)));
}

/** The refusal for a platform-funded request naming a model the allowlist doesn't offer. */
export function modelNotOfferedMessage(model: string): string {
  return `This environment doesn't offer the model ${JSON.stringify(model)}. Choose one it offers.`;
}

/**
 * Whether a turn on this model draws on the platform's allowance, so it's checked and counted: a
 * gateway model always; the local developer key (a managed model) only under the plain daily cap,
 * so a stage's bound can be tried locally. A person's own key or plan never does.
 */
export function drawsOnPlatformAllowance(env: Cloudflare.Env,
    model: { config: { billing?: string }, profile: { managed?: boolean } }): boolean {
  if (model.config.billing === undefined) return true;
  return model.profile.managed === true && !isCloudflareLimitsEnabled(env);
}

/**
 * The cap from DAILY_AGENT_TURN_LIMIT, or null when unset or not a positive integer. It applies
 * only while the Cloudflare limits flow is off, which has its own allowance and top-up.
 */
export function getDailyAgentTurnCap(env: Pick<Cloudflare.Env, "DAILY_AGENT_TURN_LIMIT">): number | null {
  const raw = env.DAILY_AGENT_TURN_LIMIT?.trim();
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

/**
 * Why a Gadget model binding on this model is refused, or null when it's allowed. Under the plain
 * daily cap, a binding on the platform's models is refused: its calls come from Gadget code, not an
 * agent turn, so the cap can't count them. A binding on a person's own key or plan is theirs to pay
 * for. Checked when a binding is made and again when it starts a session, so one made before the
 * cap was set is refused too.
 */
export function modelBindingRefusal(env: Cloudflare.Env,
    model: { config: { billing?: string }, profile: { managed?: boolean } }): string | null {
  if (getDailyAgentTurnCap(env) === null || isCloudflareLimitsEnabled(env)) return null;
  if (!drawsOnPlatformAllowance(env, model)) return null;
  return "This environment caps agent turns a day, so a Gadget can't use the platform's models. " +
      "Bind a model on your own key instead.";
}
