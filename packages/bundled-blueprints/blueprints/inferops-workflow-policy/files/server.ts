// The Workflow policy gadget's Durable Object: a thin proxy from the client to the `policy` binding
// (one InferOps project's published content-workflow policy). It stores nothing -- no policy, no
// project -- so InferOps stays authoritative and the only thing kept is the binding reference the
// Workshop holds. Every load is one read through the binding, which records it and leaves out rule
// reasons, agent notes and the publisher.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { classify } from "./lib/policy.ts";
import type { GadgetStub, InferOpsWorkflowPolicySession, LoadPolicyResult } from "./lib/protocol.ts";

/** The bindings this gadget may be given. `policy` is absent until a workflow policy is connected. */
interface GadgetEnv {
  policy?: InferOpsWorkflowPolicySession;
}

// Props is `unknown` so that `ctx` is the plain `DurableObjectState` the constructor receives.
export class Gadget extends DurableObject<GadgetEnv, unknown> implements GadgetStub {
  /** The project's policy head as the binding read it, or why there is none. Never throws. */
  async loadPolicy(): Promise<LoadPolicyResult> {
    const policy = this.env.policy;
    if (!policy) return { ok: false, reason: "not-connected" };
    try {
      return { ok: true, head: await policy.readWorkflowPolicy() };
    } catch (error) {
      return classify(error);
    }
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

// A policy names principals, which are personal information, and it stays in this private gadget,
// so it offers no export: an empty list turns off the Workshop's default HTML and PDF formats too.
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<ExportFormat[]> {
    return [];
  }
}
