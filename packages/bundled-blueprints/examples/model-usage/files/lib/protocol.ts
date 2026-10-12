// The contract between this gadget's client and its Durable Object. Imported type-only, so nothing
// of it ships. Every amount is synthetic demo data from ./fixture.ts: nothing here is read from a
// provider, a gateway, a bill or any InferOS usage store.

/** One demo workspace the gadget can show. Workspace totals only: no person, session or chat. */
export interface DemoWorkspace {
  workspaceId: string;
  workspaceName: string;
}

/**
 * Usage of one model from one provider in the window. Costs are integer US cents, or `null` when
 * that kind of figure is not available (shown as "Unknown", never as 0).
 */
export interface ModelUsageRow {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  /** InferOS's own estimate from token counts and a price table. */
  estimatedCents: number | null;
  /** What the model provider or gateway reported for the window. */
  providerReportedCents: number | null;
  /** What an invoice charged. No billing source exists, so this is always null in the demo. */
  billedCents: number | null;
}

/** One workspace's usage over one window, with when the figures were last brought up to date. */
export interface WorkspaceUsage {
  workspace: DemoWorkspace;
  /** Always "demo-fixture": the figures are synthetic. */
  source: "demo-fixture";
  window: { from: string; to: string };
  /** When the figures were last updated (ISO 8601). */
  asOf: string;
  rows: ModelUsageRow[];
}

/** One load of one workspace's usage, or why there is none. */
export type LoadUsageResult =
  | ({ ok: true } & WorkspaceUsage)
  | { ok: false; reason: "unknown-workspace" }
  | { ok: false; reason: "unavailable"; message: string };

/** The Durable Object's RPC surface, as the client's `gadget` stub sees it. */
export interface GadgetStub {
  listWorkspaces(): Promise<DemoWorkspace[]>;
  loadUsage(workspaceId: string): Promise<LoadUsageResult>;
}
