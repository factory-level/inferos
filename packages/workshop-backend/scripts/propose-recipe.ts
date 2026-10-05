// Explicit local-only proposal step: wrapper fixtures are not imported by the pinned mock runtime.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RpcStub } from "capnweb";
import type { InferOpsProjectSession } from "../../../custom-gatekeepers/gatekeeper-inferops/src/types";
import { connectWorkshop, DEMO_BOARD_URL, DEMO_WORKSPACE_TITLE, findWorkspace, localWorkshopUrl, passwordHash } from "./dev-workshop.ts";
import { checkConsumer } from "../../../scripts/consumer/runtime.ts";
import { readConsumerViews } from "../../../scripts/consumer/views.ts";
import { parseRecipeName, RECIPES } from "../../../scripts/recipes/catalog.ts";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.argv[3]) throw new Error("Usage: propose-recipe.ts RECIPE_WRAPPER_ROOT");
const marker = JSON.parse(readFileSync(join(root, "recipe.json"), "utf8"));
const recipe = RECIPES[parseRecipeName(marker.recipe)];
const { config } = checkConsumer(root);
if (marker.synthetic !== true || config.inferops.mode !== "fixture" || config.inferops.targetRef !== DEMO_BOARD_URL || config.local.port !== 28787) {
  throw new Error("Recipe proposals require a synthetic demo.local fixture on isolated port 28787");
}
const view = readConsumerViews(root).find(candidate => candidate.id === "operations");
if (!view || view.sections.some(section => section.widgets.some(widget => widget.targetRef !== DEMO_BOARD_URL))) {
  throw new Error("Recipe view must reference only the synthetic demo board");
}
const { api, close } = connectWorkshop(localWorkshopUrl("http://localhost:28787"));
try {
  const token = await api.login("dev", passwordHash("dev", "devpassword"));
  if (!token) throw new Error("Run pnpm local seed in this wrapper first");
  using user = await api.authenticate(token);
  const workspace = await findWorkspace(user, DEMO_WORKSPACE_TITLE);
  if (!workspace) throw new Error("Seeded workspace not found");
  using overseer = user.openGadget(workspace.id);
  using connection = await overseer.getGatekeeperByResourceUrl(DEMO_BOARD_URL);
  if (!connection) throw new Error("Seeded board connection not found");
  using session = await connection.openSession() as RpcStub<InferOpsProjectSession>;
  const board = await session.readBoard();
  const existing = new Set(board.columns.flatMap(column => column.issues.map(issue => issue.title)));
  let proposed = 0;
  for (const title of recipe.cards) {
    if (existing.has(title)) continue;
    await session.createIssue({ title, priority: "medium" });
    proposed++;
  }
  const saved = (await overseer.listCanvases()).find(canvas => canvas.title === view.title)
    ?? await overseer.createCanvas({ title: view.title, sections: view.sections });
  console.log(JSON.stringify({ recipe: marker.recipe, proposed, approved: 0,
    url: `http://localhost:28787/workspace/${workspace.id}/inferops-canvas?view=${saved.id}`,
    next: "Review and approve or reject each recipe creation in the Workshop approval queue. Existing demo cards are retained." }));
} finally { close(); }
