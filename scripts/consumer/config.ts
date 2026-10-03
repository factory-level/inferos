/** Customer capability vocabulary (ADR 0001), accepted from schema version 2. A name states availability only. */
export const CAPABILITY_NAMES = [
  "INFEROPS_ENABLED", "INFEROPS_CANVAS_STATE_MACHINE", "HARNESS_HG_ENABLED", "INFEROPS_AUTH",
  "PUBLISH_CLOUDFLAREOS_WIDGET", "PUBLISH_CLOUDFLAREOS_APP", "AGENT_DEPLOYMENTS", "CODING_WORKBENCH_ENABLED",
] as const;

/** One customer capability flag name. */
export type CapabilityName = typeof CAPABILITY_NAMES[number];

/** Settings shared by every schema version. */
interface ConsumerSettings {
  upstream: { repository: string; revision: string };
  profile: "personal" | "inferops-operations";
  features: { composableViews: boolean; durableViews: boolean; customCloudflareCode: boolean; inferlabLogin: boolean };
  styling: { siteName: string; density: "comfortable" | "compact"; theme: "system" | "light" | "dark" };
  local: { port: number };
  inferops: { mode: "fixture"; fixture: "fixtures/project-board.json"; targetRef: string }
    | { mode: "remote"; baseUrl: string; targetRef: string };
}

/** Declarative consumer inputs. These settings never grant resource or deployment authority. */
export type ConsumerConfig = ConsumerSettings
  & ({ schemaVersion: 1 } | { schemaVersion: 2; capabilities: Record<CapabilityName, boolean> });

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
  /** Present only for schema version 2; version 1 cannot declare capabilities. */
  capabilities?: Record<CapabilityName, SettingSource>;
}

const defaults: Pick<ConsumerConfig, "features" | "styling"> = {
  features: { composableViews: false, durableViews: false, customCloudflareCode: false, inferlabLogin: false },
  styling: { siteName: "InferOS", density: "comfortable", theme: "system" },
};
const profiles: Record<ConsumerConfig["profile"], {
  features: Partial<ConsumerConfig["features"]>;
  styling: Partial<ConsumerConfig["styling"]>;
}> = {
  personal: { features: {}, styling: {} },
  // Profiles never change authentication policy, so neither one sets inferlabLogin.
  "inferops-operations": {
    features: { composableViews: true, durableViews: true },
    styling: { density: "compact" },
  },
};

// Every capability is off until its owner and default are decided; no profile enables one.
const capabilityDefaults = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, false])) as Record<CapabilityName, boolean>;

/** Validated, never auto-enabled: each key requires every listed capability to be on as well. */
export const CAPABILITY_REQUIREMENTS: Partial<Record<CapabilityName, readonly CapabilityName[]>> = {
  INFEROPS_CANVAS_STATE_MACHINE: ["INFEROPS_ENABLED"],
};

/**
 * Compatibility mapping from the version 1 flags. Each keeps its name and meaning under `features`.
 * Three map to no capability, because none means the same thing: composition and a durable layout
 * are not state-machine execution, and custom code activation is not an agent permission.
 * `inferlabLogin` is the version 1 spelling of `INFEROPS_AUTH`: either switches InferOps-backed
 * sign-in on (see {@link inferOpsAuthRequested}).
 */
export const LEGACY_FLAG_COMPATIBILITY: Record<keyof ConsumerConfig["features"], { retained: true; capability: CapabilityName | null }> = {
  composableViews: { retained: true, capability: null },
  durableViews: { retained: true, capability: null },
  customCloudflareCode: { retained: true, capability: null },
  inferlabLogin: { retained: true, capability: "INFEROPS_AUTH" },
};

/** Whether the configuration asks for InferOps-backed sign-in: `features.inferlabLogin`, or `INFEROPS_AUTH` in version 2. */
export function inferOpsAuthRequested(config: ConsumerConfig): boolean {
  return config.features.inferlabLogin || (config.schemaVersion === 2 && config.capabilities.INFEROPS_AUTH);
}

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
  const version = (input as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== 1 && version !== 2) throw new Error("schemaVersion: only versions 1 and 2 are supported");
  if (version === 1 && Object.hasOwn(input as object, "capabilities")) throw new Error("capabilities: requires schemaVersion 2");
  const root = object(input, ["schemaVersion", "upstream", "profile", "features", "styling", "local", "inferops",
    ...(version === 2 ? ["capabilities"] : [])], "config");
  const upstream = object(root.upstream, ["repository", "revision"], "upstream");
  const repository = validateRepository(upstream.repository);
  if (typeof upstream.revision !== "string" || !/^[a-f0-9]{40}$/.test(upstream.revision)) {
    throw new Error("upstream.revision: expected full lowercase Git commit SHA");
  }
  const profile = choice(root.profile, ["personal", "inferops-operations"], "profile");
  const featureOverrides = object(root.features, ["composableViews", "durableViews", "customCloudflareCode", "inferlabLogin"], "features", true);
  const resolvedFeatures = resolveGroup(defaults.features, profiles[profile].features, featureOverrides);
  const features = resolvedFeatures.value;
  for (const key of Object.keys(features)) {
    if (typeof features[key as keyof typeof features] !== "boolean") throw new Error(`features.${key}: expected boolean`);
  }
  if (features.durableViews && !features.composableViews) throw new Error("durableViews requires composableViews");
  const resolvedCapabilities = version === 2
    ? resolveGroup(capabilityDefaults, {}, object(root.capabilities, [...CAPABILITY_NAMES], "capabilities", true)) : null;
  for (const name of resolvedCapabilities ? CAPABILITY_NAMES : []) {
    const enabled = resolvedCapabilities!.value[name];
    if (typeof enabled !== "boolean") throw new Error(`capabilities.${name}: expected boolean`);
    const missing = enabled && CAPABILITY_REQUIREMENTS[name]?.find(required => resolvedCapabilities!.value[required] !== true);
    if (missing) throw new Error(`${name} requires ${missing}`);
  }
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
  const settings: ConsumerSettings = {
    upstream: { repository, revision: upstream.revision },
    profile,
    features: {
      composableViews: features.composableViews as boolean,
      durableViews: features.durableViews as boolean,
      customCloudflareCode: features.customCloudflareCode as boolean,
      inferlabLogin: features.inferlabLogin as boolean,
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
  const provenance: ConsumerProvenance = { features: resolvedFeatures.provenance, styling: resolvedStyle.provenance };
  if (!resolvedCapabilities) return { config: { schemaVersion: 1, ...settings }, provenance };
  const capabilities = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, resolvedCapabilities.value[name]])) as Record<CapabilityName, boolean>;
  return { config: { schemaVersion: 2, ...settings, capabilities }, provenance: { ...provenance, capabilities: resolvedCapabilities.provenance } };
}

/** Resolve and validate configuration; omitted profile-controlled fields inherit defaults. */
export function parseConsumerConfig(input: unknown): ConsumerConfig {
  return resolveConsumerConfig(input).config;
}

/**
 * Rewrite a version 1 file as version 2 without changing resolved behaviour. Every written setting is
 * kept as written, omitted ones still inherit, and no legacy flag turns a capability on: all eight are
 * written as explicit `false` so a later default or profile change cannot enable one unreviewed.
 */
export function migrateConsumerConfig(input: unknown): Record<string, unknown> {
  if (resolveConsumerConfig(input).config.schemaVersion !== 1) throw new Error("schemaVersion: migration expects version 1");
  return { ...structuredClone(input as Record<string, unknown>), schemaVersion: 2, capabilities: { ...capabilityDefaults } };
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
