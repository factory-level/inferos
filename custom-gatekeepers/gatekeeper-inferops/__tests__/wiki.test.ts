// The InferMind Wiki (#87): a third resource kind, one workspace's Wiki, whose reads are
// observations and whose section edits are approved actions checked at apply against the section's
// current version (InferOps' PATCH takes no expected version), and whose page body edits are
// approved actions InferOps applies by a strict compare-and-swap on the page version. Pages read by
// InferOps' page-text contract, with Masters listing the structure. Over the mock's demo Wiki.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
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
    for (const bad of [
      "inferops://acme.knowledge/knowledge/document/", "inferops://acme.knowledge/knowledge/document/a/b",
      "inferops://acme.knowledge/knowledge/document/a?b=1", "inferops://acme/knowledge/document/a",
      "inferops://acme.knowledge/knowledge/document/%2e%2e", "https://acme.knowledge/knowledge/document/a",
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

  it("is refused at apply when the page changed since, and leaves its content", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateDocumentBody(INCIDENT, "My edit.", 4);
    await mock.updateDocument(INCIDENT, { body: "Someone else's edit." }, 4, "elsewhere");

    expect(await session.readDocument(INCIDENT)).toMatchObject({ body: "Someone else's edit.", version: 5 });
    expect((await session.readDocument(INCIDENT)).pendingBody).toBeUndefined();
    expect(await hooks.applyWiki(props, 1))
      .toContain("the page changed in InferOps after this edit was proposed (expected version 4)");
    expect(await mock.readDocument(INCIDENT)).toMatchObject({ body: "Someone else's edit.", version: 5 });
    expect(await hooks.getWikiRaw(props, "action:1")).toMatchObject({ status: "pending" });
  });

  it("fails as stale, never in effect, when another writer already wrote the same body", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateDocumentBody(INCIDENT, "Same text.", 4);
    await mock.updateDocument(INCIDENT, { body: "Same text." }, 4, "another-writer");

    expect(await hooks.applyWiki(props, 1)).toContain("the page changed in InferOps after this edit was proposed");
    expect(await hooks.getWikiRaw(props, "action:1")).toMatchObject({ status: "pending" });
    expect((await mock.readDocument(INCIDENT)).version).toBe(5);
  });

  it("is replayed by InferOps when an apply is retried after its write committed", async () => {
    const { props, hooks, mock, session } = setup();
    await session.updateDocumentBody(INCIDENT, "Written once.", 4);
    expect(await hooks.applyWiki(props, 1)).toBeNull();
    // The write committed but its response was lost, so the action is still pending here.
    const applied = await hooks.getWikiRaw(props, "action:1") as Record<string, unknown>;
    const { appliedVersion: _, ...pending } = applied;
    await hooks.putWikiRaw(props, "action:1", { ...pending, status: "pending" });

    expect(await hooks.applyWiki(props, 1)).toBeNull();
    expect(await mock.readDocument(INCIDENT)).toMatchObject({ body: "Written once.", version: 5 });
    expect(await hooks.getWikiRaw(props, "action:1")).toMatchObject({ status: "applied", appliedVersion: 5 });

    // The replay is bound to the whole write: the same key with another body or version is stale.
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
    expect(await hooks.applyWiki(props, 1)).toContain("was not applied: InferOps refused the Wiki");
    await mock.setInferMindEnabled(true);
    expect((await mock.readDocument(INCIDENT)).version).toBe(4);
    expect(await hooks.applyWiki(props, 1)).toBeNull();
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
