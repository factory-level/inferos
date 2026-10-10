import { describe, expect, test } from "vitest";
import {
  BOUND_VIEW_FIELDS, BOUND_VIEW_LIMITS, formatBoundViewProblems, parseBoundViewSpec,
  type BoundViewProblem, type BoundViewProblemCode,
} from "./bound-view";

// Tests for the frozen v1 bound-view validator (bound-view contract §2.2 grammar, §2.3 static
// limits). Specs are built as plain objects and serialized, except where the raw text matters.

type Spec = Record<string, unknown>;
type Node = Record<string, unknown>;

const LIMITS = BOUND_VIEW_LIMITS;
const text = (node: Partial<Node> = {}): Node => ({ type: "text", text: "Hi", ...node });
const stack = (children: Node[]): Node => ({ type: "stack", children });
const issues = (extra: Record<string, unknown> = {}) => ({ requirement: "board", collection: "issues", ...extra });
const columns = (extra: Record<string, unknown> = {}) => ({ requirement: "board", collection: "columns", ...extra });
const count = (of: Record<string, unknown> = issues()): Node => ({ type: "count", label: "Open", of });
const list = (of: Record<string, unknown> = issues(), item: unknown[] = [{ type: "field", value: { field: "title" } }],
    extra: Record<string, unknown> = {}): Node => ({ type: "list", of, item, empty: "None", ...extra });
const table = (of: Record<string, unknown> = issues(), cols: unknown[] = [{ header: "Title", field: "title" }]): Node =>
  ({ type: "table", of, columns: cols, empty: "None" });
const spec = (root: Node = text(), extra: Partial<Spec> = {}): Spec =>
  ({ version: 1, title: "Board", requirements: ["board"], root, ...extra });

const parse = (value: unknown) => parseBoundViewSpec(JSON.stringify(value));
const problems = (result: ReturnType<typeof parseBoundViewSpec>): BoundViewProblem[] =>
  result.ok ? [] : result.problems;
const codes = (value: unknown) => problems(parse(value)).map(problem => problem.code);
const codesOf = (raw: string) => problems(parseBoundViewSpec(raw)).map(problem => problem.code);
const limits = (value: unknown) =>
  problems(parse(value)).filter(problem => problem.code === "limit").map(problem => problem.limit);
const expectOk = (value: unknown) => {
  const result = parse(value);
  expect(result.ok ? [] : result.problems).toEqual([]);
  return result;
};

// `n` copies of `value`, each its own object.
const times = (n: number, value: object) => Array.from({ length: n }, () => structuredClone(value));
// A root at `depth` levels: stacks down to one text leaf.
const chain = (depth: number): Node => depth === 1 ? text() : stack([chain(depth - 1)]);
// A root of exactly `n` nodes: a stack of 6 stacks, filled with texts.
const nodes = (n: number): Node => {
  let texts = n - 7;
  const groups = Array.from({ length: 6 }, () => {
    const take = Math.min(12, Math.max(0, texts));
    texts -= take;
    return stack(Array.from({ length: take }, () => text()));
  });
  return stack(groups);
};

describe("parseBoundViewSpec: accepts", () => {
  test("a minimal spec, returning it with null-prototype objects", () => {
    const result = expectOk(spec());
    if (!result.ok) return;
    expect(result.spec).toEqual(spec());
    expect(Object.getPrototypeOf(result.spec)).toBeNull();
    expect(Object.getPrototypeOf(result.spec.root)).toBeNull();
  });

  test("every node, item and column form", () => {
    const badge = { urgent: { label: "Urgent", tone: "danger" }, none: { label: "-", tone: "neutral" } };
    expectOk(spec(stack([
      { type: "stack", gap: "sm", children: [] },
      { type: "columns", children: [text({ tone: "muted", size: "lg" }), { type: "empty", text: "Nothing" }] },
      { type: "field", label: "Project", value: { requirement: "board", field: "project.identifier" } },
      { type: "field", value: { requirement: "board", field: "project.name" } },
      count(issues({ where: [{ field: "blocked", equals: true }] })),
      list(issues({ sort: [{ field: "priority", dir: "asc" }, { field: "targetDate", dir: "desc" }], limit: 200 }), [
        { type: "field", label: "Title", value: { field: "title" } },
        { type: "badge", value: { field: "priority" }, map: badge },
        { type: "badge", value: { field: "group" } },
        { type: "text", text: "-", tone: "muted" },
      ], { groupBy: "column" }),
      list(columns({ where: [{ field: "count", equals: 0 }] }), [{ type: "field", value: { field: "label" } }],
          { groupBy: "group" }),
      table(issues({ where: [{ field: "targetDate", equals: null }, { field: "targetDate", equals: "2026-10-09" }] }), [
        { header: "Id", field: "identifier" },
        { header: "Due", field: "targetDate", as: "date" },
        { header: "Blocked", field: "blocked", as: "flag" },
        { header: "Column", field: "column", as: "text" },
        { header: "Group", field: "group", as: "badge", map: { started: { label: "Doing", tone: "info" } } },
      ]),
    ])));
  });

  test("whitespace of every JSON kind between tokens", () => {
    expect(codesOf(` \t\n\r${JSON.stringify(spec(), null, "\t")}\r\n `)).toEqual([]);
  });

  test("a maximum legal spec, at every static bound at once", () => {
    const where = [
      { field: "blocked", equals: false }, { field: "priority", equals: "high" },
      { field: "group", equals: "started" }, { field: "title", equals: "x".repeat(LIMITS.literalLength) },
    ];
    const sort = [{ field: "priority", dir: "asc" }, { field: "identifier", dir: "desc" }];
    const wide: Record<string, unknown>[] = Array.from({ length: LIMITS.tableColumns }, (_, i) =>
      ({ header: `C${i}`, field: ["identifier", "title", "priority", "targetDate", "blocked", "column", "group", "title"][i] }));
    wide[2] = { header: "P", field: "priority", as: "badge", map: Object.fromEntries(
        ["urgent", "high", "medium", "low", "none"].map(key => [key, { label: key, tone: "info" }])) };
    const leaves = [
      { type: "field", value: { field: "title" } }, { type: "field", value: { field: "identifier" } },
      { type: "badge", value: { field: "column" }, map: Object.fromEntries(
          Array.from({ length: LIMITS.badgeEntries }, (_, i) => [`L${i}`, { label: "l", tone: "neutral" }])) },
      { type: "text", text: "t" },
    ];
    // 8 × 30 + 4 × 430 + 1 × 40 = 2,000 cells over 30 + 430 + 40 = 500 rows.
    const names = ["board", "r1", "r2", "r3"];
    const queries: Node[] = [
      table(issues({ where, sort, limit: 30 }), wide),
      list(issues({ limit: 200 }), leaves), list(issues({ limit: 200 }), leaves), list(issues({ limit: 30 }), leaves),
      table(columns({ limit: 40 }), [{ header: "Label", field: "label" }]),
      ...Array.from({ length: LIMITS.queries - 5 }, (_, i) => count(issues({ requirement: names[i % 4] }))),
    ];
    // Root (1) + 5 group stacks + 16 queries + a 6-node chain reaching depth 8 + 36 fillers = 64.
    const items: Node[] = [...queries, chain(LIMITS.depth - 2),
      ...Array.from({ length: 36 }, () => ({ type: "empty", text: "e" }))];
    const groups = Array.from({ length: 5 }, (_, i) => stack(items.slice(i * 12, i * 12 + 12)));
    const max = spec(stack(groups), { title: "T".repeat(LIMITS.textLength), requirements: names });
    const raw = JSON.stringify(max);
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(LIMITS.specBytes);
    expect(codesOf(raw)).toEqual([]);
    // It sits at the node and depth bounds: one more node, or one more level, is refused.
    expect(limits(spec(stack([...groups, text()]), { requirements: names }))).toEqual(["nodes"]);
    const deeper = groups.map((group, i) => i === 1 ? stack([...(group.children as Node[]).slice(0, 4), stack([chain(LIMITS.depth - 2)])]) : group);
    expect(limits(spec(stack(deeper), { requirements: names }))).toEqual(["depth"]);
  });
});

describe("parseBoundViewSpec: raw text", () => {
  test("is at most 8 KiB of UTF-8, counting bytes rather than code units", () => {
    const base = JSON.stringify(spec());
    const pad = (bytes: number) => base + " ".repeat(bytes - base.length);
    expect(codesOf(pad(LIMITS.specBytes))).toEqual([]);
    expect(problems(parseBoundViewSpec(pad(LIMITS.specBytes + 1))))
      .toEqual([{ code: "size", path: "$", limit: "specBytes" }]);
    // "é" is one code unit and two bytes.
    const accented = JSON.stringify(spec(text({ text: "é".repeat(150) }), { title: "é".repeat(150) }));
    const padded = accented + " ".repeat(LIMITS.specBytes - new TextEncoder().encode(accented).length);
    expect(codesOf(padded)).toEqual([]);
    expect(codesOf(padded + " ")).toEqual(["size"]);
  });

  test("refuses a leading byte order mark", () => {
    expect(codesOf(`﻿${JSON.stringify(spec())}`)).toEqual(["bom"]);
  });

  test.each([
    ["empty", ""], ["not JSON", "view"], ["trailing comma", '{"version":1,}'], ["array trailing comma", "[1,]"],
    ["unterminated", '{"version":1'], ["two values", "{} {}"], ["single quotes", "{'a':1}"],
    ["raw control character", '{"title":"a\u0001"}'], ["bad escape", '{"title":"\\x"}'],
    ["short unicode escape", '{"title":"\\u12"}'], ["comment", "{/* */}"], ["NaN", '{"a":NaN}'],
  ])("refuses invalid JSON: %s", (_name, raw) => {
    expect(codesOf(raw)).toEqual(["syntax"]);
  });

  test("bounds JSON nesting before it can recurse deeply", () => {
    expect(codesOf("[".repeat(4000) + "]".repeat(4000))).toEqual(["limit"]);
  });
});

describe("parseBoundViewSpec: keys", () => {
  test("refuses duplicate keys, top-level, nested and ones JSON.parse would collapse", () => {
    expect(codesOf('{"version":1,"version":1,"title":"a","requirements":["board"],"root":{"type":"empty","text":"e"}}'))
      .toEqual(["duplicateKey"]);
    // The second copy is valid, so JSON.parse alone would accept the spec.
    const nested = JSON.stringify(spec(text())).replace('"type":"text"', '"type":"bogus","type":"text"');
    expect(codesOf(nested)).toEqual(["duplicateKey"]);
  });

  test("refuses duplicate keys that differ only in escaping", () => {
    expect(codesOf('{"a":1,"\\u0061":2}')).toEqual(["duplicateKey"]);
    const raw = JSON.stringify(spec()).replace('"title":"Board"', '"title":"Board","\\u0074itle":"Board"');
    const result = parseBoundViewSpec(raw);
    expect(problems(result)).toEqual([{ code: "duplicateKey", path: "$.title" }]);
  });

  test.each([
    ["__proto__", '"__proto__"'], ["constructor", '"constructor"'], ["prototype", '"prototype"'],
    ["escaped __proto__", '"\\u005f\\u005fproto__"'], ["escaped constructor", '"\\u0063onstructor"'],
    ["escaped prototype", '"protot\\u0079pe"'],
  ])("refuses the forbidden key %s, anywhere", (_name, key) => {
    expect(codesOf(`{${key}:1}`)).toEqual(["forbiddenKey"]);
    const inMap = JSON.stringify(spec(list(issues(), [{ type: "badge", value: { field: "priority" }, map: { high: { label: "H", tone: "info" } } }])))
      .replace('"high":', `${key}:`);
    expect(codesOf(inMap)).toEqual(["forbiddenKey"]);
  });

  test("refuses unknown and missing keys", () => {
    expect(codes({ ...spec(), extra: 1 })).toEqual(["unknownKey"]);
    expect(problems(parse({ ...spec(), "a b": 1 }))).toEqual([{ code: "unknownKey", path: "$[?]" }]);
    expect(codes(spec(text({ color: "red" })))).toEqual(["unknownKey"]);
    expect(codes(spec(count(issues({ sort: [] }))))).toEqual(["unknownKey"]);
    expect(codes(spec(count(issues({ limit: 5 }))))).toEqual(["unknownKey"]);
    expect(codes({ version: 1, title: "t", root: text() })).toEqual(["missingKey"]);
    expect(problems(parse(spec({ type: "list", of: issues(), item: [{ type: "text", text: "a" }] }))))
      .toEqual([{ code: "missingKey", path: "$.root.empty" }]);
  });

  test("looks fields and badge keys up as own properties only", () => {
    expect(codes(spec(list(issues({ where: [{ field: "toString", equals: "x" }] }))))).toEqual(["field"]);
    expect(codes(spec(list(issues(), [{ type: "field", value: { field: "hasOwnProperty" } }])))).toEqual(["field"]);
    expect(codes(spec(list(issues(), [{ type: "badge", value: { field: "priority" }, map: { toString: { label: "x", tone: "info" } } }]))))
      .toEqual(["badgeKey"]);
    expect(codes(spec({ type: "field", value: { requirement: "board", field: "valueOf" } }))).toEqual(["field"]);
  });
});

describe("parseBoundViewSpec: numbers", () => {
  const withLiteral = (lexeme: string) => JSON.stringify(spec(count(columns({ where: [{ field: "count", equals: 7 }] }))))
    .replace('"equals":7', `"equals":${lexeme}`);

  test.each(["10.0", "1e1", "1E1", "-0", "00", "10001", "-1", "1.5", "1e+1", "01"])(
    "refuses the number lexeme %s", lexeme => {
      expect(codesOf(withLiteral(lexeme))).toEqual(["number"]);
    });

  test.each(["0", "7", "10000"])("accepts the number lexeme %s", lexeme => {
    expect(codesOf(withLiteral(lexeme))).toEqual([]);
  });

  test("holds version and limit to their own ranges", () => {
    expect(codes(spec(text(), { version: 2 }))).toEqual(["value"]);
    expect(limits(spec(list(issues({ limit: 0 }))))).toEqual(["limitMin"]);
    expect(limits(spec(list(issues({ limit: 201 }))))).toEqual(["limitMax"]);
    expectOk(spec(list(issues({ limit: 1 }))));
    expect(codes(spec(list(issues({ limit: "5" }))))).toEqual(["type"]);
  });
});

describe("parseBoundViewSpec: static limits, at the bound and one past", () => {
  test("depth", () => {
    expectOk(spec(chain(LIMITS.depth)));
    expect(limits(spec(chain(LIMITS.depth + 1)))).toEqual(["depth"]);
  });

  test("nodes", () => {
    expectOk(spec(nodes(LIMITS.nodes)));
    expect(limits(spec(nodes(LIMITS.nodes + 1)))).toEqual(["nodes"]);
  });

  test("children per stack, and per columns node", () => {
    expectOk(spec(stack(Array.from({ length: LIMITS.children }, () => text()))));
    expect(limits(spec(stack(Array.from({ length: LIMITS.children + 1 }, () => text()))))).toEqual(["children"]);
    const cols = (n: number) => ({ type: "columns", children: Array.from({ length: n }, () => text()) });
    expectOk(spec(cols(LIMITS.columnsChildrenMin)));
    expectOk(spec(cols(LIMITS.columnsChildrenMax)));
    expect(limits(spec(cols(LIMITS.columnsChildrenMin - 1)))).toEqual(["columnsChildrenMin"]);
    expect(limits(spec(cols(LIMITS.columnsChildrenMax + 1)))).toEqual(["columnsChildrenMax"]);
  });

  test("requirements", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => i === 0 ? "board" : `r${i}`);
    expectOk(spec(text(), { requirements: names(LIMITS.requirements) }));
    expect(limits(spec(text(), { requirements: names(LIMITS.requirements + 1) }))).toEqual(["requirements"]);
    expect(limits(spec(text(), { requirements: [] }))).toEqual(["requirementsMin"]);
  });

  test("queries, counting list, table and count", () => {
    const many = (n: number) => stack([
      stack(Array.from({ length: Math.min(n, 12) }, () => count())),
      stack(Array.from({ length: n - Math.min(n, 12) }, (_, i) => i % 2 === 0 ? list(issues({ limit: 1 })) : table(issues({ limit: 1 })))),
    ]);
    expectOk(spec(many(LIMITS.queries)));
    expect(limits(spec(many(LIMITS.queries + 1)))).toEqual(["queries"]);
  });

  test("where clauses and sort keys per query", () => {
    const clause = { field: "blocked", equals: true };
    expectOk(spec(list(issues({ where: times(LIMITS.where, clause) }))));
    expect(limits(spec(list(issues({ where: times(LIMITS.where + 1, clause) }))))).toEqual(["where"]);
    expect(limits(spec(count(issues({ where: times(LIMITS.where + 1, clause) }))))).toEqual(["where"]);
    const key = { field: "title", dir: "asc" };
    expectOk(spec(list(issues({ sort: times(LIMITS.sort, key) }))));
    expect(limits(spec(list(issues({ sort: times(LIMITS.sort + 1, key) }))))).toEqual(["sort"]);
  });

  test("table columns and list item leaves", () => {
    const col = { header: "T", field: "title" };
    expectOk(spec(table(issues({ limit: 1 }), times(LIMITS.tableColumns, col))));
    expect(limits(spec(table(issues({ limit: 1 }), times(LIMITS.tableColumns + 1, col))))).toEqual(["tableColumns"]);
    expect(limits(spec(table(issues(), [])))).toEqual(["tableColumnsMin"]);
    const leaf = { type: "text", text: "a" };
    expectOk(spec(list(issues({ limit: 1 }), times(LIMITS.itemLeaves, leaf))));
    expect(limits(spec(list(issues({ limit: 1 }), times(LIMITS.itemLeaves + 1, leaf))))).toEqual(["itemLeaves"]);
    expect(limits(spec(list(issues(), [])))).toEqual(["itemLeavesMin"]);
  });

  test("badge-map entries", () => {
    const map = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, { label: "c", tone: "info" }]));
    const badge = (n: number) => spec(list(issues(), [{ type: "badge", value: { field: "column" }, map: map(n) }]));
    expectOk(badge(LIMITS.badgeEntries));
    expect(limits(badge(LIMITS.badgeEntries + 1))).toEqual(["badgeEntries"]);
    const column = (n: number) => spec(table(issues(), [{ header: "C", field: "column", as: "badge", map: map(n) }]));
    expectOk(column(LIMITS.badgeEntries));
    expect(limits(column(LIMITS.badgeEntries + 1))).toEqual(["badgeEntries"]);
  });

  test("Text length, in code units, in every Text position", () => {
    expectOk(spec(text({ text: "a".repeat(LIMITS.textLength) }), { title: "a".repeat(LIMITS.textLength) }));
    // An astral character is two code units.
    expectOk(spec(text({ text: "\u{1F600}".repeat(LIMITS.textLength / 2) })));
    expect(limits(spec(text({ text: "\u{1F600}".repeat(LIMITS.textLength / 2) + "a" })))).toEqual(["textLength"]);
    const long = "a".repeat(LIMITS.textLength + 1);
    expect(limits(spec(text(), { title: long }))).toEqual(["textLength"]);
    expect(limits(spec(text(), { title: "" }))).toEqual(["textLengthMin"]);
    expect(limits(spec({ type: "empty", text: long }))).toEqual(["textLength"]);
    expect(limits(spec(count(), {}))).toEqual([]);
    expect(limits(spec({ ...count(), label: long }))).toEqual(["textLength"]);
    expect(limits(spec({ ...list(), empty: "" }))).toEqual(["textLengthMin"]);
    expect(limits(spec(table(issues(), [{ header: long, field: "title" }])))).toEqual(["textLength"]);
    expect(limits(spec(list(issues(), [{ type: "field", label: long, value: { field: "title" } }])))).toEqual(["textLength"]);
    expect(limits(spec(list(issues(), [{ type: "badge", value: { field: "priority" }, map: { high: { label: long, tone: "info" } } }]))))
      .toEqual(["textLength"]);
  });

  test("string literal length, in where clauses and string badge keys", () => {
    const where = (s: string) => spec(list(issues({ where: [{ field: "title", equals: s }] })));
    expectOk(where("a".repeat(LIMITS.literalLength)));
    expectOk(where(""));
    expect(limits(where("a".repeat(LIMITS.literalLength + 1)))).toEqual(["literalLength"]);
    const key = (s: string) => spec(list(issues(), [{ type: "badge", value: { field: "column" }, map: { [s]: { label: "x", tone: "info" } } }]));
    expectOk(key("k".repeat(LIMITS.literalLength)));
    expect(limits(key("k".repeat(LIMITS.literalLength + 1)))).toEqual(["literalLength"]);
  });

  test("Σ limit over lists and tables, defaults included", () => {
    const rows = (...ls: number[]) => spec(stack(ls.map(limit => list(issues({ limit })))));
    expectOk(rows(200, 200, 100));
    expect(limits(rows(200, 200, 101))).toEqual(["rows"]);
    // A list or table with no limit counts the default, 50; a count counts nothing.
    const defaults = (n: number) => spec(stack([
      stack(Array.from({ length: Math.min(n, 10) }, () => list())),
      stack([...Array.from({ length: n - Math.min(n, 10) }, () => list()), count(), count()]),
    ]));
    expectOk(defaults(LIMITS.rows / LIMITS.limitDefault));
    expect(limits(defaults(LIMITS.rows / LIMITS.limitDefault + 1))).toEqual(["rows"]);
  });

  test("Σ limit × width over lists and tables", () => {
    const col = { header: "T", field: "title" };
    const leaf = { type: "text", text: "a" };
    const cells = (listLimit: number) => spec(stack([
      table(issues({ limit: 200 }), times(8, col)),
      list(issues({ limit: listLimit }), times(4, leaf)),
    ]));
    expectOk(cells(100));
    expect(limits(cells(101))).toEqual(["cells"]);
  });

  test("requirement names: at most 64 characters of letters, digits, - and _", () => {
    const named = (name: string) => spec({ type: "field", value: { requirement: name, field: "project.name" } }, { requirements: [name] });
    expectOk(named("a".repeat(LIMITS.nameLength)));
    expectOk(named("A-b_9"));
    expect(codes(named("a".repeat(LIMITS.nameLength + 1)))).toEqual(["value", "unknownRequirement"]);
    expect(codes(named("-a"))).toEqual(["value", "unknownRequirement"]);
    expect(codes(named("a b"))).toEqual(["value", "unknownRequirement"]);
  });
});

describe("parseBoundViewSpec: requirements", () => {
  test("are unique", () => {
    expect(problems(parse(spec(text(), { requirements: ["board", "board"] }))))
      .toEqual([{ code: "duplicateRequirement", path: "$.requirements[1]" }]);
  });

  test("match exactly and case-sensitively, from queries and project refs", () => {
    expect(problems(parse(spec(list(issues({ requirement: "Board" }))))))
      .toEqual([{ code: "unknownRequirement", path: "$.root.of.requirement" }]);
    expect(codes(spec(count(issues({ requirement: "board " }))))).toEqual(["unknownRequirement"]);
    expect(codes(spec(table(issues({ requirement: "other" }))))).toEqual(["unknownRequirement"]);
    expect(codes(spec({ type: "field", value: { requirement: "BOARD", field: "project.name" } }))).toEqual(["unknownRequirement"]);
    expect(codes(spec(list(issues({ requirement: 1 }))))).toEqual(["type"]);
  });

  test("may be declared without being read", () => {
    expectOk(spec(text(), { requirements: ["board", "spare"] }));
  });
});

describe("parseBoundViewSpec: nesting", () => {
  test.each([
    ["list", list()], ["table", table()], ["count", count()], ["stack", stack([count()])],
    ["columns", { type: "columns", children: [count(), count()] }],
  ])("refuses a %s node inside a list item", (_name, inner) => {
    expect(problems(parse(spec(list(issues(), [inner])))))
      .toEqual([{ code: "nestedCollection", path: "$.root.item[0]" }]);
  });

  test("refuses a node inside a table column, which takes no type", () => {
    expect(codes(spec(table(issues(), [{ header: "Sub", field: "title", type: "list", of: issues() }])))).toEqual(["unknownKey", "unknownKey"]);
  });

  test("refuses an unknown node or item type", () => {
    expect(problems(parse(spec({ type: "chart", text: "x" })))).toEqual([{ code: "value", path: "$.root.type" }]);
    expect(codes(spec({ text: "x" }))).toEqual(["missingKey"]);
    expect(codes(spec(list(issues(), [{ type: "empty", text: "x" }])))).toEqual(["value"]);
    expect(codes(spec(list(issues(), ["title"])))).toEqual(["type"]);
  });
});

describe("parseBoundViewSpec: fields and literals", () => {
  test("names only the query's collection's fields per row, and project fields only in a ProjectRef", () => {
    expect(codes(spec(list(columns(), [{ type: "field", value: { field: "title" } }])))).toEqual(["field"]);
    expect(codes(spec(list(issues({ where: [{ field: "project.name", equals: "x" }] }))))).toEqual(["field"]);
    expect(codes(spec(list(issues({ sort: [{ field: "project.identifier", dir: "asc" }] }))))).toEqual(["field"]);
    expect(codes(spec({ type: "field", value: { requirement: "board", field: "title" } }))).toEqual(["field"]);
    expectOk(spec(list(columns({ sort: [{ field: "count", dir: "desc" }] }), [{ type: "field", value: { field: "count" } }])));
  });

  test("groups only by low-cardinality fields", () => {
    for (const field of ["column", "group", "priority", "blocked", "targetDate"]) {
      expectOk(spec(list(issues(), undefined, { groupBy: field })));
    }
    expect(codes(spec(list(issues(), undefined, { groupBy: "title" })))).toEqual(["field"]);
    expect(codes(spec(list(issues(), undefined, { groupBy: "identifier" })))).toEqual(["field"]);
    expect(codes(spec(list(columns(), [{ type: "text", text: "a" }], { groupBy: "label" })))).toEqual(["field"]);
    expectOk(spec(list(columns(), [{ type: "text", text: "a" }], { groupBy: "group" })));
  });

  test.each<[string, string, unknown, BoundViewProblemCode[]]>([
    ["string field, string", "title", "Fix it", []],
    ["string field, number", "title", 1, ["literalType"]],
    ["string field, null", "identifier", null, ["literalType"]],
    ["enum field, member", "priority", "urgent", []],
    ["enum field, non-member", "priority", "Urgent", ["value"]],
    ["enum field, boolean", "group", true, ["literalType"]],
    ["boolean field, boolean", "blocked", false, []],
    ["boolean field, string", "blocked", "true", ["literalType"]],
    ["boolean field, null", "blocked", null, ["literalType"]],
    ["date field, date", "targetDate", "2026-02-28", []],
    ["date field, null", "targetDate", null, []],
    ["date field, malformed", "targetDate", "2026-13-01", ["value"]],
    ["date field, number", "targetDate", 20261009, ["number"]],
    ["object literal", "title", { a: 1 }, ["type"]],
    ["array literal", "title", ["a"], ["type"]],
  ])("types an issues where literal: %s", (_name, field, equals, expected) => {
    expect(codes(spec(list(issues({ where: [{ field, equals }] }))))).toEqual(expected);
  });

  test("types a columns where literal", () => {
    expectOk(spec(count(columns({ where: [{ field: "count", equals: 0 }, { field: "label", equals: "Done" }] }))));
    expect(codes(spec(count(columns({ where: [{ field: "count", equals: "0" }] }))))).toEqual(["literalType"]);
  });

  test("fits a column's as to its field, and its map to as: badge", () => {
    expect(codes(spec(table(issues(), [{ header: "D", field: "title", as: "date" }])))).toEqual(["fieldType"]);
    expect(codes(spec(table(issues(), [{ header: "F", field: "priority", as: "flag" }])))).toEqual(["fieldType"]);
    expect(codes(spec(table(issues(), [{ header: "F", field: "blocked", as: "chip" }])))).toEqual(["value"]);
    expect(codes(spec(table(issues(), [{ header: "P", field: "priority", map: { high: { label: "H", tone: "info" } } }]))))
      .toEqual(["mapWithoutBadge"]);
    expect(codes(spec(table(issues(), [{ header: "P", field: "priority", as: "text", map: {} }])))).toEqual(["mapWithoutBadge"]);
  });

  test("the field table is the contract's, with derived fields marked", () => {
    expect(Object.keys(BOUND_VIEW_FIELDS.issues)).toEqual(["identifier", "title", "priority", "targetDate", "blocked", "column", "group"]);
    expect(Object.keys(BOUND_VIEW_FIELDS.columns)).toEqual(["label", "group", "count"]);
    expect(Object.keys(BOUND_VIEW_FIELDS.project)).toEqual(["project.identifier", "project.name"]);
    const derived = (fields: Record<string, { derived: boolean }>) =>
      Object.entries(fields).filter(([, type]) => type.derived).map(([name]) => name);
    expect(derived(BOUND_VIEW_FIELDS.issues)).toEqual(["column", "group"]);
    expect(derived(BOUND_VIEW_FIELDS.columns)).toEqual(["count"]);
    expect(derived(BOUND_VIEW_FIELDS.project)).toEqual([]);
    expect(BOUND_VIEW_FIELDS.issues.priority.members).toEqual(["urgent", "high", "medium", "low", "none"]);
    expect(BOUND_VIEW_FIELDS.columns.group.members).toEqual(["backlog", "unstarted", "started", "completed", "cancelled"]);
  });
});

describe("parseBoundViewSpec: badge keys, parsed per field", () => {
  const badge = (field: string, key: string) =>
    codes(spec(list(issues(), [{ type: "badge", value: { field }, map: { [key]: { label: "x", tone: "info" } } }])));
  const columnBadge = (key: string) =>
    codes(spec(list(columns(), [{ type: "badge", value: { field: "count" }, map: { [key]: { label: "x", tone: "info" } } }])));

  test.each([
    ["blocked", "true"], ["blocked", "false"], ["priority", "urgent"], ["priority", "none"], ["group", "cancelled"],
    ["targetDate", "null"], ["targetDate", "2026-10-09"], ["column", "In progress"], ["column", "Null"], ["title", ""],
  ])("accepts %s key %j", (field, key) => {
    expect(badge(field, key)).toEqual([]);
  });

  test.each([
    ["blocked", "True"], ["blocked", "1"], ["blocked", "null"], ["priority", "Urgent"], ["priority", "null"],
    ["priority", "toString"], ["group", "done"], ["targetDate", "2026-1-9"], ["targetDate", "None"],
    ["column", "null"], ["title", "null"],
  ])("refuses %s key %j", (field, key) => {
    expect(badge(field, key)).toEqual(["badgeKey"]);
  });

  test("integer keys are canonical decimals at most 10000", () => {
    for (const key of ["0", "7", "10000"]) expect(columnBadge(key)).toEqual([]);
    for (const key of ["01", "1.0", "10001", "-1", "1e1", " 1", "null"]) expect(columnBadge(key)).toEqual(["badgeKey"]);
  });

  test("entries are a Text label and a tone", () => {
    expect(codes(spec(list(issues(), [{ type: "badge", value: { field: "blocked" }, map: { true: { label: "B", tone: "red" } } }]))))
      .toEqual(["value"]);
    expect(codes(spec(list(issues(), [{ type: "badge", value: { field: "blocked" }, map: { true: { label: "B" } } }]))))
      .toEqual(["missingKey"]);
    expect(codes(spec(list(issues(), [{ type: "badge", value: { field: "blocked" }, map: [] }])))).toEqual(["type"]);
  });
});

describe("parseBoundViewSpec: authored text", () => {
  const BIDI = ["؜", "‎", "‏", "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"];

  test.each(BIDI.map(c => [`U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`, c]))(
    "refuses %s in Text, string literals and string badge keys", (_name, c) => {
      expect(problems(parse(spec(text(), { title: `a${c}b` })))).toEqual([{ code: "bidi", path: "$.title" }]);
      expect(codes(spec(text({ text: c })))).toEqual(["bidi"]);
      expect(codes(spec(list(issues({ where: [{ field: "title", equals: `x${c}` }] }))))).toEqual(["bidi"]);
      expect(codes(spec(list(issues(), [{ type: "badge", value: { field: "column" }, map: { [`k${c}`]: { label: "x", tone: "info" } } }]))))
        .toEqual(["bidi"]);
      expect(codes(spec(table(issues(), [{ header: c, field: "title" }])))).toEqual(["bidi"]);
    });

  test("refuses bidi controls written as escapes", () => {
    const raw = JSON.stringify(spec()).replace('"title":"Board"', '"title":"Board\\u202e"');
    expect(codesOf(raw)).toEqual(["bidi"]);
  });

  test("accepts other format characters, such as a zero-width joiner", () => {
    expectOk(spec(text({ text: "a‍b" }), { title: "\u{1F468}‍\u{1F469}" }));
  });

  test("refuses a lone surrogate", () => {
    const raw = JSON.stringify(spec()).replace('"title":"Board"', '"title":"\\ud800"');
    expect(codesOf(raw)).toEqual(["unpairedSurrogate"]);
  });
});

describe("parseBoundViewSpec: problems", () => {
  test("accumulate, with paths that quote no authored value", () => {
    const result = parse(spec(stack([
      { type: "text", text: "" },
      list(issues({ requirement: "nope", where: [{ field: "priority", equals: "Secret value" }] }), [list()]),
    ]), { version: 3 }));
    expect(problems(result)).toEqual([
      { code: "value", path: "$.version" },
      { code: "limit", path: "$.root.children[0].text", limit: "textLengthMin" },
      { code: "unknownRequirement", path: "$.root.children[1].of.requirement" },
      { code: "value", path: "$.root.children[1].of.where[0].equals" },
      { code: "nestedCollection", path: "$.root.children[1].item[0]" },
    ]);
    expect(JSON.stringify(result)).not.toContain("Secret");
  });

  test("are capped, so a hostile spec cannot make the report large", () => {
    const root = stack(Array.from({ length: 12 }, () => stack(Array.from({ length: 12 }, () => ({ type: "text", text: "" })))));
    const found = problems(parse(spec(root)));
    expect(found.length).toBe(32);
  });

  test("format as one line naming the first five", () => {
    expect(formatBoundViewProblems([{ code: "missingKey", path: "$.root" }, { code: "limit", path: "$", limit: "nodes" }]))
      .toBe("missingKey at $.root; limit (nodes) at $");
    const many = Array.from({ length: 7 }, () => ({ code: "type" as const, path: "$" }));
    expect(formatBoundViewProblems(many)).toMatch(/; and 2 more$/);
  });
});

// A small seeded PRNG (mulberry32), so a failure reproduces.
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("parseBoundViewSpec: fuzz", () => {
  const CODES = new Set<BoundViewProblemCode>([
    "size", "bom", "syntax", "duplicateKey", "forbiddenKey", "number", "unknownKey", "missingKey", "type",
    "value", "limit", "bidi", "unpairedSurrogate", "nestedCollection", "duplicateRequirement",
    "unknownRequirement", "field", "fieldType", "mapWithoutBadge", "literalType", "badgeKey",
  ]);
  const TOKENS = ['{', '}', '[', ']', ',', ':', '"', '\\', 'u', '0', '1', '9', '-', '.', 'e', ' ', 'true', 'null',
    '"type"', '"list"', '"__proto__"', '"\\u0061"', '‮', '\ud800', '﻿', 'é', '"root"', '"of"', '10001'];
  const VALID = JSON.stringify(spec(stack([
    count(issues({ where: [{ field: "blocked", equals: true }] })),
    list(issues({ sort: [{ field: "priority", dir: "asc" }], limit: 10 }),
        [{ type: "badge", value: { field: "priority" }, map: { high: { label: "H", tone: "warning" } } }], { groupBy: "group" }),
    table(columns(), [{ header: "Label", field: "label" }, { header: "N", field: "count" }]),
    { type: "field", label: "Project", value: { requirement: "board", field: "project.name" } },
  ])));

  // Total: never throws; a refusal has 1..32 known problems with spec paths; an acceptance is valid
  // JSON that round-trips to the same tree.
  const check = (raw: string) => {
    const result = parseBoundViewSpec(raw);
    if (result.ok) {
      expect(JSON.parse(raw)).toEqual(JSON.parse(JSON.stringify(result.spec)));
      return true;
    }
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.length).toBeLessThanOrEqual(32);
    for (const problem of result.problems) {
      expect(CODES.has(problem.code)).toBe(true);
      expect(problem.path.startsWith("$")).toBe(true);
    }
    return false;
  };

  test("random token strings never throw and are never wrongly accepted", () => {
    const random = rng(0xb0bd);
    for (let i = 0; i < 3000; i++) {
      const length = Math.floor(random() * 40);
      const raw = Array.from({ length }, () => TOKENS[Math.floor(random() * TOKENS.length)]).join("");
      let json = true;
      try { JSON.parse(raw); } catch { json = false; }
      const accepted = check(raw);
      if (!json) expect(accepted).toBe(false);
    }
  });

  test("mutated valid specs stay total, and anything accepted is JSON", () => {
    const random = rng(0x5eed);
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      let raw = VALID;
      const edits = 1 + Math.floor(random() * 3);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(random() * raw.length);
        const token = TOKENS[Math.floor(random() * TOKENS.length)]!;
        const op = random();
        raw = op < 0.33 ? raw.slice(0, at) + token + raw.slice(at)
          : op < 0.66 ? raw.slice(0, at) + raw.slice(at + 1 + Math.floor(random() * 4))
          : raw.slice(0, at) + token + raw.slice(at + token.length);
      }
      let json = true;
      try { JSON.parse(raw); } catch { json = false; }
      const ok = check(raw);
      if (!json) expect(ok).toBe(false);
      if (ok) accepted++;
    }
    expect(accepted).toBeLessThan(4000);
  });

  test("structurally mutated valid specs stay total", () => {
    const random = rng(0xface);
    const values: unknown[] = [null, true, 0, 10000, "", "x", "issues", "columns", "board", [], {}, [1], { type: "list" },
      "__proto__", "‮", "a".repeat(201)];
    const paths = (value: unknown, prefix: (string | number)[] = []): (string | number)[][] =>
      typeof value === "object" && value !== null
        ? [prefix, ...Object.entries(value).flatMap(([k, v]) => paths(v, [...prefix, Array.isArray(value) ? Number(k) : k]))]
        : [prefix];
    const base = JSON.parse(VALID) as unknown;
    const all = paths(base).filter(path => path.length > 0);
    for (let i = 0; i < 3000; i++) {
      const tree = JSON.parse(VALID) as Record<string | number, unknown>;
      const path = all[Math.floor(random() * all.length)]!;
      let holder: Record<string | number, unknown> = tree;
      for (const step of path.slice(0, -1)) holder = holder[step] as Record<string | number, unknown>;
      const last = path[path.length - 1]!;
      const op = random();
      if (op < 0.2 && !Array.isArray(holder)) delete holder[last];
      else if (op < 0.3 && !Array.isArray(holder)) holder[`k${Math.floor(random() * 3)}`] = values[0];
      else holder[last] = values[Math.floor(random() * values.length)];
      check(JSON.stringify(tree));
    }
  });
});
