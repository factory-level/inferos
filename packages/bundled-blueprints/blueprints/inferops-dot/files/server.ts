// The Dot gadget's Durable Object: a thin proxy from the client to the `dot` binding (the person's
// own Dot in one InferOps workspace). It keeps one thing, the id of the conversation it is having
// (a reference, never a message: InferOps stays authoritative, inferos ADR 0013), and reads the
// conversation back from InferOps whenever it is shown. Each change the Dot proposes is decided
// where every other write is, under Needs your approval; this gadget decides nothing.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { classify, shown, shownProgress } from "./lib/dot.ts";
import type {
  AskResult, DotConversationSession, Failure, GadgetStub, InferOpsDotSession, OpenResult, ProgressTarget,
} from "./lib/protocol.ts";

/** The bindings this gadget may be given. `dot` is absent until a Dot is connected. */
interface GadgetEnv {
  dot?: InferOpsDotSession;
}

/** Where the conversation's id is kept: the only thing this gadget stores. */
const CONVERSATION_KEY = "conversation";

const NOT_CONNECTED: Failure = { ok: false, reason: "not-connected", message: "No Dot is connected." };

// Props is `unknown` so that `ctx` is the plain `DurableObjectState` the constructor receives.
export class Gadget extends DurableObject<GadgetEnv, unknown> implements GadgetStub {
  /**
   * This gadget's conversation: the one it keeps, reopened; when that one is gone (or isn't yours)
   * it is forgotten, and with `start` a new one is begun and kept. Null when there is none and
   * `start` is false.
   */
  async #conversation(dot: InferOpsDotSession, start: boolean): Promise<DotConversationSession | null> {
    const kept = this.ctx.storage.kv.get<string>(CONVERSATION_KEY);
    if (kept) {
      try {
        return await dot.openConversation(kept);
      } catch (error) {
        if (classify(error).reason !== "not-found") throw error;
        this.ctx.storage.kv.delete(CONVERSATION_KEY);
      }
    }
    if (!start) return null;
    const conversation = await dot.startConversation();
    this.ctx.storage.kv.put(CONVERSATION_KEY, await conversation.id());
    return conversation;
  }

  async open(): Promise<OpenResult> {
    const dot = this.env.dot;
    if (!dot) return NOT_CONNECTED;
    try {
      const conversation = await this.#conversation(dot, false);
      return { ok: true, conversation: conversation ? shown(await conversation.read()) : null };
    } catch (error) {
      return classify(error);
    }
  }

  async ask(prompt: string, progress: ProgressTarget): Promise<AskResult> {
    const dot = this.env.dot;
    if (!dot) return NOT_CONNECTED;
    try {
      const conversation = (await this.#conversation(dot, true))!;
      // Each step reaches the client as it happens, a proposed change only as shown (never its
      // receipt or arguments); one it can't take stops nothing here.
      const turn = await conversation.ask(prompt, { onProgress: event => progress.progress(shownProgress(event)) });
      return { ok: true, status: turn.status, conversation: shown(await conversation.read()) };
    } catch (error) {
      return classify(error);
    }
  }

  async cancel(): Promise<{ ok: true } | Failure> {
    const dot = this.env.dot;
    if (!dot) return NOT_CONNECTED;
    try {
      await (await this.#conversation(dot, false))?.cancel();
      return { ok: true };
    } catch (error) {
      return classify(error);
    }
  }

  async startOver(): Promise<void> {
    this.ctx.storage.kv.delete(CONVERSATION_KEY);
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

// A Dot conversation is the person's own and stays in this private gadget, so it offers no export:
// an empty list turns off the Workshop's default HTML and PDF formats too.
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<ExportFormat[]> {
    return [];
  }
}
