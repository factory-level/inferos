// The demo source: which workspaces exist and one workspace's figures. The workspace is chosen
// here, at the source -- a load returns only the requested demo workspace -- and every answer is a
// copy, so no caller can change the fixture. Shared by the Durable Object and its tests.
import { DEMO_WINDOW, DEMO_WORKSPACES } from "./fixture.ts";
import type { DemoWorkspace, LoadUsageResult } from "./protocol.ts";

export function listDemoWorkspaces(): DemoWorkspace[] {
  return DEMO_WORKSPACES.map(({ workspace }) => ({ ...workspace }));
}

export function loadDemoUsage(workspaceId: string): LoadUsageResult {
  const entry = DEMO_WORKSPACES.find(({ workspace }) => workspace.workspaceId === workspaceId);
  if (!entry) return { ok: false, reason: "unknown-workspace" };
  if (entry.data.kind === "unavailable") {
    return { ok: false, reason: "unavailable", message: entry.data.message };
  }
  return {
    ok: true,
    workspace: { ...entry.workspace },
    source: "demo-fixture",
    window: { ...DEMO_WINDOW },
    asOf: entry.data.usage.asOf,
    rows: entry.data.usage.rows.map(row => ({ ...row })),
  };
}
