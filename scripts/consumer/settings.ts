// The required settings of the selected private local customer (#19, MVP scope): identity, the
// tenant/workspace/project and Wiki binding references, host and runtime, the local custom
// component path and the coding adapter. Each row says what the setting is, who owns it, its
// default, when it is required, whether it is local or cloud and where it is read. `doctor` runs
// `validateSettings` over the wrapper's resolved configuration and the shell, and
// `docs/wiki/configuration-reference.md` carries a table generated from these rows:
//
//   node scripts/consumer/settings.ts          rewrite the generated section
//   node scripts/consumer/settings.ts --check  fail when the committed section has drifted
//
// Nothing here ever prints a setting's value. Secrets are reported by presence only, and every
// other finding names the setting and the problem, never what was set, because a URL or path can
// itself carry a credential. A full deployment-provider matrix is post-release work.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INFERLAB_AUTH_ORIGIN, getInferLabLoginVars, inferLabLoginStartupError, isInferLabAuthOrigin,
  resolveInferOpsEnabled,
} from "../dev-server-config.ts";
import { inferOpsAuthRequested, type ConsumerConfig } from "./config.ts";

/** What `validateSettings` reads: the resolved wrapper configuration, the shell, and what doctor knows of the wrapper. */
export interface SettingsInput {
  /** The wrapper's resolved `inferos.config.json`. */
  config: ConsumerConfig;
  /** The shell the dev server and runner would start from. Values are read, never reported. */
  env: Readonly<Record<string, string | undefined>>;
  /** Whether `inferos.canvas.json` selects `gatekeeper-inferops`. Omitted, it is assumed selected. */
  inferOpsGatekeeperSelected?: boolean;
}

/**
 * `secret`: a credential; only its presence is ever reported. `reference`: names something outside
 * the wrapper (an origin, an `inferops://` reference, a path, an id). `value`: a plain choice.
 */
export type SettingKind = "secret" | "reference" | "value";

/** Who decides a setting. */
export type SettingOwner = "deployer" | "customer admin" | "developer";

/** One row of the settings table. */
export interface SettingEntry {
  /** The variable or configuration field, as the person sets it. */
  name: string;
  /** The scope area the row belongs to. */
  group: "Identity" | "InferOps target" | "Host and runtime" | "Custom components" | "Coding adapter" | "Publication";
  /** What the setting does. */
  description: string;
  kind: SettingKind;
  owner: SettingOwner;
  /** What applies when it is unset, or null when nothing does. */
  default: string | null;
  /** When the setting must be present, as a predicate and as the sentence the docs show. */
  requiredWhen: { test: (input: SettingsInput) => boolean; text: string };
  /** Whether the setting applies to the local stack, a cloud deployment, or both. */
  source: "local" | "cloud" | "both";
  /** The file or variable it is read from, and what reads it. */
  readAt: string;
  /** Whether it is present. `null` when doctor cannot tell without running something else. */
  present: (input: SettingsInput) => boolean | null;
  /** When startup has a working fallback, a missing value is only a warning naming that fallback. */
  whenMissing?: { severity: "warning"; note: string };
  /** Why this installation cannot honour the setting yet. */
  unsupported?: string;
}

const has = (env: SettingsInput["env"], name: string) => (env[name]?.trim() ?? "") !== "";

/** Whether the wrapper asks for InferOps-backed sign-in (`INFEROPS_AUTH` or `features.inferlabLogin`). */
export const signInRequested = ({ config }: SettingsInput) => inferOpsAuthRequested(config);

/**
 * Whether the InferOps integration is on, as `resolveInferOpsEnabled` decides it for the dev server.
 * An invalid shell value or a conflict counts as off here; `validateSettings` reports it.
 */
export function inferOpsOn(input: SettingsInput): boolean {
  try {
    return resolveInferOpsEnabled({
      capability: input.config.schemaVersion === 2 ? input.config.capabilities.INFEROPS_ENABLED : null,
      canvasSelected: input.inferOpsGatekeeperSelected ?? true,
      shell: input.env.INFEROPS_ENABLED,
    }) === "true";
  } catch { return false; }
}

/**
 * Whether coding dispatch is asked for: a version 2 wrapper's `CODING_WORKBENCH_ENABLED`, whatever
 * the shell says, otherwise the shell's `CODING_WORKBENCH_ENABLED=true` (as the dev server resolves it).
 */
export function codingRequested({ config, env }: SettingsInput): boolean {
  return config.schemaVersion === 2 ? config.capabilities.CODING_WORKBENCH_ENABLED : env.CODING_WORKBENCH_ENABLED === "true";
}

/** Whether custom tables are asked for, resolved like coding dispatch. */
export function tablesRequested({ config, env }: SettingsInput): boolean {
  return config.schemaVersion === 2 ? config.capabilities.INFEROPS_TABLES_ENABLED : env.INFEROPS_TABLES_ENABLED === "true";
}

/** Whether host boards are asked for, resolved like custom tables. */
export function hostBoardsRequested({ config, env }: SettingsInput): boolean {
  return config.schemaVersion === 2 ? config.capabilities.INFEROPS_HOST_BOARDS : env.INFEROPS_HOST_BOARDS === "true";
}

/** Whether bound views are asked for, resolved like host boards. */
export function boundViewsRequested({ config, env }: SettingsInput): boolean {
  return config.schemaVersion === 2 ? config.capabilities.INFEROPS_BOUND_VIEWS : env.INFEROPS_BOUND_VIEWS === "true";
}

/** The wrapper's `codingWorkbench.repos`, read defensively so pins whose parser predates it still load. */
function wrapperCodingRepos(config: ConsumerConfig): unknown[] | null {
  if (config.schemaVersion !== 2) return null;
  const repos = (config as { codingWorkbench?: { repos?: unknown } }).codingWorkbench?.repos;
  return Array.isArray(repos) ? repos : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The allowlisted repository ids the gatekeeper would get: the wrapper's in version 2, else the shell's. */
function codingRepoIds(input: SettingsInput): { ids: string[]; ignored: number } {
  const repos = wrapperCodingRepos(input.config);
  const entries = input.config.schemaVersion === 2
    ? (repos ?? []).map(repo => (repo as { repoId?: unknown } | null)?.repoId).map(id => typeof id === "string" ? id : "")
    : (input.env.CODING_WORKBENCH_REPOS ?? "").split(",").map(entry => entry.trim()).filter(Boolean);
  const ids = entries.filter(id => UUID.test(id));
  return { ids, ignored: entries.length - ids.length };
}

/** The publication flags, which the dev server resolves like `CODING_WORKBENCH_ENABLED`. */
const PUBLICATION_FLAG_NAMES = ["PUBLISH_CLOUDFLAREOS_WIDGET", "PUBLISH_CLOUDFLAREOS_APP"] as const;

/** Whether a publication flag is on: a version 2 wrapper's capability, else the shell's `true`. */
export function publicationRequested({ config, env }: SettingsInput, name: typeof PUBLICATION_FLAG_NAMES[number]): boolean {
  return config.schemaVersion === 2 ? config.capabilities[name] : env[name] === "true";
}

const never = { test: () => false, text: "Optional." };
const always = { test: () => true, text: "Always." };
const whenSignIn = { test: signInRequested, text: "`INFEROPS_AUTH` (or `features.inferlabLogin`) is on." };
const whenCoding = { test: codingRequested, text: "`CODING_WORKBENCH_ENABLED` is on." };
const whenToken = { test: (input: SettingsInput) => has(input.env, "INFEROPS_API_TOKEN"), text: "`INFEROPS_API_TOKEN` is set." };

/** The settings of the selected private local customer, in the order the docs list them. */
export const SETTINGS: readonly SettingEntry[] = [
  {
    name: "INFEROPS_AUTH", group: "Identity", kind: "value", owner: "deployer", default: "off", source: "local",
    description: "Turns on \"Sign in with InferLab\" and per-person InferOps accounts. Version 1 spells it `features.inferlabLogin`.",
    requiredWhen: never,
    readAt: "`inferos.config.json` `capabilities.INFEROPS_AUTH` (version 2) or `features.inferlabLogin`; `scripts/run-dev-server.ts`",
    present: ({ config }) => inferOpsAuthRequested(config),
  },
  {
    name: "INFERLAB_AUTH_ORIGIN", group: "Identity", kind: "reference", owner: "deployer",
    default: `\`${DEFAULT_INFERLAB_AUTH_ORIGIN}\` (doctor warns when sign-in is on and it is unset)`, source: "local",
    description: "The InferLab central-auth origin: a bare HTTPS origin, or HTTP on loopback, with no credentials, path, query or fragment.",
    requiredWhen: whenSignIn,
    readAt: "Shell, passed to `gatekeeper-inferops` by `scripts/run-dev-server.ts` (`getInferLabLoginVars`)",
    present: ({ env }) => has(env, "INFERLAB_AUTH_ORIGIN"),
    whenMissing: { severity: "warning", note: `startup uses \`${DEFAULT_INFERLAB_AUTH_ORIGIN}\`, the local InferOps` },
  },
  {
    name: "AUTH_GATEKEEPERS", group: "Identity", kind: "value", owner: "deployer",
    default: "`inferops` is added when sign-in is on", source: "both",
    description: "Comma-separated sign-in gatekeeper vendors. Listing `inferops` needs the gatekeeper selected and a valid `INFERLAB_AUTH_ORIGIN`.",
    requiredWhen: {
      test: input => input.env.DISABLE_PASSWORD_AUTH === "true" && !signInRequested(input),
      text: "`DISABLE_PASSWORD_AUTH=true` and sign-in is off.",
    },
    readAt: "Shell, then the backend's `auth/config.ts`",
    present: ({ env }) => has(env, "AUTH_GATEKEEPERS"),
  },
  {
    name: "DISABLE_PASSWORD_AUTH", group: "Identity", kind: "value", owner: "deployer", default: "password login on", source: "both",
    description: "`true` turns password login off. It needs some sign-in gatekeeper in `AUTH_GATEKEEPERS`.",
    requiredWhen: never,
    readAt: "Shell, then the backend's `auth/config.ts`",
    present: ({ env }) => has(env, "DISABLE_PASSWORD_AUTH"),
  },
  {
    name: "INFEROPS_BASE_URL", group: "InferOps target", kind: "reference", owner: "deployer",
    default: "the InferLab origin", source: "local",
    description: "The InferOps API connected people call with their own session. An http(s) URL with no credentials.",
    requiredWhen: whenToken,
    readAt: "Shell, passed to `gatekeeper-inferops` (`http-inferops.ts` `endpointFromEnv`)",
    present: ({ env }) => has(env, "INFEROPS_BASE_URL"),
  },
  {
    name: "INFEROPS_API_TOKEN", group: "InferOps target", kind: "secret", owner: "developer", default: null, source: "local",
    description: "Local-development stopgap credential for accounts with no identity. Never a deployed credential.",
    requiredWhen: never,
    readAt: "Shell or `.dev.vars`, passed to `gatekeeper-inferops` (`connectionFromEnv`)",
    present: ({ env }) => has(env, "INFEROPS_API_TOKEN"),
  },
  {
    name: "INFEROPS_WORKSPACE_ID", group: "InferOps target", kind: "reference", owner: "developer", default: null, source: "local",
    description: "The workspace id the stopgap token acts in.",
    requiredWhen: whenToken,
    readAt: "Shell, passed to `gatekeeper-inferops` (`connectionFromEnv`)",
    present: ({ env }) => has(env, "INFEROPS_WORKSPACE_ID"),
  },
  {
    name: "INFEROPS_WORKSPACE_SLUG", group: "InferOps target", kind: "reference", owner: "developer", default: null, source: "local",
    description: "The stopgap workspace's slug. A board reference uses the token only when it names this workspace.",
    requiredWhen: whenToken,
    readAt: "Shell, passed to `gatekeeper-inferops` (`connectionFromEnv`)",
    present: ({ env }) => has(env, "INFEROPS_WORKSPACE_SLUG"),
  },
  {
    name: "inferops.targetRef", group: "InferOps target", kind: "reference", owner: "customer admin",
    default: "`inferops://demo.local/project/board/DEMO` (the mock)", source: "local",
    description: "The tenant, workspace and project board the customer works on (`inferops://<tenant>.<workspace>/project/board/<KEY>`). It identifies a board; it never authorizes one.",
    requiredWhen: always,
    readAt: "`inferos.config.json`, validated by `scripts/consumer/config.ts`",
    present: () => true,
  },
  {
    name: "inferops.mode", group: "InferOps target", kind: "value", owner: "deployer", default: "`fixture`", source: "local",
    description: "`fixture` serves the synthetic board. `remote` (with `inferops.baseUrl`) is parsed but has no adapter.",
    requiredWhen: always,
    readAt: "`inferos.config.json`",
    present: () => true,
  },
  {
    name: "Wiki binding", group: "InferOps target", kind: "reference", owner: "customer admin", default: null, source: "local",
    description: "The workspace Wiki the customer reads (`inferops://<tenant>.<workspace>/knowledge/wiki`).",
    requiredWhen: never,
    readAt: "No configuration field yet",
    present: () => null,
    unsupported: "Hosting the InferMind Wiki is pending (factory-level/inferos#87); intake records Wiki pillars only.",
  },
  {
    name: "INFEROPS_ENABLED", group: "Host and runtime", kind: "value", owner: "deployer",
    default: "off in version 2; on for version 1 and the plain checkout", source: "local",
    description: "The InferOps integration switch the gatekeeper enforces on every call. A version 2 wrapper's capability wins over the shell.",
    requiredWhen: never,
    readAt: "`inferos.config.json` `capabilities.INFEROPS_ENABLED` (version 2), else the shell; `resolveInferOpsEnabled`",
    present: inferOpsOn,
  },
  {
    name: "INFEROPS_TABLES_ENABLED", group: "Host and runtime", kind: "value", owner: "deployer", default: "off", source: "local",
    description: "Turns read-only InferOps custom-table bindings through the InferOps gatekeeper on. Needs `INFEROPS_ENABLED`; a version 2 wrapper's capability wins over the shell.",
    requiredWhen: never,
    readAt: "`inferos.config.json` `capabilities.INFEROPS_TABLES_ENABLED` (version 2), else the shell",
    present: tablesRequested,
  },
  {
    name: "INFEROPS_HOST_BOARDS", group: "Host and runtime", kind: "value", owner: "deployer", default: "off", source: "local",
    description: "Proposed: turns kernel host boards on (a console's host-rendered board, read by each operator through their own connection). Needs `INFEROPS_ENABLED`; a version 2 wrapper's capability wins over the shell.",
    requiredWhen: never,
    readAt: "`inferos.config.json` `capabilities.INFEROPS_HOST_BOARDS` (version 2), else the shell",
    present: hostBoardsRequested,
  },
  {
    name: "CONSOLE_TOOLS", group: "Host and runtime", kind: "value", owner: "deployer", default: "off", source: "local",
    description: "Turns callable widget tools on for console publication (`consoleToolsEnabled`): off unless exactly `\"true\"`. **Must not be set in any shared or deployed environment** until MVP-35 records the remote CPU, wall-time and memory checks as passed (see [operate mode](../architecture/operate-mode.md#configuration)); set only in test harnesses.",
    requiredWhen: { test: () => false, text: "Never, until MVP-35 passes." },
    readAt: "The shell only; no `inferos.config.json` field",
    present: ({ env }) => env.CONSOLE_TOOLS === "true",
  },
  {
    name: "INFEROPS_BOUND_VIEWS", group: "Host and runtime", kind: "value", owner: "deployer", default: "off", source: "local",
    description: "Proposed: turns kernel bound views on (a console's authored, declarative view of its host boards, rendered by trusted host code from each operator's own reads). Needs `INFEROPS_HOST_BOARDS`; a version 2 wrapper's capability wins over the shell.",
    requiredWhen: never,
    readAt: "`inferos.config.json` `capabilities.INFEROPS_BOUND_VIEWS` (version 2), else the shell",
    present: boundViewsRequested,
  },
  {
    name: "local.port", group: "Host and runtime", kind: "value", owner: "developer", default: "`8787`", source: "local",
    description: "The wrapper's local Workshop port, distinct per wrapper.",
    requiredWhen: always,
    readAt: "`inferos.config.json`; `pnpm dev` and `pnpm local start`",
    present: () => true,
  },
  {
    name: "upstream.revision", group: "Host and runtime", kind: "reference", owner: "deployer", default: null, source: "local",
    description: "The exact InferOS commit the wrapper pins (and `upstream.repository`, an HTTPS URL or absolute path with no credentials).",
    requiredWhen: always,
    readAt: "`inferos.config.json`, checked against the submodule by `inferos:check`",
    present: () => true,
  },
  {
    name: "Cloud deployment target", group: "Host and runtime", kind: "reference", owner: "deployer", default: null, source: "cloud",
    description: "Worker names, account and route for a hosted customer.",
    requiredWhen: never,
    readAt: "No wrapper deploy command yet",
    present: () => null,
    unsupported: "The private customer runs locally; cloud deployment is tracked in factory-level/inferos#11.",
  },
  {
    name: "features.customCloudflareCode", group: "Custom components", kind: "value", owner: "deployer", default: "off", source: "local",
    description: "Master switch for the wrapper's own Workers (`workers/`, listed in `inferos.extensions.json`) and gatekeepers (`gatekeepers/gatekeeper-<name>/`, listed in `gatekeepers`).",
    requiredWhen: never,
    readAt: "`inferos.config.json`; `scripts/consumer/extensions.ts` and `gatekeepers.ts`",
    present: ({ config }) => config.features.customCloudflareCode,
  },
  {
    name: "gatekeepers", group: "Custom components", kind: "value", owner: "deployer", default: "none (no wrapper gatekeeper loads)", source: "local",
    description: "`[{ slug, enabled }]`, at most 32: which wrapper gatekeepers may load. Each also needs a valid `connection.json` declaring a gatekeeper API level the pin implements; anything else is reported by `gatekeepers:check` and doctor, never bound. Grants no resource.",
    requiredWhen: never,
    readAt: "`inferos.config.json`; `readConsumerGatekeepers` in `scripts/consumer/gatekeepers.ts`",
    present: ({ config }) => (config.gatekeepers?.length ?? 0) > 0,
  },
  {
    name: "inferos.extensions.json", group: "Custom components", kind: "reference", owner: "developer", default: null, source: "local",
    description: "The custom component paths, each contained in the wrapper. `pnpm extensions:check` and `gatekeepers:check` validate them.",
    requiredWhen: { test: ({ config }) => config.features.customCloudflareCode, text: "`features.customCloudflareCode` is on." },
    readAt: "Wrapper root; `readConsumerWorkers` in `scripts/consumer/extensions.ts`",
    present: () => null,
  },
  {
    name: "CODING_WORKBENCH_ENABLED", group: "Coding adapter", kind: "value", owner: "deployer", default: "off", source: "local",
    description: "Turns coding dispatch through the InferOps gatekeeper on. Needs `INFEROPS_ENABLED`; a version 2 wrapper's capability wins over the shell.",
    requiredWhen: never,
    readAt: "`inferos.config.json` `capabilities.CODING_WORKBENCH_ENABLED` (version 2), else the shell",
    present: codingRequested,
  },
  {
    name: "codingWorkbench.repos", group: "Coding adapter", kind: "reference", owner: "developer", default: "none (nothing is allowlisted)", source: "local",
    description: "The repository allowlist: InferOps repository id, absolute local checkout path and test commands. Only the ids reach the gatekeeper (`CODING_WORKBENCH_REPOS`).",
    requiredWhen: whenCoding,
    readAt: "`inferos.config.json` (version 2), else the shell's `CODING_WORKBENCH_REPOS`",
    present: input => codingRepoIds(input).ids.length > 0,
  },
  {
    name: "INFEROPS_CLI", group: "Coding adapter", kind: "reference", owner: "developer", default: null, source: "local",
    description: "Absolute path of the pinned InferOps CLI that runs `inferops runner codex --result patch`.",
    requiredWhen: whenCoding,
    readAt: "Shell; for the local runner lifecycle (`pnpm local runner`, factory-level/inferos#72), which this revision does not ship yet",
    present: ({ env }) => has(env, "INFEROPS_CLI"),
  },
  {
    name: "INFEROPS_API_KEY", group: "Coding adapter", kind: "secret", owner: "developer", default: null, source: "local",
    description: "The runner's InferOps credential for claiming and finishing runs. The runner never passes it to Codex.",
    requiredWhen: whenCoding,
    readAt: "Shell of the InferOps runner (`inferops runner codex`)",
    present: ({ env }) => has(env, "INFEROPS_API_KEY"),
  },
  {
    name: "codex login", group: "Coding adapter", kind: "secret", owner: "developer", default: null, source: "local",
    description: "Codex signed in with ChatGPT. API-key login is refused; there is no fallback.",
    requiredWhen: whenCoding,
    readAt: "`CODEX_HOME`, through `codex login status` in the InferOps runner preflight (factory-level/inferos#71)",
    present: () => null,
  },
  {
    name: "PUBLISH_CLOUDFLAREOS_WIDGET", group: "Publication", kind: "value", owner: "deployer", default: "off", source: "local",
    description: "Lets widget-kind blueprints be published (`deployment` or `export`) once a deployment admin approves each one. Off refuses every publication operation and suspends widget publications; on again needs each one re-confirmed. Never publishes by itself.",
    requiredWhen: never,
    readAt: "`inferos.config.json` `capabilities.PUBLISH_CLOUDFLAREOS_WIDGET` (version 2), else the shell; the backend's `publication.ts`",
    present: input => publicationRequested(input, "PUBLISH_CLOUDFLAREOS_WIDGET"),
  },
  {
    name: "PUBLISH_CLOUDFLAREOS_APP", group: "Publication", kind: "value", owner: "deployer", default: "off", source: "local",
    description: "The same switch for app- and workflow-kind blueprints.",
    requiredWhen: never,
    readAt: "`inferos.config.json` `capabilities.PUBLISH_CLOUDFLAREOS_APP` (version 2), else the shell; the backend's `publication.ts`",
    present: input => publicationRequested(input, "PUBLISH_CLOUDFLAREOS_APP"),
  },
  {
    name: "PUBLICATION_SELF_APPROVAL", group: "Publication", kind: "value", owner: "deployer", default: "off", source: "both",
    description: "`true` lets a deployment admin approve a publication they requested; the record says so. Authorization config: env only, never an admin setting.",
    requiredWhen: never,
    readAt: "Shell, then the backend's `auth/config.ts`",
    present: ({ env }) => env.PUBLICATION_SELF_APPROVAL === "true",
  },
];

/** One problem with the settings. Messages name settings and problems only, never values. */
export interface SettingFinding {
  setting: string;
  /** `error` blocks doctor; `warning` is reported and does not. */
  severity: "error" | "warning";
  code: "missing" | "invalid" | "credentialed" | "contradictory" | "unsupported" | "unchecked";
  message: string;
}

/** One row's state in a report. Never carries a value. */
export interface SettingState {
  name: string;
  kind: SettingKind;
  required: boolean;
  state: "set" | "unset" | "unchecked" | "unsupported";
}

type UrlProblem = "credentialed" | "invalid" | null;

function urlProblem(value: string, protocols: readonly string[]): UrlProblem {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return "invalid"; }
  if (url.username || url.password) return "credentialed";
  return protocols.includes(url.protocol) ? null : "invalid";
}

/**
 * Check the selected settings against the resolved configuration and shell. Every finding is
 * redacted: it names the setting and the problem, never the value.
 */
export function validateSettings(config: ConsumerConfig, env: SettingsInput["env"], context: Pick<SettingsInput, "inferOpsGatekeeperSelected"> = {}) {
  const input: SettingsInput = { config, env, ...context };
  const findings: SettingFinding[] = [];
  const add = (setting: string, severity: SettingFinding["severity"], code: SettingFinding["code"], message: string) =>
    findings.push({ setting, severity, code, message });

  for (const entry of SETTINGS) {
    if (entry.requiredWhen.test(input) && entry.present(input) === false) {
      const message = `${entry.name} is required when ${lowerFirst(entry.requiredWhen.text)}`;
      add(entry.name, entry.whenMissing?.severity ?? "error", "missing",
        entry.whenMissing ? `${message}; unset, ${entry.whenMissing.note}` : message);
    }
  }

  // Identity. The default origin applies when sign-in is on and the shell names none.
  const origin = env.INFERLAB_AUTH_ORIGIN;
  if (has(env, "INFERLAB_AUTH_ORIGIN")) {
    if (urlProblem(origin!, ["https:", "http:"]) === "credentialed") {
      add("INFERLAB_AUTH_ORIGIN", "error", "credentialed", "INFERLAB_AUTH_ORIGIN contains credentials; use the bare origin");
    } else if (!isInferLabAuthOrigin(origin)) {
      add("INFERLAB_AUTH_ORIGIN", "error", "invalid", "INFERLAB_AUTH_ORIGIN is not a bare HTTPS origin (or HTTP on loopback)");
    }
  }
  const signIn = signInRequested(input);
  const loginError = inferLabLoginStartupError(
    { ...getInferLabLoginVars(signIn, env), DISABLE_PASSWORD_AUTH: env.DISABLE_PASSWORD_AUTH },
    input.inferOpsGatekeeperSelected ?? true);
  // An invalid origin is already reported above; this adds the contradictions only startup sees.
  if (loginError && !findings.some(finding => ["INFERLAB_AUTH_ORIGIN", "AUTH_GATEKEEPERS"].includes(finding.setting))) {
    add("AUTH_GATEKEEPERS", "error", "contradictory", loginError);
  }

  // The InferOps target.
  if (has(env, "INFEROPS_BASE_URL")) {
    const problem = urlProblem(env.INFEROPS_BASE_URL!, ["https:", "http:"]);
    if (problem === "credentialed") add("INFEROPS_BASE_URL", "error", "credentialed", "INFEROPS_BASE_URL contains credentials; the token travels separately");
    else if (problem) add("INFEROPS_BASE_URL", "error", "invalid", "INFEROPS_BASE_URL is not an http(s) URL");
  }
  const targetWorkspace = /^inferops:\/\/[^./]+\.([^/]+)\//.exec(config.inferops.targetRef)?.[1];
  if (has(env, "INFEROPS_API_TOKEN") && has(env, "INFEROPS_WORKSPACE_SLUG") && env.INFEROPS_WORKSPACE_SLUG!.trim() !== targetWorkspace) {
    add("INFEROPS_WORKSPACE_SLUG", "warning", "contradictory",
      "INFEROPS_WORKSPACE_SLUG does not name inferops.targetRef's workspace, so the stopgap token never serves the configured board");
  }
  if (config.inferops.mode === "remote") {
    add("inferops.mode", "error", "unsupported", "inferops.mode remote has no adapter; use fixture with the InferOps gatekeeper");
  }

  // Host and runtime: the switches the dev server resolves, and shell values a version 2 wrapper overrides.
  try {
    resolveInferOpsEnabled({
      capability: config.schemaVersion === 2 ? config.capabilities.INFEROPS_ENABLED : null,
      canvasSelected: input.inferOpsGatekeeperSelected ?? true,
      shell: env.INFEROPS_ENABLED,
    });
  } catch (error) { add("INFEROPS_ENABLED", "error", "contradictory", (error as Error).message); }
  if (config.schemaVersion === 2) {
    for (const name of ["INFEROPS_ENABLED", "CODING_WORKBENCH_ENABLED", "INFEROPS_TABLES_ENABLED", "INFEROPS_HOST_BOARDS", "INFEROPS_BOUND_VIEWS"] as const) {
      if (env[name] !== undefined && env[name] !== String(config.capabilities[name])) {
        add(name, "warning", "contradictory", `The shell's ${name} differs from the wrapper capability, which wins; unset it`);
      }
    }
    if (env.CODING_WORKBENCH_REPOS !== undefined) {
      add("codingWorkbench.repos", "warning", "contradictory", "The shell's CODING_WORKBENCH_REPOS is ignored; a version 2 wrapper's codingWorkbench.repos is the allowlist");
    }
  } else {
    for (const name of ["CODING_WORKBENCH_ENABLED", "INFEROPS_TABLES_ENABLED", "INFEROPS_HOST_BOARDS", "INFEROPS_BOUND_VIEWS"] as const) {
      if (env[name] !== undefined && !["true", "false"].includes(env[name]!)) {
        add(name, "error", "invalid", `${name} must be "true" or "false"`);
      }
    }
  }
  if (tablesRequested(input) && !inferOpsOn(input)) {
    add("INFEROPS_TABLES_ENABLED", "error", "contradictory", "INFEROPS_TABLES_ENABLED is on, but the InferOps integration (INFEROPS_ENABLED) is off");
  }
  if (hostBoardsRequested(input) && !inferOpsOn(input)) {
    add("INFEROPS_HOST_BOARDS", "error", "contradictory", "INFEROPS_HOST_BOARDS is on, but the InferOps integration (INFEROPS_ENABLED) is off");
  }
  if (boundViewsRequested(input) && !(hostBoardsRequested(input) && inferOpsOn(input))) {
    add("INFEROPS_BOUND_VIEWS", "error", "contradictory", "INFEROPS_BOUND_VIEWS is on, but host boards (INFEROPS_HOST_BOARDS) are off");
  }

  // Publication. A version 2 wrapper's capabilities win over the shell, as for coding dispatch.
  for (const name of PUBLICATION_FLAG_NAMES) {
    if (config.schemaVersion === 2) {
      if (env[name] !== undefined && env[name] !== String(config.capabilities[name])) {
        add(name, "warning", "contradictory", `The shell's ${name} differs from the wrapper capability, which wins; unset it`);
      }
    } else if (env[name] !== undefined && !["true", "false"].includes(env[name]!)) {
      add(name, "error", "invalid", `${name} must be "true" or "false"`);
    }
  }
  if (env.PUBLICATION_SELF_APPROVAL !== undefined && !["true", "false"].includes(env.PUBLICATION_SELF_APPROVAL)) {
    add("PUBLICATION_SELF_APPROVAL", "error", "invalid", 'PUBLICATION_SELF_APPROVAL must be "true" or "false"');
  }

  // The coding adapter.
  if (codingRequested(input)) {
    if (!inferOpsOn(input)) {
      add("CODING_WORKBENCH_ENABLED", "error", "contradictory", "CODING_WORKBENCH_ENABLED is on, but the InferOps integration (INFEROPS_ENABLED) is off");
    }
    const { ignored } = codingRepoIds(input);
    if (ignored) add("codingWorkbench.repos", "warning", "invalid", `${ignored} allowlist entries are not repository UUIDs and are ignored`);
    if (has(env, "INFEROPS_CLI") && !isAbsolute(env.INFEROPS_CLI!.trim())) {
      add("INFEROPS_CLI", "error", "invalid", "INFEROPS_CLI must be an absolute path");
    }
    add("codex login", "warning", "unchecked", "Doctor does not run Codex; the runner preflight refuses API-key login, so sign in with ChatGPT (codex login)");
  }

  const states: SettingState[] = SETTINGS.map(entry => {
    const present = entry.present(input);
    return {
      name: entry.name, kind: entry.kind, required: entry.requiredWhen.test(input),
      state: entry.unsupported ? "unsupported" : present === null ? "unchecked" : present ? "set" : "unset",
    };
  });
  return { ok: !findings.some(finding => finding.severity === "error"), findings, settings: states };
}

const lowerFirst = (text: string) => text.replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, letter => letter.toLowerCase());

/** The doctor check for a validation result: an error only for error findings. */
export function settingsDiagnostic(result: ReturnType<typeof validateSettings>) {
  const errors = result.findings.filter(finding => finding.severity === "error");
  const warnings = result.findings.filter(finding => finding.severity === "warning");
  const unsupported = result.settings.filter(setting => setting.state === "unsupported").map(setting => setting.name);
  const status: "pass" | "warning" | "error" = errors.length ? "error" : warnings.length ? "warning" : "pass";
  const message = [
    ...[...errors, ...warnings].map(finding => finding.message),
    `${result.settings.filter(setting => setting.required).length} settings required for this configuration` +
      (unsupported.length ? `; not supported yet: ${unsupported.join(", ")}` : ""),
  ].join("; ");
  return { name: "settings", status, message };
}

export const DOC_BEGIN = "<!-- settings:begin (generated by node scripts/consumer/settings.ts; do not edit) -->";
export const DOC_END = "<!-- settings:end -->";

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The generated Markdown section, one table per group. */
export function renderSettingsTable(entries: readonly SettingEntry[] = SETTINGS): string {
  const groups = [...new Set(entries.map(entry => entry.group))];
  const lines = [DOC_BEGIN, ""];
  for (const group of groups) {
    lines.push(`### ${group}`, "", "| Setting | Kind | Owner | Default | Required when | Source | Read from | Notes |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const entry of entries.filter(candidate => candidate.group === group)) {
      const notes = entry.unsupported ? `${entry.description} **Unsupported:** ${entry.unsupported}` : entry.description;
      lines.push(`| ${[`\`${entry.name}\``, entry.kind, entry.owner, entry.default ?? "none", entry.requiredWhen.text, entry.source, entry.readAt, notes].map(cell).join(" | ")} |`);
    }
    lines.push("");
  }
  lines.push(DOC_END);
  return lines.join("\n");
}

/** `text` with its generated section replaced by `section`. Throws when the markers are missing. */
export function replaceGeneratedSection(text: string, section: string): string {
  const begin = text.indexOf(DOC_BEGIN);
  const end = text.indexOf(DOC_END);
  if (begin === -1 || end < begin) throw new Error("configuration-reference.md lacks the settings markers");
  return text.slice(0, begin) + section + text.slice(end + DOC_END.length);
}

/** The committed reference document this module generates into. */
export const REFERENCE_DOC = join(dirname(fileURLToPath(import.meta.url)), "../../docs/wiki/configuration-reference.md");

function main(args: readonly string[]) {
  if (args.some(arg => arg !== "--check")) throw new Error("Usage: node scripts/consumer/settings.ts [--check]");
  const current = readFileSync(REFERENCE_DOC, "utf8");
  const generated = replaceGeneratedSection(current, renderSettingsTable());
  if (args.includes("--check")) {
    if (generated !== current) throw new Error("docs/wiki/configuration-reference.md is out of date; run node scripts/consumer/settings.ts");
    return;
  }
  if (generated !== current) writeFileSync(REFERENCE_DOC, generated);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
