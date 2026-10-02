import { DEFAULT_CANVAS_CATALOG, parseCanvasCatalog, type CanvasCatalog } from "@gadgets/workshop-shared/canvas";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.canvas.catalog");

/** An empty catalog: nothing may be added. What a malformed configuration resolves to. */
const CLOSED_CATALOG: CanvasCatalog = { widgetKinds: [], blueprints: [], screens: [] };

/**
 * The deployment's composition catalog, from the deployer-controlled `CANVAS_CATALOG` JSON var
 * (written by the consumer config CLI). Unset means every registered kind with no blueprints or
 * templates. A malformed value fails closed -- nothing may be added -- and is logged, because a
 * catalog only ever narrows what composition offers.
 */
export function readCanvasCatalog(env: Pick<Cloudflare.Env, "CANVAS_CATALOG">): CanvasCatalog {
  if (env.CANVAS_CATALOG === undefined || env.CANVAS_CATALOG === "") return DEFAULT_CANVAS_CATALOG;
  try {
    return parseCanvasCatalog(JSON.parse(env.CANVAS_CATALOG));
  } catch (error) {
    logger.error("invalid canvas catalog", { event: "canvas.catalog.invalid", error });
    return CLOSED_CATALOG;
  }
}
