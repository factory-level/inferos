import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { GadgetStub, QueryResult, ServiceProject, ServiceQueryName } from "./protocol.ts";

/** Three dashboard widgets share this project capability without copying records into storage. */
export class Gadget extends DurableObject<{ project?: ServiceProject }, unknown> implements GadgetStub {
  async query(name: ServiceQueryName, cursor?: string): Promise<QueryResult> {
    if (!this.env.project) return { ok: false, reason: "not-connected" };
    try {
      const page = await this.env.project.readServiceQuery(name, { limit: 25, ...(cursor ? { cursor } : {}) });
      return { ok: true, page };
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":")[0] : "";
      return { ok: false, reason: ["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"].includes(code ?? "") ? "denied" : "unavailable" };
    }
  }

  async comment(jobId: string, body: string, headSeq: string): Promise<{ ok: boolean }> {
    if (!this.env.project) return { ok: false };
    try {
      using issue = await this.env.project.openIssue(jobId);
      await issue.comment(body, headSeq);
      return { ok: true };
    } catch { return { ok: false }; }
  }
}

/** Joined customer data is private; this dashboard offers no export. */
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<[]> { return []; }
}

export type * from "./protocol.ts";
