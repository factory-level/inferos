// The Tickets connection package's Worker: vendor, account, verifier and the queue gatekeeper.
//
// The second connection package after InferOps, built through `pnpm gatekeepers:scaffold tickets`
// and filled in: a synthetic support-ticket service with one read surface (a queue's tickets) and
// one approved write (a status change). Its data source is `TicketsFakeProvider`, synthetic data in
// a Durable Object; there is no real Tickets service. It passes the shared conformance suite, so
// `connection.json` says `status: "conformant"`, which keeps it out of releases and out of the
// default custom-gatekeeper selection.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ActionApplyError, ActionJournal, applyActionOutcome, defineActions, type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { createLogger } from "@gadgets/observability/logger";
import type {
  AccountDescription, ActionApplyFailure, ActionKind, ApprovalQueue, Gatekeeper,
  GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, GitCache,
  ResourceConfiguratorFrame, ResourceDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { errorCode, openClient, type TicketsClient, type ErrorCode } from "./client";
import { TicketsFakeProvider } from "./fake-provider";
import type { Revision, Ticket, TicketStatus, TicketsQueueSession } from "./types";
import TYPES_CODE from "./types.txt";

export { TicketsFakeProvider };

const VENDOR_ID = "tickets";

type LogFields = { vendorId: string; queueId: string; action: number; code: string };
const logger = createLogger<LogFields>({ component: "gatekeeper.tickets", vendorId: VENDOR_ID });

// A plain square glyph; replace with the provider's own mark.
const ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<rect x='40' y='40' width='176' height='176' rx='24'/></svg>"),
};

const NO_CONNECT_FLOW = "The Tickets connector is provided automatically; it has no connect flow.";
const STATUSES: readonly TicketStatus[] = ["open", "pending", "closed"];

/** The one resource kind: a queue of tickets, bound by URL. */
const QUEUE_RESOURCE: SupportedResource = {
  urlPattern: "tickets://*/queue/*",
  title: "Tickets queue",
  description: "One Tickets queue: read its tickets and propose status changes, each approved by you.",
  icon: ICON,
};

/** What the Workshop bakes into one binding when it mints it; the session never takes these. */
type BindingProps = { accountId: string; workspace: string; queueId: string };

/** The props of one account, as the Workshop's stub for it carries them. */
type AccountProps = { accountId: string };

/** The workspace and queue a resource URL names, or an error saying why it names none. */
function parseQueueUrl(url: string): { workspace: string; queueId: string } {
  const match = /^tickets:\/\/([a-z0-9-]+)\/queue\/([A-Za-z0-9_-]+)$/.exec(url);
  if (!match) throw new Error(`Not a Tickets queue URL: expected tickets://<workspace>/queue/<id>.`);
  return { workspace: match[1]!, queueId: match[2]! };
}

/** The message an agent sees for a provider refusal. Never echoes a value the agent sent. */
function refusal(code: ErrorCode | null): string {
  switch (code) {
    case "NOT_FOUND": return "NOT_FOUND: No such ticket in this queue.";
    case "STALE_REVISION": return "STALE_REVISION: The ticket changed after this was proposed; read it again.";
    case "INVALID_REQUEST": return "INVALID_REQUEST: The request was malformed.";
    case "INVALID_STATE": return "INVALID_STATE: The ticket is closed or already has that status.";
    case "UNAUTHORIZED": return "UNAUTHORIZED: This Tickets account was disconnected.";
    case "UNAVAILABLE": return "UNAVAILABLE: Tickets could not be reached; try again.";
    default: return "Tickets failed unexpectedly.";
  }
}

/** Errors known to have left nothing behind at the provider, so a retry can never succeed. */
const TERMINAL: ReadonlySet<ErrorCode> = new Set(["NOT_FOUND", "STALE_REVISION", "INVALID_REQUEST", "INVALID_STATE", "UNAUTHORIZED"]);

/** No HTTP surface: there is no connect flow, and everything else is RPC. */
export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Actions

/** Every write this connector can be asked to make, by kind. */
type Actions = {
  setStatus: { ticketId: string; status: TicketStatus; expectedRevision: Revision };
};

/** What the action handlers may reach: the client and this binding's scope, never the DO itself. */
type Host = { client: TicketsClient; queueId: string; idempotencyKey(actionId: number): string };

const actions = defineActions<Host, Actions>({
  setStatus: {
    kind: { tag: "set-status", label: "Change a ticket's status" },
    // No simulation: the agent waits for the decision instead of reading a pending change.
    delivery: "await-decision",
    describe: ({ ticketId, status, expectedRevision }) => ({
      title: `Set ticket ${ticketId} to ${status}`,
      description: `Moves ticket \`${ticketId}\` (revision ${expectedRevision}) to **${status}**.` +
        (status === "closed" ? " A closed ticket cannot be reopened through this connector." : ""),
      descriptionIsComplete: true,
      implementsRevert: false,
    }),
    apply: async ({ ticketId, status, expectedRevision }, host, { id }) => {
      try {
        // The key is stable across retries, so a repeated or retried apply is answered by the
        // provider without writing twice.
        await host.client.setStatus(host.queueId, ticketId, status, expectedRevision, host.idempotencyKey(id));
      } catch (error) {
        const code = errorCode(error);
        logger.warn("status change failed", {
          event: "status.apply.failed", queueId: host.queueId, action: id, code: code ?? "UNKNOWN", error,
        });
        // Known to have changed nothing: terminal. Anything else stays pending and is retried.
        if (code && TERMINAL.has(code)) throw new ActionApplyError(refusal(code));
        throw new Error(refusal(code), { cause: error });
      }
    },
  },
}, {
  // Accounts are auto-provisioned and never reconnected, so there is no authority to fence on.
  fence: "none",
  vendorId: VENDOR_ID,
});

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Tickets",
      url: "https://example.com/tickets",
      logo: ICON,
      tagline: "Read a support queue and propose status changes (synthetic data)",
      description:
        "Gives Gadgets access to one Tickets queue at a time: read its tickets and propose " +
        "moving them between open, pending and closed, each change approved by you. Tickets is a " +
        "synthetic service for exercising connection packages; it holds demo data only.",
      autoProvisionsAccount: true,
    };
  }

  /**
   * Mint an account with no user identity; its random id keys its own synthetic data. Return
   * validation is skipped: proxy-wrapping a WorkerEntrypoint stub breaks serialization.
   */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.TicketsAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>,
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error(NO_CONNECT_FLOW);
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [QUEUE_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// Account

@validateRpc()
export class TicketsAccount extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
    implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return { displayName: "Tickets (synthetic data)", avatar: ICON };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [QUEUE_RESOURCE];
  }

  /**
   * Bind one queue this account can see. The scope is fixed in the binding's props here; no
   * session method takes a queue. An unknown queue is refused before anything is minted.
   */
  @skipRpcValidation()
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const { workspace, queueId } = parseQueueUrl(url);
    const { accountId } = this.ctx.props;
    if (!(await openClient(this.ctx.exports, accountId).hasQueue(queueId))) {
      throw new Error(`No Tickets queue "${queueId}" is available to this account.`);
    }
    const props: BindingProps = { accountId, workspace, queueId };
    return { class: this.ctx.exports.TicketsQueueGatekeeper({ props }), resource: QUEUE_RESOURCE };
  }

  /** No picker yet: the resource URL is entered by hand. */
  @skipRpcValidation()
  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Tickets has no resource picker; enter tickets://<workspace>/queue/<id>.");
  }

  /** Forget this account's data; its bindings then fail on their next call. */
  async revoke(): Promise<void> {
    await openClient(this.ctx.exports, this.ctx.props.accountId).forget();
  }

  async reconnect(): Promise<{ url: string }> {
    throw new Error(NO_CONNECT_FLOW);
  }

  async commitReconnect(_stageId: string): Promise<void> {
    throw new Error(NO_CONNECT_FLOW);
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** No grantable resource types, so nothing to authorize. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.TicketsVerifier({ props: this.ctx.props });
  }
}

/** The verifier surface `addObserver` relies on; the overseer only hands it back to this vendor. */
export interface TicketsVerifierApi extends GatekeeperUserVerifier {
  /** Whether this account can see the queue, from its own data. */
  hasQueueAccess(queueId: string): Promise<boolean>;
}

@validateRpc()
export class TicketsVerifier extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
    implements TicketsVerifierApi {
  async hasQueueAccess(queueId: string): Promise<boolean> {
    try {
      return await openClient(this.ctx.exports, this.ctx.props.accountId).hasQueue(queueId);
    } catch (error) {
      // A disconnected observer has no access; any other failure is reported, not read as "no".
      if (errorCode(error) === "UNAUTHORIZED") return false;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Queue gatekeeper (a facet of the overseer, one per binding)

@validateRpc()
export class TicketsQueueGatekeeper extends DurableObject<Cloudflare.Env, BindingProps>
    implements Gatekeeper<TicketsQueueSession> {
  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, { namespace: "tickets" });

  // One host per journal: the action set refuses to be rebound to a different one.
  readonly #host: Host = {
    client: openClient(this.ctx.exports, this.ctx.props.accountId),
    queueId: this.ctx.props.queueId,
    idempotencyKey: actionId => `${this.#bindingId()}:${actionId}`,
  };

  /** A random id for this binding, so two bindings of one account never share a key. */
  #bindingId(): string {
    let id = this.ctx.storage.kv.get<string>("binding-id");
    if (!id) this.ctx.storage.kv.put("binding-id", id = crypto.randomUUID());
    return id;
  }

  #actions() {
    return actions.bind(this.#journal, this.#host);
  }

  async describe(): Promise<ResourceDescription> {
    const { workspace, queueId } = this.ctx.props;
    return {
      url: `tickets://${workspace}/queue/${queueId}`,
      title: `Tickets queue ${queueId}`,
      snippet: `Tickets queue ${queueId}: read its tickets and propose status changes.`,
      suggestedBindingName: "TICKETS_QUEUE",
      tsType: "TicketsQueueSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Every write waits for review; none is auto-approvable. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<TicketsQueueSession> {
    const queue = approvalQueue.dup();
    return new QueueSessionImpl(this.#host, queue,
      payload => this.#actions().submit(queue, "setStatus", payload));
  }

  /** Strategy B: the binding is one queue, so admit an observer who can see that queue. */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<TicketsVerifierApi>;
    if (!(await verifier.hasQueueAccess(this.ctx.props.queueId))) {
      throw new Error("This collaborator cannot see this Tickets queue, so they cannot observe " +
        "what a Gadget reads from it.");
    }
  }

  /** Nothing is tracked per observer under strategy B. */
  async removeObserver(_id: string): Promise<void> {}

  /**
   * Applies once: the kit's journal answers a repeated apply of an applied action as a no-op. A
   * terminal failure reaches the overseer as its structured result (`applyActionOutcome`): known not
   * applied for `ActionApplyError`, possibly applied for `ActionOutcomeUnknownError`, replayed with
   * the same classification after a restart. Any other error is rethrown and stays retryable.
   */
  async applyAction(actionId: number, _cache: RpcStub<GitCache>):
      Promise<void | { failed: ActionApplyFailure }> {
    return applyActionOutcome(() => this.#actions().apply(actionId));
  }

  async rejectAction(actionId: number): Promise<void> {
    await this.#actions().reject(actionId);
  }

  /** Submitted as not revertible. */
  async revertAction(_actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    return { message: "Status changes are not revertible here; propose the previous status instead.", canRetry: false };
  }
}

// ---------------------------------------------------------------------------
// Session: what the agent holds

@validateRpc()
class QueueSessionImpl extends RpcTarget implements TicketsQueueSession {
  readonly #host: Host;
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #submit: (payload: Actions["setStatus"]) => Promise<number>;

  constructor(host: Host, queue: RpcStub<ApprovalQueue>,
              submit: (payload: Actions["setStatus"]) => Promise<number>) {
    super();
    this.#host = host;
    this.#queue = queue;
    this.#submit = submit;
  }

  [Symbol.dispose]() {
    this.#queue[Symbol.dispose]();
  }

  /** Runs one provider read, turning a provider refusal into the message the agent sees. */
  async #read<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw new Error(refusal(errorCode(error)), { cause: error });
    }
  }

  async listTickets(): Promise<Ticket[]> {
    const { client, queueId } = this.#host;
    const tickets = await this.#read(() => client.listTickets(queueId));
    await this.#queue.authorizeObservation({
      title: `Read Tickets queue ${queueId}`,
      description: `Listed ${tickets.length} tickets.`,
    });
    return tickets;
  }

  async readTicket(ticketId: string): Promise<Ticket> {
    const { client, queueId } = this.#host;
    const ticket = await this.#read(() => client.readTicket(queueId, ticketId));
    await this.#queue.authorizeObservation({
      title: `Read Tickets ticket ${ticket.id}`,
      description: `Read ticket ${ticket.id} of queue ${queueId}.`,
    });
    return ticket;
  }

  async setStatus(ticketId: string, status: TicketStatus, expectedRevision: Revision): Promise<void> {
    if (!STATUSES.includes(status) || !/^\d+$/.test(expectedRevision)) {
      throw new Error(refusal("INVALID_REQUEST"));
    }
    const { client, queueId } = this.#host;
    // Checked now so a wrong id, a closed ticket or a no-op fails here rather than at approval.
    // Nothing read is returned, so this is not an observation. The provider checks again at apply.
    const current = await this.#read(() => client.readTicket(queueId, ticketId));
    if (current.status === "closed" || current.status === status) throw new Error(refusal("INVALID_STATE"));
    await this.#submit({ ticketId, status, expectedRevision });
  }
}
