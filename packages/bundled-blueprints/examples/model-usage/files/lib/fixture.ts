// The demo data: synthetic workspaces and figures, deterministic, chosen to exercise every state
// the view draws. No real model, provider account, person or bill is described.
import type { DemoWorkspace, WorkspaceUsage } from "./protocol.ts";

export const DEMO_WINDOW = { from: "2026-10-05T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" };

type Dataset =
  | { kind: "usage"; usage: Omit<WorkspaceUsage, "workspace" | "source" | "window"> }
  | { kind: "unavailable"; message: string };

const ws = (n: number, workspaceName: string): DemoWorkspace => ({
  workspaceId: `00000000-0000-4000-8000-0000000de${String(n).padStart(3, "0")}`,
  workspaceName,
});

export const DEMO_WORKSPACES: ReadonlyArray<{ workspace: DemoWorkspace; data: Dataset }> = [
  {
    workspace: ws(1, "Demo Operations"),
    data: {
      kind: "usage",
      usage: {
        asOf: "2026-10-11T23:00:00.000Z",
        rows: [
          { model: "demo-large", provider: "Demo Provider A", inputTokens: 1_250_000, outputTokens: 310_000,
            estimatedCents: 1_860, providerReportedCents: 1_912, billedCents: null },
          { model: "demo-small", provider: "Demo Provider A", inputTokens: 4_800_000, outputTokens: 920_000,
            estimatedCents: 744, providerReportedCents: 731, billedCents: null },
          { model: "demo-code", provider: "Demo Provider B", inputTokens: 640_000, outputTokens: 205_500,
            estimatedCents: 1_130, providerReportedCents: null, billedCents: null },
        ],
      },
    },
  },
  {
    // Last updated two days before the window's end: drawn as stale.
    workspace: ws(2, "Demo Research"),
    data: {
      kind: "usage",
      usage: {
        asOf: "2026-10-10T00:00:00.000Z",
        rows: [
          { model: "demo-large", provider: "Demo Provider A", inputTokens: 90_000, outputTokens: 12_000,
            estimatedCents: 118, providerReportedCents: 120, billedCents: null },
        ],
      },
    },
  },
  { workspace: ws(3, "Demo Quiet"), data: { kind: "usage", usage: { asOf: "2026-10-11T23:00:00.000Z", rows: [] } } },
  {
    workspace: ws(4, "Demo Unavailable"),
    data: { kind: "unavailable", message: "The demo usage source for this workspace is offline (synthetic error)." },
  },
];
