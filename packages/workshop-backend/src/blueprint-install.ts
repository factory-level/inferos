// Installing a published blueprint version, shared by the two ways of installing one: as a new
// workspace of the installer's own (AuthenticatedApi.newGadgetFromBlueprint) and as a new gadget in
// an existing workspace, an operate space (Overseer.installBlueprint). Both refuse the same things
// before creating anything, record the same `BlueprintInstall`, and create the bindings the same
// way, under the installer's own authority.

import type {
  AgentSpawnerConfig, BlueprintBinding, BlueprintBindingAssignment, BlueprintInstall,
  BlueprintInstallOptions, WorkpieceId, WorkspaceKind,
} from '@gadgets/workshop-shared/api';
import {
  BlueprintKvRecord, readBlueprintContent, readBlueprintKvRecord, readBlueprintVersionBindings,
} from "./blueprint-archive.js";

/** A blueprint version that may be installed with a given set of binding assignments. */
export type BlueprintVersionToInstall = {
  kvRecord: BlueprintKvRecord;
  /** The version's code snapshot (see `readBlueprintContent`). */
  code: Uint8Array;
  /** What the install records (see `BlueprintInstall`). */
  install: BlueprintInstall;
  /** The version's bindings, by name: the ones stored with it, or the current ones if none were. */
  bindings: Map<string, BlueprintBinding>;
};

/**
 * Read the version of `blueprintId` that `options` pins (default: the current one), refusing a
 * missing blueprint or version, a version of another kind than `options.kind`, and an assignment
 * naming a binding that version doesn't have. Throws before anything is created.
 */
export async function readBlueprintVersionToInstall(
  env: Pick<Cloudflare.Env, 'BLUEPRINTS' | 'BLUEPRINT_CONTENT'>,
  blueprintId: string,
  assignments: Record<string, BlueprintBindingAssignment>,
  options?: BlueprintInstallOptions,
): Promise<BlueprintVersionToInstall> {
  let kvRecord = await readBlueprintKvRecord(env, blueprintId);
  if (!kvRecord) throw new Error("Blueprint not found.");

  let version = options?.version ?? kvRecord.metadata.version;
  let content = await readBlueprintContent(env, blueprintId, version);
  if (!content) throw new Error(`Blueprint version ${version} not found.`);
  if (options?.kind !== undefined && options.kind !== content.kind) {
    throw new Error(`Blueprint version ${version} is a ${content.kind}, not a ${options.kind}.`);
  }
  // A map (not a raw object) until names are validated.
  let bindings = new Map(Object.entries(
      await readBlueprintVersionBindings(env, blueprintId, version) ?? kvRecord.metadata.bindings));
  let unknown = Object.keys(assignments).find(name => !bindings.has(name));
  if (unknown !== undefined) {
    throw new Error(`Unknown binding name: ${unknown} (blueprint version ${version}).`);
  }
  let install: BlueprintInstall = {blueprintId, version, kind: content.kind};
  if (content.dataContract !== undefined) install.dataContract = content.dataContract;
  return {kvRecord, code: content.code, install, bindings};
}

/** An assignment that creates a connection or a model binding (not an agent spawner). */
export type DirectBindingAssignment = Exclude<BlueprintBindingAssignment, {type: "agentSpawner"}>;

/**
 * How an install creates and binds its bindings. Each create runs as the installer (their own
 * accounts and models) and returns the new binding's workpiece id.
 */
export type BlueprintBindingTarget = {
  create(bindingName: string, assignment: DirectBindingAssignment): Promise<WorkpieceId>;
  createSpawner(config: AgentSpawnerConfig): Promise<WorkpieceId>;
  bind(bindingName: string, id: WorkpieceId): Promise<void>;
};

/**
 * Create every assigned binding and bind it into the installed gadget `gadgetId`. In two phases:
 * first every connection and model (binding the ones that aren't `spawnerOnly`, which exist only
 * to feed a spawner's env), then the agent spawners, whose env references the phase-one results
 * by binding name (see SpawnerEnvTarget).
 */
export async function createBlueprintBindings(
  target: BlueprintBindingTarget,
  gadgetId: WorkpieceId,
  blueprintBindings: Map<string, BlueprintBinding>,
  assignments: Record<string, BlueprintBindingAssignment>,
): Promise<void> {
  let createdIds = new Map<string, WorkpieceId>();
  await Promise.all(Object.entries(assignments).map(async ([bindingName, assignment]) => {
    let blueprintBinding = blueprintBindings.get(bindingName);
    if (!blueprintBinding) throw new Error(`Unknown binding name: ${bindingName}`);
    if (assignment.type === "agentSpawner") return;  // phase two
    let id = await target.create(bindingName, assignment);
    createdIds.set(bindingName, id);
    if (!blueprintBinding.spawnerOnly) await target.bind(bindingName, id);
  }));

  for (let [bindingName, assignment] of Object.entries(assignments)) {
    if (assignment.type !== "agentSpawner") continue;
    let blueprintBinding = blueprintBindings.get(bindingName);
    if (blueprintBinding?.type !== "agentSpawner") {
      throw new Error(`Binding "${bindingName}" type mismatch.`);
    }
    let env: Record<string, WorkpieceId> = {};
    for (let [envName, envTarget] of Object.entries(blueprintBinding.env)) {
      if (envTarget.type === "gadget") {
        env[envName] = gadgetId;
      } else {
        let id = createdIds.get(envTarget.name);
        if (id === undefined) {
          throw new Error(`Agent spawner binding "${bindingName}" references binding ` +
              `"${envTarget.name}", which was not assigned.`);
        }
        env[envName] = id;
      }
    }
    // The full config: displayName from the binding's title, modelId from the assignment.
    let id = await target.createSpawner(
        {displayName: blueprintBinding.title, modelId: assignment.modelId, env});
    await target.bind(bindingName, id);
  }
}

/**
 * Whether an install's kind and data contract allow moving it from `installed` to a version of
 * `kind` declaring `dataContract`; throws the refusal otherwise. Both contracts must be declared
 * and equal: a different one needs a migration, and an undeclared one is unknown.
 */
export function assertUpgradeCompatible(
  installed: BlueprintInstall, version: number, kind: WorkspaceKind,
  dataContract: number | undefined,
): void {
  if (kind !== installed.kind) {
    throw new Error(`Blueprint version ${version} is a ${kind}, not a ${installed.kind}; an ` +
        `upgrade cannot change the install's kind.`);
  }
  if (installed.dataContract === undefined) {
    throw new Error(`The installed version ${installed.version} declares no data contract, so ` +
        `its data's compatibility is unknown; it cannot be upgraded.`);
  }
  if (dataContract === undefined) {
    throw new Error(`Blueprint version ${version} declares no data contract, so its data's ` +
        `compatibility is unknown; the install cannot be upgraded to it.`);
  }
  if (dataContract !== installed.dataContract) {
    throw new Error(`Blueprint version ${version} needs migration: it declares data contract ` +
        `${dataContract}, and the installed version ${installed.version} declares ` +
        `${installed.dataContract}.`);
  }
}
