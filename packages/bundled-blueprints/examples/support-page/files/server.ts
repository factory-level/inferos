// The tech-support page's Durable Object: serves the SYNTHETIC demo fixture, one installation per
// load. It has no bindings, stores nothing and has no write method. The installation is chosen
// here, at the source: a load returns only the requested demo installation's page, so the client
// never receives another installation's issues or runbook to filter. This is a presentation demo;
// it proves no tenant authorization and reads no live board, Wiki or metric.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DemoInstallation, GadgetStub, LoadSupportPageResult } from "./lib/protocol.ts";
import { listDemoInstallations, loadDemoSupportPage } from "./lib/source.ts";

export class Gadget extends DurableObject<Record<string, never>, unknown> implements GadgetStub {
  /** The demo installations, names and ids only. */
  async listInstallations(): Promise<DemoInstallation[]> {
    return listDemoInstallations();
  }

  /** One demo installation's page, or why there is none. Never throws. */
  async loadSupportPage(installationId: string): Promise<LoadSupportPageResult> {
    return loadDemoSupportPage(installationId);
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
