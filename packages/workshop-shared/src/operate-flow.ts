import { MAX_OPERATE_FLOW_STEPS, MAX_OPERATE_FLOW_TITLE_LENGTH } from "./operate-session.js";

// An authored flow: an ordered list of one workspace's screens (canvas ids), stored in that
// workspace. Running one copies its steps into the runner's operate session (see `startFlow` in
// operate-session.ts); the flow itself holds references and order only.

/** Most flows one workspace stores. */
export const MAX_WORKSPACE_FLOWS = 32;

/** The authored part of a flow. */
export type OperateFlowContent = {
  /** Shown while the flow runs. 1 to `MAX_OPERATE_FLOW_TITLE_LENGTH` characters. */
  title: string;
  /** Canvas ids of this workspace, in the order they are shown. 1 to `MAX_OPERATE_FLOW_STEPS`. */
  steps: string[];
};

/** A stored flow. */
export type OperateFlow = OperateFlowContent & {
  /** Server-minted id, stable for the flow's life. */
  id: string;
  /** Decimal revision, starting at "0" and raised by one on each replacement. */
  revision: string;
};

const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Checks a flow's content against its limits and returns a trimmed copy. Throws a `TypeError`
 * naming the first problem. It does not check that the steps exist; the store does.
 */
export function parseOperateFlowContent(content: OperateFlowContent): OperateFlowContent {
  let title = content.title.trim();
  if (title.length === 0 || title.length > MAX_OPERATE_FLOW_TITLE_LENGTH) {
    throw new TypeError(`A flow title must be 1-${MAX_OPERATE_FLOW_TITLE_LENGTH} characters.`);
  }
  if (content.steps.length === 0 || content.steps.length > MAX_OPERATE_FLOW_STEPS) {
    throw new TypeError(`A flow must have 1-${MAX_OPERATE_FLOW_STEPS} steps.`);
  }
  if (!content.steps.every(step => STEP_ID.test(step))) {
    throw new TypeError("A flow step must be a canvas id.");
  }
  return { title, steps: [...content.steps] };
}
