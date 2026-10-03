// The InferMind Wiki (#87): a third resource kind, one workspace's Wiki, whose reads are
// observations and whose section edits are approved actions checked at apply against the section's
// current version (InferOps' PATCH takes no expected version). Over the mock's demo Wiki.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseWikiDocumentUrl, parseWikiUrl, resourceKind, wikiDocumentUrl, wikiUrl,
} from "../src/resources";
import { documentText, embeddedReferences, wikilinksOf } from "../src/wiki";
import type { WikiProps } from "./worker";

const WIKI_URL = "inferops://demo.local/knowledge/wiki";
const HANDBOOK = "60000000-0000-4000-8000-000000000001";
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
    expect(pages.map(p => p.slug)).toEqual(["onboarding", "handbook", "drafts", "release-process"]);
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
    expect(bySlug).toMatchObject({ id: HANDBOOK, slug: "handbook", title: "Team handbook" });
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
});
