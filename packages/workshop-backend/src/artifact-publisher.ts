import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { DurableObject, RpcStub as NativeRpcStub } from "cloudflare:workers";
import {
  artifactRef, type ArtifactKind, type ArtifactModelRequirement, type ArtifactPin,
  type ArtifactQualification,
} from "@gadgets/workshop-shared/agent-artifact";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { ApprovalQueue, Gatekeeper, ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { createLogger } from "@gadgets/observability/logger";
import { requireNameAndNumber, requirePins, requireQualification } from "./artifact-store";
import ARTIFACT_PUBLISHER_BINDING_TYPES from "./artifact-publisher-binding.txt";

// The agent route to publishing an artifact revision (ADR 0006: agents draft, a person publishes).
// A built-in gatekeeper, like the agent spawner: a person creates it in a workspace with
// Overseer.newArtifactPublisherGatekeeper() and binds it where an agent should reach it. The agent's
// requestPublish() is queued in the workspace's approval queue; when a person approves, the
// Overseer publishes it as that person (OverseerImpl.publishApprovedArtifact).

const logger = createLogger<{action?: number}>({component: "workshop.artifact-publisher"});

/** Everything a publish needs, as the agent asks for it and as it is applied on approval. */
export type ArtifactPublishRequest = {
  gadgetId: WorkpieceId;
  kind: ArtifactKind;
  name: string;
  number: number;
  pins: ArtifactPin[];
  model: ArtifactModelRequirement | null;
  qualification: ArtifactQualification;
};

/** Props baked into the gatekeeper class when the workspace creates it. */
export type ArtifactPublisherProps = {
  /** The workspace whose revisions it publishes into. */
  overseerId: string;
};

// Queued requests live in the gatekeeper's own storage until applied or rejected, keyed by the
// action number the approval queue hands back.
const REQUEST_PREFIX = "request/";
const NEXT_ACTION_KEY = "nextAction";

/** The built-in gatekeeper behind an agent's ArtifactPublisherBinding. */
export class ArtifactPublisherGatekeeper
    extends DurableObject<Cloudflare.Env, ArtifactPublisherProps>
    implements Gatekeeper<ArtifactPublisherBindingImpl> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "http://artifact-publisher.local/",
      title: "Artifact publishing",
      snippet: "Lets an agent validate artifact revisions and ask a person to publish them.",
      suggestedBindingName: "ARTIFACTS",
      tsType: "ArtifactPublisherBinding",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return ARTIFACT_PUBLISHER_BINDING_TYPES;
  }

  /** Publishing is never auto-approvable: a person must approve each one. */
  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<ArtifactPublisherBindingImpl> {
    return new ArtifactPublisherBindingImpl(this, approvalQueue.dup());
  }

  /** The workspace this gatekeeper publishes into. */
  overseer() {
    let ns = this.ctx.exports.OverseerDurableObject;
    return ns.get(ns.idFromString(this.ctx.props.overseerId));
  }

  /** Store `request` and allocate the action number it is queued under. */
  queue(request: ArtifactPublishRequest): number {
    return this.ctx.storage.transactionSync(() => {
      let action = this.ctx.storage.kv.get<number>(NEXT_ACTION_KEY) ?? 1;
      this.ctx.storage.kv.put(NEXT_ACTION_KEY, action + 1);
      this.ctx.storage.kv.put(`${REQUEST_PREFIX}${action}`, request);
      return action;
    });
  }

  async applyAction(action: number): Promise<void> {
    let request = this.ctx.storage.kv.get<ArtifactPublishRequest>(`${REQUEST_PREFIX}${action}`);
    if (!request) throw new Error("This publish request no longer exists.");
    let result = await this.overseer().publishApprovedArtifact(action, request);
    // A refusal leaves the action pending, with the reason, for the approver to reject.
    if (!result.ok) throw new Error(`${result.refusal}: ${result.detail ?? ""}`.trim());
    this.ctx.storage.kv.delete(`${REQUEST_PREFIX}${action}`);
    logger.info("artifact revision published on approval", {event: "artifact.publish.approved", action});
  }

  async rejectAction(action: number): Promise<void> {
    this.ctx.storage.kv.delete(`${REQUEST_PREFIX}${action}`);
  }

  async revertAction(_action: number): Promise<{message: string, canRetry: boolean}> {
    return {message: "A published revision is immutable and cannot be reverted.", canRetry: false};
  }

  async addObserver(_id: string, _user: Fetcher): Promise<void> {
    // Reads nothing outside the workspace it belongs to, so any observer is permitted.
  }

  async removeObserver(_id: string): Promise<void> {
    // No observer state is tracked.
  }
}

// Deliberately not `implements` the agent-facing interface: that lives in the .d.ts text the agent
// reads, and startSession()'s return type is this class.
@validateRpc()
class ArtifactPublisherBindingImpl extends RpcTarget {
  constructor(private gatekeeper: ArtifactPublisherGatekeeper, private queue: NativeRpcStub<ApprovalQueue>) {
    super();
  }

  [Symbol.dispose]() {
    this.queue[Symbol.dispose]();
  }

  async validate(gadgetId: WorkpieceId, kind: ArtifactKind, pins: ArtifactPin[],
      model: ArtifactModelRequirement | null): Promise<{digest: string, refusals: string[]}> {
    return this.gatekeeper.overseer().validateArtifactDraft(gadgetId, kind, pins, model);
  }

  async requestPublish(request: ArtifactPublishRequest): Promise<void> {
    // Malformed requests fail now, in the agent's turn, rather than at approval.
    requireNameAndNumber(request.name, request.number);
    let pins = requirePins(request.pins);
    let qualification = requireQualification(request.qualification);
    let stored: ArtifactPublishRequest = {...request, pins, qualification};
    let ref = artifactRef(request.kind, request.name, request.number);
    let action = this.gatekeeper.queue(stored);
    await this.queue.submitAction(action, {
      title: `Publish ${ref}`,
      description: `Publish gadget ${request.gadgetId}'s committed code as the immutable revision ` +
          `${ref}, qualified by ${qualification.harness} for ${qualification.digest}. It is recorded ` +
          `as published by you. Publishing activates, schedules and binds nothing.`,
      fields: [
        {label: "Revision", kind: "inline", value: ref},
        {label: "Digest", kind: "inline", value: qualification.digest},
        {label: "Checks", kind: "list", items: qualification.checks
            .map(check => `${check.passed ? "pass" : "fail"} ${check.mode} ${check.name}`)},
      ],
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: false,
    });
  }
}
