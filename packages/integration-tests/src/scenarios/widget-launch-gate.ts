// Scenario `widget-launch-gate` version 1 (FAC-15): one authored React/Refine widget through the
// whole governed loop, on synthetic fixtures: generated (compiled by the real build Durable Object),
// securely published (a console publication, listed in InferOps' widget index as its publisher),
// found by meaning (the person's own widget search), embedded in the Wiki (the published console's
// instance a page resolves) and in Operate (a placement on the person's own canvas), then read,
// filtered and acted on by the operate agent, whose act is a declared board command the person
// approves. The contract is `widget-launch-gate.md` beside this file; this module holds its data,
// and the runner is `__tests__/widget-launch-gate-scenario.test.ts`.
//
// Only the InferOps and InferLab provider answers (`InferOpsFake`) and the model (a scripted model
// router) are programmed. The widget's own data is a local, in-memory Refine data provider: it reads
// no governed data (FAC-15's known gap G-1).

import {
  assertLoopbackTarget as assertLoopback, scenarioVerdict as verdictFor,
  type ScenarioCase, type ScenarioIsolation, type ScenarioReport as Report,
} from "./scenario-report.js";

/** Bump `version` whenever a fixture input or an expected result below changes. */
export const SCENARIO = { id: "widget-launch-gate", version: 2 } as const;

/** The InferOps workspace the fixture people hold, where the publisher may publish shared configuration. */
export const SCENARIO_WORKSPACE = "operations";

/** What the widget is called, and what its definition says it is for: what a search by meaning finds. */
export const WIDGET_TITLE = "Open orders";
export const WIDGET_PURPOSE = "Lists the orders still open, with their customer, so a dispatcher can pick the next one.";

/**
 * The words a person searches with. The fake InferOps ranks by keyword (one shared word, "orders"):
 * a real deployment ranks by embeddings, which this run doesn't exercise (FAC-15 gap: no real-embedding run).
 */
export const SEARCH_INTENT = "which orders are still waiting";

/**
 * The authored widget's source: React and Refine (`@refinedev/core`), compiled by the build Durable
 * Object, with a local in-memory data provider. It reaches nothing outside its frame.
 */
export const WIDGET_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  "client.tsx": `import React from "react";
import { Refine, useList, type DataProvider } from "@refinedev/core";

const ORDERS = [
  { id: 1, customer: "Acme", status: "open" },
  { id: 2, customer: "Globex", status: "open" },
  { id: 3, customer: "Initech", status: "closed" },
];

// Local only: the widget's data never leaves its frame.
const local: DataProvider = {
  getApiUrl: () => "",
  getList: async ({ filters }) => {
    const status = (filters ?? []).find((f) => "field" in f && f.field === "status")?.value ?? "open";
    const data = ORDERS.filter((order) => order.status === status);
    return { data: data as never, total: data.length };
  },
  getOne: async ({ id }) => ({ data: ORDERS.find((order) => order.id === Number(id)) as never }),
  create: async () => { throw new Error("read-only"); },
  update: async () => { throw new Error("read-only"); },
  deleteOne: async () => { throw new Error("read-only"); },
};

const Orders = () => {
  const { result } = useList({ resource: "orders", filters: [{ field: "status", operator: "eq", value: "open" }] });
  return <ul>{result.data.map((order: { id: number; customer: string }) => <li key={order.id}>{order.customer}</li>)}</ul>;
};

export default function Widget() {
  return <Refine dataProvider={local} resources={[{ name: "orders" }]}><Orders /></Refine>;
}
`,
  "server.js": `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {}
`,
  // Its one declared command (FAC-14 K2): the builder binds it to the console's own board connection,
  // and the operate agent may only request it.
  "tools.json": JSON.stringify([
    { name: "moveIssue", description: "Ask to move an order's issue on the board.", effect: "write",
      command: "inferops.issue.transition" },
  ]),
});

/** The widget's declared command the agent requests. */
export const COMMAND = "moveIssue";

/** The seeded board issue the command moves, on the fake InferOps board `ENG`. */
export const SCENARIO_ISSUE = "ENG-1";

/** Refuse any target that is not a plain-HTTP loopback Workshop. */
export function assertLoopbackTarget(target: URL): URL {
  return assertLoopback(target, SCENARIO.id);
}

export type { ScenarioCase };

/** The bounded, credential-free report a run writes. */
export type ScenarioReport = Report<typeof SCENARIO.id>;

/** The case names a complete run records, in order. */
export const CASE_NAMES = [
  "loopback-only", "generate", "publish", "find", "embed-resolve", "embed-operate", "agent-read-filter", "agent-act",
] as const;

/** PASS only for every case passing and an isolation check that ran and found no unanswered request. */
export function scenarioVerdict(cases: readonly ScenarioCase[], isolation: ScenarioIsolation): ScenarioReport["verdict"] {
  return verdictFor(CASE_NAMES, cases, isolation);
}

/** Which parts of the run are programmed and which are the real code paths. */
export const BOUNDARIES = {
  mocked: [
    "InferOps and InferLab provider answers (InferOpsFake: sign-in, the widget index and keyword widget search, the board and its write log)",
    "the model: a scripted model router; no live model call",
    "the widget's data: a local in-memory Refine data provider inside its frame (no governed data, FAC-15 gap G-1)",
    "synthetic password accounts and InferLab identities",
  ],
  real: [
    "the authored widget compiler and the build Durable Object (React, Refine 5, the import allowlist and closure hash)",
    "blueprint publication, the console's frozen installs and console publication with shared configuration authority",
    "the console widget index write to InferOps as the publisher",
    "the person's own widget search through their InferOps account",
    "the kernel embed path a Wiki embed calls (resolveEmbeddedWidget, getEmbeddedWidget); no Wiki page renders it",
    "the person's own canvas placement (OperateSession.saveWidgetPlacement)",
    "the operate agent's widget tools and its declared-command request, and the person's approval through the action journal",
  ],
};
