// The Kanban gadget's Durable Object: a thin proxy from the client to the `board` binding (an
// InferOps project board). It keeps no copy of InferOps data -- InferOps stays authoritative, and
// every read goes through the binding, which records it and shows pending moves.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { failureCode, failureMessage } from "./lib/board.ts";
import type {
  GadgetStub, InferOpsProjectSession, LoadBoardResult, MoveResult, Revision,
} from "./lib/protocol.ts";

/** The bindings this gadget may be given. `board` is absent until a project board is connected. */
interface GadgetEnv {
  board?: InferOpsProjectSession;
}

const NOT_CONNECTED =
  "No InferOps board is connected. Connect an InferOps project board to this gadget as `board`.";

// Props is `unknown` so that `ctx` is the plain `DurableObjectState` the constructor receives.
export class Gadget extends DurableObject<GadgetEnv, unknown> implements GadgetStub {
  async loadBoard(): Promise<LoadBoardResult> {
    const board = this.env.board;
    if (!board) return { ok: false, reason: "not-connected" };
    try {
      return { ok: true, board: await board.readBoard() };
    } catch (error) {
      return { ok: false, reason: "error", message: failureMessage(error) };
    }
  }

  /**
   * Propose moving an issue. The issue capability is opened and used in one pipelined round trip,
   * and released afterwards. A refused move comes back as a result, not a thrown error, so the
   * client can branch on its code.
   */
  async moveIssue(issueId: string, toStateId: string, expectedRevision: Revision): Promise<MoveResult> {
    const board = this.env.board;
    if (!board) return { ok: false, code: "NOT_CONNECTED", message: NOT_CONNECTED };
    const issue = board.openIssue(issueId);
    try {
      await issue.transition(toStateId, expectedRevision);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: failureCode(error), message: failureMessage(error) };
    } finally {
      issue[Symbol.dispose]?.();
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

const KANBAN_EXPORT_FORMATS: ExportFormat[] = [
  { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
  { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<ExportFormat[]> {
    return KANBAN_EXPORT_FORMATS;
  }

  async export(_gadget: GadgetStub, id: string): Promise<never> {
    throw new Error("Unsupported Kanban export format: " + id);
  }
}
