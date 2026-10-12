#!/usr/bin/env node
// Custom metric declarations for a vertical bootstrap, and their LOCAL check (MVP-34, fixture contract).
//
// A declaration file names the custom metrics one customer's reviewed intake would ask InferOps to hold:
// what is counted, from which source, how it combines and who answers for it. This module validates a
// declaration file against a v1 intake and prints a deterministic report. It registers nothing, proposes
// nothing, writes no file and opens no network connection: there is no metrics store, producer registry,
// deriver or approval path in this revision, and the report says so for every metric. Tenant and
// workspace come from the intake as labels; nothing here enforces or proves tenant isolation.
//
//   node scripts/consumer/metric-declarations.ts <declarations.json> --intake <intake.json> [--json]
//
// Exit codes: 0 valid (the report is printed; metrics may still be unsupported), 1 invalid, 2 usage.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readIntakeFile, type ConsumerIntake } from "./intake.ts";

/** The declaration format this check reads. Separate from the intake's own `schemaVersion`, which stays 1. */
export const DECLARATIONS_SCHEMA_VERSION = 1;
/** Largest declaration file accepted, in bytes. */
export const DECLARATIONS_MAX_BYTES = 64 * 1024;
/** Custom keys live under `custom.`, so a declaration can never shadow a code-owned built-in. */
export const CUSTOM_KEY = /^custom\.[a-z][a-z0-9_]{0,62}$/u;
/** Bounds this revision checks. They are schema bounds, not the per-tenant deployment limits InferOps owes. */
export const LIMITS = { metrics: 64, dimensions: 4, values: 32, labels: 20 } as const;

/** Every enumeration of the draft design. Values outside these lists are invalid. */
export const KINDS = ["counter", "gauge", "distribution", "histogram"] as const;
/**
 * The sources name the duration/size kind differently -- the draft `distribution`, InferOps Metrics
 * `histogram` -- and no decision picks one. Both are accepted as that one kind and both are reported
 * `unsupported`; neither is preferred.
 */
export const DISTRIBUTION_KINDS: readonly string[] = ["distribution", "histogram"];
export const AGGREGATIONS = ["sum", "count", "avg", "min", "max", "p50", "p90", "p95", "last", "ratio"] as const;
export const GRAINS = ["hour", "day"] as const;
export const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;

/** The only derivation templates: Projects' four, each with its kind and closed parameter set. No code, no SQL. */
export const TEMPLATES = {
  "project.issues_in_state": { kind: "gauge", parameters: ["project", "stateGroup", "labels"] },
  "project.entered_state": { kind: "counter", parameters: ["project", "stateGroup", "labels"] },
  "project.time_between_states": { kind: "distribution", parameters: ["project", "from", "to", "labels"] },
  "project.age_in_state": { kind: "distribution", parameters: ["project", "stateGroup", "labels"] },
} as const;
export type TemplateName = keyof typeof TEMPLATES;

/** Field names that would carry code or a query. Refused wherever they appear, at any depth. */
export const CODE_FIELDS = ["sql", "query", "expression", "expr", "formula", "code", "script", "deriver", "function", "fn", "javascript", "js"] as const;

/**
 * What this revision can carry through, and why the rest is reported `unsupported` rather than guessed.
 * Each reason names its source, so a reviewer can see which document the subset follows.
 */
export const UNSUPPORTED = {
  distribution: "kind distribution or histogram: the draft names it `distribution` and InferOps Metrics names it `histogram`, with no decision between them; the store contract reviewed so far (MVP-19 rev2) carries counter and gauge only",
  aggregation: "aggregation outside sum, min, max: MVP-19 rev2 defers avg and last as not decomposable across dimensions, and no source defines count, percentiles or ratio combination yet",
  ref: "opaque-reference dimension: MVP-19 rev2 defers ref dimensions (unbounded per-series cardinality, the most identifying type)",
  live: "live source: the draft computes live values only for built-ins such as project/issue-count; no custom live path is defined",
  derivedDimensions: "dimensions on a derived metric: no source defines which record fields a template may break down by",
} as const;

/** One check failure: which field, and what rule it broke. Never the rejected value. */
export class DeclarationError extends Error {
  readonly field: string;
  readonly rule: string;
  constructor(field: string, rule: string) {
    super(`${field}: ${rule}`);
    this.field = field;
    this.rule = rule;
  }
}

const fail = (field: string, rule: string): never => { throw new DeclarationError(field, rule); };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

// Unknown keys are refused by naming the expected set, never the key found: a key can hold anything.
const exact = (value: unknown, required: readonly string[], path: string, optional: readonly string[] = []): Json => {
  if (!isObject(value)) fail(path, "expected object");
  const record = value as Json;
  const allowed = [...required, ...optional];
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !allowed.includes(key))) {
    fail(path, `expected exactly ${required.join(", ")}${optional.length ? ` (optionally ${optional.join(", ")})` : ""}`);
  }
  return record;
};

const text = (value: unknown, path: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(path, `expected nonempty string of at most ${max} characters`);
  if ((value as string).split("").some(char => char < " " || char === "\u007f")) fail(path, "control characters are not allowed");
  return value as string;
};

const pattern = (value: unknown, regex: RegExp, path: string, rule: string): string => {
  if (typeof value !== "string" || !regex.test(value)) fail(path, rule);
  return value as string;
};

const choice = <T extends string>(value: unknown, choices: readonly T[], path: string): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(path, `expected one of ${choices.join(", ")}`);
  return value as T;
};

const list = (value: unknown, path: string, min: number, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `expected array of ${min} to ${max} entries`);
  return value as unknown[];
};

const unique = (values: string[], path: string) => {
  if (new Set(values).size !== values.length) fail(path, "duplicate entry");
};

const NAME = /^[a-z][a-z0-9_]{0,31}$/u;
const VALUE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PRODUCER = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;

/**
 * Every field name the format defines. A refusal path is built from these and indices only; any other
 * key is shown as `<key>`, because a key can hold anything (a token, a customer name).
 */
const FORMAT_FIELDS: ReadonlySet<string> = new Set([
  "schemaVersion", "kind", "synthetic", "metrics", "key", "name", "unit", "aggregation", "grain", "dimensions",
  "values", "cardinalityCap", "source", "template", "parameters", "project", "stateGroup", "from", "to", "labels",
  "producer", "attribution", "operation", "accountable",
]);

/** Refuse any code- or query-shaped field before shape checks, so the message says why. */
function refuseCode(value: unknown, path: string): void {
  if (Array.isArray(value)) { value.forEach((entry, index) => refuseCode(entry, `${path}[${index}]`)); return; }
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    const known = CODE_FIELDS.find(field => field === key.toLowerCase());
    if (known) fail(`${path}.${known}`, "code or SQL is not accepted; name a declared template or a recorded producer");
    refuseCode(value[key], `${path}.${FORMAT_FIELDS.has(key) ? key : "<key>"}`);
  }
}

export type Dimension = { name: string; values: string[] } | { name: string; cardinalityCap: number };
export type MetricSource =
  | { kind: "derived"; template: TemplateName; parameters: { project: string; stateGroup?: string; from?: string; to?: string; labels?: string[] } }
  | { kind: "recorded"; producer: string }
  | { kind: "live" };

/** One validated declaration, normalized: dimensions and their values sorted, labels sorted. */
export interface MetricDeclaration {
  key: string;
  name: string;
  unit: string;
  kind: typeof KINDS[number];
  aggregation: typeof AGGREGATIONS[number];
  grain: typeof GRAINS[number];
  dimensions: Dimension[];
  source: MetricSource;
  attribution: { operation: string; accountable: string };
}

export interface MetricDeclarations { schemaVersion: 1; kind: "metric-declarations"; synthetic: boolean; metrics: MetricDeclaration[] }

function parseSource(value: unknown, intake: ConsumerIntake, path: string): MetricSource {
  if (!isObject(value)) fail(path, "expected object");
  const kind = choice((value as Json).kind, ["derived", "recorded", "live"] as const, `${path}.kind`);
  if (kind === "live") { exact(value, ["kind"], path); return { kind }; }
  if (kind === "recorded") {
    const source = exact(value, ["kind", "producer"], path);
    return { kind, producer: pattern(source.producer, PRODUCER, `${path}.producer`, "expected a producer slug") };
  }
  const source = exact(value, ["kind", "template", "parameters"], path);
  const template = choice(source.template, Object.keys(TEMPLATES) as TemplateName[], `${path}.template`);
  const spec = TEMPLATES[template];
  const needed = spec.parameters.filter(name => name !== "labels");
  const raw = exact(source.parameters, needed, `${path}.parameters`, ["labels"]);
  const project = pattern(raw.project, /^[A-Z][A-Z0-9]{1,9}$/u, `${path}.parameters.project`, "expected a project key");
  if (!intake.inferops.projects.some(candidate => candidate.key === project)) fail(`${path}.parameters.project`, "expected a key listed in the intake's inferops.projects");
  const parameters: Extract<MetricSource, { kind: "derived" }>["parameters"] = { project };
  for (const name of ["stateGroup", "from", "to"] as const) {
    if (needed.includes(name)) parameters[name] = choice(raw[name], STATE_GROUPS, `${path}.parameters.${name}`);
  }
  if (parameters.from !== undefined && parameters.from === parameters.to) fail(`${path}.parameters.to`, "expected a state group different from `from`");
  if (raw.labels !== undefined) {
    const labels = list(raw.labels, `${path}.parameters.labels`, 1, LIMITS.labels)
      .map((label, index) => pattern(label, LABEL, `${path}.parameters.labels[${index}]`, "expected a label name"));
    unique(labels, `${path}.parameters.labels`);
    parameters.labels = labels.toSorted();
  }
  return { kind, template, parameters };
}

function parseDimension(value: unknown, path: string): Dimension {
  if (!isObject(value)) fail(path, "expected object");
  if (Object.hasOwn(value as Json, "cardinalityCap")) {
    const dimension = exact(value, ["name", "cardinalityCap"], path);
    const cap = dimension.cardinalityCap;
    if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > LIMITS.values) fail(`${path}.cardinalityCap`, `expected an integer from 1 to ${LIMITS.values}`);
    return { name: pattern(dimension.name, NAME, `${path}.name`, "expected a lowercase dimension name"), cardinalityCap: cap as number };
  }
  const dimension = exact(value, ["name", "values"], path);
  const values = list(dimension.values, `${path}.values`, 1, LIMITS.values)
    .map((entry, index) => pattern(entry, VALUE, `${path}.values[${index}]`, "expected a lowercase value slug"));
  unique(values, `${path}.values`);
  return { name: pattern(dimension.name, NAME, `${path}.name`, "expected a lowercase dimension name"), values: values.toSorted() };
}

/** Validate an untrusted declaration file against a parsed v1 intake. Throws {@link DeclarationError} on the first problem. */
export function parseMetricDeclarations(input: unknown, intake: ConsumerIntake): MetricDeclarations {
  refuseCode(input, "declarations");
  if (!isObject(input) || input.schemaVersion !== DECLARATIONS_SCHEMA_VERSION) fail("schemaVersion", `only version ${DECLARATIONS_SCHEMA_VERSION} is supported`);
  const root = exact(input, ["schemaVersion", "kind", "synthetic", "metrics"], "declarations");
  if (root.kind !== "metric-declarations") fail("kind", "expected metric-declarations");
  if (typeof root.synthetic !== "boolean") fail("synthetic", "expected boolean");
  if (root.synthetic !== intake.synthetic) fail("synthetic", "expected to match the intake's synthetic flag");
  const owners = new Map(intake.operations.map(operation => [operation.id, operation.owner]));
  const metrics = list(root.metrics, "metrics", 1, LIMITS.metrics).map((entry, index): MetricDeclaration => {
    const path = `metrics[${index}]`;
    const metric = exact(entry, ["key", "name", "unit", "kind", "aggregation", "grain", "dimensions", "source", "attribution"], path);
    const key = typeof metric.key === "string" && /^[a-z]/u.test(metric.key) && !metric.key.startsWith("custom.")
      ? fail(`${path}.key`, "custom keys must start with custom.; built-in metrics are declared in code by their domain")
      : pattern(metric.key, CUSTOM_KEY, `${path}.key`, "expected custom.<lowercase_name>");
    const kind = choice(metric.kind, KINDS, `${path}.kind`);
    const dimensions = list(metric.dimensions, `${path}.dimensions`, 0, LIMITS.dimensions)
      .map((dimension, at) => parseDimension(dimension, `${path}.dimensions[${at}]`));
    unique(dimensions.map(dimension => dimension.name), `${path}.dimensions`);
    const source = parseSource(metric.source, intake, `${path}.source`);
    const sameKind = (a: string, b: string) => a === b || (DISTRIBUTION_KINDS.includes(a) && DISTRIBUTION_KINDS.includes(b));
    if (source.kind === "derived" && !sameKind(TEMPLATES[source.template].kind, kind)) {
      fail(`${path}.kind`, `expected ${TEMPLATES[source.template].kind}, the kind of template ${source.template}`);
    }
    const attribution = exact(metric.attribution, ["operation", "accountable"], `${path}.attribution`);
    const operation = text(attribution.operation, `${path}.attribution.operation`, 64);
    if (!owners.has(operation)) fail(`${path}.attribution.operation`, "expected an operation id listed in the intake");
    const accountable = text(attribution.accountable, `${path}.attribution.accountable`, 120);
    if (![...owners.values()].includes(accountable)) fail(`${path}.attribution.accountable`, "expected a role that owns an operation in the intake");
    return {
      key, kind, source, attribution: { operation, accountable },
      name: text(metric.name, `${path}.name`, 80),
      unit: text(metric.unit, `${path}.unit`, 32),
      aggregation: choice(metric.aggregation, AGGREGATIONS, `${path}.aggregation`),
      grain: choice(metric.grain, GRAINS, `${path}.grain`),
      dimensions: dimensions.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
    };
  });
  unique(metrics.map(metric => metric.key), "metrics");
  return { schemaVersion: 1, kind: "metric-declarations", synthetic: root.synthetic as boolean, metrics: metrics.toSorted((a, b) => (a.key < b.key ? -1 : 1)) };
}

/** Why a valid declaration cannot be carried through in this revision. Empty means `declared`. */
export function unsupportedReasons(metric: MetricDeclaration): string[] {
  const reasons: string[] = [];
  if (DISTRIBUTION_KINDS.includes(metric.kind)) reasons.push(UNSUPPORTED.distribution);
  if (!["sum", "min", "max"].includes(metric.aggregation)) reasons.push(UNSUPPORTED.aggregation);
  if (metric.dimensions.some(dimension => "cardinalityCap" in dimension)) reasons.push(UNSUPPORTED.ref);
  if (metric.source.kind === "live") reasons.push(UNSUPPORTED.live);
  if (metric.source.kind === "derived" && metric.dimensions.length > 0) reasons.push(UNSUPPORTED.derivedDimensions);
  return reasons;
}

/** The report a valid declaration file yields. Deterministic: no clock, no environment, no host path. */
export function buildDeclarationReport(declarations: MetricDeclarations, intake: ConsumerIntake, intakeSha256: string) {
  return {
    status: "NOT REGISTERED" as const,
    note: "A local check of declarations only. Nothing was proposed, approved, registered or recorded; InferOps assigns versions on an approved definition.",
    declarationsDigest: createHash("sha256").update(canonical(declarations)).digest("hex"),
    intakeSha256,
    declarationsSchemaVersion: declarations.schemaVersion,
    synthetic: declarations.synthetic,
    customer: intake.customer.name,
    scope: { tenant: intake.inferops.tenant, workspace: intake.inferops.workspace, isolation: "not-enforced" as const },
    metrics: declarations.metrics.map(metric => {
      const reasons = unsupportedReasons(metric);
      return {
        ...metric,
        version: null,
        disposition: reasons.length ? "unsupported" as const : "declared" as const,
        reasons,
        producer: metric.source.kind === "recorded" ? "unresolved" as const : "not-applicable" as const,
        deriver: metric.source.kind === "derived" ? "unavailable" as const : "not-applicable" as const,
        approval: "unavailable" as const,
        registration: "none" as const,
      };
    }),
  };
}
export type DeclarationReport = ReturnType<typeof buildDeclarationReport>;

/** Key-order-independent JSON, so the digest names the declarations' content, not their formatting. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Read and validate a declaration file: a regular JSON file of at most {@link DECLARATIONS_MAX_BYTES}. */
export function readDeclarationsFile(path: string, intake: ConsumerIntake): MetricDeclarations {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error("Declarations file not found"); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Declarations must be a regular file, not a link or directory");
  if (stat.size > DECLARATIONS_MAX_BYTES) throw new Error(`Declarations exceed ${DECLARATIONS_MAX_BYTES} bytes`);
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Declarations file is not valid JSON"); }
  return parseMetricDeclarations(input, intake);
}

/** The human-readable report: a header that cannot be mistaken for a registration. */
export function formatDeclarationReport(report: DeclarationReport): string {
  const lines = [
    `${report.status} -- local check of ${report.metrics.length} metric declaration(s) for ${report.customer}, digest ${report.declarationsDigest}`,
    report.note,
    `Scope labels ${report.scope.tenant}.${report.scope.workspace} (isolation ${report.scope.isolation}); intake sha256 ${report.intakeSha256}.`,
    ...report.metrics.flatMap(metric => [
      `  ${metric.key} (${metric.kind}, ${metric.aggregation}, ${metric.grain}; ${metric.source.kind}): ${metric.disposition}; producer ${metric.producer}, deriver ${metric.deriver}, approval ${metric.approval}, registration ${metric.registration}`,
      ...metric.reasons.map(reason => `    unsupported: ${reason}`),
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const args = argv.filter(arg => arg !== "--json");
  const intakeAt = args.indexOf("--intake");
  const declarationsPath = args.find((_arg, index) => index !== intakeAt && index !== intakeAt + 1);
  const intakePath = intakeAt >= 0 ? args[intakeAt + 1] : undefined;
  if (!declarationsPath || !intakePath) {
    process.stderr.write("usage: metric-declarations <declarations.json> --intake <intake.json> [--json]\n");
    return 2;
  }
  let intake;
  try { intake = readIntakeFile(intakePath); } catch (error) {
    process.stderr.write(`NOT REGISTERED -- the intake is invalid: ${(error as Error).message}\n`);
    return 1;
  }
  let declarations;
  try { declarations = readDeclarationsFile(declarationsPath, intake.intake); } catch (error) {
    const problem = error instanceof DeclarationError ? { field: error.field, rule: error.rule } : { field: "(file)", rule: (error as Error).message };
    if (json) process.stdout.write(`${JSON.stringify({ status: "NOT REGISTERED", ok: false, problem }, null, 2)}\n`);
    else process.stderr.write(`NOT REGISTERED -- the declarations are invalid:\n  ${problem.field}: ${problem.rule}\n`);
    return 1;
  }
  const report = buildDeclarationReport(declarations, intake.intake, intake.sha256);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatDeclarationReport(report));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
