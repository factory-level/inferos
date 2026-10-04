// Who has one operate subject open (docs/design/operate-mode.md, "Collaboration is on records").
// Each person's session lives in their own user DO and workspace, so no existing object is shared
// by two operators on the same board. One of these per subject reference (`idFromName(boardRef)`)
// is that shared place. It holds only an in-memory roster, like a workspace's presence in the
// Overseer, and speaks the same PresenceSubscriber protocol.
//
// It does no access check of its own: it is reachable only from the kernel, and
// `OperateSession.subscribeToSubjectPresence()` admits a caller only after checking that their own
// access reaches the subject, so the roster is only ever seen by people who can read the subject.

import type { RpcStub } from "capnweb";
import { DurableObject, RpcStub as NativeRpcStub } from "cloudflare:workers";
import type {
  AiChatAuthorInfo, OperateSubjectParticipant, PresenceSubscriber,
} from "@gadgets/workshop-shared/api";

/** A subscriber as the roster uses it: the methods it calls, and how it is released. */
export type RosterSubscriber = Pick<PresenceSubscriber<OperateSubjectParticipant>, "init" | "add" | "remove"> & {
  [Symbol.dispose](): void;
};

/**
 * The roster of one subject. Several joins by one person (their tabs and devices) collapse into one
 * participant, who shows the issue of their latest join and leaves when their last join ends.
 */
export class SubjectRoster {
  #people = new Map<string, {
    key: string; user: AiChatAuthorInfo; joins: Map<object, string | null>;
  }>();
  #subscribers = new Map<object, RosterSubscriber>();
  #nextKey = 0;

  #participant(userId: string): OperateSubjectParticipant {
    let person = this.#people.get(userId)!;
    return { key: person.key, user: person.user, issueId: [...person.joins.values()].at(-1)! };
  }

  #broadcast(send: (subscriber: RosterSubscriber) => Promise<void> | void) {
    for (let [token, subscriber] of this.#subscribers) this.#deliver(token, subscriber, send);
  }

  // A subscriber whose delivery fails, now or later, is dropped.
  #deliver(token: object, subscriber: RosterSubscriber,
           send: (subscriber: RosterSubscriber) => Promise<void> | void) {
    try {
      Promise.resolve(send(subscriber)).catch(() => this.#unsubscribe(token));
    } catch {
      this.#unsubscribe(token);
    }
  }

  #unsubscribe(token: object) {
    let subscriber = this.#subscribers.get(token);
    if (!subscriber) return;
    this.#subscribers.delete(token);
    subscriber[Symbol.dispose]();
  }

  /** The current participants. */
  get participants(): OperateSubjectParticipant[] {
    return [...this.#people.keys()].map(userId => this.#participant(userId));
  }

  /**
   * Adds `user` (with the issue they have open) and `subscriber`, which receives the roster,
   * including this join, then every change. Returns a function that ends both, once.
   */
  join(user: AiChatAuthorInfo, issueId: string | null, subscriber: RosterSubscriber): () => void {
    let join = {};
    let person = this.#people.get(user.id);
    if (person) {
      person.joins.set(join, issueId);
    } else {
      person = { key: `s${++this.#nextKey}`, user, joins: new Map([[join, issueId]]) };
      this.#people.set(user.id, person);
    }
    let added = this.#participant(user.id);
    this.#broadcast(other => other.add(added));
    this.#subscribers.set(join, subscriber);
    let participants = this.participants;
    this.#deliver(join, subscriber, joined => joined.init(participants));

    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#unsubscribe(join);
      let current = this.#people.get(user.id);
      if (!current) return;
      let before = this.#participant(user.id).issueId;
      current.joins.delete(join);
      if (current.joins.size === 0) {
        this.#people.delete(user.id);
        this.#broadcast(other => other.remove(current.key));
      } else if (this.#participant(user.id).issueId !== before) {
        let updated = this.#participant(user.id);
        this.#broadcast(other => other.add(updated));
      }
    };
  }
}

/** One operate subject's live presence: see the file comment. */
export class SubjectPresenceDurableObject extends DurableObject<Cloudflare.Env> {
  #roster = new SubjectRoster();

  /**
   * Joins `user` to this subject for as long as the returned stub is held, or until `subscriber`
   * breaks. The caller must already have checked that `user` can read the subject.
   */
  join(user: AiChatAuthorInfo, issueId: string | null,
       subscriber: RpcStub<PresenceSubscriber<OperateSubjectParticipant>>): RpcStub<{}> {
    subscriber = subscriber.dup();  // keep the stub after this call returns
    let leave = this.#roster.join(user, issueId, subscriber);
    subscriber.onRpcBroken(leave);
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({ [Symbol.dispose]: leave });
  }
}
