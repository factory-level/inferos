// Semantic board discovery (#61): ranks the projects a person can read, in every InferOps
// workspace they hold, against what they said, without them having to remember a board's title,
// key, workspace or URI. Pure, so the session can feed it whatever the person's own token listed,
// and the ranking is tested on its own.
//
// "Semantic" here is deliberately local and explainable: query words (lowercased, lightly stemmed,
// common words dropped) are matched against a project's key, its name and the titles of its open
// issues, and every candidate says which words matched where. Nothing is indexed or sent elsewhere.

import type { BoardCandidate } from "./types";

/** Longest query `findBoards` accepts. */
export const MAX_DISCOVERY_QUERY_LENGTH = 200;

/** Most candidates `findBoards` returns. */
export const MAX_DISCOVERY_CANDIDATES = 8;

/**
 * Most projects whose issue titles are read for one query, across every workspace searched; the
 * rest are matched on key and name.
 */
export const MAX_DISCOVERY_SCANNED_PROJECTS = 20;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "board", "boards", "by", "do", "find", "for", "from",
  "has", "have", "i", "in", "into", "is", "it", "its", "kanban", "me", "my", "of", "on", "open",
  "or", "our", "project", "projects", "show", "that", "the", "their", "this", "to", "us", "we",
  "where", "which", "with", "work", "you", "your",
]);

/** Lowercase words of `text`, without common ones, each reduced to a crude stem. */
export function discoveryTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter(word => !STOPWORDS.has(word)).map(stem))];
}

function stem(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

/** What discovery knows of one project the person can read. */
export type DiscoveryProject = {
  identifier: string;
  name: string;
  /** Titles of its open issues, or null when they were not read (past the scan limit). */
  openIssueTitles: string[] | null;
};

/** Where the board candidates live: one workspace and how to name a board in it. */
export type DiscoveryScope = {
  tenant: string;
  workspace: string;
  boardRef: (projectKey: string) => string;
};

/** The projects the person can read in one workspace. */
export type DiscoveryWorkspace = { scope: DiscoveryScope; projects: DiscoveryProject[] };

/**
 * The projects across `workspaces` that match `query`, best first, at most
 * `MAX_DISCOVERY_CANDIDATES`. A project that matches nothing is never returned, so an empty result
 * means no match, and ties are kept: callers must disambiguate rather than take the first. Equal
 * scores are ordered by project key, then workspace, so the result does not depend on the order the
 * workspaces were listed in.
 */
export function rankBoards(query: string, workspaces: DiscoveryWorkspace[]): BoardCandidate[] {
  const terms = discoveryTerms(query);
  const rawKeys = new Set((query.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).map(word => word.toUpperCase()));
  const scored = workspaces.flatMap(({ scope, projects }) => projects.flatMap(project => {
    const reasons: string[] = [];
    let score = 0;
    if (rawKeys.has(project.identifier)) {
      score += 10;
      reasons.push(`Project key is ${project.identifier}`);
    }
    const nameTerms = new Set(discoveryTerms(project.name));
    const inName = terms.filter(term => nameTerms.has(term));
    if (inName.length > 0) {
      score += 4 * inName.length;
      reasons.push(`Name "${project.name}" matches ${quoted(inName)}`);
    }
    if (project.openIssueTitles) {
      const titles = project.openIssueTitles.map(title => new Set(discoveryTerms(title)));
      for (const term of terms) {
        const count = titles.filter(words => words.has(term)).length;
        if (count === 0) continue;
        score += Math.min(count, 3);
        reasons.push(`${count} open ${count === 1 ? "issue mentions" : "issues mention"} "${term}"`);
      }
    }
    if (score === 0) return [];
    const candidate: BoardCandidate = {
      tenant: scope.tenant, workspace: scope.workspace, projectKey: project.identifier,
      boardRef: scope.boardRef(project.identifier), title: project.name, reasons,
    };
    return [{ candidate, score }];
  }));
  return scored
    .toSorted((a, b) => b.score - a.score
      || a.candidate.projectKey.localeCompare(b.candidate.projectKey)
      || a.candidate.workspace.localeCompare(b.candidate.workspace))
    .slice(0, MAX_DISCOVERY_CANDIDATES)
    .map(entry => entry.candidate);
}

const quoted = (terms: string[]) => terms.map(term => `"${term}"`).join(", ");
