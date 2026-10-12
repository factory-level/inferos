// The Model usage gadget's Durable Object: serves the SYNTHETIC demo fixture, one workspace per
// load. It has no bindings and stores nothing. The workspace is chosen here, at the source: a load
// returns only the requested demo workspace's figures, so the client never receives another
// workspace's rows to filter. This is a presentation demo; it proves no tenant authorization.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DemoWorkspace, GadgetStub, LoadUsageResult } from "./lib/protocol.ts";
import { listDemoWorkspaces, loadDemoUsage } from "./lib/source.ts";

export class Gadget extends DurableObject<Record<string, never>, unknown> implements GadgetStub {
  /** The demo workspaces, names and ids only. */
  async listWorkspaces(): Promise<DemoWorkspace[]> {
    return listDemoWorkspaces();
  }

  /** One demo workspace's usage, or why there is none. Never throws. */
  async loadUsage(workspaceId: string): Promise<LoadUsageResult> {
    return loadDemoUsage(workspaceId);
  }
}

// An export format as the Workshop lists it.
interface ExportFormat {
  id: string;
  label: string;
  mode: "server" | "browser";
  contentType: string;
  fileExtension: string;
}

/**
 * Demo figures must not leave the gadget looking like a report: no export formats at all, which
 * also turns off the Workshop's default HTML and PDF formats.
 */
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<ExportFormat[]> {
    return [];
  }
}
