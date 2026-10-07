// The Records gadget's Durable Object: a thin proxy from the client to the `table` binding (one
// InferOps custom table). It stores nothing -- no rows, no definition -- so InferOps stays
// authoritative and the only thing kept is the binding reference the Workshop holds. Every load is
// one read through the binding, which records it and leaves out personal columns.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { ROW_LIMIT, classify } from "./lib/records.ts";
import type { GadgetStub, InferOpsTableSession, LoadRowsResult } from "./lib/protocol.ts";

/** The bindings this gadget may be given. `table` is absent until a custom table is connected. */
interface GadgetEnv {
  table?: InferOpsTableSession;
}

// Props is `unknown` so that `ctx` is the plain `DurableObjectState` the constructor receives.
export class Gadget extends DurableObject<GadgetEnv, unknown> implements GadgetStub {
  /** The rows with the definition read with them, or why there are none. Never throws. */
  async loadRows(): Promise<LoadRowsResult> {
    const table = this.env.table;
    if (!table) return { ok: false, reason: "not-connected" };
    try {
      const { table: description, records } = await table.listRecords({ limit: ROW_LIMIT });
      return { ok: true, table: description, records };
    } catch (error) {
      return classify(error);
    }
  }
}

// An export format as the Workshop lists it; both are rendered by the client in the browser.
interface ExportFormat {
  id: string;
  label: string;
  mode: "server" | "browser";
  contentType: string;
  fileExtension: string;
}

const RECORDS_EXPORT_FORMATS: ExportFormat[] = [
  { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
  { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<ExportFormat[]> {
    return RECORDS_EXPORT_FORMATS;
  }

  async export(_gadget: GadgetStub, id: string): Promise<never> {
    throw new Error("Unsupported Records export format: " + id);
  }
}
