import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANVAS_WIDGET_KINDS, parseCanvasCatalog,
  type CanvasCatalog, type CanvasSection, type CanvasWidgetKind,
} from "../../packages/workshop-shared/src/canvas.ts";
import { WORKER_PACKAGE_ROOTS } from "../worker-dirs.ts";
import { consumerBlueprintDirectory } from "./runtime.ts";

/** The file, at the root of this repository or of a consumer wrapper, that configures composition. */
export const CANVAS_CONFIG_FILE = "inferos.canvas.json";

/**
 * What a fork or wrapper offers on its canvases, before any custom code: which built widget kinds
 * and blueprint widgets may be composed, the screens new canvases start from, and which of the
 * fork's own gatekeepers run. None of it grants access to any resource.
 */
export interface CanvasConfig {
  schemaVersion: 1;
  widgets: {
    /** Registered widget kinds people and agents may add. */
    kinds: CanvasWidgetKind[];
    /** Blueprint IDs offered as widgets; each must be a blueprint this checkout ships. */
    blueprints: string[];
  };
  /** Screen templates, in display order. Layout and InferOps board references only. */
  screens: { id: string; title: string; sections: CanvasSection[] }[];
  /** `custom-gatekeepers/` packages the dev server binds: all of them, or the named ones. */
  customGatekeepers: "all" | string[];
}

/** A blueprint this checkout ships, as the CLI lists it. */
export interface AvailableBlueprint { blueprintId: string; title: string; description: string }

/** Everything built that a canvas config can choose from. */
export interface CanvasInventory {
  kinds: readonly CanvasWidgetKind[];
  blueprints: AvailableBlueprint[];
  customGatekeepers: string[];
}

/** The configuration a checkout without a canvas file behaves as: everything built, nothing extra. */
export const DEFAULT_CANVAS_CONFIG: CanvasConfig = {
  schemaVersion: 1,
  widgets: { kinds: [...CANVAS_WIDGET_KINDS], blueprints: [] },
  screens: [],
  customGatekeepers: "all",
};

const UPSTREAM = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The blueprints and custom gatekeepers built into the checkout at `upstream`, for a config at `root`. */
export function canvasInventory(root: string, upstream = UPSTREAM): CanvasInventory {
  // A wrapper's blueprints directory is its complete format set, replacing upstream's.
  const blueprintDir = consumerBlueprintDirectory(root) ?? join(upstream, "packages/bundled-blueprints/blueprints");
  const blueprints = readdirSync(blueprintDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(blueprintDir, entry.name, "blueprint.json")))
    .map(entry => {
      const manifest = JSON.parse(readFileSync(join(blueprintDir, entry.name, "blueprint.json"), "utf8"));
      return { blueprintId: String(manifest.blueprintId), title: String(manifest.title), description: String(manifest.description) };
    })
    .toSorted((a, b) => a.blueprintId.localeCompare(b.blueprintId));
  const customRoot = join(upstream, WORKER_PACKAGE_ROOTS[1]);
  const customGatekeepers = existsSync(customRoot)
    ? readdirSync(customRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith("gatekeeper-") && existsSync(join(customRoot, entry.name, "wrangler.jsonc")))
      .map(entry => entry.name).toSorted()
    : [];
  return { kinds: CANVAS_WIDGET_KINDS, blueprints, customGatekeepers };
}

const exactKeys = (value: unknown, keys: string[], path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new Error(`${path}: expected exactly ${keys.join(", ")}`);
  }
  return record;
};

const stringList = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${path}: expected string array`);
  if (new Set(value).size !== value.length) throw new Error(`${path}: duplicate entry`);
  return value;
};

/**
 * Validate a canvas config against what the checkout builds and resolve it to the catalog the
 * Workshop enforces. Names that the checkout does not build are errors, not silently dropped.
 */
export function resolveCanvasConfig(input: unknown, inventory: CanvasInventory): { config: CanvasConfig; catalog: CanvasCatalog } {
  const root = exactKeys(input, ["schemaVersion", "widgets", "screens", "customGatekeepers"], "canvas config");
  if (root.schemaVersion !== 1) throw new Error("schemaVersion: only version 1 is supported");
  const widgets = exactKeys(root.widgets, ["kinds", "blueprints"], "widgets");
  const kinds = stringList(widgets.kinds, "widgets.kinds");
  const unknownKind = kinds.find(kind => !inventory.kinds.includes(kind as CanvasWidgetKind));
  if (unknownKind) throw new Error(`widgets.kinds: unknown widget kind "${unknownKind}" (built: ${inventory.kinds.join(", ")})`);
  const blueprintIds = stringList(widgets.blueprints, "widgets.blueprints");
  const blueprints = blueprintIds.map(blueprintId => {
    const found = inventory.blueprints.find(blueprint => blueprint.blueprintId === blueprintId);
    if (!found) throw new Error(`widgets.blueprints: no blueprint "${blueprintId}" in this checkout`);
    return { blueprintId, label: found.title, description: found.description };
  });
  if (blueprints.length && !kinds.includes("inferos.gadget")) {
    throw new Error("widgets.blueprints: blueprint widgets are placed as gadgets; enable the inferos.gadget kind");
  }
  if (!Array.isArray(root.screens)) throw new Error("screens: expected array");
  const screens = root.screens.map((screen, index) => {
    const entry = exactKeys(screen, ["id", "title", "sections"], `screens[${index}]`);
    return { id: entry.id, content: { title: entry.title, sections: entry.sections } };
  });
  let customGatekeepers: CanvasConfig["customGatekeepers"];
  if (root.customGatekeepers === "all") {
    customGatekeepers = "all";
  } else {
    customGatekeepers = stringList(root.customGatekeepers, "customGatekeepers");
    const missing = customGatekeepers.find(name => !inventory.customGatekeepers.includes(name));
    if (missing) throw new Error(`customGatekeepers: no custom gatekeeper "${missing}" in this checkout`);
  }
  // The Workshop's own parser is the authority on templates: same IDs, limits and widget rules.
  const catalog = parseCanvasCatalog({ widgetKinds: kinds, blueprints, screens });
  const config: CanvasConfig = {
    schemaVersion: 1,
    widgets: { kinds: catalog.widgetKinds, blueprints: blueprintIds },
    screens: catalog.screens.map(({ id, content }) => ({ id, title: content.title, sections: content.sections })),
    customGatekeepers,
  };
  return { config, catalog };
}

/** Read `root`'s canvas config, or null when it has none (the Workshop then offers every kind). */
export function readCanvasConfig(root: string, inventory = canvasInventory(root)) {
  const path = join(root, CANVAS_CONFIG_FILE);
  if (!existsSync(path)) return null;
  return resolveCanvasConfig(JSON.parse(readFileSync(path, "utf8")), inventory);
}

/** The custom gatekeepers a config selects, from those the checkout builds. */
export function selectedCustomGatekeepers(config: CanvasConfig | undefined, inventory: CanvasInventory): string[] {
  if (!config || config.customGatekeepers === "all") return inventory.customGatekeepers;
  return config.customGatekeepers;
}

function writeCanvasConfig(root: string, config: CanvasConfig, inventory: CanvasInventory): void {
  // Round-trip through validation so the CLI can never write a file the Workshop would reject.
  resolveCanvasConfig(config, inventory);
  writeFileSync(join(root, CANVAS_CONFIG_FILE), JSON.stringify(config, null, 2) + "\n");
}

const USAGE = `Usage: canvas.ts ROOT <command>
  list                               Show built widgets, blueprints, custom gatekeepers and what is enabled
  check                              Validate ${CANVAS_CONFIG_FILE}
  init                               Write a config enabling every built widget kind
  enable <kind|blueprintId>          Offer a widget kind or blueprint widget
  disable <kind|blueprintId>         Stop offering one (existing canvases keep their widgets)
  add-screen <id> <title> [boardRef ...]   Add a screen template, optionally with InferOps board references
  remove-screen <id>                 Remove a screen template
  gatekeeper enable|disable <name>   Choose which custom-gatekeepers/ packages the dev server binds
  gatekeeper all                     Bind every custom gatekeeper (the default)`;

/** Run one CLI command against the config at `root`; returns the JSON report it prints. */
export function runCanvasCommand(root: string, args: string[], upstream = UPSTREAM): unknown {
  const inventory = canvasInventory(root, upstream);
  const existing = readCanvasConfig(root, inventory);
  const config: CanvasConfig = structuredClone(existing?.config ?? DEFAULT_CANVAS_CONFIG);
  const [command, ...rest] = args;
  const report = () => {
    const resolved = readCanvasConfig(root, inventory);
    return {
      ok: true,
      file: resolved ? CANVAS_CONFIG_FILE : null,
      enabled: {
        kinds: (resolved?.catalog ?? { widgetKinds: CANVAS_WIDGET_KINDS }).widgetKinds,
        blueprints: resolved?.config.widgets.blueprints ?? [],
        screens: resolved?.config.screens.map(({ id, title }) => ({ id, title })) ?? [],
        customGatekeepers: selectedCustomGatekeepers(resolved?.config, inventory),
      },
      available: inventory,
    };
  };
  switch (command) {
    case "list": case "check":
      if (rest.length) break;
      return report();
    case "init":
      if (rest.length) break;
      if (existing) throw new Error(`${CANVAS_CONFIG_FILE} already exists`);
      writeCanvasConfig(root, config, inventory);
      return report();
    case "enable": case "disable": {
      if (rest.length !== 1) break;
      const [name] = rest;
      const isKind = inventory.kinds.includes(name as CanvasWidgetKind);
      const list: string[] = isKind ? config.widgets.kinds : config.widgets.blueprints;
      if (!isKind && !inventory.blueprints.some(blueprint => blueprint.blueprintId === name)) {
        throw new Error(`"${name}" is neither a widget kind nor a blueprint in this checkout; run list`);
      }
      if (command === "enable" && !list.includes(name)) list.push(name);
      if (command === "disable") list.splice(0, list.length, ...list.filter(item => item !== name));
      // Blueprint widgets are gadgets, so offering one offers the gadget kind it is placed as.
      if (command === "enable" && !isKind && !config.widgets.kinds.includes("inferos.gadget")) config.widgets.kinds.push("inferos.gadget");
      writeCanvasConfig(root, config, inventory);
      return report();
    }
    case "add-screen": {
      if (rest.length < 2) break;
      const [id, title, ...boards] = rest;
      if (config.screens.some(screen => screen.id === id)) throw new Error(`Screen "${id}" already exists`);
      const widgets = boards.map((targetRef, index) => ({
        id: `board-${index + 1}`, kind: "inferops.project-board" as const, version: 1 as const, targetRef,
        size: "full" as const, params: { workflow: "software" as const, showCompleted: false },
      }));
      config.screens.push({ id, title, sections: [{ id: "main", title, columns: widgets.length > 1 ? 2 : 1, widgets }] });
      writeCanvasConfig(root, config, inventory);
      return report();
    }
    case "remove-screen": {
      if (rest.length !== 1) break;
      if (!config.screens.some(screen => screen.id === rest[0])) throw new Error(`No screen "${rest[0]}"`);
      config.screens = config.screens.filter(screen => screen.id !== rest[0]);
      writeCanvasConfig(root, config, inventory);
      return report();
    }
    case "gatekeeper": {
      const [action, name] = rest;
      if (action === "all" && rest.length === 1) {
        config.customGatekeepers = "all";
      } else if ((action === "enable" || action === "disable") && rest.length === 2) {
        if (!inventory.customGatekeepers.includes(name)) throw new Error(`No custom gatekeeper "${name}"; run list`);
        const current = config.customGatekeepers === "all" ? inventory.customGatekeepers : config.customGatekeepers;
        config.customGatekeepers = action === "enable"
          ? [...new Set([...current, name])].toSorted() : current.filter(item => item !== name);
      } else {
        break;
      }
      writeCanvasConfig(root, config, inventory);
      return report();
    }
  }
  throw new Error(USAGE);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...args] = process.argv.slice(2);
  try {
    if (!root) throw new Error(USAGE);
    console.log(JSON.stringify(runCanvasCommand(resolve(root), args), null, 2));
  } catch (error) {
    console.error(error instanceof SyntaxError ? `Invalid JSON in ${CANVAS_CONFIG_FILE}` : (error as Error).message);
    process.exitCode = 1;
  }
}
