import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bootstrapConsumer } from "../consumer/bootstrap.ts";
import { parseConsumerConfig } from "../consumer/config.ts";
import { checkConsumerFixture } from "../consumer/fixtures.ts";
import { checkConsumer } from "../consumer/runtime.ts";
import { readConsumerViews } from "../consumer/views.ts";
import { parseRecipeName, RECIPES } from "./catalog.ts";

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** Create a pinned, synthetic recipe wrapper atomically; reruns preserve every customer edit. */
export function createRecipe(name: string, destination: string, repository: string, revision: string, port = 28787) {
  const recipeName = parseRecipeName(name);
  const recipe = RECIPES[recipeName];
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8787 || port === 18787) {
    throw new Error("Choose a local port from 1024 to 65535 other than protected 8787/18787");
  }
  const target = resolve(destination);
  if (existsSync(target)) {
    const marker = join(target, "recipe.json");
    if (!existsSync(marker) || JSON.parse(readFileSync(marker, "utf8")).recipe !== recipeName) {
      throw new Error("Destination is not this recipe; choose a new directory");
    }
    // The existing bootstrap validates the requested pin and refuses unrelated repositories.
    bootstrapConsumer(target, repository, revision);
    return { created: false, destination: target, recipe: recipeName, revision, runtimeReady: false };
  }
  mkdirSync(dirname(target), { recursive: true });
  const temporary = mkdtempSync(join(dirname(target), ".recipe-"));
  const staging = join(temporary, "wrapper");
  try {
    bootstrapConsumer(staging, repository, revision, { capabilities: ["INFEROPS_ENABLED"] });
    const configPath = join(staging, "inferos.config.json");
    const config = parseConsumerConfig(JSON.parse(readFileSync(configPath, "utf8")));
    config.local.port = port;
    config.styling.siteName = recipe.title;
    writeFileSync(configPath, json(config));
    const board = JSON.parse(readFileSync(join(staging, "fixtures/project-board.json"), "utf8"));
    board.projects[0].name = recipe.title;
    const first = board.columns[0].issues[0];
    board.columns[0].issues = recipe.cards.map((title, index) => ({
      ...first,
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      identifier: `DEMO-${index + 1}`, title,
    }));
    writeFileSync(join(staging, "fixtures/project-board.json"), json(board));
    const viewPath = join(staging, "views/operations.json");
    const view = JSON.parse(readFileSync(viewPath, "utf8"));
    view.title = recipe.title;
    writeFileSync(viewPath, json(view));
    cpSync(new URL("./fixtures", import.meta.url), join(staging, "fixtures/recipe-reference"), { recursive: true });
    writeFileSync(join(staging, "recipe.json"), json({
      schemaVersion: 1, synthetic: true, recipe: recipeName, sourceRevision: revision,
      boundaries: recipe.boundaries, productionReady: false, fixtureAutoImported: false,
    }));
    writeFileSync(join(staging, "RECIPE.md"), `# ${recipe.title}\n\nSynthetic data only. Pin: ${revision}. Port: ${port}.\n\n` +
      recipe.boundaries.map(boundary => `- ${boundary}`).join("\n") +
      "\n\nRun `pnpm run setup`, `pnpm inferos:check`, `pnpm fixtures:check`, `pnpm views:check`, " +
      "`pnpm skills:check`, then `pnpm run doctor`. Read README.md before `pnpm dev`. " +
      "Seed only this local stack with `pnpm local seed`. The pinned mock does not import this fixture. " +
      "From the generator checkout run `node packages/workshop-backend/scripts/propose-recipe.ts <this-wrapper>` " +
      "to queue the three catalog cards and create a view, then review each creation in the approval queue. " +
      "Existing demo cards remain; fixture IDs are not imported. Never stop an unrelated listener. " +
      "A passing check is not runtime or provider proof.\n\n" +
      "Use the shipped Operate skills and board to propose a status change; reject once, then approve a fresh proposal. " +
      "Verify rejection leaves the source revision unchanged. Open two tabs, make one proposal stale with a competing edit, " +
      "and confirm it cannot silently overwrite. Disconnect the resource and verify further reads/actions fail. " +
      "The recipe does not automate approval or upload skills.\n\n" +
      "Keep customizations in this wrapper. Rerunning recipe creation preserves all edits. " +
      "Use `pnpm inferos upgrade <reviewed-sha> --plan` before an explicit reviewed upgrade. " +
      "Reference fixtures under fixtures/recipe-reference are scenario inputs, not working device/EHR adapters.\n");
    checkConsumer(staging);
    checkConsumerFixture(staging);
    readConsumerViews(staging);
    renameSync(staging, target);
    return { created: true, destination: target, recipe: recipeName, revision, runtimeReady: false };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repository: { type: "string" }, revision: { type: "string" }, port: { type: "string", default: "28787" },
  } });
  if (positionals.length !== 2 || !values.repository || !values.revision) {
    throw new Error("Usage: create.ts RECIPE NEW_DIRECTORY --repository URL_OR_ABSOLUTE_PATH --revision FULL_SHA [--port 28787]");
  }
  console.log(json(createRecipe(positionals[0], positionals[1], values.repository, values.revision, Number(values.port))));
}
