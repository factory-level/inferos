import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, OperateSubjectParticipant } from "@gadgets/workshop-shared/api";
import { SubjectRoster, type RosterSubscriber } from "../src/subject-presence.js";

const person = (id: string): AiChatAuthorInfo => ({ type: "user", id, name: id.toUpperCase() });

/** A subscriber that mirrors the roster it is sent, as a client would. */
class Mirror implements RosterSubscriber {
  readonly roster = new Map<string, OperateSubjectParticipant>();
  disposed = false;
  fail = false;
  init(participants: OperateSubjectParticipant[]) {
    this.roster.clear();
    for (const participant of participants) this.roster.set(participant.key, participant);
  }
  add(participant: OperateSubjectParticipant) {
    if (this.fail) throw new Error("gone");
    this.roster.set(participant.key, participant);
  }
  remove(key: string) {
    this.roster.delete(key);
  }
  [Symbol.dispose]() {
    this.disposed = true;
  }
  people() {
    return [...this.roster.values()].map(p => [p.user.id, p.issueId]);
  }
}

describe("subject roster", () => {
  it("two people on one subject see each other, with the issue each has open", () => {
    const roster = new SubjectRoster();
    const alice = new Mirror();
    const bob = new Mirror();
    roster.join(person("alice"), null, alice);
    expect(alice.people()).toEqual([["alice", null]]);
    const leaveBob = roster.join(person("bob"), "ENG-1", bob);
    expect(bob.people()).toEqual([["alice", null], ["bob", "ENG-1"]]);
    expect(alice.people()).toEqual([["alice", null], ["bob", "ENG-1"]]);

    leaveBob();
    expect(alice.people()).toEqual([["alice", null]]);
    expect(bob.disposed).toBe(true);
    leaveBob();  // Leaving twice changes nothing.
    expect(roster.participants).toHaveLength(1);
  });

  it("collapses one person's tabs into one participant, who leaves with their last tab", () => {
    const roster = new SubjectRoster();
    const watcher = new Mirror();
    roster.join(person("watcher"), null, watcher);
    const leaveFirst = roster.join(person("alice"), null, new Mirror());
    const leaveSecond = roster.join(person("alice"), "ENG-2", new Mirror());
    expect(watcher.people()).toEqual([["watcher", null], ["alice", "ENG-2"]]);

    // Their latest tab's issue shows; closing it falls back to the remaining tab's.
    leaveSecond();
    expect(watcher.people()).toEqual([["watcher", null], ["alice", null]]);
    leaveFirst();
    expect(watcher.people()).toEqual([["watcher", null]]);
  });

  it("drops a subscriber whose delivery fails, without disturbing the others", () => {
    const roster = new SubjectRoster();
    const broken = new Mirror();
    const healthy = new Mirror();
    roster.join(person("broken"), null, broken);
    roster.join(person("healthy"), null, healthy);
    broken.fail = true;
    roster.join(person("carol"), null, new Mirror());
    return Promise.resolve().then(() => {
      expect(broken.disposed).toBe(true);
      expect(healthy.people().map(([id]) => id)).toEqual(["broken", "healthy", "carol"]);
    });
  });
});
