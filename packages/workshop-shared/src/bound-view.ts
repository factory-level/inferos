import { HOST_BOARD_SNAPSHOT_LIMITS } from "./operate-console.js";

// A bound view: a widget's `view.json`, a declarative spec of what trusted host code renders from
// each operator's own host-board reads. It holds no code. This module is the frozen v1 grammar and
// its pure, static validator: it never sees a DTO and evaluates nothing. Tightening it needs
// `version: 2`, so a published v1 spec is never reclassified.

/** The file in a view-only widget's commit that holds its bound view. */
export const BOUND_VIEW_FILE = "view.json";

/**
 * The static limits a bound view is checked against when it is parsed. Byte sizes are UTF-8 bytes;
 * every other length is in UTF-16 code units.
 */
export const BOUND_VIEW_LIMITS = {
  /** The raw `view.json`, in UTF-8 bytes (8 KiB). */
  specBytes: 8192,
  /** Node nesting: the root is at depth 1. */
  depth: 8,
  /** Nodes in the whole spec. List items and table columns are not nodes. */
  nodes: 64,
  /** Children of one `stack`. */
  children: 12,
  /** Fewest children of a `columns` node. */
  columnsChildrenMin: 2,
  /** Most children of a `columns` node. */
  columnsChildrenMax: 4,
  /** Fewest requirements a spec names. */
  requirementsMin: 1,
  /** Most requirements a spec names. */
  requirements: 4,
  /** Longest requirement name; names match host-board requirement names. */
  nameLength: 64,
  /** `list`, `table` and `count` nodes in the whole spec. */
  queries: 16,
  /** `where` clauses in one query; they are ANDed. */
  where: 4,
  /** `sort` keys in one query. */
  sort: 2,
  /** Fewest columns in a table. */
  tableColumnsMin: 1,
  /** Most columns in a table. */
  tableColumns: 8,
  /** Fewest leaves in a list item. */
  itemLeavesMin: 1,
  /** Most leaves in a list item. */
  itemLeaves: 4,
  /** Entries in one badge map. */
  badgeEntries: 8,
  /** Shortest `Text`. */
  textLengthMin: 1,
  /** Longest `Text`. */
  textLength: 200,
  /** Longest string `Literal` (and string badge key). */
  literalLength: 100,
  /** Largest integer literal; integers are 0 or more, written `0|[1-9][0-9]*`. */
  integer: 10000,
  /** Smallest `limit` a query may give. */
  limitMin: 1,
  /** Largest `limit` a query may give. */
  limitMax: 200,
  /** The `limit` of a `list` or `table` query that gives none. */
  limitDefault: 50,
  /** Σ `limit` over every `list` and `table`, defaults included. */
  rows: 500,
  /** Σ `limit` × (table columns, or list item leaves). */
  cells: 2000,
} as const;

/** The name of one of `BOUND_VIEW_LIMITS`, as a problem reports which limit failed. */
export type BoundViewLimit = keyof typeof BOUND_VIEW_LIMITS;

/** A board column's workflow group, in its declared (sort) order. */
const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
/** An issue's priority, in its declared (sort) order. */
const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;

/**
 * The type of one field a bound view can name:
 * - `string`: at most `maxLength` code units, compared and sorted by code unit;
 * - `enum`: one of `members`, sorted in their listed order;
 * - `boolean`: `false` sorts before `true`;
 * - `date`: `yyyy-mm-dd` or null, sorted lexically;
 * - `integer`: `min`..`max`, sorted numerically.
 *
 * `nullable` fields may be null; nulls sort last in both directions. A `derived` field is computed
 * by the evaluator from the snapshot's structure, not read from a DTO property.
 */
export type BoundViewFieldType =
  | { type: "string"; maxLength: number; nullable: false; derived: boolean }
  | { type: "enum"; members: readonly string[]; nullable: false; derived: boolean }
  | { type: "boolean"; nullable: false; derived: boolean }
  | { type: "date"; nullable: true; derived: boolean }
  | { type: "integer"; min: number; max: number; nullable: false; derived: boolean };

/**
 * The closed field tables of a host-board snapshot (`HostBoardViewSnapshot`), by collection.
 * `project` holds the per-requirement fields only a `ProjectRef` can name: they cannot be filtered,
 * sorted, grouped or shown per row. Look fields up with `Object.hasOwn`, since names are authored.
 */
export const BOUND_VIEW_FIELDS = {
  issues: {
    identifier: { type: "string", maxLength: HOST_BOARD_SNAPSHOT_LIMITS.issueIdentifier, nullable: false, derived: false },
    title: { type: "string", maxLength: HOST_BOARD_SNAPSHOT_LIMITS.issueTitle, nullable: false, derived: false },
    priority: { type: "enum", members: PRIORITIES, nullable: false, derived: false },
    targetDate: { type: "date", nullable: true, derived: false },
    blocked: { type: "boolean", nullable: false, derived: false },
    /** The containing column's `label`. */
    column: { type: "string", maxLength: HOST_BOARD_SNAPSHOT_LIMITS.columnLabel, nullable: false, derived: true },
    /** The containing column's `group`. */
    group: { type: "enum", members: GROUPS, nullable: false, derived: true },
  },
  columns: {
    label: { type: "string", maxLength: HOST_BOARD_SNAPSHOT_LIMITS.columnLabel, nullable: false, derived: false },
    group: { type: "enum", members: GROUPS, nullable: false, derived: false },
    /** The column's `issues.length`. */
    count: { type: "integer", min: 0, max: HOST_BOARD_SNAPSHOT_LIMITS.issuesPerColumn, nullable: false, derived: true },
  },
  project: {
    "project.identifier": { type: "string", maxLength: HOST_BOARD_SNAPSHOT_LIMITS.projectIdentifier, nullable: false, derived: false },
    "project.name": { type: "string", maxLength: HOST_BOARD_SNAPSHOT_LIMITS.projectName, nullable: false, derived: false },
  },
} as const satisfies Record<string, Record<string, BoundViewFieldType>>;

/** The fields a group-by may name, per collection: low-cardinality ones only. */
const GROUP_FIELDS: Record<BoundViewCollection, readonly string[]> = {
  issues: ["column", "group", "priority", "blocked", "targetDate"],
  columns: ["group"],
};

/** A collection a query reads from one requirement's snapshot. */
export type BoundViewCollection = "issues" | "columns";
/** A field of the `issues` collection. */
export type BoundViewIssueField = keyof typeof BOUND_VIEW_FIELDS.issues;
/** A field of the `columns` collection. */
export type BoundViewColumnField = keyof typeof BOUND_VIEW_FIELDS.columns;
/** A per-row field: one of the query's collection's fields (checked at parse). */
export type BoundViewField = BoundViewIssueField | BoundViewColumnField;
/** A field a `groupBy` may name: for `issues` any of these, for `columns` only `group`. */
export type BoundViewGroupField = "column" | "group" | "priority" | "blocked" | "targetDate";
/** A badge's tone. */
export type BoundViewTone = "neutral" | "info" | "success" | "warning" | "danger";
/** A `where` literal, typed by its field. A number is an integer 0..10000. */
export type BoundViewLiteral = string | boolean | null | number;

/**
 * A badge's label and tone for each value of a field, keyed by the value's canonical string: an enum
 * member, `"true"`/`"false"`, a canonical decimal, the exact string, or `"null"` for a nullable
 * field. A null-prototype map: look keys up with `Object.hasOwn`.
 */
export type BoundViewBadgeMap = Record<string, { label: string; tone: BoundViewTone }>;

/** One `AND`ed equality filter. */
export type BoundViewWhere = { field: BoundViewField; equals: BoundViewLiteral };

/** What a `count` counts: every matching row, before any limit. */
export type BoundViewCountQuery = {
  /** The requirement whose snapshot is read. */
  requirement: string;
  /** The rows counted. */
  collection: BoundViewCollection;
  /** Filters, all of which must match. */
  where?: BoundViewWhere[];
};

/** What a `list` or `table` shows: filter, then stable sort, then limit, then group. */
export type BoundViewQuery = BoundViewCountQuery & {
  /** Sort keys, most significant first; ties keep snapshot order. */
  sort?: { field: BoundViewField; dir: "asc" | "desc" }[];
  /** Rows kept after sorting, `limitMin`..`limitMax`; `limitDefault` when absent. */
  limit?: number;
};

/** A per-requirement project field. */
export type BoundViewProjectRef = {
  /** The requirement whose snapshot is read. */
  requirement: string;
  /** Which project field. */
  field: "project.identifier" | "project.name";
};

/** A field of the current row. */
export type BoundViewRowRef = { field: BoundViewField };

/** One leaf of a list item. Leaves never hold nodes, so query work never multiplies with depth. */
export type BoundViewItem =
  | { type: "field"; label?: string; value: BoundViewRowRef }
  | { type: "badge"; value: BoundViewRowRef; map?: BoundViewBadgeMap }
  | { type: "text"; text: string; tone?: "default" | "muted" };

/** One table column. `as: "date"` needs a date field, `"flag"` a boolean, and `map` needs `"badge"`. */
export type BoundViewColumn = {
  header: string;
  field: BoundViewField;
  as?: "text" | "badge" | "date" | "flag";
  map?: BoundViewBadgeMap;
};

/**
 * One node of a bound view. `stack` and `columns` hold nodes; `list`, `table` and `count` are
 * queries and may appear only outside any row scope.
 */
export type BoundViewNode =
  | { type: "stack"; gap?: "sm" | "md"; children: BoundViewNode[] }
  | { type: "columns"; children: BoundViewNode[] }
  | { type: "text"; text: string; tone?: "default" | "muted"; size?: "sm" | "md" | "lg" }
  | { type: "field"; label?: string; value: BoundViewProjectRef }
  | { type: "count"; label: string; of: BoundViewCountQuery }
  | { type: "list"; of: BoundViewQuery; groupBy?: BoundViewGroupField; item: BoundViewItem[]; empty: string }
  | { type: "table"; of: BoundViewQuery; columns: BoundViewColumn[]; empty: string }
  | { type: "empty"; text: string };

/**
 * A parsed v1 bound view. Every authored string is a `Text` (1..200 code units) or a string literal
 * (at most 100), well-formed UTF-16 with no bidi controls. Objects have null prototypes.
 */
export type BoundViewSpec = {
  version: 1;
  /** The view's title. */
  title: string;
  /** The host-board requirement names the view reads, unique and exact. */
  requirements: string[];
  /** The view's root node, at depth 1. */
  root: BoundViewNode;
};

/**
 * Why a bound view does not parse:
 * - `size`: over `specBytes`; `bom`: a leading byte order mark; `syntax`: not JSON;
 * - `duplicateKey` / `forbiddenKey`: a key repeated in one object, or `__proto__`, `constructor`
 *   or `prototype`, compared after unescaping;
 * - `number`: a number that is not `0|[1-9][0-9]*` or is over `integer`;
 * - `unknownKey` / `missingKey` / `type` / `value`: the closed schema;
 * - `limit`: a static limit, named by the problem's `limit`;
 * - `bidi` / `unpairedSurrogate`: authored text with a bidi control or a lone surrogate;
 * - `nestedCollection`: a query or container where only a leaf may be;
 * - `duplicateRequirement` / `unknownRequirement`: a repeated name, or one the spec does not
 *   declare (names match exactly, case-sensitively);
 * - `field`: a field the collection or position does not offer; `fieldType`: a column's `as`
 *   that does not fit its field; `mapWithoutBadge`: a column `map` without `as: "badge"`;
 * - `literalType`: a `where` literal of another type than its field; `badgeKey`: a badge-map key
 *   that is not the canonical string of a value of the mapped field.
 */
export type BoundViewProblemCode =
  | "size" | "bom" | "syntax" | "duplicateKey" | "forbiddenKey" | "number"
  | "unknownKey" | "missingKey" | "type" | "value" | "limit" | "bidi" | "unpairedSurrogate"
  | "nestedCollection" | "duplicateRequirement" | "unknownRequirement" | "field" | "fieldType"
  | "mapWithoutBadge" | "literalType" | "badgeKey";

/**
 * One reason a bound view does not parse: a code and the spec path it applies to, such as
 * `$.root.children[2].of.where[0].equals`. A path never quotes an authored value; a key that is not
 * a plain identifier is shown as `[?]`.
 */
export type BoundViewProblem = {
  /** What failed. */
  code: BoundViewProblemCode;
  /** Where in the spec. */
  path: string;
  /** For `limit`, which of `BOUND_VIEW_LIMITS` failed. */
  limit?: BoundViewLimit;
};

/** `parseBoundViewSpec`'s result: the spec, or the problems (at most `MAX_PROBLEMS`). */
export type BoundViewParseResult =
  | { ok: true; spec: BoundViewSpec }
  | { ok: false; problems: BoundViewProblem[] };

// Problems kept per parse, so a hostile spec cannot make the report large.
const MAX_PROBLEMS = 32;
// JSON nesting the tokenizer allows. The deepest legal spec nests 20 levels: a node at depth 8 is
// at level 16, and a badge entry inside one of its list items at level 20.
const MAX_JSON_DEPTH = 24;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const DATE = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const TONES = ["neutral", "info", "success", "warning", "danger"];
const ESCAPES = new Map([['"', '"'], ["\\", "\\"], ["/", "/"], ["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"], ["t", "\t"]]);

const keyPath = (path: string, key: string) => IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[?]`;

// UTF-8 length of `text`, stopping once it passes `limit`. A lone surrogate counts as the three
// bytes of the U+FFFD it would be encoded as.
function utf8BytesOver(text: string, limit: number): boolean {
  let bytes = 0;
  for (let i = 0; i < text.length && bytes <= limit; i++) {
    let unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length &&
        (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes > limit;
}

// The tokenizer pass, run before JSON.parse: full JSON syntax, keys compared after unescaping
// (duplicates and forbidden names refused), every number lexeme `0|[1-9][0-9]*` and at most
// `integer`, and nesting bounded. A syntax error ends the scan; other problems accumulate.
class Tokenizer {
  #i = 0;
  readonly problems: BoundViewProblem[] = [];
  constructor(readonly text: string) {}

  #problem(code: BoundViewProblemCode, path: string, limit?: BoundViewLimit) {
    if (this.problems.length < MAX_PROBLEMS) {
      this.problems.push(limit === undefined ? { code, path } : { code, path, limit });
    }
  }

  #space() {
    let s = this.text;
    while (this.#i < s.length) {
      let c = s.charCodeAt(this.#i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      this.#i++;
    }
  }

  /** Scans the whole text; false on a syntax error. */
  scan(): boolean {
    this.#space();
    if (!this.#value("$", 1)) return false;
    this.#space();
    if (this.#i !== this.text.length) return this.#syntax("$");
    return true;
  }

  #syntax(path: string): false {
    this.#problem("syntax", path);
    return false;
  }

  #value(path: string, depth: number): boolean {
    let s = this.text;
    let c = s[this.#i];
    if (c === "{" || c === "[") {
      if (depth > MAX_JSON_DEPTH) {
        this.#problem("limit", path, "depth");
        return false;
      }
      return c === "{" ? this.#object(path, depth) : this.#array(path, depth);
    }
    if (c === '"') return this.#string(path) !== null;
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.#number(path);
    for (let word of ["true", "false", "null"]) {
      if (s.startsWith(word, this.#i)) {
        this.#i += word.length;
        return true;
      }
    }
    return this.#syntax(path);
  }

  #object(path: string, depth: number): boolean {
    let s = this.text;
    let keys = new Set<string>();
    this.#i++;
    this.#space();
    if (s[this.#i] === "}") {
      this.#i++;
      return true;
    }
    for (;;) {
      this.#space();
      if (s[this.#i] !== '"') return this.#syntax(path);
      let key = this.#string(path);
      if (key === null) return false;
      let at = keyPath(path, key);
      if (FORBIDDEN_KEYS.has(key)) this.#problem("forbiddenKey", at);
      else if (keys.has(key)) this.#problem("duplicateKey", at);
      keys.add(key);
      this.#space();
      if (s[this.#i] !== ":") return this.#syntax(at);
      this.#i++;
      this.#space();
      if (!this.#value(at, depth + 1)) return false;
      this.#space();
      if (s[this.#i] === ",") {
        this.#i++;
        continue;
      }
      if (s[this.#i] === "}") {
        this.#i++;
        return true;
      }
      return this.#syntax(path);
    }
  }

  #array(path: string, depth: number): boolean {
    let s = this.text;
    this.#i++;
    this.#space();
    if (s[this.#i] === "]") {
      this.#i++;
      return true;
    }
    for (let index = 0; ; index++) {
      this.#space();
      if (!this.#value(`${path}[${index}]`, depth + 1)) return false;
      this.#space();
      if (s[this.#i] === ",") {
        this.#i++;
        continue;
      }
      if (s[this.#i] === "]") {
        this.#i++;
        return true;
      }
      return this.#syntax(path);
    }
  }

  // A JSON string starting at the cursor, unescaped; null (after a syntax problem) if malformed.
  #string(path: string): string | null {
    let s = this.text;
    let out = "";
    this.#i++;
    while (this.#i < s.length) {
      let c = s[this.#i]!;
      let code = c.charCodeAt(0);
      if (c === '"') {
        this.#i++;
        return out;
      }
      if (code < 0x20) break;
      if (c !== "\\") {
        out += c;
        this.#i++;
        continue;
      }
      let next = s[this.#i + 1] ?? "";
      let escaped = ESCAPES.get(next);
      if (escaped !== undefined) {
        out += escaped;
        this.#i += 2;
      } else if (next === "u" &&/^[0-9A-Fa-f]{4}$/.test(s.slice(this.#i + 2, this.#i + 6))) {
        out += String.fromCharCode(parseInt(s.slice(this.#i + 2, this.#i + 6), 16));
        this.#i += 6;
      } else break;
    }
    this.#syntax(path);
    return null;
  }

  #number(path: string): boolean {
    let s = this.text;
    let start = this.#i;
    while (this.#i < s.length && /[0-9+\-.eE]/.test(s[this.#i]!)) this.#i++;
    let lexeme = s.slice(start, this.#i);
    if (!INTEGER.test(lexeme) || Number(lexeme) > BOUND_VIEW_LIMITS.integer) {
      this.#problem("number", path);
    }
    return true;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The closed-schema pass over the null-prototype tree, accumulating problems and the totals the
// static limits bound.
class Checker {
  readonly problems: BoundViewProblem[] = [];
  #requirements = new Set<string>();
  #nodes = 0;
  #queries = 0;
  #rows = 0;
  #cells = 0;

  problem(code: BoundViewProblemCode, path: string, limit?: BoundViewLimit) {
    if (this.problems.length < MAX_PROBLEMS) {
      this.problems.push(limit === undefined ? { code, path } : { code, path, limit });
    }
  }

  spec(value: Json) {
    let spec = this.#object(value, "$", ["version", "title", "requirements", "root"], []);
    if (spec === null) return;
    if (Object.hasOwn(spec, "version") && spec.version !== 1) this.problem("value", "$.version");
    if (Object.hasOwn(spec, "title")) this.#text(spec.title!, "$.title");
    if (Object.hasOwn(spec, "requirements")) this.#requirementNames(spec.requirements!);
    if (Object.hasOwn(spec, "root")) this.#node(spec.root!, "$.root", 1);
    if (this.#nodes > BOUND_VIEW_LIMITS.nodes) this.problem("limit", "$", "nodes");
    if (this.#queries > BOUND_VIEW_LIMITS.queries) this.problem("limit", "$", "queries");
    if (this.#rows > BOUND_VIEW_LIMITS.rows) this.problem("limit", "$", "rows");
    if (this.#cells > BOUND_VIEW_LIMITS.cells) this.problem("limit", "$", "cells");
  }

  // `value` as an object with exactly these keys: every required one and no others.
  #object(value: Json, path: string, required: string[], optional: string[]): JsonObject | null {
    if (!isObject(value)) {
      this.problem("type", path);
      return null;
    }
    for (let key of Object.keys(value)) {
      if (!required.includes(key) && !optional.includes(key)) this.problem("unknownKey", keyPath(path, key));
    }
    for (let key of required) {
      if (!Object.hasOwn(value, key)) this.problem("missingKey", keyPath(path, key));
    }
    return value;
  }

  // `value` as an array, or none (after a problem) when it is not one.
  #elements(value: Json | undefined, path: string): Json[] {
    if (Array.isArray(value)) return value;
    this.problem("type", path);
    return [];
  }

  // `value` as an array of `min`..`max` elements.
  #array(value: Json | undefined, path: string, min: BoundViewLimit, max: BoundViewLimit): Json[] {
    if (!Array.isArray(value)) return this.#elements(value, path);
    if (value.length < BOUND_VIEW_LIMITS[min]) this.problem("limit", path, min);
    if (value.length > BOUND_VIEW_LIMITS[max]) this.problem("limit", path, max);
    return value;
  }

  #oneOf(value: Json | undefined, path: string, members: readonly string[]) {
    if (typeof value !== "string") this.problem("type", path);
    else if (!members.includes(value)) this.problem("value", path);
  }

  // Authored text shared by `Text`, string literals and string badge keys.
  #authored(value: string, path: string) {
    if (!value.isWellFormed()) this.problem("unpairedSurrogate", path);
    if (BIDI.test(value)) this.problem("bidi", path);
  }

  #text(value: Json | undefined, path: string) {
    if (typeof value !== "string") return this.problem("type", path);
    if (value.length < BOUND_VIEW_LIMITS.textLengthMin) this.problem("limit", path, "textLengthMin");
    if (value.length > BOUND_VIEW_LIMITS.textLength) this.problem("limit", path, "textLength");
    this.#authored(value, path);
  }

  #requirementNames(value: Json) {
    let names = this.#array(value, "$.requirements", "requirementsMin", "requirements");
    names.forEach((name, index) => {
      let path = `$.requirements[${index}]`;
      if (typeof name !== "string") return this.problem("type", path);
      if (!NAME.test(name)) return this.problem("value", path);
      if (this.#requirements.has(name)) return this.problem("duplicateRequirement", path);
      this.#requirements.add(name);
    });
  }

  #requirement(value: Json | undefined, path: string) {
    if (typeof value !== "string") return this.problem("type", path);
    if (!this.#requirements.has(value)) this.problem("unknownRequirement", path);
  }

  #node(value: Json, path: string, depth: number) {
    this.#nodes++;
    if (depth > BOUND_VIEW_LIMITS.depth) return this.problem("limit", path, "depth");
    let type = isObject(value) ? value.type : undefined;
    let node: JsonObject | null;
    switch (type) {
      case "stack":
        if ((node = this.#object(value, path, ["type", "children"], ["gap"])) === null) return;
        if (Object.hasOwn(node, "gap")) this.#oneOf(node.gap, `${path}.gap`, ["sm", "md"]);
        if (Object.hasOwn(node, "children")) {
          // No minimum: an empty stack renders nothing.
          let children = this.#elements(node.children, `${path}.children`);
          if (children.length > BOUND_VIEW_LIMITS.children) this.problem("limit", `${path}.children`, "children");
          children.forEach((child, index) => this.#node(child, `${path}.children[${index}]`, depth + 1));
        }
        return;
      case "columns":
        if ((node = this.#object(value, path, ["type", "children"], [])) === null) return;
        if (Object.hasOwn(node, "children")) {
          this.#array(node.children, `${path}.children`, "columnsChildrenMin", "columnsChildrenMax")
            .forEach((child, index) => this.#node(child, `${path}.children[${index}]`, depth + 1));
        }
        return;
      case "text":
        if ((node = this.#object(value, path, ["type", "text"], ["tone", "size"])) === null) return;
        if (Object.hasOwn(node, "text")) this.#text(node.text, `${path}.text`);
        if (Object.hasOwn(node, "tone")) this.#oneOf(node.tone, `${path}.tone`, ["default", "muted"]);
        if (Object.hasOwn(node, "size")) this.#oneOf(node.size, `${path}.size`, ["sm", "md", "lg"]);
        return;
      case "field":
        if ((node = this.#object(value, path, ["type", "value"], ["label"])) === null) return;
        if (Object.hasOwn(node, "label")) this.#text(node.label, `${path}.label`);
        if (Object.hasOwn(node, "value")) this.#projectRef(node.value!, `${path}.value`);
        return;
      case "count":
        this.#queries++;
        if ((node = this.#object(value, path, ["type", "label", "of"], [])) === null) return;
        if (Object.hasOwn(node, "label")) this.#text(node.label, `${path}.label`);
        if (Object.hasOwn(node, "of")) this.#query(node.of!, `${path}.of`, false);
        return;
      case "list": {
        this.#queries++;
        if ((node = this.#object(value, path, ["type", "of", "item", "empty"], ["groupBy"])) === null) return;
        let query = Object.hasOwn(node, "of") ? this.#query(node.of!, `${path}.of`, true) : null;
        let collection = query?.collection ?? null;
        if (Object.hasOwn(node, "groupBy")) {
          if (typeof node.groupBy !== "string") this.problem("type", `${path}.groupBy`);
          else if (collection !== null && !GROUP_FIELDS[collection].includes(node.groupBy)) {
            this.problem("field", `${path}.groupBy`);
          }
        }
        let leaves = Object.hasOwn(node, "item")
          ? this.#array(node.item, `${path}.item`, "itemLeavesMin", "itemLeaves") : [];
        leaves.forEach((leaf, index) => this.#item(leaf, `${path}.item[${index}]`, collection));
        if (Object.hasOwn(node, "empty")) this.#text(node.empty, `${path}.empty`);
        this.#charge(query?.limit, leaves.length);
        return;
      }
      case "table": {
        this.#queries++;
        if ((node = this.#object(value, path, ["type", "of", "columns", "empty"], [])) === null) return;
        let query = Object.hasOwn(node, "of") ? this.#query(node.of!, `${path}.of`, true) : null;
        let columns = Object.hasOwn(node, "columns")
          ? this.#array(node.columns, `${path}.columns`, "tableColumnsMin", "tableColumns") : [];
        columns.forEach((column, index) =>
          this.#column(column, `${path}.columns[${index}]`, query?.collection ?? null));
        if (Object.hasOwn(node, "empty")) this.#text(node.empty, `${path}.empty`);
        this.#charge(query?.limit, columns.length);
        return;
      }
      case "empty":
        if ((node = this.#object(value, path, ["type", "text"], [])) === null) return;
        if (Object.hasOwn(node, "text")) this.#text(node.text, `${path}.text`);
        return;
      default:
        if (!isObject(value)) this.problem("type", path);
        else if (!Object.hasOwn(value, "type")) this.problem("missingKey", `${path}.type`);
        else this.problem("value", `${path}.type`);
    }
  }

  // Adds a list's or table's rows and cells to the spec's totals. A query whose limit did not
  // parse is charged nothing, since it is already refused.
  #charge(limit: number | null | undefined, width: number) {
    if (limit === null) return;
    let rows = limit ?? BOUND_VIEW_LIMITS.limitDefault;
    this.#rows += rows;
    this.#cells += rows * width;
  }

  // A query; returns its collection (null when not one) and limit (undefined when absent, null
  // when invalid).
  #query(value: Json, path: string, rows: boolean)
      : { collection: BoundViewCollection | null; limit: number | null | undefined } {
    let query = this.#object(value, path, ["requirement", "collection"],
        rows ? ["where", "sort", "limit"] : ["where"]);
    if (query === null) return { collection: null, limit: null };
    if (Object.hasOwn(query, "requirement")) this.#requirement(query.requirement, `${path}.requirement`);
    let collection: BoundViewCollection | null = null;
    if (Object.hasOwn(query, "collection")) {
      this.#oneOf(query.collection, `${path}.collection`, ["issues", "columns"]);
      if (query.collection === "issues" || query.collection === "columns") collection = query.collection;
    }
    if (Object.hasOwn(query, "where")) {
      let clauses = this.#elements(query.where, `${path}.where`);
      if (clauses.length > BOUND_VIEW_LIMITS.where) this.problem("limit", `${path}.where`, "where");
      clauses.forEach((clause, index) => this.#where(clause, `${path}.where[${index}]`, collection));
    }
    if (Object.hasOwn(query, "sort")) {
      let keys = this.#elements(query.sort, `${path}.sort`);
      if (keys.length > BOUND_VIEW_LIMITS.sort) this.problem("limit", `${path}.sort`, "sort");
      keys.forEach((key, index) => {
        let at = `${path}.sort[${index}]`;
        let sort = this.#object(key, at, ["field", "dir"], []);
        if (sort === null) return;
        if (Object.hasOwn(sort, "field")) this.#field(sort.field, `${at}.field`, collection);
        if (Object.hasOwn(sort, "dir")) this.#oneOf(sort.dir, `${at}.dir`, ["asc", "desc"]);
      });
    }
    let limit: number | null | undefined;
    if (Object.hasOwn(query, "limit")) {
      let given = query.limit;
      if (typeof given !== "number") {
        this.problem("type", `${path}.limit`);
        limit = null;
      } else if (given < BOUND_VIEW_LIMITS.limitMin || given > BOUND_VIEW_LIMITS.limitMax) {
        this.problem("limit", `${path}.limit`, given < BOUND_VIEW_LIMITS.limitMin ? "limitMin" : "limitMax");
        limit = null;
      } else limit = given;
    }
    return { collection, limit };
  }

  // A per-row field of `collection`; returns its type, or null (after a problem) when it is not
  // one. With an unknown collection nothing can be checked, and the collection is already refused.
  #field(value: Json | undefined, path: string, collection: BoundViewCollection | null): BoundViewFieldType | null {
    if (typeof value !== "string") {
      this.problem("type", path);
      return null;
    }
    if (collection === null) return null;
    let table: Record<string, BoundViewFieldType> = BOUND_VIEW_FIELDS[collection];
    if (!Object.hasOwn(table, value)) {
      this.problem("field", path);
      return null;
    }
    return table[value]!;
  }

  #where(value: Json, path: string, collection: BoundViewCollection | null) {
    let clause = this.#object(value, path, ["field", "equals"], []);
    if (clause === null) return;
    let type = Object.hasOwn(clause, "field") ? this.#field(clause.field, `${path}.field`, collection) : null;
    if (!Object.hasOwn(clause, "equals")) return;
    let literal = clause.equals!;
    let at = `${path}.equals`;
    if (typeof literal === "string") this.#literalString(literal, at);
    else if (typeof literal === "object" && literal !== null) return this.problem("type", at);
    if (type === null) return;
    if (literal === null) {
      if (!type.nullable) this.problem("literalType", at);
      return;
    }
    switch (type.type) {
      case "string":
        if (typeof literal !== "string") this.problem("literalType", at);
        return;
      case "enum":
        if (typeof literal !== "string") this.problem("literalType", at);
        else if (!type.members.includes(literal)) this.problem("value", at);
        return;
      case "boolean":
        if (typeof literal !== "boolean") this.problem("literalType", at);
        return;
      case "date":
        if (typeof literal !== "string") this.problem("literalType", at);
        else if (!DATE.test(literal)) this.problem("value", at);
        return;
      case "integer":
        // The tokenizer already held every number to an integer 0..10000.
        if (typeof literal !== "number") this.problem("literalType", at);
        return;
    }
  }

  #literalString(value: string, path: string) {
    if (value.length > BOUND_VIEW_LIMITS.literalLength) this.problem("limit", path, "literalLength");
    this.#authored(value, path);
  }

  #projectRef(value: Json, path: string) {
    let ref = this.#object(value, path, ["requirement", "field"], []);
    if (ref === null) return;
    if (Object.hasOwn(ref, "requirement")) this.#requirement(ref.requirement, `${path}.requirement`);
    if (Object.hasOwn(ref, "field")) {
      if (typeof ref.field !== "string") this.problem("type", `${path}.field`);
      else if (!Object.hasOwn(BOUND_VIEW_FIELDS.project, ref.field)) this.problem("field", `${path}.field`);
    }
  }

  #rowRef(value: Json | undefined, path: string, collection: BoundViewCollection | null): BoundViewFieldType | null {
    if (value === undefined) return null;
    let ref = this.#object(value, path, ["field"], []);
    if (ref === null || !Object.hasOwn(ref, "field")) return null;
    return this.#field(ref.field, `${path}.field`, collection);
  }

  #item(value: Json, path: string, collection: BoundViewCollection | null) {
    let type = isObject(value) ? value.type : undefined;
    let item: JsonObject | null;
    switch (type) {
      case "field":
        if ((item = this.#object(value, path, ["type", "value"], ["label"])) === null) return;
        if (Object.hasOwn(item, "label")) this.#text(item.label, `${path}.label`);
        this.#rowRef(item.value, `${path}.value`, collection);
        return;
      case "badge": {
        if ((item = this.#object(value, path, ["type", "value"], ["map"])) === null) return;
        let field = this.#rowRef(item.value, `${path}.value`, collection);
        if (Object.hasOwn(item, "map")) this.#badgeMap(item.map!, `${path}.map`, field);
        return;
      }
      case "text":
        if ((item = this.#object(value, path, ["type", "text"], ["tone"])) === null) return;
        if (Object.hasOwn(item, "text")) this.#text(item.text, `${path}.text`);
        if (Object.hasOwn(item, "tone")) this.#oneOf(item.tone, `${path}.tone`, ["default", "muted"]);
        return;
      case "list": case "table": case "count": case "stack": case "columns":
        // A query, or a container that could hold one, inside a row scope.
        return this.problem("nestedCollection", path);
      default:
        if (!isObject(value)) this.problem("type", path);
        else if (!Object.hasOwn(value, "type")) this.problem("missingKey", `${path}.type`);
        else this.problem("value", `${path}.type`);
    }
  }

  #column(value: Json, path: string, collection: BoundViewCollection | null) {
    let column = this.#object(value, path, ["header", "field"], ["as", "map"]);
    if (column === null) return;
    if (Object.hasOwn(column, "header")) this.#text(column.header, `${path}.header`);
    let field = Object.hasOwn(column, "field") ? this.#field(column.field, `${path}.field`, collection) : null;
    let as = column.as;
    if (Object.hasOwn(column, "as")) {
      this.#oneOf(as, `${path}.as`, ["text", "badge", "date", "flag"]);
      if (field !== null && ((as === "date" && field.type !== "date") || (as === "flag" && field.type !== "boolean"))) {
        this.problem("fieldType", `${path}.as`);
      }
    }
    if (Object.hasOwn(column, "map")) {
      if (as !== "badge") this.problem("mapWithoutBadge", `${path}.map`);
      else this.#badgeMap(column.map!, `${path}.map`, field);
    }
  }

  // A badge map: each key the canonical string of a value of `field` (unchecked when the field is
  // already refused), each entry a label and a tone.
  #badgeMap(value: Json, path: string, field: BoundViewFieldType | null) {
    if (!isObject(value)) return this.problem("type", path);
    let keys = Object.keys(value);
    if (keys.length > BOUND_VIEW_LIMITS.badgeEntries) this.problem("limit", path, "badgeEntries");
    for (let key of keys) {
      let at = keyPath(path, key);
      if (field !== null && !badgeKeyFits(key, field)) this.problem("badgeKey", at);
      if (field?.type === "string") this.#literalString(key, at);
      let entry = this.#object(value[key]!, at, ["label", "tone"], []);
      if (entry === null) continue;
      if (Object.hasOwn(entry, "label")) this.#text(entry.label, `${at}.label`);
      if (Object.hasOwn(entry, "tone")) this.#oneOf(entry.tone, `${at}.tone`, TONES);
    }
  }
}

// Whether `key` is the canonical string of a value of `field`. A string field's key is the exact
// string, except `"null"`: no string field is nullable, and v1 is frozen, so the key that would
// read as null is refused rather than taken as the four-letter string. Length and text rules are
// checked apart.
function badgeKeyFits(key: string, field: BoundViewFieldType): boolean {
  switch (field.type) {
    case "string": return key !== "null";
    case "enum": return field.members.includes(key);
    case "boolean": return key === "true" || key === "false";
    case "date": return key === "null" || DATE.test(key);
    case "integer": return INTEGER.test(key) && Number(key) <= BOUND_VIEW_LIMITS.integer;
  }
}

/**
 * Parses and validates a bound view's `view.json` text against the frozen v1 grammar and its static
 * limits (`BOUND_VIEW_LIMITS`). Total: it never throws, and reports every problem it finds (up to a
 * fixed number) as a code and a spec path. In order:
 * 1. the text is at most `specBytes` UTF-8 bytes and has no leading BOM (strict UTF-8 decoding is
 *    the caller's: `GitStore.readCommitBlob` with `"text"`);
 * 2. a tokenizer checks JSON syntax, refuses duplicate keys and `__proto__` / `constructor` /
 *    `prototype` after unescaping, and holds every number lexeme to `0|[1-9][0-9]*`, at most
 *    `integer`;
 * 3. `JSON.parse` builds the tree with null-prototype objects;
 * 4. a closed schema refuses unknown keys, checks types, fields, literals, badge keys, requirement
 *    names, authored text (no bidi controls or lone surrogates) and every static limit.
 *
 * It evaluates nothing: the returned spec is what the host evaluator runs over each snapshot.
 */
export function parseBoundViewSpec(text: string): BoundViewParseResult {
  if (utf8BytesOver(text, BOUND_VIEW_LIMITS.specBytes)) {
    return { ok: false, problems: [{ code: "size", path: "$", limit: "specBytes" }] };
  }
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, problems: [{ code: "bom", path: "$" }] };
  let tokenizer = new Tokenizer(text);
  if (!tokenizer.scan() || tokenizer.problems.length > 0) return { ok: false, problems: tokenizer.problems };
  let tree: Json;
  try {
    tree = JSON.parse(text, (_key, value: unknown) =>
      isObject(value) ? Object.assign(Object.create(null) as JsonObject, value) : value) as Json;
  } catch {
    // Unreachable after the tokenizer accepts; kept so the parser stays total.
    return { ok: false, problems: [{ code: "syntax", path: "$" }] };
  }
  let checker = new Checker();
  checker.spec(tree);
  if (checker.problems.length > 0) return { ok: false, problems: checker.problems };
  return { ok: true, spec: tree as unknown as BoundViewSpec };
}

/**
 * The problems as one line for a person or the agent, such as
 * `missingKey at $.root.of; limit (nodes) at $`, naming at most the first five.
 */
export function formatBoundViewProblems(problems: readonly BoundViewProblem[]): string {
  let shown = problems.slice(0, 5).map(({ code, path, limit }) =>
    `${code}${limit === undefined ? "" : ` (${limit})`} at ${path}`);
  if (problems.length > shown.length) shown.push(`and ${problems.length - shown.length} more`);
  return shown.join("; ");
}
