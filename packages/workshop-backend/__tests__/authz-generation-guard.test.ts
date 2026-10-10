// A static guard for the authorization generation (callable-widget contract §4.1, step C5a). Every
// storage write to an authorization input must raise the generation through bumpAuthzGeneration
// in the same synchronous block: after the write, with no await between them, in the same method.
// authz-generation.test.ts proves each known site raises it at runtime; this scan catches a site
// added later. A new write site fails here until someone reviews it, gives it a bump (or, if it
// changes nothing about who may reach the workspace, adds it to EXEMPT with the reason) and adds it
// to the pinned list below.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as
    Record<string, string>;

// Storage writes to an authorization input: the sharing graph (collaborators, share keys), the
// observer records, the two policy flags, the owner, the operate-session mark, and workspace
// deletion. The access restart is checked separately below (it is a call, not a write).
const AUTHZ_WRITE = new RegExp(
    String.raw`\bstorage\.(?:collaborators|shareKeys|observers|ownerInvitesOnly|` +
    String.raw`containsRestrictedData|ownerId|operateSession)(?:\.\w+)?\.(?:put|delete)\(` +
    String.raw`|\bstorage\.deleteAll\(`, "g");
const BUMP = /\bbumpAuthzGeneration\(/g;

// Write sites that change no authorization input, each with the reason.
const EXEMPT: Record<string, string> = {
  "sharing.ts:SharingManager.updateShareLink":
      "edits a link's note only; its role, revocation and keys are untouched",
};

// Blanks comments and string and template literals in one pass (keeping offsets and line
// structure), so a mention in a comment or message is not a write.
function code(source: string): string {
  return source.replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
      match => match.replace(/[^\n]/g, " "));
}

// `<Class>.<method>` enclosing each line, by the same indentation convention as
// chat-taint-guard.test.ts: classes at column 0, methods at column 2.
function enclosingMethods(lines: string[]): string[] {
  let className = "(module)";
  let method = "(top level)";
  return lines.map(line => {
    let classMatch = /^(?:export\s+)?class\s+(\w+)/.exec(line);
    if (classMatch) { className = classMatch[1]; method = "(class body)"; }
    let methodMatch = /^ {2}(?:static\s+)?(?:async\s+)?(#?\w+)\s*(?:<[^>]*>)?\(/.exec(line);
    if (methodMatch && !/^ {2}(?:if|for|while|switch|return)\b/.test(line)) method = methodMatch[1];
    let functionMatch = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(line);
    if (functionMatch) { className = "(module)"; method = functionMatch[1]; }
    return `${className}.${method}`;
  });
}

type WriteSite = { site: string; line: number; problem?: string };

/** Every authorization write in `source`, each with a problem if no bump follows it in time. */
function authzWriteSites(file: string, source: string): WriteSite[] {
  let text = code(source);
  let lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  let lineOf = (offset: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++;
    return line;
  };
  let methods = enclosingMethods(text.split("\n"));
  let bumps = [...text.matchAll(BUMP)].map(m => m.index!);

  return [...text.matchAll(AUTHZ_WRITE)].map(write => {
    let at = write.index!;
    let line = lineOf(at);
    let site = `${file}:${methods[line]}`;
    if (site in EXEMPT) return { site, line: line + 1 };
    let bump = bumps.find(offset => offset > at);
    let problem: string | undefined;
    if (bump === undefined || methods[lineOf(bump)] !== methods[line]) {
      problem = "no bumpAuthzGeneration() after it in the same method";
    } else if (/\bawait\b/.test(text.slice(at, bump))) {
      problem = "an await separates it from its bumpAuthzGeneration()";
    }
    return { site, line: line + 1, problem };
  });
}

function allWriteSites(): WriteSite[] {
  return Object.entries(SOURCES).flatMap(([path, source]) =>
    authzWriteSites(path.replace("../src/", ""), source));
}

describe("authorization-input write sites", () => {
  it("are exactly the reviewed ones", () => {
    // One entry per write. Adding a site means reviewing it against §4.1 first.
    expect(allWriteSites().map(w => w.site).toSorted()).toEqual([
      "overseer.ts:OverseerClientInterface.deleteSelf",
      "overseer.ts:OverseerDurableObject.open",
      "overseer.ts:OverseerDurableObject.open",
      "overseer.ts:OverseerDurableObject.receiveExternalMessage",
      "overseer.ts:OverseerImpl.#enforceExcludeObservers",
      "overseer.ts:OverseerImpl.authorizeObservation",
      "overseer.ts:OverseerImpl.authorizeObservation",
      "overseer.ts:OverseerImpl.ensureObserver",
      "overseer.ts:OverseerImpl.tearDownLostObservers",
      "sharing.ts:SharingManager.#reRootKeptUsers",
      "sharing.ts:SharingManager.addCollaborator",
      "sharing.ts:SharingManager.addCollaborator",
      "sharing.ts:SharingManager.createShareLink",
      "sharing.ts:SharingManager.newShareLinkKey",
      "sharing.ts:SharingManager.redeemShareKey",
      "sharing.ts:SharingManager.redeemShareKey",
      "sharing.ts:SharingManager.removeCollaborator",
      "sharing.ts:SharingManager.revokeShareLink",
      "sharing.ts:SharingManager.revokeShareLink",
      "sharing.ts:SharingManager.updateShareLink",
    ]);
  });

  it("each raise the generation after the write, with no await between", () => {
    expect(allWriteSites().filter(w => w.problem)
        .map(w => `${w.site} (line ${w.line}): ${w.problem}`)).toEqual([]);
  });

  it("only the helper and deleteSelf's carry-over write the generation directly", () => {
    let writers = Object.entries(SOURCES).flatMap(([path, source]) => {
      let text = code(source);
      let methods = enclosingMethods(text.split("\n"));
      return text.split("\n").flatMap((line, i) => /\bauthzGeneration\.put\(/.test(line)
          ? [`${path.replace("../src/", "")}:${methods[i]}`] : []);
    });
    expect(writers.toSorted()).toEqual([
      "overseer.ts:OverseerClientInterface.deleteSelf",
      "sharing.ts:(module).bumpAuthzGeneration",
    ]);
  });

  it("the access restart bumps before its first await", () => {
    let source = code(SOURCES["../src/overseer.ts"]);
    let body = /async scheduleAccessRestart\(reason: string\): Promise<void> \{([\s\S]*?)\n {2}\}/
        .exec(source)![1];
    expect(body.trim()).toMatch(/^bumpAuthzGeneration\(this\.storage\);\s*await /);
  });
});

describe("the scan itself", () => {
  // Synthetic sources, so a scan that silently matched nothing could not pass the checks above.
  const SAMPLE = [
    "class Sample {",
    "  async missing() {",
    "    this.storage.collaborators.put(record);",
    "  }",
    "  async late() {",
    "    this.storage.shareKeys.put(link);",
    "    await somethingElse();",
    "    bumpAuthzGeneration(this.storage);",
    "  }",
    "  async good() {",
    "    await before();",
    "    this.storage.observers.delete(id);",
    "    bumpAuthzGeneration(this.storage);",
    "  }",
    "  commented() {",
    "    // this.storage.collaborators.put(record);",
    "    let s = \"this.storage.ownerId.put(x)\";",
    "  }",
    "}",
  ].join("\n");

  it("flags a missing bump and one an await separates, and ignores comments and strings", () => {
    expect(authzWriteSites("sample.ts", SAMPLE)).toEqual([
      { site: "sample.ts:Sample.missing", line: 3,
        problem: "no bumpAuthzGeneration() after it in the same method" },
      { site: "sample.ts:Sample.late", line: 6,
        problem: "an await separates it from its bumpAuthzGeneration()" },
      { site: "sample.ts:Sample.good", line: 12, problem: undefined },
    ]);
  });
});
