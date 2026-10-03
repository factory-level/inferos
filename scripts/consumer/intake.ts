import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseCanvasDefinition, type CanvasSection } from "../../packages/workshop-shared/src/canvas.ts";
import { canvasInventory, CANVAS_CONFIG_FILE, DEFAULT_CANVAS_CONFIG, resolveCanvasConfig, type CanvasConfig } from "./canvas.ts";
import { CAPABILITY_REQUIREMENTS, migrateConsumerConfig, parseConsumerConfig, type CapabilityName } from "./config.ts";
import { capabilitySources, featureSources, inferOpsGatekeeperSelected, unsupportedCapabilities } from "./runtime.ts";

/** The only intake format version this revision reads. */
export const INTAKE_SCHEMA_VERSION = 1;
/** Largest intake file accepted, in bytes. */
export const INTAKE_MAX_BYTES = 256 * 1024;

/** Product capabilities a customer can ask for. Each maps to zero or more configuration capabilities. */
export const PRODUCT_CAPABILITIES = [
  "kanban", "wiki", "local-coding", "state-machine", "harness", "publish-widget", "publish-app", "agent-deployments",
] as const;
/** One product capability name. */
export type ProductCapability = typeof PRODUCT_CAPABILITIES[number];

/** What a requirement is about; the category alone decides its disposition. */
export const REQUIREMENT_CATEGORIES = [
  "kanban", "sign-in", "views", "wiki", "local-coding", "state-machine", "harness", "publish-widget", "publish-app",
  "agent-deployments", "deployment", "custom-component", "integration",
] as const;
/** One requirement category. */
export type RequirementCategory = typeof REQUIREMENT_CATEGORIES[number];

/** A reviewed customer intake (schema version 1): the input `intake apply` derives a wrapper from. */
export interface ConsumerIntake {
  schemaVersion: 1;
  /** True for invented sample data. Reports and drafted issues carry the label. */
  synthetic: boolean;
  review: { status: "reviewed" | "draft"; reviewedBy: string; reviewedOn: string };
  customer: { name: string };
  inferops: { tenant: string; workspace: string; projects: { key: string; name: string; workflow: "software" | "content" }[] };
  capabilities: ProductCapability[];
  wiki: { pillars: { id: string; title: string }[] };
  operations: { id: string; name: string; owner: string; project: string; pillar: string | null; sop: string | null }[];
  requirements: { id: string; text: string; category: RequirementCategory }[];
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// Every message names the field and the rule, never the rejected value: an intake can hold anything.
const fail = (path: string, rule: string): never => { throw new Error(`${path}: ${rule}`); };

const exact = (value: unknown, keys: readonly string[], path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) fail(path, `expected exactly ${keys.join(", ")}`);
  return record;
};

const text = (value: unknown, path: string, max: number, multiline = false): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(path, `expected nonempty string of at most ${max} characters`);
  // Control characters other than newlines/tabs in free text are never meaningful in a requirement.
  if ((value as string).split("").some(char => char < " " && !(multiline && (char === "\n" || char === "\t")))) fail(path, "control characters are not allowed");
  return value as string;
};

const pattern = (value: unknown, regex: RegExp, path: string, rule: string): string => {
  if (typeof value !== "string" || !regex.test(value)) fail(path, rule);
  return value as string;
};

const list = (value: unknown, path: string, min: number, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `expected array of ${min} to ${max} entries`);
  return value as unknown[];
};

const choice = <T extends string>(value: unknown, choices: readonly T[], path: string): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(path, `expected one of ${choices.join(", ")}`);
  return value as T;
};

const unique = (values: string[], path: string) => {
  if (new Set(values).size !== values.length) fail(path, "duplicate entry");
};

/** Which product capability each requirement category needs listed in `capabilities`. */
const CATEGORY_PRODUCT: Record<RequirementCategory, ProductCapability | null> = {
  kanban: "kanban", "sign-in": "kanban", views: "kanban", wiki: "wiki", "local-coding": "local-coding",
  "state-machine": "state-machine", harness: "harness", "publish-widget": "publish-widget", "publish-app": "publish-app",
  "agent-deployments": "agent-deployments", deployment: null, "custom-component": null, integration: null,
};

/** Validate an untrusted intake strictly and within bounds, without echoing any rejected value. */
export function parseIntake(input: unknown): ConsumerIntake {
  if ((input as { schemaVersion?: unknown } | null)?.schemaVersion !== INTAKE_SCHEMA_VERSION) {
    fail("schemaVersion", `only version ${INTAKE_SCHEMA_VERSION} is supported`);
  }
  const root = exact(input, ["schemaVersion", "synthetic", "review", "customer", "inferops", "capabilities", "wiki", "operations", "requirements"], "intake");
  if (typeof root.synthetic !== "boolean") fail("synthetic", "expected boolean");
  const review = exact(root.review, ["status", "reviewedBy", "reviewedOn"], "review");
  const reviewedOn = pattern(review.reviewedOn, /^\d{4}-\d{2}-\d{2}$/, "review.reviewedOn", "expected YYYY-MM-DD date");
  const customer = exact(root.customer, ["name"], "customer");
  const inferops = exact(root.inferops, ["tenant", "workspace", "projects"], "inferops");
  const projects = list(inferops.projects, "inferops.projects", 1, 12).map((entry, index) => {
    const path = `inferops.projects[${index}]`;
    const project = exact(entry, ["key", "name", "workflow"], path);
    return {
      key: pattern(project.key, KEY, `${path}.key`, "expected 2 to 10 uppercase letters or digits, starting with a letter"),
      name: text(project.name, `${path}.name`, 80),
      workflow: choice(project.workflow, ["software", "content"] as const, `${path}.workflow`),
    };
  });
  unique(projects.map(project => project.key), "inferops.projects");
  const capabilities = list(root.capabilities, "capabilities", 0, PRODUCT_CAPABILITIES.length)
    .map((name, index) => choice(name, PRODUCT_CAPABILITIES, `capabilities[${index}]`));
  unique(capabilities, "capabilities");
  const wiki = exact(root.wiki, ["pillars"], "wiki");
  const pillars = list(wiki.pillars, "wiki.pillars", 0, 32).map((entry, index) => {
    const pillar = exact(entry, ["id", "title"], `wiki.pillars[${index}]`);
    return { id: pattern(pillar.id, SLUG, `wiki.pillars[${index}].id`, "expected lowercase slug"), title: text(pillar.title, `wiki.pillars[${index}].title`, 120) };
  });
  unique(pillars.map(pillar => pillar.id), "wiki.pillars");
  if (pillars.length && !capabilities.includes("wiki")) fail("wiki.pillars", "selecting pillars requires the wiki capability");
  const operations = list(root.operations, "operations", 0, 256).map((entry, index) => {
    const path = `operations[${index}]`;
    const operation = exact(entry, ["id", "name", "owner", "project", "pillar", "sop"], path);
    const project = pattern(operation.project, KEY, `${path}.project`, "expected a project key");
    if (!projects.some(candidate => candidate.key === project)) fail(`${path}.project`, "expected a key listed in inferops.projects");
    const pillar = operation.pillar === null ? null : pattern(operation.pillar, SLUG, `${path}.pillar`, "expected lowercase slug or null");
    if (pillar !== null && !pillars.some(candidate => candidate.id === pillar)) fail(`${path}.pillar`, "expected a pillar listed in wiki.pillars");
    return {
      id: pattern(operation.id, ID, `${path}.id`, "expected identifier"),
      name: text(operation.name, `${path}.name`, 120),
      owner: text(operation.owner, `${path}.owner`, 120),
      project, pillar,
      sop: operation.sop === null ? null : text(operation.sop, `${path}.sop`, 512),
    };
  });
  unique(operations.map(operation => operation.id), "operations");
  const requirements = list(root.requirements, "requirements", 1, 256).map((entry, index) => {
    const path = `requirements[${index}]`;
    const requirement = exact(entry, ["id", "text", "category"], path);
    const category = choice(requirement.category, REQUIREMENT_CATEGORIES, `${path}.category`);
    const product = CATEGORY_PRODUCT[category];
    if (product && !capabilities.includes(product)) fail(`${path}.category`, `requires the ${product} capability in capabilities`);
    return { id: pattern(requirement.id, ID, `${path}.id`, "expected identifier"), text: text(requirement.text, `${path}.text`, 2000, true), category };
  });
  unique(requirements.map(requirement => requirement.id), "requirements");
  return {
    schemaVersion: 1,
    synthetic: root.synthetic as boolean,
    review: { status: choice(review.status, ["reviewed", "draft"] as const, "review.status"), reviewedBy: text(review.reviewedBy, "review.reviewedBy", 120), reviewedOn },
    customer: { name: text(customer.name, "customer.name", 80) },
    inferops: {
      tenant: pattern(inferops.tenant, SLUG, "inferops.tenant", "expected lowercase slug"),
      workspace: pattern(inferops.workspace, SLUG, "inferops.workspace", "expected lowercase slug"),
      projects,
    },
    capabilities, wiki: { pillars }, operations, requirements,
  };
}

/** Read and validate an intake file: a regular JSON file of at most {@link INTAKE_MAX_BYTES}. */
export function readIntakeFile(path: string): { intake: ConsumerIntake; sha256: string } {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error("Intake file not found"); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Intake must be a regular file, not a link or directory");
  if (stat.size > INTAKE_MAX_BYTES) throw new Error(`Intake exceeds ${INTAKE_MAX_BYTES} bytes`);
  const bytes = readFileSync(path);
  let input: unknown;
  try { input = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Intake is not valid JSON"); }
  return { intake: parseIntake(input), sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The `inferops://` board reference for one project of the intake's workspace (ADR 0005). It identifies; it never authorizes. */
export const boardReference = (intake: ConsumerIntake, key: string) =>
  `inferops://${intake.inferops.tenant}.${intake.inferops.workspace}/project/board/${key}`;

/** How each product capability is delivered: the configuration capabilities that carry it and its tracking issue. */
export const PRODUCT_SUPPORT: Record<ProductCapability, { flags: readonly CapabilityName[]; tracking: string | null }> = {
  kanban: { flags: ["INFEROPS_ENABLED", "INFEROPS_AUTH"], tracking: null },
  // The Wiki has no InferOS flag: hosting it is the work of #87, so it is pending whatever the pin.
  wiki: { flags: [], tracking: "factory-level/inferos#87" },
  "local-coding": { flags: ["CODING_WORKBENCH_ENABLED"], tracking: "factory-level/inferos#69" },
  "state-machine": { flags: ["INFEROPS_CANVAS_STATE_MACHINE"], tracking: null },
  harness: { flags: ["HARNESS_HG_ENABLED"], tracking: null },
  "publish-widget": { flags: ["PUBLISH_CLOUDFLAREOS_WIDGET"], tracking: null },
  "publish-app": { flags: ["PUBLISH_CLOUDFLAREOS_APP"], tracking: null },
  "agent-deployments": { flags: ["AGENT_DEPLOYMENTS"], tracking: null },
};

const installed = (upstream: string, source: string | null) => source !== null && existsSync(join(upstream, source));

/** Whether this pin honours every configuration capability a product capability needs. */
export function productSupported(product: ProductCapability, upstream: string, sources = capabilitySources): boolean {
  const { flags } = PRODUCT_SUPPORT[product];
  return flags.length > 0 && flags.every(flag => installed(upstream, sources[flag]));
}

/** `supported`: this pin configures it. `unsupported`: no code in this pin. `custom-work`: wrapper-owned code, not configuration. */
export type Disposition = "supported" | "unsupported" | "custom-work";

/** A requirement's outcome. Every intake requirement gets exactly one; none is dropped. */
export interface RequirementDisposition {
  id: string;
  text: string;
  category: RequirementCategory;
  disposition: Disposition;
  reason: string;
  /** What carries it: configuration capabilities, `features` flags and the tracking issue, when any. */
  maps: { capabilities: CapabilityName[]; features: string[]; issue: string | null };
  /** For `supported`: whether the wrapper now holds every mapped value (a kept customer edit can leave it off). */
  configured: boolean | null;
  /** A gap issue drafted for every `unsupported` and `custom-work` requirement. */
  draft: { title: string; body: string } | null;
  /** The issue URL once filed with `--file-issues`. */
  filed: string | null;
}

/** Decide each requirement's disposition against the capability support of the pin at `upstream`. */
export function disposeRequirements(intake: ConsumerIntake, upstream: string, sources = capabilitySources): RequirementDisposition[] {
  return intake.requirements.map(requirement => {
    const base = { ...requirement, configured: null, draft: null, filed: null };
    const outcome = (disposition: Disposition, reason: string, maps: Partial<RequirementDisposition["maps"]> = {}) =>
      ({ ...base, disposition, reason, maps: { capabilities: [], features: [], issue: null, ...maps } });
    switch (requirement.category) {
      case "kanban": case "sign-in": {
        const flag: CapabilityName = requirement.category === "kanban" ? "INFEROPS_ENABLED" : "INFEROPS_AUTH";
        const issue = requirement.category === "sign-in" ? "factory-level/inferos#66" : null;
        return installed(upstream, sources[flag])
          ? outcome("supported", `${flag} is implemented in this pin and switched on by the intake; live acceptance is recorded against a running InferOps`, { capabilities: [flag], issue })
          : outcome("unsupported", `${flag} has no implementation in this pin`, { capabilities: [flag], issue });
      }
      case "views": {
        const features = ["composableViews", "durableViews"] as const;
        // The starter view holds InferOps boards, so it needs the integration as well as the canvas store.
        const maps = { capabilities: ["INFEROPS_ENABLED" as const], features: [...features] };
        return features.every(name => existsSync(join(upstream, featureSources[name]))) && installed(upstream, sources.INFEROPS_ENABLED)
          ? outcome("supported", "The inferops-operations profile turns on composable and durable views; the intake writes a starter view of the customer boards", maps)
          : outcome("unsupported", "This pin lacks the canvas store or InferOps integration that a saved board view needs", maps);
      }
      case "wiki":
        return outcome("unsupported", "Hosting the InferMind Wiki with the selected pillars is pending; pillars are recorded in the report only", { issue: PRODUCT_SUPPORT.wiki.tracking });
      case "deployment":
        return outcome("unsupported", "No deploy command exists; deployment stays a separate explicit step and the intake never deploys", { issue: "factory-level/inferos#11" });
      case "custom-component":
        return outcome("custom-work", "Customer-specific code belongs in the wrapper (workers/, gatekeepers/, blueprints/); configuration cannot express it", { issue: "factory-level/inferos#36" });
      case "integration":
        return outcome("custom-work", "A new external connection is a wrapper-owned gatekeeper with its own grants; configuration cannot express it", { issue: "factory-level/inferos#9" });
      default: {
        const product = requirement.category;
        const { flags, tracking } = PRODUCT_SUPPORT[product];
        return productSupported(product, upstream, sources)
          ? outcome("supported", `${flags.join(", ")} is implemented in this pin and switched on by the intake`, { capabilities: [...flags], issue: tracking })
          : outcome("unsupported", `${flags.join(", ")} has no implementation in this pin, so the intake leaves it off`, { capabilities: [...flags], issue: tracking });
      }
    }
  });
}

/** The configuration capabilities an intake switches on: those of requested products this pin supports, with their requirements met. */
export function derivedCapabilities(intake: ConsumerIntake, upstream: string, sources = capabilitySources): CapabilityName[] {
  const enabled = new Set(intake.capabilities.filter(product => productSupported(product, upstream, sources)).flatMap(product => PRODUCT_SUPPORT[product].flags));
  // Never switch on a capability whose prerequisites stay off; the parser would reject it anyway.
  for (const flag of enabled) if (CAPABILITY_REQUIREMENTS[flag]?.some(required => !enabled.has(required))) enabled.delete(flag);
  return [...enabled].toSorted();
}

/** The view and screen template id the intake owns. */
export const CUSTOMER_VIEW_ID = "customer-operations";
/** The wrapper-relative starter view file the intake owns. */
export const CUSTOMER_VIEW_FILE = `views/${CUSTOMER_VIEW_ID}.json`;
/** Where the wrapper records what the intake manages; committed with the wrapper. */
export const MANAGED_RECORD_FILE = ".inferos/intake-managed.json";
/** The generated reports, rewritten on every apply. */
export const REPORT_FILES = { json: "intake-report.json", markdown: "intake-report.md" } as const;

/** One section per project, each with its board: shared by the starter view and the screen template. */
function customerSections(intake: ConsumerIntake): CanvasSection[] {
  return intake.inferops.projects.map(project => ({
    id: `project-${project.key.toLowerCase()}`, title: `${project.name} (${project.key})`, columns: 1,
    widgets: [{
      id: `board-${project.key.toLowerCase()}`, kind: "inferops.project-board", version: 1, targetRef: boardReference(intake, project.key),
      size: "full", params: { workflow: project.workflow, showCompleted: false },
    }],
  }));
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A value the intake manages. `baseline`, when given, is a default it may replace on first apply. */
interface Slot { key: string; desired: Json; baseline?: Json; read(): Json | undefined; write(value: Json): void }

/** What happened to one managed field. */
export interface FieldChange {
  /** `file:locator` of the managed value. */
  field: string;
  /**
   * `set`: written. `unchanged`: already the intake's value. `customized`: a customer edit, kept, while the
   * intake's value is unchanged. `conflict`: the customer's value and the intake's both changed (or the value
   * predates the intake), kept and not overwritten. `released`: no longer derived; the value is left as is.
   */
  action: "set" | "unchanged" | "customized" | "conflict" | "released";
}

interface ManagedRecord { version: 1; intakeSha256: string; fields: Record<string, Json>; filedIssues: Record<string, string> }

function readManagedRecord(root: string): ManagedRecord {
  const path = join(root, MANAGED_RECORD_FILE);
  if (!existsSync(path)) return { version: 1, intakeSha256: "", fields: {}, filedIssues: {} };
  let record: ManagedRecord;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`${MANAGED_RECORD_FILE} is not valid JSON; restore it from version control`); }
  if (record?.version !== 1 || typeof record.fields !== "object" || typeof record.filedIssues !== "object") {
    throw new Error(`${MANAGED_RECORD_FILE} has an unsupported shape; restore it from version control`);
  }
  return record;
}

/**
 * Reconcile each slot against what the intake last wrote. A value equal to the last written one is the
 * intake's to update; anything else is the customer's and is kept. Unmanaged fields are never read.
 */
function reconcile(slots: Slot[], record: ManagedRecord): { changes: FieldChange[]; fields: Record<string, Json> } {
  const changes: FieldChange[] = [];
  const fields: Record<string, Json> = {};
  for (const slot of slots) {
    const current = slot.read();
    const prior = Object.hasOwn(record.fields, slot.key) ? record.fields[slot.key] : undefined;
    let action: FieldChange["action"];
    if (same(current, slot.desired)) action = "unchanged";
    else if (prior !== undefined ? same(current, prior) : current === undefined || (slot.baseline !== undefined && same(current, slot.baseline))) {
      slot.write(slot.desired);
      action = "set";
    } else action = prior !== undefined && same(slot.desired, prior) ? "customized" : "conflict";
    // A kept value leaves the record at what the intake last wrote, so a later intake change is still detected.
    fields[slot.key] = action === "set" || action === "unchanged" ? slot.desired : prior ?? slot.desired;
    if (action === "conflict" && prior === undefined) delete fields[slot.key];
    changes.push({ field: slot.key, action });
  }
  for (const key of Object.keys(record.fields)) if (!slots.some(slot => slot.key === key)) changes.push({ field: key, action: "released" });
  return { changes, fields };
}

/** Run a command and return its standard output. Injected in tests so nothing reaches GitHub. */
export type ExecSeam = (command: string, args: string[]) => string;

const defaultExec: ExecSeam = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Options for {@link applyIntake}. */
export interface ApplyIntakeOptions {
  /** The pinned InferOS checkout whose support table applies. Defaults to the checkout holding this script. */
  upstream?: string;
  /** File drafted gap issues in this `owner/repo` with `gh issue create`. Omitted, nothing is filed. */
  fileIssues?: string;
  /** Replaces `gh` for filing; tests inject it. */
  exec?: ExecSeam;
  /** Runs the wrapper's `inferos:check`; tests may inject it. Returns null when it passes, else a short reason. */
  check?: (root: string) => string | null;
}

const UPSTREAM = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const runWrapperCheck = (root: string): string | null => {
  const result = spawnSync(process.execPath, [join(root, ".inferos/runtime.ts"), "check"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? null : (result.stderr.trim().split("\n").at(-1) || "inferos:check failed");
};

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/**
 * Derive the wrapper at `root` from a reviewed intake: configuration capabilities, profile, the starter
 * view and screen template, and a report with every requirement's disposition. Only managed fields are
 * written; customer edits are kept and reported. Validates with `inferos:check` and rolls every write
 * back if it fails. Files gap issues only with `fileIssues`. Never deploys.
 */
export function applyIntake(root: string, intakePath: string, options: ApplyIntakeOptions = {}) {
  const upstream = options.upstream ?? UPSTREAM;
  if (options.fileIssues !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.fileIssues)) {
    throw new Error("--file-issues: expected OWNER/REPO");
  }
  const { intake, sha256 } = readIntakeFile(intakePath);
  if (intake.review.status !== "reviewed") throw new Error("Intake is a draft; apply only a reviewed intake (review.status \"reviewed\")");
  const configPath = join(root, "inferos.config.json");
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
  const startVersion = parseConsumerConfig(rawConfig).schemaVersion;
  const config = startVersion === 1
    ? migrateConsumerConfig(rawConfig, { inferOpsGatekeeperSelected: inferOpsGatekeeperSelected(root, upstream) }) as Record<string, any>
    : structuredClone(rawConfig);
  const record = readManagedRecord(root);
  const capabilities = derivedCapabilities(intake, upstream);
  const kanban = capabilities.includes("INFEROPS_ENABLED");

  const slots: Slot[] = [{
    key: "inferos.config.json:/profile", desired: "inferops-operations",
    read: () => config.profile, write: value => { config.profile = value; },
  }];
  for (const flag of capabilities) {
    slots.push({
      key: `inferos.config.json:/capabilities/${flag}`, desired: true, baseline: false,
      read: () => config.capabilities[flag], write: value => { config.capabilities[flag] = value; },
    });
  }

  const inventory = kanban ? canvasInventory(root, upstream) : null;
  const canvasPath = join(root, CANVAS_CONFIG_FILE);
  const canvasExisted = existsSync(canvasPath);
  const canvas: CanvasConfig = canvasExisted ? JSON.parse(readFileSync(canvasPath, "utf8")) : structuredClone(DEFAULT_CANVAS_CONFIG);
  const viewPath = join(root, CUSTOMER_VIEW_FILE);
  let view: Json | undefined;
  if (kanban) {
    const sections = customerSections(intake) as unknown as Json;
    const title = intake.customer.name;
    slots.push({
      key: `${CANVAS_CONFIG_FILE}:/customGatekeepers[gatekeeper-inferops]`, desired: true, baseline: false,
      read: () => canvas.customGatekeepers === "all" || canvas.customGatekeepers.includes("gatekeeper-inferops"),
      write: () => {
        if (canvas.customGatekeepers !== "all") canvas.customGatekeepers = [...new Set([...canvas.customGatekeepers, "gatekeeper-inferops"])].toSorted();
      },
    }, {
      key: `${CANVAS_CONFIG_FILE}:/screens[id=${CUSTOMER_VIEW_ID}]`, desired: { id: CUSTOMER_VIEW_ID, title, sections },
      read: () => canvas.screens.find(screen => screen.id === CUSTOMER_VIEW_ID) as Json | undefined,
      write: value => {
        const index = canvas.screens.findIndex(screen => screen.id === CUSTOMER_VIEW_ID);
        // First in the list, so `pnpm local seed` opens the customer's screen.
        if (index === -1) canvas.screens.unshift(value as unknown as CanvasConfig["screens"][number]);
        else canvas.screens[index] = value as unknown as CanvasConfig["screens"][number];
      },
    });
    if (existsSync(viewPath) && (lstatSync(viewPath).isSymbolicLink() || !lstatSync(viewPath).isFile())) {
      throw new Error(`${CUSTOMER_VIEW_FILE} must be a regular file`);
    }
    let currentView: Json | undefined;
    if (existsSync(viewPath)) {
      try { currentView = JSON.parse(readFileSync(viewPath, "utf8")); } catch { currentView = "unreadable"; }
    }
    view = currentView;
    slots.push({
      key: CUSTOMER_VIEW_FILE, desired: { schemaVersion: 1, id: CUSTOMER_VIEW_ID, revision: "0", title, sections },
      read: () => currentView, write: value => { view = value; },
    });
  }

  const { changes, fields } = reconcile(slots, record);
  const changed = (prefix: string) => changes.some(change => change.action === "set" && change.field.startsWith(prefix));

  // Validate everything before any write: the same parsers the launcher and Workshop use.
  const resolved = parseConsumerConfig(config);
  const blocked = unsupportedCapabilities(resolved, upstream);
  if (blocked.length) throw new Error(`Derived configuration enables capabilities this pin does not support: ${blocked.join(", ")}`);
  if (inventory && changed(`${CANVAS_CONFIG_FILE}:`)) resolveCanvasConfig(canvas, inventory);
  if (changed(CUSTOMER_VIEW_FILE)) parseCanvasDefinition(view);

  const requirements: RequirementDisposition[] = disposeRequirements(intake, upstream).map(requirement => {
    const configured = requirement.disposition !== "supported" ? null
      : requirement.maps.capabilities.every(flag => resolved.schemaVersion === 2 && resolved.capabilities[flag])
        && requirement.maps.features.every(name => resolved.features[name as keyof typeof resolved.features]);
    return { ...requirement, configured, draft: requirement.disposition === "supported" ? null : draftIssue(intake, requirement, sha256) };
  });

  const writes = new Map<string, string>();
  if (startVersion === 1 || changed("inferos.config.json:")) writes.set(configPath, json(config));
  if (changed(`${CANVAS_CONFIG_FILE}:`)) writes.set(canvasPath, json(canvas));
  if (changed(CUSTOMER_VIEW_FILE)) writes.set(viewPath, json(view));
  const recordPath = join(root, MANAGED_RECORD_FILE);
  const nextRecord: ManagedRecord = { version: 1, intakeSha256: sha256, fields, filedIssues: { ...record.filedIssues } };
  writes.set(recordPath, json(nextRecord));

  const backups = new Map<string, Buffer | null>();
  for (const path of writes.keys()) backups.set(path, existsSync(path) ? readFileSync(path) : null);
  const restore = () => {
    for (const [path, previous] of backups) {
      if (previous === null) rmSync(path, { force: true });
      else writeFileSync(path, previous);
    }
  };
  for (const [path, content] of writes) writeFileSync(path, content);
  const failure = (options.check ?? runWrapperCheck)(root);
  if (failure !== null) {
    restore();
    throw new Error(`inferos:check failed for the derived wrapper, so every write was rolled back: ${failure}`);
  }

  // Filing happens only on request and after the wrapper checks, and never twice for one requirement.
  if (options.fileIssues !== undefined) {
    const exec = options.exec ?? defaultExec;
    for (const requirement of requirements) {
      if (!requirement.draft) continue;
      const existing = nextRecord.filedIssues[requirement.id];
      if (existing) { requirement.filed = existing; continue; }
      let url: string;
      try {
        url = exec("gh", ["issue", "create", "--repo", options.fileIssues, "--title", requirement.draft.title, "--body", requirement.draft.body]).trim();
      } catch {
        writeFileSync(recordPath, json(nextRecord));
        throw new Error(`gh issue create failed for requirement ${requirement.id}; issues filed before it are recorded in ${MANAGED_RECORD_FILE}`);
      }
      nextRecord.filedIssues[requirement.id] = url;
      requirement.filed = url;
    }
    writeFileSync(recordPath, json(nextRecord));
  } else {
    for (const requirement of requirements) requirement.filed = nextRecord.filedIssues[requirement.id] ?? null;
  }

  const report = buildReport({ root, intakePath, intake, sha256, startVersion, resolved, capabilities, changes, requirements });
  writeFileSync(join(root, REPORT_FILES.json), json(report));
  writeFileSync(join(root, REPORT_FILES.markdown), renderReport(report));
  return report;
}

/** Assemble the JSON report; every intake requirement appears in it exactly once. */
function buildReport({ root, intakePath, intake, sha256, startVersion, resolved, capabilities, changes, requirements }: {
  root: string; intakePath: string; intake: ConsumerIntake; sha256: string; startVersion: 1 | 2;
  resolved: ReturnType<typeof parseConsumerConfig>; capabilities: CapabilityName[]; changes: FieldChange[]; requirements: RequirementDisposition[];
}) {
  const intakeFile = relative(root, resolve(intakePath));
  return {
    reportVersion: 1,
    intake: {
      file: intakeFile.startsWith("..") || isAbsolute(intakeFile) ? null : intakeFile,
      sha256, schemaVersion: intake.schemaVersion, synthetic: intake.synthetic, customer: intake.customer.name, review: intake.review,
    },
    target: {
      tenant: intake.inferops.tenant, workspace: intake.inferops.workspace,
      projects: intake.inferops.projects.map(project => ({ ...project, ref: boardReference(intake, project.key) })),
    },
    configuration: {
      migratedFromVersion1: startVersion === 1,
      profile: resolved.profile,
      capabilitiesEnabledByIntake: capabilities,
      capabilities: resolved.schemaVersion === 2 ? resolved.capabilities : null,
      changes,
      conflicts: changes.filter(change => change.action === "conflict").map(change => change.field),
    },
    pillars: intake.wiki.pillars.map(pillar => ({ ...pillar, status: "pending", tracking: PRODUCT_SUPPORT.wiki.tracking })),
    operations: intake.operations,
    requirements,
    summary: {
      requirements: requirements.length,
      supported: requirements.filter(requirement => requirement.disposition === "supported").length,
      unsupported: requirements.filter(requirement => requirement.disposition === "unsupported").length,
      customWork: requirements.filter(requirement => requirement.disposition === "custom-work").length,
      draftedIssues: requirements.filter(requirement => requirement.draft).length,
      filedIssues: requirements.filter(requirement => requirement.filed).length,
      conflicts: changes.filter(change => change.action === "conflict").length,
    },
    check: { ok: true, command: "pnpm inferos:check" },
    deployed: false,
    pending: [
      "A validated configuration is not proof that a feature works; live acceptance is recorded per issue against a running InferOps (factory-level/inferos#1).",
      "inferops.targetRef and fixtures/project-board.json still name the synthetic fixture board; the customer references are in the starter view and screen template.",
      ...(intake.wiki.pillars.length ? ["Wiki pillars are recorded only; hosting them is pending factory-level/inferos#87."] : []),
      "Nothing was deployed. Deployment has no command yet and stays an explicit, separate step.",
    ],
  };
}

/** The `intake-report.json` document. */
export type IntakeReport = ReturnType<typeof buildReport>;

/** The gap issue drafted for an unsupported or custom-work requirement. */
function draftIssue(intake: ConsumerIntake, requirement: Omit<RequirementDisposition, "draft" | "filed" | "configured">, sha256: string) {
  const label = intake.synthetic ? "[synthetic] " : "";
  const summary = requirement.text.replace(/\s+/g, " ").trim();
  const title = `${label}${intake.customer.name} ${requirement.id}: ${summary.length > 72 ? `${summary.slice(0, 71)}…` : summary}`;
  const body = [
    intake.synthetic ? "> Drafted from a **synthetic** intake. It describes invented sample data, not a real customer.\n" : "",
    `Customer requirement **${requirement.id}** (${requirement.category}) from the reviewed intake for ${intake.customer.name}`,
    `(tenant \`${intake.inferops.tenant}\`, workspace \`${intake.inferops.workspace}\`, intake sha256 \`${sha256.slice(0, 12)}\`).`,
    "",
    "## Requirement",
    "",
    requirement.text,
    "",
    "## Disposition",
    "",
    `**${requirement.disposition}**: ${requirement.reason}.`,
    ...(requirement.maps.capabilities.length ? ["", `Configuration capabilities: ${requirement.maps.capabilities.map(flag => `\`${flag}\``).join(", ")}.`] : []),
    ...(requirement.maps.issue ? ["", `Related: ${requirement.maps.issue}.`] : []),
    "",
    "Drafted by `pnpm inferos intake apply`. The intake configured nothing for this requirement and deployed nothing.",
  ].join("\n");
  return { title, body };
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** Human-readable form of the report; the JSON report is the authority. */
export function renderReport(report: IntakeReport): string {
  const lines = [
    `# Intake report: ${report.intake.customer}`,
    "",
    report.intake.synthetic ? "> **Synthetic intake.** Invented sample data, not a real customer.\n" : "",
    `Intake ${report.intake.file ?? "(outside the wrapper)"}, sha256 \`${report.intake.sha256}\`, reviewed by ${report.intake.review.reviewedBy} on ${report.intake.review.reviewedOn}.`,
    "",
    `Requirements: ${report.summary.requirements} (${report.summary.supported} supported, ${report.summary.unsupported} unsupported, ${report.summary.customWork} custom work). Drafted issues: ${report.summary.draftedIssues}, filed: ${report.summary.filedIssues}. Conflicts: ${report.summary.conflicts}. Deployed: no.`,
    "",
    "## Target",
    "",
    `Tenant \`${report.target.tenant}\`, workspace \`${report.target.workspace}\`.`,
    "",
    "| Project | Name | Workflow | Reference |",
    "| --- | --- | --- | --- |",
    ...report.target.projects.map(project => `| ${project.key} | ${cell(project.name)} | ${project.workflow} | \`${project.ref}\` |`),
    "",
    "## Configuration",
    "",
    `Profile \`${report.configuration.profile}\`${report.configuration.migratedFromVersion1 ? "; migrated from schema version 1" : ""}. Capabilities switched on by the intake: ${report.configuration.capabilitiesEnabledByIntake.map(flag => `\`${flag}\``).join(", ") || "none"}.`,
    "",
    "| Managed field | Action |",
    "| --- | --- |",
    ...report.configuration.changes.map(change => `| \`${change.field}\` | ${change.action} |`),
    "",
    ...(report.configuration.conflicts.length
      ? ["Conflicts were kept as the customer wrote them and not overwritten. Resolve each by hand, then rerun.", ""] : []),
    "## Requirements",
    "",
    "| ID | Category | Disposition | Reason | Maps to | Issue |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.requirements.map(requirement => `| ${requirement.id} | ${requirement.category} | ${requirement.disposition}${requirement.configured === false ? " (customer edit leaves it off)" : ""} | ${cell(requirement.reason)} | ${[...requirement.maps.capabilities, ...requirement.maps.features].map(name => `\`${name}\``).join(", ") || "-"} | ${requirement.filed ?? requirement.maps.issue ?? (requirement.draft ? "drafted" : "-")} |`),
    "",
    "## Drafted issues",
    "",
    ...(report.requirements.some(requirement => requirement.draft)
      ? report.requirements.filter(requirement => requirement.draft).flatMap(requirement => [
        `### ${requirement.draft!.title}`, "", requirement.filed ? `Filed: ${requirement.filed}` : "Not filed. Rerun with `--file-issues OWNER/REPO` to file it.", "",
      ])
      : ["None.", ""]),
    "## Wiki pillars",
    "",
    ...(report.pillars.length ? report.pillars.map(pillar => `- ${cell(pillar.title)} (\`${pillar.id}\`): pending ${pillar.tracking}`) : ["None selected."]),
    "",
    "## Operational inventory",
    "",
    ...(report.operations.length ? [
      "| ID | Operation | Owner | Project | Pillar | SOP |",
      "| --- | --- | --- | --- | --- | --- |",
      ...report.operations.map(operation => `| ${operation.id} | ${cell(operation.name)} | ${cell(operation.owner)} | ${operation.project} | ${operation.pillar ?? "-"} | ${operation.sop ? cell(operation.sop) : "-"} |`),
    ] : ["None recorded."]),
    "",
    "## Pending",
    "",
    ...report.pending.map(item => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}

const USAGE = "Usage: intake.ts apply CONSUMER_ROOT INTAKE_FILE [--file-issues OWNER/REPO]";

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let parsed;
    try {
      parsed = parseArgs({ allowPositionals: true, options: { "file-issues": { type: "string" } } });
    } catch { throw new Error(USAGE); }
    const [command, root, file, extra] = parsed.positionals;
    if (command !== "apply" || !root || !file || extra) throw new Error(USAGE);
    const report = applyIntake(resolve(root), resolve(file), { fileIssues: parsed.values["file-issues"] });
    console.log(json({
      ok: true, operation: "intake", reports: Object.values(REPORT_FILES), summary: report.summary,
      conflicts: report.configuration.conflicts, deployed: false,
    }));
  } catch (error) {
    console.error(error instanceof SyntaxError ? "Invalid JSON in the wrapper configuration" : (error as Error).message);
    process.exitCode = 1;
  }
}
