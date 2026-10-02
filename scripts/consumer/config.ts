/** Declarative consumer inputs. These settings never grant resource or deployment authority. */
export interface ConsumerConfig {
  schemaVersion: 1;
  upstream: { repository: string; revision: string };
  profile: "personal" | "inferops-operations";
  features: { composableViews: boolean; durableViews: boolean; customCloudflareCode: boolean };
  styling: { siteName: string; density: "comfortable" | "compact"; theme: "system" | "light" | "dark" };
  local: { port: number };
  inferops: { mode: "fixture"; fixture: "fixtures/project-board.json"; targetRef: string }
    | { mode: "remote"; baseUrl: string; targetRef: string };
}

const object = (value: unknown, keys: string[], path: string, partial = false): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key)) || (!partial && keys.some(key => !Object.hasOwn(record, key)))) {
    throw new Error(`${path}: expected exactly ${keys.join(", ")}`);
  }
  return record;
};

const choice = <T extends string>(value: unknown, choices: readonly T[], path: string): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${path}: invalid value`);
  return value as T;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error(`${path}: expected nonempty string`);
  return value;
};

/** Origin of a resolved installation setting; administrator state is managed separately. */
export type SettingSource = "default" | "profile" | "override";

/** Resolution sources for the settings that profiles can customize. */
export interface ConsumerProvenance {
  features: Record<keyof ConsumerConfig["features"], SettingSource>;
  styling: Record<keyof ConsumerConfig["styling"], SettingSource>;
}

const defaults: Pick<ConsumerConfig, "features" | "styling"> = {
  features: { composableViews: false, durableViews: false, customCloudflareCode: false },
  styling: { siteName: "InferOS", density: "comfortable", theme: "system" },
};
const profiles: Record<ConsumerConfig["profile"], {
  features: Partial<ConsumerConfig["features"]>;
  styling: Partial<ConsumerConfig["styling"]>;
}> = {
  personal: { features: {}, styling: {} },
  "inferops-operations": {
    features: { composableViews: true, durableViews: true },
    styling: { density: "compact" },
  },
};

function resolveGroup<T extends object>(base: T, profile: Partial<T>, overrides: Record<string, unknown>) {
  // Only known own properties participate; false is an override, never a missing value.
  const value = { ...base, ...profile, ...overrides };
  const provenance = Object.fromEntries(Object.keys(base).map(key => [key,
    Object.hasOwn(overrides, key) ? "override" : Object.hasOwn(profile, key) ? "profile" : "default",
  ])) as Record<keyof T, SettingSource>;
  return { value, provenance };
}

/** Reject credentials in committed repository and API URLs. Local repository paths are explicit inputs. */
export function validateRepository(value: unknown): string {
  const repository = string(value, "upstream.repository");
  if (repository.startsWith("-") || /[\r\n\0]/.test(repository)) throw new Error("upstream.repository: invalid location");
  if (repository.includes("://")) validateHttpsUrl(repository, "upstream.repository");
  else if (!repository.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(repository)) {
    throw new Error("upstream.repository: use an HTTPS URL or absolute local path");
  }
  return repository;
}

function validateHttpsUrl(value: unknown, path: string): string {
  const text = string(value, path);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${path}: expected HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${path}: expected HTTPS URL without credentials, query or fragment`);
  }
  return text;
}

/** Validate untrusted configuration without echoing rejected values, which may contain secrets. */
export function resolveConsumerConfig(input: unknown): { config: ConsumerConfig; provenance: ConsumerProvenance } {
  const root = object(input, ["schemaVersion", "upstream", "profile", "features", "styling", "local", "inferops"], "config");
  if (root.schemaVersion !== 1) throw new Error("schemaVersion: only version 1 is supported");
  const upstream = object(root.upstream, ["repository", "revision"], "upstream");
  const repository = validateRepository(upstream.repository);
  if (typeof upstream.revision !== "string" || !/^[a-f0-9]{40}$/.test(upstream.revision)) {
    throw new Error("upstream.revision: expected full lowercase Git commit SHA");
  }
  const profile = choice(root.profile, ["personal", "inferops-operations"], "profile");
  const featureOverrides = object(root.features, ["composableViews", "durableViews", "customCloudflareCode"], "features", true);
  const resolvedFeatures = resolveGroup(defaults.features, profiles[profile].features, featureOverrides);
  const features = resolvedFeatures.value;
  for (const key of Object.keys(features)) {
    if (typeof features[key as keyof typeof features] !== "boolean") throw new Error(`features.${key}: expected boolean`);
  }
  if (features.durableViews && !features.composableViews) throw new Error("durableViews requires composableViews");
  const styleOverrides = object(root.styling, ["siteName", "density", "theme"], "styling", true);
  const resolvedStyle = resolveGroup(defaults.styling, profiles[profile].styling, styleOverrides);
  const styling = resolvedStyle.value;
  // Native AdminApi.setSiteName and initializeProfile enforce the same public limit.
  if (string(styling.siteName, "styling.siteName").length > 40) throw new Error("styling.siteName: maximum 40 characters");
  const local = object(root.local, ["port"], "local");
  if (typeof local.port !== "number" || !Number.isInteger(local.port) || local.port < 1024 || local.port > 65535) {
    throw new Error("local.port: expected integer from 1024 to 65535");
  }
  const rawData = root.inferops as Record<string, unknown> | null;
  const remote = rawData?.mode === "remote";
  const data = object(root.inferops, remote ? ["mode", "baseUrl", "targetRef"] : ["mode", "fixture", "targetRef"], "inferops");
  const targetRef = string(data.targetRef, "inferops.targetRef");
  if (!/^inferops:\/\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\/project\/board\/[a-zA-Z0-9_-]+$/.test(targetRef)) {
    throw new Error("inferops.targetRef: expected tenant.workspace/project/board/project reference");
  }
  const config: ConsumerConfig = {
    schemaVersion: 1,
    upstream: { repository, revision: upstream.revision },
    profile,
    features: {
      composableViews: features.composableViews as boolean,
      durableViews: features.durableViews as boolean,
      customCloudflareCode: features.customCloudflareCode as boolean,
    },
    styling: {
      siteName: string(styling.siteName, "styling.siteName"),
      density: choice(styling.density, ["comfortable", "compact"], "styling.density"),
      theme: choice(styling.theme, ["system", "light", "dark"], "styling.theme"),
    },
    local: { port: local.port },
    inferops: remote
      ? { mode: "remote", baseUrl: validateHttpsUrl(data.baseUrl, "inferops.baseUrl"), targetRef }
      : { mode: choice(data.mode, ["fixture"], "inferops.mode"), fixture: choice(data.fixture, ["fixtures/project-board.json"], "inferops.fixture"), targetRef },
  };
  return { config, provenance: { features: resolvedFeatures.provenance, styling: resolvedStyle.provenance } };
}

/** Resolve and validate configuration; omitted profile-controlled fields inherit defaults. */
export function parseConsumerConfig(input: unknown): ConsumerConfig {
  return resolveConsumerConfig(input).config;
}

/** Initial explicit settings; materialize the operations profile so later profile changes cannot silently alter a wrapper. */
export function initialConsumerConfig(repository: string, revision: string): ConsumerConfig {
  return parseConsumerConfig({
    schemaVersion: 1, upstream: { repository, revision }, profile: "inferops-operations",
    features: {}, styling: {},
    local: { port: 8787 },
    inferops: { mode: "fixture", fixture: "fixtures/project-board.json", targetRef: "inferops://demo.local/project/board/DEMO" },
  });
}
