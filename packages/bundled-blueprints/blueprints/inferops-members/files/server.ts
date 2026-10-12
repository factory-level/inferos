// The Members gadget's Durable Object: a thin proxy from the client to the `members` binding (one
// InferOps workspace's member list). It stores nothing -- no members, no workspace -- so InferOps
// stays authoritative and the only thing kept is the binding reference the Workshop holds. Every
// load is one read through the binding, which records it and leaves out email addresses.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { classify } from "./lib/members.ts";
import type { GadgetStub, InferOpsMembersSession, LoadMembersResult } from "./lib/protocol.ts";

/** The bindings this gadget may be given. `members` is absent until a member list is connected. */
interface GadgetEnv {
  members?: InferOpsMembersSession;
}

// Props is `unknown` so that `ctx` is the plain `DurableObjectState` the constructor receives.
export class Gadget extends DurableObject<GadgetEnv, unknown> implements GadgetStub {
  /** The workspace's members with the workspace read with them, or why there are none. Never throws. */
  async loadMembers(): Promise<LoadMembersResult> {
    const members = this.env.members;
    if (!members) return { ok: false, reason: "not-connected" };
    try {
      const { workspace, members: list } = await members.listMembers();
      return { ok: true, workspace, members: list };
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

// A member list is personal information that stays in this private gadget, so it offers no export:
// an empty list turns off the Workshop's default HTML and PDF formats too.
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<ExportFormat[]> {
    return [];
  }
}
