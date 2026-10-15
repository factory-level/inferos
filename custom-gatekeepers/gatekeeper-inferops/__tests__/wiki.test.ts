// The InferMind Wiki (#87): a third resource kind, one workspace's Wiki, whose reads are
// observations and whose section edits are approved actions checked at apply against the section's
// current version (InferOps' PATCH takes no expected version), and whose page body edits are
// approved actions InferOps applies by a strict compare-and-swap on the page version. Pages read by
// InferOps' page-text contract, with Masters listing the structure. Over the mock's demo Wiki.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintOf } from "../src/actions";
import {
  parseWikiDocumentUrl, parseWikiUrl, resourceKind, wikiDocumentUrl, wikiUrl,
} from "../src/resources";
import {
  bodyWithoutTitle, composeDocumentText, documentText, embeddedReferences, masterStructureText, wikilinksOf,
} from "../src/wiki";
import type { WikiProps } from "./worker";

const WIKI_URL = "inferops://demo.local/knowledge/wiki";
const HANDBOOK = "60000000-0000-4000-8000-000000000001";
const RELEASE = "60000000-0000-4000-8000-000000000002";
const ONBOARDING = "60000000-0000-4000-8000-000000000003";
const COMPANY = "60000000-0000-4000-8000-000000000005";
const ENGINEERING = "60000000-0000-4000-8000-000000000006";
const OPERATIONS = "60000000-0000-4000-8000-000000000007";
const INCIDENT = "60000000-0000-4000-8000-000000000008";
const DISPATCH = "60000000-0000-4000-8000-000000000009";
const GENERATED = "<!-- generated: wiki structure -->";

/** A page as a structure read names it. */
const structurePage = (id: string, slug: string, title: string, parentId: string | null) => ({ id, slug, title, parentId });
/** A page's content for the text composer. */
const content = (body: string, visibleSections: string[] = [], generated: string | null = null) =>
  ({ body, visibleSections, generated });
/** A Master page named by its id. */
const master = (id: string) => ({ id, slug: id, title: id.toUpperCase(), parentId: null });
const PURPOSE = "61000000-0000-4000-8000-000000000001";
const CURRENT_WORK = "61000000-0000-4000-8000-000000000002";
const STEPS = "61000000-0000-4000-8000-000000000003";
const UNKNOWN = "61000000-0000-4000-8000-0000000000ff";
const BOARD_REF = "inferops://demo.local/project/board/DEMO";

const vars = env as unknown as { INFEROPS_ENABLED?: string };
afterEach(() => {
  delete vars.INFEROPS_ENABLED;
});

async function failure(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
    return "";
  } catch (error) {
    return String(error);
  }
}

/** A fresh demo account's Wiki binding, its mock data and a session. */
function setup(accountId: string = crypto.randomUUID()) {
  const props: WikiProps = { accountId, host: "demo.local" };
  const hooks = env.TEST_HOOKS.getByName(accountId);
  const mock = env.MOCK_INFEROPS.getByName(`demo.local/${accountId}`);
  return { props, hooks, mock, session: hooks.startWikiSession(props) };
}

describe("the Wiki resource kind", () => {
  it("parses its grammar, apart from the project kinds", () => {
    expect(parseWikiUrl("inferops://acme.knowledge/knowledge/wiki")).toEqual({
      host: "acme.knowledge", tenant: "acme", workspace: "knowledge",
    });
    expect(wikiUrl({ host: "demo.local" })).toBe(WIKI_URL);
    expect(resourceKind(WIKI_URL)).toBe("wiki");
    expect(resourceKind("inferops://demo.local/project/board/DEMO")).toBe("board");
    for (const url of [
      "inferops://acme.knowledge/knowledge/wiki/x", "inferops://acme/knowledge/wiki",
      "inferops://acme.knowledge:1/knowledge/wiki", "inferops://ACME.knowledge/knowledge/wiki",
      "inferops://acme.knowledge/knowledge/document/handbook",
    ]) {
      expect(() => parseWikiUrl(url), url).toThrow(/knowledge\/wiki/);
    }
  });

  it("parses a page reference, which identifies a page and is never a binding", () => {
    const ref = "inferops://acme.knowledge/knowledge/document/release-process";
    expect(parseWikiDocumentUrl(ref)).toEqual({
      host: "acme.knowledge", tenant: "acme", workspace: "knowledge", slug: "release-process",
    });
    expect(wikiDocumentUrl({ host: "acme.knowledge", slug: "release-process" })).toBe(ref);
    expect(resourceKind(ref)).toBeNull();
    // A slug with `/` is one encoded segment, decoded once.
    const shared = "inferops://acme.knowledge/knowledge/document/dispatch%2Fdispatch-a-crew";
    expect(wikiDocumentUrl({ host: "acme.knowledge", slug: "dispatch/dispatch-a-crew" })).toBe(shared);
    expect(parseWikiDocumentUrl(shared)?.slug).toBe("dispatch/dispatch-a-crew");
    expect(parseWikiDocumentUrl(shared.replace("%2F", "%2f"))?.slug).toBe("dispatch/dispatch-a-crew");
    for (const bad of [
      "inferops://acme.knowledge/knowledge/document/", "inferops://acme.knowledge/knowledge/document/a/b",
      "inferops://acme.knowledge/knowledge/document/a?b=1", "inferops://acme/knowledge/document/a",
      "inferops://acme.knowledge/knowledge/document/%2e%2e", "https://acme.knowledge/knowledge/document/a",
      // Encoded dot segments, double encoding, other escapes, empty segments and a fragment.
      "inferops://acme.knowledge/knowledge/document/a%2F..", "inferops://acme.knowledge/knowledge/document/a%2F.",
      "inferops://acme.knowledge/knowledge/document/a%252Fb", "inferops://acme.knowledge/knowledge/document/a%20b",
      "inferops://acme.knowledge/knowledge/document/a%2F%2Fb", "inferops://acme.knowledge/knowledge/document/%2Fa",
      "inferops://acme.knowledge/knowledge/document/a%2Fb#c",
    ]) {
      expect(parseWikiDocumentUrl(bad), bad).toBeNull();
    }
  });

  it("binds the demo Wiki to the Wiki gatekeeper", async () => {
    const { hooks } = setup();
    expect(await hooks.bindAccount("wiki", { accountId: crypto.randomUUID() }, WIKI_URL)).toBeNull();
    expect(await hooks.describeBound("wiki")).toMatchObject({
      url: WIKI_URL, tsType: "InferOpsWikiSession", suggestedBindingName: "INFEROPS_WIKI",
    });
    const pages = await hooks.startBoundWikiSession("wiki").listDocuments();
    expect(pages.map(p => p.slug)).toEqual([
      "engineering", "incident-response", "onboarding", "handbook", "dispatch/dispatch-a-crew", "drafts",
      "operations", "release-process", "company",
    ]);
  });

  it("refuses another workspace or tenant like a missing Wiki", async () => {
    const { hooks } = setup();
    const account = { accountId: crypto.randomUUID() };
    // A demo account holds no workspace: any other host is refused the same way.
    expect(await hooks.bindAccount("x", account, "inferops://acme.knowledge/knowledge/wiki"))
      .toBe("No InferMind Wiki is available on acme.knowledge.");
    expect(await hooks.bindAccount("y", account, "inferops://globex.local/knowledge/wiki"))
      .toBe("No InferMind Wiki is available on globex.local.");
    expect(await hooks.bindAccount("z", account, "inferops://demo.local/knowledge/wiki/extra"))
      .toContain("Not an InferOps project board URL");
  });

  it("refuses a workspace without InferMind with FORBIDDEN, at binding and on every call", async () => {
    const { props, hooks, mock, session } = setup();
    await session.listDocuments();
    await session.updateSection(PURPOSE, "Edited before InferMind went away.", 1);

    await mock.setInferMindEnabled(false);
    const account = { accountId: props.accountId };
    expect(await hooks.bindAccount("off", account, WIKI_URL)).toContain("FORBIDDEN");
    expect(await failure(session.listDocuments())).toContain("FORBIDDEN");
    expect(await failure(session.readDocument("handbook"))).toContain("FORBIDDEN");
    expect(await hooks.applyWiki(props, 1)).toContain("was not applied: InferOps refused the Wiki");

    await mock.setInferMindEnabled(true);
    expect(await hooks.applyWiki(props, 1)).toBeNull();
  });
});

describe("reading", () => {
  it("lists pages with their place in the tree, as an observation", async () => {
    const { hooks, session } = setup();
    const pages = await session.listDocuments();
    expect(pages.find(p => p.slug === "onboarding")).toEqual({
      id: "60000000-0000-4000-8000-000000000003", slug: "onboarding", title: "Onboarding",
      parentId: HANDBOOK, siblingOrder: 0,
    });
    expect((await hooks.log()).observations).toEqual(["List InferMind Wiki pages"]);
  });

  it("reads a page by slug or id, with sections, versions, wikilinks and standalone references", async () => {
    const { hooks, session } = setup();
    const bySlug = await session.readDocument("handbook");
    expect(await session.readDocument(HANDBOOK)).toEqual(bySlug);
    expect(bySlug).toMatchObject({
      id: HANDBOOK, slug: "handbook", title: "Team handbook", body: "", version: 1, masterRole: null,
    });
    expect(bySlug.pendingBody).toBeUndefined();
    expect(bySlug.sections.map(s => [s.tag, s.version])).toEqual([["purpose", 1], ["current-work", 3]]);
    expect(bySlug.sections[0]!.wikilinks).toEqual([
      { target: "onboarding", tag: "first-week" }, { target: "release-process", tag: "steps" },
    ]);
    expect(bySlug.references).toEqual([BOARD_REF]);
    // A link inside prose is not an embed.
    expect((await session.readDocument("release-process")).references).toEqual([]);
    expect((await hooks.log()).observations).toEqual([
      "Read Wiki page handbook", "Read Wiki page handbook", "Read Wiki page release-process",
    ]);
  });

  it("projects a page as InferOps' agent text, leaving references as written", async () => {
    const { session } = setup();
    const page = await session.readDocument("handbook");
    const text = await session.readDocumentText("handbook");
    expect(text).toBe(`# Team handbook\n\n${page.sections[0]!.body}\n\n${page.sections[1]!.body}`);
    expect(text).toContain(`[DEMO board](${BOARD_REF})`);
  });

  it("answers unknown, malformed and section-less pages without saying more", async () => {
    const { hooks, session } = setup();
    expect(await failure(session.readDocument("no-such-page"))).toContain("NOT_FOUND: No such page in this Wiki.");
    expect(await failure(session.readDocument("60000000-0000-4000-8000-0000000000ff")))
      .toContain("NOT_FOUND: No such page in this Wiki.");
    expect(await failure(session.readDocument("../handbook"))).toContain("INVALID_REQUEST");
    expect((await session.readDocument("drafts")).sections).toEqual([]);
    expect(await failure(session.readDocumentText("drafts"))).toContain("NOT_FOUND");
    expect((await hooks.log()).observations).toEqual(["Read Wiki page drafts"]);
  });
});

describe("the structure and page text", () => {
  it("reads the root, the pillars with their Masters and filed pages, and the unfiled pages, as an observation", async () => {
    const { hooks, session } = setup();
    const dispatch = structurePage(DISPATCH, "dispatch/dispatch-a-crew", "Dispatch a crew", OPERATIONS);
    const release = structurePage(RELEASE, "release-process", "Release process", HANDBOOK);
    expect(await session.readStructure()).toEqual({
      root: structurePage(COMPANY, "company", "Demo Company", null),
      pillars: [{
        key: "engineering", title: "Engineering", position: 0,
        master: structurePage(ENGINEERING, "engineering", "Engineering", COMPANY),
        members: [{ ...dispatch, source: "human" }, { ...release, source: "intake" }],
      }, {
        key: "operations", title: "Operations", position: 1,
        master: structurePage(OPERATIONS, "operations", "Operations", COMPANY),
        members: [
          { ...dispatch, source: "intake" }, { ...structurePage(INCIDENT, "incident-response", "Incident response", OPERATIONS), source: "intake" },
          { ...release, source: "human" },
        ],
      }],
      unfiled: [
        structurePage(HANDBOOK, "handbook", "Team handbook", null), structurePage(ONBOARDING, "onboarding", "Onboarding", HANDBOOK),
        structurePage("60000000-0000-4000-8000-000000000004", "drafts", "Drafts", null),
      ],
    });
    expect((await hooks.log()).observations).toEqual(["Read InferMind Wiki structure"]);
  });

  it("reads a page's body, version and Master role, and takes references from the body", async () => {
    const { session } = setup();
    expect(await session.readDocument("incident-response")).toMatchObject({
      id: INCIDENT, version: 4, masterRole: null, sections: [], references: [BOARD_REF],
    });
    expect((await session.readDocument("incident-response")).body).toMatch(/^# Incident response\n\n1\. Page/);
    expect(await session.readDocument("company")).toMatchObject({ masterRole: "root", body: "", sections: [] });
    expect((await session.readDocument(ENGINEERING)).masterRole).toBe("pillar");
    // A slug of several segments is looked up as listed.
    expect((await session.readDocument("dispatch/dispatch-a-crew")).id).toBe(DISPATCH);
  });

  it("reads a body-only page as its title and body, dropping only a leading heading equal to the title", async () => {
    const { session } = setup();
    expect(await session.readDocumentText("incident-response")).toBe(
      "# Incident response\n\n1. Page the on-call engineer.\n2. Open an incident issue on the board.\n" +
      `3. Write the timeline while it is fresh.\n\n[DEMO board](${BOARD_REF})`);
    expect(await session.readDocumentText(DISPATCH)).toBe(
      "# Dispatch a crew\n\n# Before you start\n\nCheck the crew roster on the board.\n\n## Steps\n\n" +
      "1. Pick the nearest free crew.\n2. Move the job card to Dispatched.");
  });

  it("reads a page with a body as its body only, never merging its sections", async () => {
    const { session } = setup();
    const page = await session.readDocument("onboarding");
    expect(page.sections.map(s => s.tag)).toEqual(["first-week"]);
    expect(await session.readDocumentText("onboarding")).toBe(`# Onboarding\n\n${page.body}`);
    expect(await session.readDocumentText("onboarding")).not.toContain("pair with a teammate");
  });

  it("adds a Master's generated structure block, encoding each slug as one route segment", async () => {
    const { hooks, session } = setup();
    expect(await session.readDocumentText("engineering")).toBe([
      "# Engineering", "", GENERATED, "## Pages in Engineering",
      "- [Dispatch a crew](/wiki/dispatch%2Fdispatch-a-crew)", "- [Release process](/wiki/release-process)",
    ].join("\n"));
    expect(await session.readDocumentText("operations")).toBe([
      "# Operations", "", "How the demo team runs day to day.", "", GENERATED, "## Pages in Operations",
      "- [Dispatch a crew](/wiki/dispatch%2Fdispatch-a-crew)", "- [Incident response](/wiki/incident-response)",
      "- [Release process](/wiki/release-process)",
    ].join("\n"));
    expect(await session.readDocumentText("company")).toBe([
      "# Demo Company", "", GENERATED, "## Pillars", "- [Engineering](/wiki/engineering)", "- [Operations](/wiki/operations)",
    ].join("\n"));
    expect((await hooks.log()).observations).toEqual([
      "Read Wiki page engineering as text", "Read Wiki page operations as text", "Read Wiki page company as text",
    ]);
  });
});

describe("page body edits", () => {
  it("queue an approval, show at once as pendingBody, and write only on approval", async () => {
    const { props, hooks, mock, session } = setup();
    const before = (await mock.readDocument(INCIDENT)).body;
    await session.updateDocumentBody("incident-response", "# Incident response\n\nCall the on-call first.", 4);

    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({
      title: "Edit Wiki page Incident response", kind: "inferops.wiki-page-update", implementsRevert: true,
    });
    expect(action!.fields).toMatchObject({
      Page: "Incident response", "Expected version": "4", "Current text": before,
      "New text": "# Incident response\n\nCall the on-call first.",
    });
    expect((await mock.readDocument(INCIDENT)).body).toBe(before);

    const shown = await session.readDocument("incident-response");
    expect(shown).toMatchObject({ body: "# Incident response\n\nCall the on-call first.", version: 4, pendingBody: true,
                                  references: [] });
    expect(await session.readDocumentText("incident-response")).toBe("# Incident response\n\nCall the on-call first.");

    expect(await hooks.applyWiki(props, action!.id)).toBeNull();
    expect(await mock.readDocument(INCIDENT)).toMatchObject({ body: "# Incident response\n\nCall the on-call first.", version: 5 });
    expect(await hooks.getWikiRaw(props, `action:${action!.id}`)).toMatchObject({ status: "applied", appliedVersion: 5 });
    expect(await hooks.applyWiki(props, action!.id)).toBeNull();
    expect((await mock.readDocument(INCIDENT)).version).toBe(5);
    expect((await session.readDocument("incident-response")).pendingBody).toBeUndefined();
  });

  it("gives a body to a Master that had none; its sections and generated block are untouched", async () => {
    const { props, hooks, session } = setup();
    await session.updateDocumentBody("engineering", "How we build things.", 1);
    expect(await hooks.applyWiki(props, 1)).toBeNull();
    expect(await session.readDocumentText("engineering"))
      .toContain(`# Engineering\n\nHow we build things.\n\n${GENERATED}\n## Pages in Engineering\n`);
  });

  it("refuses a stale version, an unknown page and bad arguments at proposal, queueing nothing", async () => {
    const { hooks, session } = setup();
    expect(await failure(session.updateDocumentBody("incident-response", "x", 3)))
      .toContain("STALE_REVISION: Page incident-response is at version 4, not 3.");
    expect(await failure(session.updateDocumentBody("no-such-page", "x", 1))).toContain("NOT_FOUND");
    expect(await failure(session.updateDocumentBody("60000000-0000-4000-8000-0000000000ff", "x", 1))).toContain("NOT_FOUND");
    expect(await failure(session.updateDocumentBody("../handbook", "x", 1))).toContain("INVALID_REQUEST");
    expect(await failure(session.updateDocumentBody("handbook", "x", 0))).toContain("INVALID_REQUEST");
    expect(await failure(session.updateDocumentBody("handbook", "x", 1.5))).toContain("INVALID_REQUEST");
    expect(await failure(session.updateDocumentBody("handbook", "x".repeat(200_001), 1))).toContain("INVALID_REQUEST");
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("does nothing for an unchanged body, and refuses a second edit while one is pending", async () => {
    const { hooks, mock, session } = setup();
    await session.updateDocumentBody(INCIDENT, (await mock.readDocument(INCIDENT)).body, 4);
    expect((await hooks.log()).actions).toEqual([]);

    await session.updateDocumentBody(INCIDENT, "First edit.", 4);
    await session.updateDocumentBody(INCIDENT, "First edit.", 4);
    expect(await failure(session.updateDocumentBody(INCIDENT, "Second edit.", 4))).toContain("CONFLICT");
    expect((await hooks.log()).actions).toHaveLength(1);
    // A section edit of the same page is a separate change.
    await session.updateSection("61000000-0000-4000-8000-000000000004", "Edited section.", 1);
    expect(await failure(session.updateDocumentBody("onboarding", "x", 3))).toBe("");
  });

  it("stages one edit when proposals race: the same body joins, a different one is CONFLICT", async () => {
    const { hooks, session } = setup();
    const same = await Promise.allSettled([
      session.updateDocumentBody(INCIDENT, "Raced edit.", 4),
      session.updateDocumentBody(INCIDENT, "Raced edit.", 4),
    ]);
    expect(same.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await hooks.log()).actions).toHaveLength(1);

    const second = setup();
    const different = await Promise.allSettled([
      second.session.updateDocumentBody(INCIDENT, "Edit A.", 4),
      second.session.updateDocumentBody(INCIDENT, "Edit B.", 4),
    ]);
    expect(different.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const refused = different.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toContain("CONFLICT");
    const actions = (await second.hooks.log()).actions;
    expect(actions).toHaveLength(1);
    // The overlay shows exactly the one staged edit.
    const shown = await second.session.readDocument(INCIDENT);
    expect(shown.pendingBody).toBe(true);
    expect(["Edit A.", "Edit B."]).toContain(shown.body);
  });

  it("leaves an edit refused as stale unknown and reconcile-only, and leaves the content", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateDocumentBody(INCIDENT, "My edit.", 4);
    await mock.updateDocument(INCIDENT, { body: "Someone else's edit." }, 4, "elsewhere");

    expect(await session.readDocument(INCIDENT)).toMatchObject({ body: "Someone else's edit.", version: 5 });
    expect((await session.readDocument(INCIDENT)).pendingBody).toBeUndefined();
    expect(await hooks.applyOutcome(props, 1, "wiki"))
      .toMatchObject({ outcome: "unknown", retryable: false, code: "STALE_REVISION" });
    expect(await mock.readDocument(INCIDENT)).toMatchObject({ body: "Someone else's edit.", version: 5 });
    expect(await hooks.getWikiRaw(props, "action:1")).toMatchObject({ status: "pending" });
  });

  it("fails as stale, never in effect, when another writer already wrote the same body", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateDocumentBody(INCIDENT, "Same text.", 4);
    await mock.updateDocument(INCIDENT, { body: "Same text." }, 4, "another-writer");

    expect(await hooks.applyWiki(props, 1)).toContain("InferOps refused it (STALE_REVISION)");
    expect(await hooks.getWikiRaw(props, "action:1")).toMatchObject({ status: "pending" });
    expect((await mock.readDocument(INCIDENT)).version).toBe(5);
  });

  it("is not sent again once an attempt may have reached InferOps, even if it committed", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateDocumentBody(INCIDENT, "Written once.", 4);
    expect(await hooks.applyWiki(props, 1)).toBeNull();
    // The write committed but its response was lost, so the action is still pending here.
    const applied = await hooks.getWikiRaw(props, "action:1") as Record<string, unknown>;
    const { appliedVersion: _, ...pending } = applied;
    await hooks.putWikiRaw(props, "action:1", { ...pending, status: "pending" });

    // No same-key replay contract is verified for page bodies yet, so it is reconcile-only.
    expect(await hooks.applyWiki(props, 1)).toContain("an earlier attempt was interrupted before InferOps answered");
    expect(await mock.readDocument(INCIDENT)).toMatchObject({ body: "Written once.", version: 5 });
    expect(await hooks.getWikiRaw(props, "action:1")).toMatchObject({ status: "pending" });

    // InferOps' own replay is bound to the whole write: the same key with another body or version is stale.
    const key = `${await hooks.getWikiRaw(props, "instanceId") as string}:1`;
    expect(await failure(mock.updateDocument(INCIDENT, { body: "Another body." }, 4, key))).toContain("STALE_REVISION");
    expect(await failure(mock.updateDocument(INCIDENT, { body: "Written once." }, 3, key))).toContain("STALE_REVISION");
    expect(await mock.updateDocument(INCIDENT, { body: "Written once." }, 4, key)).toEqual({ id: INCIDENT, version: 5 });
  });

  it("never sends a request that differs from the approved one", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateDocumentBody(INCIDENT, "Approved text.", 4);
    const stored = await hooks.getWikiRaw(props, "action:1") as Record<string, unknown>;
    await hooks.putWikiRaw(props, "action:1", { ...stored, body: "Swapped text." });
    expect(await hooks.applyWiki(props, 1)).toContain("the stored request no longer matches");
    await hooks.putWikiRaw(props, "action:1", { ...stored, expectedVersion: 5 });
    expect(await hooks.applyWiki(props, 1)).toContain("the stored request no longer matches");
    expect((await mock.readDocument(INCIDENT)).version).toBe(4);
  });

  it("is forgotten when rejected", async () => {
    const { props, hooks, session } = setup();
    await session.updateDocumentBody(INCIDENT, "Rejected text.", 4);
    await hooks.rejectWiki(props, 1);
    expect((await session.readDocument(INCIDENT)).pendingBody).toBeUndefined();
    await session.updateDocumentBody(INCIDENT, "Another text.", 4);
  });

  it("reverts only while the page is still at the version the edit produced", async () => {
    const { props, hooks, mock, session } = setup();
    const before = (await mock.readDocument(INCIDENT)).body;
    await session.updateDocumentBody(INCIDENT, "Edit to revert.", 4);
    expect(await hooks.applyWiki(props, 1)).toBeNull();
    expect(await hooks.revertWiki(props, 1)).toBeNull();
    expect(await mock.readDocument(INCIDENT)).toMatchObject({ body: before, version: 6 });
    expect(await hooks.getWikiRaw(props, "action:1")).toMatchObject({ status: "reverted" });

    await session.updateDocumentBody(INCIDENT, "Edit changed later.", 6);
    expect(await hooks.applyWiki(props, 2)).toBeNull();
    // Even a write that leaves the same text moves the page on, so the revert refuses.
    await mock.updateDocument(INCIDENT, { body: "Edit changed later." }, 7, "elsewhere");
    expect(await hooks.revertWiki(props, 2)).toContain("has changed again since this edit");
    expect(await mock.readDocument(INCIDENT)).toMatchObject({ body: "Edit changed later.", version: 8 });
  });

  it("is refused at proposal and at apply when the person lacks the Wiki", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateDocumentBody(INCIDENT, "Queued while allowed.", 4);
    await mock.setInferMindEnabled(false);
    expect(await failure(session.updateDocumentBody(HANDBOOK, "x", 1))).toContain("FORBIDDEN");
    expect(await failure(session.readStructure())).toContain("FORBIDDEN");
    // InferOps refused the write itself, which is not yet proof for a page body: reconcile-only.
    expect(await hooks.applyWiki(props, 1)).toContain("InferOps refused it (FORBIDDEN)");
    await mock.setInferMindEnabled(true);
    expect((await mock.readDocument(INCIDENT)).version).toBe(4);
    expect(await hooks.applyWiki(props, 1)).toContain("InferOps refused it (FORBIDDEN)");
    expect((await mock.readDocument(INCIDENT)).version).toBe(4);
  });
});

describe("section edits", () => {
  it("queue an approval, show at once, and write only on approval", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateSection(PURPOSE, "The handbook, rewritten. See [[onboarding#first-week]].", 1);

    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({
      title: "Edit Wiki section purpose of Team handbook", kind: "inferops.wiki-section-update",
      implementsRevert: true,
    });
    expect(action!.fields).toMatchObject({ Page: "Team handbook", Section: "purpose", "Expected version": "1" });
    expect((await mock.readSection(PURPOSE)).body).toContain("explains how the demo team works");

    const shown = (await session.readDocument("handbook")).sections[0]!;
    expect(shown).toMatchObject({ version: 1, pending: "update", wikilinks: [{ target: "onboarding", tag: "first-week" }] });
    expect(await session.readDocumentText("handbook")).toContain("The handbook, rewritten.");

    expect(await hooks.applyWiki(props, action!.id)).toBeNull();
    expect(await mock.readSection(PURPOSE)).toMatchObject({
      body: "The handbook, rewritten. See [[onboarding#first-week]].", version: 2,
    });
    expect((await hooks.getWikiRaw(props, `action:${action!.id}`)) as object)
      .toMatchObject({ status: "applied", appliedVersion: 2 });
    // A repeated apply writes nothing.
    expect(await hooks.applyWiki(props, action!.id)).toBeNull();
    expect((await mock.readSection(PURPOSE)).version).toBe(2);
    expect((await session.readDocument("handbook")).sections[0]!.pending).toBeUndefined();
  });

  it("refuses a stale version, an unknown section and a bad argument at proposal, queueing nothing", async () => {
    const { hooks, session } = setup();
    expect(await failure(session.updateSection(CURRENT_WORK, "x", 2)))
      .toContain("STALE_REVISION: Section current-work is at version 3, not 2.");
    expect(await failure(session.updateSection(UNKNOWN, "x", 1))).toContain("NOT_FOUND");
    expect(await failure(session.updateSection("not-an-id", "x", 1))).toContain("NOT_FOUND");
    expect(await failure(session.updateSection(PURPOSE, "x", -1))).toContain("INVALID_REQUEST");
    expect(await failure(session.updateSection(PURPOSE, "x".repeat(100_001), 1))).toContain("INVALID_REQUEST");
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("does nothing for an unchanged body, and refuses a second edit while one is pending", async () => {
    const { hooks, mock, session } = setup();
    const current = (await mock.readSection(STEPS)).body;
    await session.updateSection(STEPS, current, 2);
    expect((await hooks.log()).actions).toEqual([]);

    await session.updateSection(STEPS, "First edit.", 2);
    await session.updateSection(STEPS, "First edit.", 2);
    expect(await failure(session.updateSection(STEPS, "Second edit.", 2))).toContain("CONFLICT");
    expect((await hooks.log()).actions).toHaveLength(1);
  });

  it("stages one edit when section proposals race with different bodies", async () => {
    const { hooks, session } = setup();
    const results = await Promise.allSettled([
      session.updateSection(STEPS, "Edit A.", 2),
      session.updateSection(STEPS, "Edit B.", 2),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await hooks.log()).actions).toHaveLength(1);
  });

  it("is refused at apply when the section changed in InferOps since, and writes nothing", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateSection(PURPOSE, "My edit.", 1);
    await mock.updateSection(PURPOSE, "Someone else's edit.", "elsewhere");

    // The stale edit is no longer shown, and does not block a new one.
    expect((await session.readDocument("handbook")).sections[0]).toMatchObject({
      body: "Someone else's edit.", version: 2,
    });
    expect((await session.readDocument("handbook")).sections[0]!.pending).toBeUndefined();
    expect(await hooks.applyWiki(props, 1))
      .toContain("the section changed in InferOps after this edit was proposed (expected version 1)");
    expect(await mock.readSection(PURPOSE)).toMatchObject({ body: "Someone else's edit.", version: 2 });
  });

  it("counts an edit already in effect as applied without writing again (a lost response)", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateSection(PURPOSE, "Written once.", 1);
    // The first apply's PATCH committed, but its response never arrived.
    await mock.updateSection(PURPOSE, "Written once.", "lost");

    expect(await hooks.applyWiki(props, 1)).toBeNull();
    expect(await mock.readSection(PURPOSE)).toMatchObject({ body: "Written once.", version: 2 });
  });

  it("never sends a request that differs from the approved one", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateSection(PURPOSE, "Approved text.", 1);
    const stored = await hooks.getWikiRaw(props, "action:1") as Record<string, unknown>;

    await hooks.putWikiRaw(props, "action:1", { ...stored, body: "Swapped text." });
    expect(await hooks.applyWiki(props, 1)).toContain("the stored request no longer matches");
    // A record with its fingerprint removed is refused too.
    const { fingerprint: _, ...unsigned } = stored;
    await hooks.putWikiRaw(props, "action:1", { ...unsigned, body: "Swapped text." });
    expect(await hooks.applyWiki(props, 1)).toContain("the stored request no longer matches");
    expect((await mock.readSection(PURPOSE)).version).toBe(1);
  });

  it("is forgotten when rejected", async () => {
    const { props, hooks, session } = setup();
    await session.updateSection(PURPOSE, "Rejected text.", 1);
    await hooks.rejectWiki(props, 1);
    expect((await session.readDocument("handbook")).sections[0]!.pending).toBeUndefined();
    await session.updateSection(PURPOSE, "Another text.", 1);
  });

  it("reverts to the previous text only while the section is as the edit left it", async () => {
    const { props, hooks, mock, session } = setup();
    const before = (await mock.readSection(PURPOSE)).body;
    await session.updateSection(PURPOSE, "Edit to revert.", 1);
    expect(await hooks.applyWiki(props, 1)).toBeNull();
    expect(await hooks.revertWiki(props, 1)).toBeNull();
    expect(await mock.readSection(PURPOSE)).toMatchObject({ body: before, version: 3 });

    await session.updateSection(PURPOSE, "Edit changed later.", 3);
    expect(await hooks.applyWiki(props, 2)).toBeNull();
    await mock.updateSection(PURPOSE, "Later edit.", "elsewhere");
    expect(await hooks.revertWiki(props, 2)).toContain("has changed again since this edit");
    expect((await mock.readSection(PURPOSE)).body).toBe("Later edit.");
  });
});

describe("the integration switch and observers", () => {
  it("refuses every Wiki call and apply while InferOps is off, and restores them when on", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateSection(PURPOSE, "Queued before the switch.", 1);

    vars.INFEROPS_ENABLED = "false";
    expect(await failure(session.listDocuments())).toContain("DISABLED");
    expect(await failure(session.readDocumentText("handbook"))).toContain("DISABLED");
    expect(await hooks.applyWiki(props, 1)).toContain("InferOps is turned off for this deployment");
    expect(await hooks.bindAccount("off", { accountId: crypto.randomUUID() }, WIKI_URL))
      .toContain("InferOps is turned off");
    expect((await mock.readSection(PURPOSE)).version).toBe(1);

    delete vars.INFEROPS_ENABLED;
    expect(await hooks.applyWiki(props, 1)).toBeNull();
    expect((await mock.readSection(PURPOSE)).body).toBe("Queued before the switch.");
  });

  it("admits an observer only when their own account reads the Wiki", async () => {
    const { props, hooks } = setup();
    expect(await hooks.addWikiObserver(props, true)).toBeNull();
    expect(await hooks.addWikiObserver(props, false)).toContain("cannot read the InferMind Wiki of demo.local");
  });

  it("reads page text as InferOps composes it, and keeps an admitted collaborator out of that read", async () => {
    const { props, hooks, mock, session } = setup();
    expect(await hooks.addWikiObserver(props, true)).toBeNull();
    // InferOps' own `document.text` for the page is what the caller gets.
    expect(await session.readDocumentText("company")).toBe(await mock.readDocumentText(COMPANY));
    let log = await hooks.log();
    expect(log.observations.at(-1)).toBe("Read Wiki page company as text");
    expect(log.observationTexts.at(-1)).toContain("as InferOps composes it for this connection");
    // Its coverage and live widget text are not covered by the Wiki admission.
    expect(log.excluded.at(-1)).toEqual(["observer-1"]);
    // The page itself is Wiki data the admission covers.
    await session.readDocument("company");
    log = await hooks.log();
    expect(log.excluded.at(-1)).toEqual([]);
  });

  it("reads a page with an edit of its own waiting back with that edit, composed here", async () => {
    const { props, hooks, session } = setup();
    expect(await hooks.addWikiObserver(props, true)).toBeNull();
    await session.updateDocumentBody("incident-response", "# Incident response\n\nCall the on-call first.", 4);
    expect(await session.readDocumentText("incident-response")).toBe("# Incident response\n\nCall the on-call first.");
    const log = await hooks.log();
    expect(log.observationTexts.at(-1)).toContain("with its pending edits");
    expect(log.excluded.at(-1)).toEqual([]);
    // Another page, with nothing of its own waiting, still reads InferOps' text.
    await session.readDocumentText("handbook");
    expect((await hooks.log()).excluded.at(-1)).toEqual(["observer-1"]);
  });
});

// MVP-40: drafted page proposals, read as observations and approved for publication as an approved
// action, over the mock's InferOps rules (mock-inferops.ts). Approving queues InferOps' publication;
// the mock's `runPublishJobs` stands in for that job.
describe("Wiki proposal approval", () => {
  const P_EDIT = "62000000-0000-4000-8000-000000000001";
  const P_NEW = "62000000-0000-4000-8000-000000000002";
  const P_NOPARENT = "62000000-0000-4000-8000-000000000003";
  const P_SELF = "62000000-0000-4000-8000-000000000004";
  const P_STALE = "62000000-0000-4000-8000-000000000005";
  const P_UNKNOWN = "62000000-0000-4000-8000-0000000000ff";
  const FIRST_WEEK = "61000000-0000-4000-8000-000000000004";
  const NO_PROPOSAL = "NOT_FOUND: No such proposal in this Wiki, or Wiki publishing is off in InferOps.";
  const SHARED = "A shared gadget cannot approve Wiki proposals: the approval would be sent with the " +
    "gadget owner's InferOps sign-in. Approve from an unshared gadget.";
  /** P-edit's sources as staged and sent: sorted by section id. */
  const EDIT_SOURCES = [{ sectionId: PURPOSE, version: 1 }, { sectionId: STEPS, version: 2 }];

  type Mock = ReturnType<typeof setup>["mock"];
  const hashOf = async (mock: Mock, id: string) => (await mock.readProposal(id)).proposal.proposalHash;
  const instanceKey = async (hooks: ReturnType<typeof setup>["hooks"], props: WikiProps, id: number) =>
    `${await hooks.getWikiRaw(props, "instanceId") as string}:${id}`;

  /** A fresh binding with P-edit's approval staged; returns its action id and hash. */
  async function staged(proposalId = P_EDIT) {
    const context = setup();
    const hash = await hashOf(context.mock, proposalId);
    await context.session.approveProposal(proposalId, hash);
    const action = (await context.hooks.log()).actions.at(-1)!;
    return { ...context, hash, id: action.id, action };
  }

  it("A1: lists and reads proposals as observations, with state, hash, target, sources and freshness", async () => {
    const { hooks, session } = setup();
    const all = await session.listProposals();
    expect(all.map(p => p.id)).toEqual([P_STALE, P_SELF, P_NOPARENT, P_NEW, P_EDIT]);
    expect(await session.listProposals("in_review")).toHaveLength(5);
    expect(await session.listProposals("published")).toEqual([]);
    // Refused at the RPC boundary, before anything reaches InferOps.
    expect(await failure(session.listProposals("nope" as never))).toContain("listProposals[0]: expected union");
    const { proposal, freshness } = await session.readProposal(P_EDIT);
    expect(proposal).toMatchObject({
      id: P_EDIT, revision: 1, state: "in_review", targetDocumentId: RELEASE, expectedVersion: 2,
      targetSlug: "release-process", parentId: null, title: "Release process", approvedHash: null,
      publishedDocumentId: null, sources: [{ sectionId: STEPS, version: 2 }, { sectionId: PURPOSE, version: 1 }],
    });
    expect(proposal.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal.pending).toBeUndefined();
    // No principal of InferOps' reaches the caller.
    expect(Object.keys(proposal)).not.toContain("requestedBy");
    expect(freshness).toEqual({
      targetVersion: 2, stale: false, sources: [
        { sectionId: STEPS, proposedVersion: 2, currentVersion: 2 }, { sectionId: PURPOSE, proposedVersion: 1, currentVersion: 1 },
      ],
    });
    expect((await session.readProposal(P_STALE)).freshness).toMatchObject({
      stale: true, sources: [{ sectionId: FIRST_WEEK, proposedVersion: 0, currentVersion: 1 }],
    });
    expect(await failure(session.readProposal(P_UNKNOWN))).toContain(NO_PROPOSAL);
    expect(await failure(session.readProposal("../x"))).toContain(NO_PROPOSAL);
    const log = await hooks.log();
    expect(log.observations).toEqual([
      "List InferMind Wiki proposals", "List InferMind Wiki proposals", "List InferMind Wiki proposals",
      "Read Wiki proposal release-process", "Read Wiki proposal onboarding",
    ]);
    expect(log.observationTexts[0]).toBe("Listed the 5 page proposals of the InferMind Wiki of demo.local, with their content.");
    expect(log.observationTexts[3]).toContain("in_review, its target and cited sections unchanged, 2 cited sections");
    expect(log.observationTexts[4]).toContain("its target or a cited section has changed");
  });

  it("A1: shows a proposal with an approval waiting here as pending approve", async () => {
    const { session } = await staged();
    expect((await session.readProposal(P_EDIT)).proposal).toMatchObject({ state: "in_review", pending: "approve" });
    const listed = await session.listProposals();
    expect(listed.find(p => p.id === P_EDIT)!.pending).toBe("approve");
    expect(listed.find(p => p.id === P_NEW)!.pending).toBeUndefined();
  });

  it("A2: stages one approval with the exact card, sends nothing until approved, then reads approved and later published", async () => {
    const { props, hooks, mock, session } = setup();
    const page = (await mock.listDocuments()).find(d => d.id === RELEASE);
    const head = await mock.readDocument(RELEASE);
    const structure = await mock.readStructure();
    const hash = await hashOf(mock, P_EDIT);
    await session.approveProposal(P_EDIT, hash);

    const [action] = (await hooks.log()).actions;
    expect(action).toMatchObject({
      title: "Approve Wiki proposal: Release process", kind: "inferops.wiki-proposal-approve",
      implementsRevert: false, complete: true, truncated: [],
    });
    expect(action!.description).toContain("Approving queues its publication and publishes nothing itself.");
    expect(action!.description).toContain("otherwise the proposal ends stale or blocked");
    expect(action!.fields).toEqual({
      Page: "Release process", Revision: "1", "Proposal hash": hash,
      Summary: "Writes the release steps out as the page's own body.", Sources: "2 cited sections",
      Content: "# Release process\n\n1. Cut the release branch.\n2. Run the checks on it.\n3. Tag the build and announce it.",
    });
    // The identifying fields come before the content.
    expect(Object.keys(action!.fields)).toEqual(["Page", "Revision", "Proposal hash", "Summary", "Sources", "Content"]);
    expect(await mock.approveRequests()).toEqual([]);
    expect((await mock.readProposal(P_EDIT)).proposal.state).toBe("in_review");

    expect(await hooks.applyWiki(props, action!.id)).toBeNull();
    expect(await mock.approveRequests()).toEqual([
      { proposalId: P_EDIT, approval: { proposalHash: hash, sources: EDIT_SOURCES }, key: await instanceKey(hooks, props, action!.id) },
    ]);
    expect(await hooks.getWikiRaw(props, `action:${action!.id}`))
      .toMatchObject({ status: "applied", approvedState: "approved", proposalId: P_EDIT, proposalHash: hash });
    const approved = (await session.readProposal(P_EDIT)).proposal;
    expect(approved).toMatchObject({ state: "approved", approvedHash: hash, publishedDocumentId: null, publishedVersion: null });
    expect(approved.pending).toBeUndefined();

    expect(await mock.runPublishJobs()).toBe(1);
    expect((await session.readProposal(P_EDIT)).proposal).toMatchObject({
      state: "published", publishedDocumentId: RELEASE, publishedVersion: head.version + 1,
    });
    expect(await mock.readDocument(RELEASE)).toEqual({
      ...head, version: head.version + 1, body: action!.fields.Content,
    });
    // Its id, parent, sibling order, Master role and pillar membership are unchanged.
    expect((await mock.listDocuments()).find(d => d.id === RELEASE)).toEqual(page);
    expect(await mock.readStructure()).toEqual(structure);
    expect(await mock.proposalCounts(P_EDIT)).toEqual({ approvals: 1, enqueues: 1, publications: 1 });
  });

  it("A3: a Viewer or Member is refused FORBIDDEN with the publish message, stays pending, and passes once granted", async () => {
    const { props, hooks, mock, id } = await staged();
    for (const role of ["viewer", "member"] as const) {
      await mock.setProposalRole(role);
      expect(await hooks.applyOutcome(props, id, "wiki")).toEqual({
        outcome: "notApplied", retryable: true, code: "FORBIDDEN",
        message: 'The approval of Wiki proposal "Release process" (revision 1) was not applied: ' +
          "Approving for publication needs knowledge:publish (Owner or Admin).",
      });
      expect(await hooks.getWikiRaw(props, `action:${id}`)).toMatchObject({ status: "pending", attempts: {} });
    }
    expect((await mock.readProposal(P_EDIT)).proposal.state).toBe("in_review");
    expect(await mock.proposalCounts(P_EDIT)).toMatchObject({ approvals: 0 });
    await mock.setProposalRole("admin");
    expect(await hooks.applyWiki(props, id)).toBeNull();
    expect((await mock.readProposal(P_EDIT)).proposal.state).toBe("approved");
  });

  it("A4: the requester's own approval is refused for good by InferOps, and nothing is approved", async () => {
    const { props, hooks, mock, id } = await staged(P_SELF);
    const refused = {
      outcome: "notApplied", retryable: false, code: "CONFLICT",
      message: 'The approval of Wiki proposal "Incident response" (revision 1) was not applied: ' +
        "You requested this draft or wrote this revision; another person must approve it.",
    };
    expect(await hooks.applyOutcome(props, id, "wiki")).toEqual(refused);
    expect(await hooks.getWikiRaw(props, `action:${id}`)).toMatchObject({ status: "failed" });
    // A later apply replays the refusal without sending.
    expect(await hooks.applyOutcome(props, id, "wiki")).toEqual(refused);
    expect(await mock.approveRequests()).toHaveLength(1);
    expect((await mock.readProposal(P_SELF)).proposal.state).toBe("in_review");
    expect(await mock.proposalCounts(P_SELF)).toEqual({ approvals: 0, enqueues: 0, publications: 0 });
    // A revision the demo account wrote is its own too.
    const revised = await mock.reviseProposal(P_EDIT, "self");
    const second = setup(props.accountId);
    await second.session.approveProposal(revised.id, revised.proposalHash);
    const last = (await hooks.log()).actions.at(-1)!;
    expect(await hooks.applyOutcome(props, last.id, "wiki")).toMatchObject({ outcome: "notApplied", code: "CONFLICT" });
  });

  it("A5: refuses a stale proposal before anything is staged", async () => {
    const { hooks, mock, session } = setup();
    const hash = await hashOf(mock, P_EDIT);
    expect(await failure(session.approveProposal(P_EDIT, "0".repeat(64))))
      .toContain('STALE_REVISION: Wiki proposal "Release process" changed since it was read (its hash differs).');
    expect(await failure(session.approveProposal(P_STALE, await hashOf(mock, P_STALE))))
      .toContain("is stale: its target page or a cited section changed (or is not visible to you). Draft it again.");
    await mock.reviseProposal(P_EDIT);
    expect(await failure(session.approveProposal(P_EDIT, hash)))
      .toContain('STALE_REVISION: Wiki proposal "Release process" has a newer revision.');
    // A target moved since the draft is stale too.
    await mock.updateDocument(INCIDENT, { body: "Moved on." }, 4, "elsewhere");
    expect(await failure(session.approveProposal(P_SELF, await hashOf(mock, P_SELF)))).toContain("is stale");
    // Not in review, a malformed hash and an unknown or malformed id.
    await mock.approveProposal(P_NEW, { proposalHash: await hashOf(mock, P_NEW), sources: [{ sectionId: CURRENT_WORK, version: 3 }] }, "elsewhere");
    expect(await failure(session.approveProposal(P_NEW, await hashOf(mock, P_NEW))))
      .toContain('CONFLICT: Wiki proposal "Postmortems" is approved, not in review.');
    expect(await failure(session.approveProposal(P_NEW, "ABC"))).toContain("INVALID_REQUEST");
    expect(await failure(session.approveProposal(P_UNKNOWN, hash))).toContain(NO_PROPOSAL);
    expect(await failure(session.approveProposal("not-an-id", hash))).toContain(NO_PROPOSAL);
    expect((await hooks.log()).actions).toEqual([]);
  });

  it("A6: a proposal revised after staging is refused at apply as stale, for good", async () => {
    const { props, hooks, mock, id } = await staged();
    await mock.reviseProposal(P_EDIT);
    expect(await hooks.applyOutcome(props, id, "wiki")).toEqual({
      outcome: "notApplied", retryable: false, code: "STALE_REVISION",
      message: 'The approval of Wiki proposal "Release process" (revision 1) was not applied: ' +
        "The proposal changed since it was approved here; read it again.",
    });
    expect(await hooks.getWikiRaw(props, `action:${id}`)).toMatchObject({ status: "failed" });
    expect(await mock.proposalCounts(P_EDIT)).toEqual({ approvals: 0, enqueues: 0, publications: 0 });
  });

  it("A7a/b: a lost response is unknown and resent under the same key, which InferOps replays once", async () => {
    const { props, hooks, mock, hash, id } = await staged();
    await mock.failNextWrite("lost");
    expect(await hooks.applyOutcome(props, id, "wiki")).toMatchObject({ outcome: "unknown", retryable: true });
    expect(await hooks.getWikiRaw(props, `action:${id}`))
      .toMatchObject({ status: "pending", attempts: { dispatchedAt: expect.any(String) } });
    expect((await mock.readProposal(P_EDIT)).proposal.state).toBe("approved");

    expect(await hooks.applyWiki(props, id)).toBeNull();
    expect(await hooks.getWikiRaw(props, `action:${id}`)).toMatchObject({ status: "applied", approvedState: "approved" });
    const key = await instanceKey(hooks, props, id);
    const sent = { proposalId: P_EDIT, approval: { proposalHash: hash, sources: EDIT_SOURCES }, key };
    expect(await mock.approveRequests()).toEqual([sent, sent]);
    // (b) Applying an applied action sends nothing.
    expect(await hooks.applyWiki(props, id)).toBeNull();
    expect(await mock.approveRequests()).toHaveLength(2);
    // A job delivered twice publishes once, and the second delivery leaves the outcome as it was.
    expect(await mock.runPublishJobs()).toBe(1);
    expect(await mock.runPublishJobs()).toBe(0);
    expect(await mock.proposalCounts(P_EDIT)).toEqual({ approvals: 1, enqueues: 1, publications: 1 });
    expect((await mock.readProposal(P_EDIT)).proposal.state).toBe("published");
  });

  it("A7c: concurrent proposals of one approval stage it once; another approval waiting is CONFLICT", async () => {
    const { props, hooks, mock, session } = setup();
    const hash = await hashOf(mock, P_EDIT);
    const raced = await Promise.allSettled([session.approveProposal(P_EDIT, hash), session.approveProposal(P_EDIT, hash)]);
    expect(raced.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const actions = (await hooks.log()).actions;
    expect(actions).toHaveLength(1);
    // Another approval of the same proposal waiting here (another hash) blocks this one.
    const stored = await hooks.getWikiRaw(props, `action:${actions[0]!.id}`) as Record<string, unknown>;
    await hooks.putWikiRaw(props, `action:${actions[0]!.id}`, { ...stored, proposalHash: "f".repeat(64) });
    expect(await failure(session.approveProposal(P_EDIT, hash)))
      .toContain('CONFLICT: Wiki proposal "Release process" already has another approval waiting for a decision.');
    expect((await hooks.log()).actions).toHaveLength(1);
  });

  it("A7d: a lost response, then a revision, then a retry ends unknown and not retryable, publishing nothing", async () => {
    const { props, hooks, mock, id } = await staged();
    await mock.failNextWrite("lost");
    expect(await hooks.applyOutcome(props, id, "wiki")).toMatchObject({ outcome: "unknown", retryable: true });
    await mock.reviseProposal(P_EDIT);
    const outcome = await hooks.applyOutcome(props, id, "wiki") as { outcome: string; retryable: boolean; code: string; message: string };
    expect(outcome).toMatchObject({ outcome: "unknown", retryable: false, code: "STALE_REVISION" });
    expect(outcome.message).toContain("may already have been applied by an earlier attempt");
    expect(outcome.message).not.toMatch(/publish/i);
    expect(await hooks.getWikiRaw(props, `action:${id}`)).toMatchObject({ status: "pending" });
    expect((await mock.readProposal(P_EDIT)).proposal.state).toBe("superseded");
    expect(await mock.runPublishJobs()).toBe(0);
    expect(await mock.proposalCounts(P_EDIT)).toMatchObject({ publications: 0 });
  });

  it("A8: a stored record changed after staging is refused before sending", async () => {
    const { props, hooks, mock, id } = await staged();
    const stored = await hooks.getWikiRaw(props, `action:${id}`) as Record<string, unknown>;
    await hooks.putWikiRaw(props, `action:${id}`, { ...stored, proposalHash: "e".repeat(64) });
    expect(await hooks.applyOutcome(props, id, "wiki")).toMatchObject({ outcome: "notApplied", code: "IDEMPOTENCY_CONFLICT" });
    await hooks.putWikiRaw(props, `action:${id}`, { ...stored, sources: [{ sectionId: PURPOSE, version: 1 }] });
    expect(await hooks.applyWiki(props, id)).toContain("the stored request no longer matches");
    const { fingerprint: _, ...unsigned } = stored;
    await hooks.putWikiRaw(props, `action:${id}`, unsigned);
    expect(await hooks.applyWiki(props, id)).toContain("the stored request no longer matches");
    expect(await mock.approveRequests()).toEqual([]);
  });

  it("A9: a new page needs a parent; with one it publishes under it, filed in its pillar", async () => {
    const { props, hooks, mock, session } = setup();
    expect(await failure(session.approveProposal(P_NOPARENT, await hashOf(mock, P_NOPARENT))))
      .toContain('INVALID_REQUEST: Wiki proposal "Glossary" is a new page that needs a parent; set it in InferMind.');
    expect((await hooks.log()).actions).toEqual([]);

    await session.approveProposal(P_NEW, await hashOf(mock, P_NEW));
    const [action] = (await hooks.log()).actions;
    expect(action!.fields.Page).toBe('New page "Postmortems" (postmortems) under "Operations"');
    expect(await hooks.applyWiki(props, action!.id)).toBeNull();
    // Delivered twice, a new page (which no page version guards) is still published once.
    expect(await mock.runPublishJobs()).toBe(1);
    expect(await mock.runPublishJobs()).toBe(0);
    expect(await mock.proposalCounts(P_NEW)).toEqual({ approvals: 1, enqueues: 1, publications: 1 });
    expect((await mock.listDocuments()).filter(d => d.slug === "postmortems")).toHaveLength(1);
    const published = (await session.readProposal(P_NEW)).proposal;
    expect(published).toMatchObject({ state: "published", publishedVersion: 1 });
    expect((await mock.listDocuments()).find(d => d.slug === "postmortems"))
      .toMatchObject({ id: published.publishedDocumentId, parentId: OPERATIONS, title: "Postmortems" });
    const operations = (await mock.readStructure()).pillars.find(p => p.key === "operations")!;
    expect(operations.members.map(m => m.slug)).toContain("postmortems");

    // InferOps' 422 at apply (a parentless proposal reaching it) is final INVALID_REQUEST.
    const stored = await hooks.getWikiRaw(props, `action:${action!.id}`) as Record<string, unknown>;
    const parentless = {
      ...stored, actionId: 99, status: "pending", attempts: {}, approvedState: undefined,
      proposalId: P_NOPARENT, proposalHash: await hashOf(mock, P_NOPARENT), sources: [{ sectionId: PURPOSE, version: 1 }],
    };
    await hooks.putWikiRaw(props, "action:99", { ...parentless, fingerprint: await fingerprintOf("knowledge/wiki", parentless as never) });
    expect(await hooks.applyOutcome(props, 99, "wiki")).toEqual({
      outcome: "notApplied", retryable: false, code: "INVALID_REQUEST",
      message: 'The approval of Wiki proposal "Postmortems" (revision 1) was not applied: ' +
        "A new page needs a parent; set one in InferMind.",
    });
  });

  it("A10: reads the later outcome from InferOps: stale when the target moved, superseded when revised", async () => {
    const { props, hooks, mock, session, id } = await staged();
    expect(await hooks.applyWiki(props, id)).toBeNull();
    await mock.updateDocument(RELEASE, { body: "Edited in InferMind meanwhile." }, 2, "elsewhere");
    expect(await mock.runPublishJobs()).toBe(0);
    expect((await session.readProposal(P_EDIT)).proposal).toMatchObject({
      state: "stale", lastError: "The page changed since the proposal was drafted.", publishedDocumentId: null,
    });
    // The action stays what it was: approved, never published.
    expect(await hooks.getWikiRaw(props, `action:${id}`)).toMatchObject({ status: "applied", approvedState: "approved" });
    expect((await mock.readDocument(RELEASE)).body).toBe("Edited in InferMind meanwhile.");

    const second = await staged();
    expect(await second.hooks.applyWiki(second.props, second.id)).toBeNull();
    await second.mock.reviseProposal(P_EDIT);
    expect((await second.session.readProposal(P_EDIT)).proposal).toMatchObject({ state: "superseded", publishedDocumentId: null });
    expect(await second.mock.runPublishJobs()).toBe(0);
    expect((await second.mock.readDocument(RELEASE)).version).toBe(2);
  });

  it("A11: the stopgap connection is refused an approval at staging and at apply, sending nothing; its reads go to InferOps", async () => {
    const stopgap = env as unknown as Record<string, string | undefined>;
    const names = ["INFEROPS_BASE_URL", "INFEROPS_API_TOKEN", "INFEROPS_WORKSPACE_ID", "INFEROPS_WORKSPACE_SLUG"];
    const saved = names.map(name => stopgap[name]);
    const workspaceId = "90000000-0000-4000-8000-000000000001";
    Object.assign(stopgap, {
      INFEROPS_BASE_URL: "http://stopgap.test", INFEROPS_API_TOKEN: "iex_stopgap-for-proposals",
      INFEROPS_WORKSPACE_ID: workspaceId, INFEROPS_WORKSPACE_SLUG: "knowledge",
    });
    // The demo binding's proposal, as InferOps answers it.
    const demo = setup();
    const wire = { ...(await demo.mock.readProposal(P_EDIT)), };
    const record = {
      ...wire.proposal, requestedBy: { id: "00000000-0000-4000-8000-0000000000d2", type: "user" }, draftedBy: null,
      revisedBy: null, decidedBy: null, decisionNote: null, approvedSources: null, sectionRefs: [],
    };
    const calls: Array<{ method: string; path: string; token: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search,
                   token: new Headers(init?.headers).get("authorization") });
      if (url.pathname === "/knowledge/wiki/proposals") return Response.json({ proposals: [record] });
      if (url.pathname === `/knowledge/wiki/proposals/${P_EDIT}`) return Response.json({ proposal: record, freshness: wire.freshness });
      return Response.json({ success: false, error: { code: "NOT_FOUND", message: "no route" } }, { status: 404 });
    });
    try {
      const { props, hooks, session } = setup();
      const stopgapProps = { accountId: props.accountId, host: "acme.knowledge" };
      const stopgapSession = hooks.startWikiSession(stopgapProps);
      expect((await stopgapSession.listProposals()).map(p => p.id)).toEqual([P_EDIT]);
      expect((await stopgapSession.readProposal(P_EDIT)).proposal.proposalHash).toBe(record.proposalHash);
      expect(calls.map(c => [c.method, c.path, c.token])).toEqual([
        ["GET", "/knowledge/wiki/proposals", "Bearer iex_stopgap-for-proposals"],
        ["GET", `/knowledge/wiki/proposals/${P_EDIT}`, "Bearer iex_stopgap-for-proposals"],
      ]);
      expect(await failure(stopgapSession.approveProposal(P_EDIT, record.proposalHash))).toContain(
        "FORBIDDEN: Approving a Wiki proposal needs your own InferLab sign-in: this connection is shared and approves as no one.");
      expect(calls).toHaveLength(2);
      expect((await hooks.log()).actions).toEqual([]);

      // At apply: an approval in a stopgap binding is refused unsent and stays pending.
      await session.approveProposal(P_EDIT, record.proposalHash);
      const [action] = (await hooks.log()).actions;
      await hooks.putWikiRaw(stopgapProps, `action:${action!.id}`, await hooks.getWikiRaw(props, `action:${action!.id}`));
      expect(await hooks.applyOutcome(stopgapProps, action!.id, "wiki")).toMatchObject({
        outcome: "notApplied", retryable: true, code: "FORBIDDEN",
        message: "Approving a Wiki proposal needs your own InferLab sign-in: this connection is shared and approves as no one.",
      });
      expect(await hooks.getWikiRaw(stopgapProps, `action:${action!.id}`)).toMatchObject({ status: "pending", attempts: {} });
      expect(calls.filter(c => c.method !== "GET")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete stopgap[name];
        else stopgap[name] = saved[index];
      });
    }
  });

  it("A12: an approval cannot be reverted here, and a rejected one is forgotten without a call", async () => {
    const { props, hooks, mock, session, id } = await staged();
    await hooks.rejectWiki(props, id);
    expect((await session.readProposal(P_EDIT)).proposal.pending).toBeUndefined();
    expect(await hooks.getWikiRaw(props, `action:${id}`)).toBeUndefined();
    expect(await mock.approveRequests()).toEqual([]);

    await session.approveProposal(P_EDIT, await hashOf(mock, P_EDIT));
    const again = (await hooks.log()).actions.at(-1)!;
    expect(await hooks.applyWiki(props, again.id)).toBeNull();
    expect(await hooks.revertWiki(props, again.id))
      .toBe("An approval cannot be undone here. If the page was published, edit it in InferMind.");
    expect(await mock.approveRequests()).toHaveLength(1);
    expect(await hooks.getWikiRaw(props, `action:${again.id}`)).toMatchObject({ status: "applied" });
  });

  it("A13: with InferOps off, reads and apply are DISABLED and the approval stays pending", async () => {
    const { props, hooks, mock, session, id } = await staged();
    vars.INFEROPS_ENABLED = "false";
    expect(await failure(session.listProposals())).toContain("DISABLED");
    expect(await failure(session.readProposal(P_EDIT))).toContain("DISABLED");
    expect(await hooks.applyOutcome(props, id, "wiki")).toMatchObject({ outcome: "notApplied", retryable: true, code: "DISABLED" });
    expect(await hooks.getWikiRaw(props, `action:${id}`)).toMatchObject({ status: "pending", attempts: {} });
    delete vars.INFEROPS_ENABLED;
    expect(await hooks.applyWiki(props, id)).toBeNull();
    expect((await mock.readProposal(P_EDIT)).proposal.state).toBe("approved");
  });

  it("A14: a shared gadget is refused an approval at staging; its reads and edits still work", async () => {
    const { props, hooks, mock, session } = setup();
    expect(await hooks.addWikiObserver(props, true)).toBeNull();
    expect(await failure(session.approveProposal(P_EDIT, await hashOf(mock, P_EDIT)))).toBe(`InferOpsError: FORBIDDEN: ${SHARED}`);
    expect((await hooks.log()).actions).toEqual([]);
    expect(await hooks.getWikiRaw(props, "action:1")).toBeUndefined();
    expect((await session.readProposal(P_EDIT)).proposal.state).toBe("in_review");
    expect(await session.listProposals()).toHaveLength(5);
    await session.updateDocumentBody("incident-response", "Edited while shared.", 4);
    expect((await hooks.log()).actions.map(a => a.kind)).toEqual(["inferops.wiki-page-update"]);
  });

  it("A15: a collaborator admitted after staging stops the apply before it is sent, until removed", async () => {
    const { props, hooks, mock, id } = await staged();
    expect(await hooks.addWikiObserver(props, true)).toBeNull();
    expect(await hooks.applyOutcome(props, id, "wiki")).toEqual({
      outcome: "notApplied", retryable: true, code: "FORBIDDEN", message: SHARED,
    });
    const stored = await hooks.getWikiRaw(props, `action:${id}`) as { status: string; attempts: Record<string, unknown> };
    expect(stored).toMatchObject({ status: "pending", attempts: {} });
    expect(stored.attempts.dispatchedAt).toBeUndefined();
    expect(await mock.approveRequests()).toEqual([]);
    expect(await mock.proposalCounts(P_EDIT)).toEqual({ approvals: 0, enqueues: 0, publications: 0 });

    await hooks.removeWikiObserver(props);
    expect(await hooks.applyWiki(props, id)).toBeNull();
    expect(await mock.approveRequests()).toHaveLength(1);
    expect(await hooks.getWikiRaw(props, `action:${id}`)).toMatchObject({ status: "applied", approvedState: "approved" });
  });

  it("A15: after an attempt that may have been sent, the collaborator refusal is unknown and retryable, sending nothing", async () => {
    const { props, hooks, mock, id } = await staged();
    await mock.failNextWrite("lost");
    expect(await hooks.applyOutcome(props, id, "wiki")).toMatchObject({ outcome: "unknown", retryable: true });
    expect(await hooks.addWikiObserver(props, true)).toBeNull();
    expect(await hooks.applyOutcome(props, id, "wiki")).toMatchObject({ outcome: "unknown", retryable: true, code: "FORBIDDEN" });
    expect(await mock.approveRequests()).toHaveLength(1);
    expect(await hooks.getWikiRaw(props, `action:${id}`))
      .toMatchObject({ status: "pending", attempts: { dispatchedAt: expect.any(String) } });
    await hooks.removeWikiObserver(props);
    expect(await hooks.applyWiki(props, id)).toBeNull();
    expect(await mock.approveRequests()).toHaveLength(2);
  });

  it("A16: an approval is never auto-approvable, and the Wiki facet has no edit-before-approve path", async () => {
    const { props, hooks } = setup();
    expect(await hooks.wikiApprovalSurfaces(props)).toEqual({
      autoApprovable: [], getApprovalProposal: false, editApprovalProposal: false, boardEditPath: true,
    });
  });

  it("A17: a proposal too long to show in full is refused at staging; one that fits shows every field whole", async () => {
    const { hooks, mock, session } = setup();
    const long = await mock.seedProposal({ title: "Long page", content: `# Long page\n\n${"word ".repeat(30_000)}` });
    expect(await failure(session.approveProposal(long.id, long.proposalHash)))
      .toContain("INVALID_REQUEST: This proposal is too long to show in full on an approval card; approve it in " +
        "InferOps directly (proposal.approve).");
    expect((await hooks.log()).actions).toEqual([]);
    const fits = await mock.seedProposal({ title: "Fits", content: `# Fits\n\n${"word ".repeat(15_000)}` });
    await session.approveProposal(fits.id, fits.proposalHash);
    expect((await hooks.log()).actions[0]).toMatchObject({ complete: true, truncated: [] });
    expect(Object.keys((await hooks.log()).actions[0]!.fields)).toEqual(["Page", "Revision", "Proposal hash", "Summary", "Sources", "Content"]);
  });
});

describe("the read projections", () => {
  it("take only standalone-paragraph inferops:// links as references, each once", () => {
    expect(embeddedReferences([
      "Intro\n\n[Board](inferops://acme.ops/project/board/ENG)\n\nOutro",
      "Inline [Board](inferops://acme.ops/project/board/WEB) in prose.",
      "  [Again](inferops://acme.ops/project/board/ENG)  \r\n\r\n[Bad host](inferops://acme/project/board/X)",
      "[No widget](inferops://acme.ops/project)\n\n[Web](https://example.com/x)",
    ])).toEqual(["inferops://acme.ops/project/board/ENG"]);
  });

  it("parse [[target#tag]] links as InferOps does", () => {
    expect(wikilinksOf("[[ A # one ]] [[A#one]] [[B]] [[C#two|alias]] [[D#three]]"))
      .toEqual([{ target: "A", tag: "one" }, { target: "D", tag: "three" }]);
  });

  it("join title and sections as InferOps' renderDocumentAsText does", () => {
    expect(documentText("Title", ["one", "two"])).toBe("# Title\n\none\n\ntwo");
  });

  it("compose page text by InferOps' contract", () => {
    expect(composeDocumentText("T", content("  # T  \r\n\r\nBody."))).toBe("# T\n\nBody.");
    expect(composeDocumentText("T", content("# Other\nBody."))).toBe("# T\n\n# Other\nBody.");
    expect(composeDocumentText("T", content("# T"))).toBeNull();
    expect(composeDocumentText("T", content("Body.", ["section"]))).toBe("# T\n\nBody.");
    expect(composeDocumentText("T", content("  ", ["one", " ", "two"]))).toBe("# T\n\none\n\ntwo");
    expect(composeDocumentText("T", content("", [], "G"))).toBe("# T\n\nG");
    expect(composeDocumentText("T", content("", []))).toBeNull();
    expect(bodyWithoutTitle("#T\nx", "T")).toBe("#T\nx");
  });

  it("list the pillars, or a pillar's pages, as a Master's generated block", () => {
    const structure = { root: null, unfiled: [], pillars: [
      { key: "a", title: "Alpha", position: 0, master: master("a"), members: [{ ...master("x/y"), source: "human" as const }] },
      { key: "b", title: "Beta", position: 1, master: null, members: [] },
    ] };
    expect(masterStructureText({ id: "r", masterRole: "root" }, structure))
      .toBe(`${GENERATED}\n## Pillars\n- [Alpha](/wiki/a)\n- Beta`);
    expect(masterStructureText({ id: "a", masterRole: "pillar" }, structure))
      .toBe(`${GENERATED}\n## Pages in Alpha\n- [X/Y](/wiki/x%2Fy)`);
    expect(masterStructureText({ id: "zz", masterRole: "pillar" }, structure)).toBeNull();
    expect(masterStructureText({ id: "r", masterRole: "root" }, { ...structure, pillars: [] }))
      .toBe(`${GENERATED}\n## Pillars\n(none yet)`);
    expect(masterStructureText({ id: "a", masterRole: null }, structure)).toBeNull();
  });
});
