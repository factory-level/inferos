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

// FAC-88: when a person's company changes, their user DO takes them out of the former subject's
// presence (SubjectPresenceDurableObject.leaveAll): every one of their joins ends at once, their
// subscribers receive nothing more, and everyone else sees them leave.
describe("leaving every join of one person", () => {
  it("ends all of the person's joins synchronously, and nothing more reaches them", () => {
    const roster = new SubjectRoster();
    const watcher = new Mirror();
    roster.join(person("watcher"), null, watcher);
    const firstTab = new Mirror();
    const secondTab = new Mirror();
    roster.join(person("alice"), null, firstTab);
    roster.join(person("alice"), "ENG-2", secondTab);

    roster.leaveAll("alice");
    expect(firstTab.disposed).toBe(true);
    expect(secondTab.disposed).toBe(true);
    expect(watcher.people()).toEqual([["watcher", null]]);

    // Later changes on the subject reach only those still there.
    const before = [firstTab.people(), secondTab.people()];
    roster.join(person("bob"), "ENG-3", new Mirror());
    expect([firstTab.people(), secondTab.people()]).toEqual(before);
    expect(watcher.people()).toEqual([["watcher", null], ["bob", "ENG-3"]]);
  });

  it("leaves other people, and a person with no joins, alone", () => {
    const roster = new SubjectRoster();
    const bob = new Mirror();
    roster.join(person("bob"), null, bob);
    roster.leaveAll("alice");
    expect(bob.disposed).toBe(false);
    expect(roster.participants.map(p => p.user.id)).toEqual(["bob"]);
  });
});
