// A deployment's optional allowlist of platform models (MODEL_ALLOWLIST), so a stage can offer one
// cheap model by default and nothing costlier. It covers the AI Gateway catalog and the local
// developer key; models a person adds with their own key are theirs to pay for and stay offered.

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
