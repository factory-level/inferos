import { describe, expect, test } from "vitest";
import type { BlueprintBindingAssignment } from "./api";
import type { ArtifactBindingRequirement } from "./agent-artifact";
import {
  AGENT_DEPLOYMENT_TRANSITIONS, agentDeploymentTransition, carryForwardGrants,
  type AgentDeploymentEvent, type AgentDeploymentState,
} from "./agent-deployment";

const STATES = Object.keys(AGENT_DEPLOYMENT_TRANSITIONS) as AgentDeploymentState[];
const EVENTS: AgentDeploymentEvent[] = ["activate", "pause", "drained", "resume", "update", "retire"];

describe("agentDeploymentTransition", () => {
  test("follows the reviewed path from plan to retirement", () => {
    let path: [AgentDeploymentEvent, AgentDeploymentState][] = [
      ["activate", "active"], ["pause", "draining"], ["drained", "paused"], ["update", "paused"],
      ["resume", "active"], ["pause", "draining"], ["drained", "paused"], ["retire", "retired"],
    ];
    let state: AgentDeploymentState = "planned";
    for (let [event, next] of path) {
      expect(agentDeploymentTransition(state, event)).toBe(next);
      state = next;
    }
  });

  test("never updates or retires while a run can be in flight", () => {
    for (let state of ["active", "draining"] as const) {
      expect(agentDeploymentTransition(state, "update")).toBeNull();
      expect(agentDeploymentTransition(state, "retire")).toBeNull();
    }
  });

  test("retired is terminal", () => {
    for (let event of EVENTS) expect(agentDeploymentTransition("retired", event)).toBeNull();
  });

  test("only a draining deployment can become paused, and only by draining", () => {
    for (let state of STATES) {
      for (let event of EVENTS) {
        if (agentDeploymentTransition(state, event) === "paused" && state !== "paused") {
          expect([state, event]).toEqual(["draining", "drained"]);
        }
      }
    }
  });
});

describe("carryForwardGrants", () => {
  const board: ArtifactBindingRequirement = { type: "gatekeeper", gatekeeperName: "inferops", typeUrlPattern: "inferops://*" };
  const grants: Record<string, BlueprintBindingAssignment> = {
    BOARD: { type: "gatekeeper", accountId: 7, resourceUrl: "inferops://acme.ops/project/board/OPS" },
    MODEL: { type: "aiModel", modelId: "m1" },
  };

  test("a behaviour-only change carries exactly the same grants and adds none", () => {
    let requirements = { BOARD: board, MODEL: { type: "aiModel" } as const };
    expect(carryForwardGrants(requirements, { ...requirements }, grants)).toEqual({ carried: grants, needsGrant: [] });
  });

  test("a changed, new or ungranted requirement needs an explicit grant", () => {
    let from = { BOARD: board, MODEL: { type: "aiModel" } as const };
    let to = {
      BOARD: { ...board, typeUrlPattern: "inferops://*/project/*" },
      MODEL: { type: "aiModel" } as const,
      WIKI: { type: "gatekeeper", gatekeeperName: "inferops", typeUrlPattern: "inferops://*/wiki" } as const,
    };
    expect(carryForwardGrants(from, to, grants)).toEqual({ carried: { MODEL: grants.MODEL }, needsGrant: ["BOARD", "WIKI"] });
  });

  test("grants for dropped bindings are released", () => {
    expect(carryForwardGrants({ BOARD: board, MODEL: { type: "aiModel" } }, { MODEL: { type: "aiModel" } }, grants).carried)
        .toEqual({ MODEL: grants.MODEL });
  });

  test("inherited object keys are never read as grants", () => {
    expect(carryForwardGrants({}, { toString: { type: "aiModel" } as const }, {}).needsGrant).toEqual(["toString"]);
  });
});
