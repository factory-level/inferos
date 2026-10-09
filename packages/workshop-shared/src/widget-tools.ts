// A callable widget's tools: the `tools.json` its commit declares, and the checks on what crosses
// into and out of a tool call. Everything here is pure and uses no `eval`, so the kernel (at
// publish, and around each call) and the classifier agree. Inputs are limited to choices the
// builder wrote down (string enums, booleans and small-range integers), so authored code never
// receives free text from the operator's agent; outputs are bounded plain JSON.
//
// Every problem message here is kernel-written. A message may name a tool, property or schema
// path that `tools.json` declared (each matches a name pattern first), but it never quotes a value
// that crossed a call, because such values are authored or agent-chosen.

/** The file in a widget's commit, next to `server.js`, that declares its tools. */
export const WIDGET_TOOLS_FILE = "tools.json";

/**
 * The limits on `tools.json` and on the values a tool call carries. They are the default with no
 * owner exception: inputs never take free strings or `number`s.
 */
export const WIDGET_TOOL_LIMITS = Object.freeze({
  /** Most tools one `tools.json` declares. */
  tools: 8,
  /** Largest `tools.json`, in UTF-8 bytes. */
  fileBytes: 16 * 1024,
  /** Longest tool, method or property name. */
  nameLength: 48,
  /** Longest tool description, in characters (code points). */
  descriptionLength: 200,
  /** Most properties an input schema declares. */
  inputProperties: 8,
  /** Most values one input string `enum` lists. */
  enumValues: 64,
  /** Longest input `enum` value, in characters (code points). */
  enumValueLength: 64,
  /** Most values an input integer's range holds: `maximum - minimum + 1`, at most 10 bits. */
  integerValues: 1024,
  /** Largest serialized tool input, in UTF-8 bytes. */
  inputBytes: 512,
  /** Deepest nesting of objects and arrays in an output schema. */
  outputDepth: 3,
  /** Largest `maxItems` an output array may declare. */
  outputMaxItems: 64,
  /** Largest `maxLength` an output string may declare, in characters (code points). */
  outputMaxLength: 256,
  /** Largest serialized tool output, in UTF-8 bytes. */
  outputBytes: 16 * 1024,
  /** Longest error message an `err` envelope carries, in characters (code points). */
  errorLength: 1024,
  /** Largest result envelope, in UTF-8 bytes. */
  envelopeBytes: 16 * 1024,
  /** Deepest nesting of objects and arrays `plainJsonProblem` accepts in any value. */
  jsonDepth: 8,
});

/**
 * Method names a tool may never call: the Durable Object and Worker lifecycle and handler names,
 * the tool runner's own `__invoke`, names an RPC layer or `JSON.stringify` treats specially
 * (`then`, `dup`, `toJSON`), `Object.prototype`'s methods, and `ctx`/`env`. `isReservedToolMethod`
 * also refuses every name that starts with `_` or `webSocket`.
 */
export const RESERVED_TOOL_METHODS: ReadonlySet<string> = new Set([
  "constructor", "fetch", "alarm", "webSocketMessage", "webSocketClose", "webSocketError",
  "__invoke", "connect", "queue", "scheduled", "tail", "tailStream", "trace", "email", "test",
  "then", "dup", "toJSON", "toString", "toLocaleString", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "ctx", "env",
]);

const RESERVED_TOOL_METHOD_PREFIXES = ["_", "webSocket"];

/**
 * Module names the kernel's tool runner uses for its own code. A callable widget whose commit has
 * either at its top level is refused, so authored code can never stand in for the runner.
 */
export const RESERVED_TOOL_MODULES: readonly string[] =
  Object.freeze(["tool-main.js", "tool-guard.js"]);

/** Whether `name` is a method no tool may call: in `RESERVED_TOOL_METHODS` or a reserved prefix. */
export function isReservedToolMethod(name: string): boolean {
  return RESERVED_TOOL_METHODS.has(name) ||
      RESERVED_TOOL_METHOD_PREFIXES.some(prefix => name.startsWith(prefix));
}

/**
 * A restricted JSON Schema for a tool's input or output. Every object is closed
 * (`additionalProperties: false`), every array and string is bounded, and every number has a
 * range; no other keyword (`$ref`, `pattern`, `oneOf`, `anyOf`, `description`, ...) exists.
 *
 * An input schema is narrower still (see `parseWidgetTools`): one flat object whose properties are
 * string enums, booleans or ranged integers. An output schema may also use `number`, `null`,
 * bounded strings and arrays, and objects nested up to `WIDGET_TOOL_LIMITS.outputDepth` deep.
 */
export type WidgetToolSchema =
  | {
    type: "object";
    /** Each property's schema, by name. */
    properties: Record<string, WidgetToolSchema>;
    /** The properties a value must have; the rest are optional. */
    required?: string[];
    /** Always `false`; only a no-input schema (`{type: "object", properties: {}}`) omits it. */
    additionalProperties?: false;
  }
  | {
    type: "array";
    /** Every item's schema. */
    items: WidgetToolSchema;
    /** Most items the array holds. */
    maxItems: number;
  }
  | {
    type: "string";
    /** An input string's choices, written by the builder. */
    enum?: string[];
    /** An output string's longest length, in characters (code points). */
    maxLength?: number;
  }
  | {
    type: "integer" | "number";
    /** Smallest value allowed. */
    minimum: number;
    /** Largest value allowed. */
    maximum: number;
  }
  | { type: "boolean" | "null" };

/** One tool a callable widget declares in `tools.json`: what the agent sees and what it runs. */
export type WidgetToolDeclaration = {
  /** The tool's name, unique in the file: a lowercase letter, then letters and digits. */
  name: string;
  /** What the tool does: one line of plain text, untrusted when shown to the agent. */
  description: string;
  /** The `server.js` method the tool calls, by the same pattern as `name`, and never reserved. */
  method: string;
  /** What the tool may do. Only reads exist; `"write"` is reserved. */
  effect: "read";
  /** Its input: none (`{type: "object", properties: {}}`) or builder-written choices. */
  input: WidgetToolSchema;
  /** The output it returns; the kernel checks every result against it. */
  output: WidgetToolSchema;
};

/** A tool call's result as its runner reports it: a value, or a capped error with its length. */
export type WidgetToolEnvelope =
  | {
    t: "ok";
    /** The result, which matched the tool's output schema. */
    v: unknown;
  }
  | {
    t: "err";
    /** The error's message, cut to `WIDGET_TOOL_LIMITS.errorLength` characters. */
    m: string;
    /** The message's length before it was cut, in characters (code points). */
    len: number;
  };

const NAME = /^[a-z][A-Za-z0-9]{0,47}$/;
const PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const INDEX = /^(?:0|[1-9][0-9]*)$/;
// Control and format characters (bidi overrides, zero-width), line and paragraph separators, and
// lone surrogates: what keeps authored text to one visible line.
const NOT_PLAIN_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * Parses `tools.json`'s text into its tool declarations, or throws an `Error` whose message names
 * the first rule it fails. The file is a JSON array of 1 to 8 declarations; every key is required
 * and no other key is allowed. Each input schema is either no input or a flat, closed object of at
 * most 8 properties, each a string `enum`, a `boolean`, or an `integer` whose range holds at most
 * 1,024 values. Free strings, `number`s, unranged integers, nested objects and arrays are refused.
 * The result is built afresh from the checked fields.
 */
export function parseWidgetTools(text: string): WidgetToolDeclaration[] {
  if (utf8Length(text, WIDGET_TOOL_LIMITS.fileBytes) > WIDGET_TOOL_LIMITS.fileBytes) {
    throw new Error(`it is over ${WIDGET_TOOL_LIMITS.fileBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("it is not JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("it is not a JSON array of tools");
  if (parsed.length === 0) throw new Error("it declares no tools");
  if (parsed.length > WIDGET_TOOL_LIMITS.tools) {
    throw new Error(`it declares more than ${WIDGET_TOOL_LIMITS.tools} tools`);
  }
  let names = new Set<string>();
  return parsed.map((raw, index) => {
    let tool = fields(raw, `tool ${index + 1}`,
        ["name", "description", "method", "effect", "input", "output"]);
    let { name, description, method, effect } = tool;
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new Error(`tool ${index + 1}'s name must be a lowercase letter, then at most ` +
          `${WIDGET_TOOL_LIMITS.nameLength - 1} letters and digits`);
    }
    if (names.has(name)) throw new Error(`two tools are named "${name}"`);
    names.add(name);
    let at = `tool "${name}"`;
    let problem = typeof description === "string"
        ? plainLineProblem(description, WIDGET_TOOL_LIMITS.descriptionLength) : "is not a string";
    if (problem !== null) throw new Error(`${at}'s description ${problem}`);
    if (typeof method !== "string" || !NAME.test(method)) {
      throw new Error(`${at}'s method must be a lowercase letter, then letters and digits`);
    }
    if (isReservedToolMethod(method)) throw new Error(`${at}'s method "${method}" is reserved`);
    if (effect !== "read") throw new Error(`${at}'s effect must be "read"`);
    return {
      name, description: description as string, method, effect,
      input: inputSchema(tool.input, `${at}'s input`),
      output: outputSchema(tool.output, `${at}'s output`, 0),
    };
  });
}

/**
 * Why `value` does not match `schema`, or `null` when it does. It first requires finite plain JSON
 * of at most `maxBytes` serialized UTF-8 bytes (`plainJsonProblem`), then every type, range,
 * length, `enum` and closed object of the schema. `maxBytes` defaults to the input cap; a caller
 * checking an output passes `WIDGET_TOOL_LIMITS.outputBytes`.
 */
export function widgetToolValueProblem(
    schema: WidgetToolSchema, value: unknown,
    maxBytes: number = WIDGET_TOOL_LIMITS.inputBytes): string | null {
  return plainJsonProblem(value, maxBytes) ?? matchProblem(schema, value, "value");
}

/**
 * Why `value` is not finite plain JSON of at most `maxBytes` UTF-8 bytes when serialized, or
 * `null` when it is. Plain JSON is `null`, booleans, finite numbers, strings, dense arrays and
 * objects whose prototype is `Object.prototype` or `null`, with only enumerable string-keyed data
 * properties, nested at most `WIDGET_TOOL_LIMITS.jsonDepth` deep. Functions (and so capabilities),
 * class instances, cycles, `NaN` and `Infinity`, `undefined`, symbols and bigints are refused. The
 * size is counted as `JSON.stringify` would write it, without building the string, and the walk
 * stops as soon as it passes `maxBytes`.
 */
export function plainJsonProblem(value: unknown, maxBytes: number): string | null {
  let used = 0;
  let over = () => `it is over ${maxBytes} bytes`;
  let spend = (bytes: number) => (used += bytes) > maxBytes;
  let ancestors = new Set<object>();
  let walk = (node: unknown, depth: number): string | null => {
    switch (typeof node) {
      case "string":
        return spend(jsonStringBytes(node, maxBytes - used)) ? over() : null;
      case "number":
        if (!Number.isFinite(node)) return "it contains a non-finite number";
        return spend(String(node).length) ? over() : null;
      case "boolean":
        return spend(node ? 4 : 5) ? over() : null;
      case "function":
        return "it contains a function or capability";
      case "object":
        break;
      default:
        return `it contains a ${typeof node}, which JSON cannot hold`;
    }
    if (node === null) return spend(4) ? over() : null;
    if (ancestors.has(node)) return "it contains a cycle";
    if (depth >= WIDGET_TOOL_LIMITS.jsonDepth) {
      return `it is nested more than ${WIDGET_TOOL_LIMITS.jsonDepth} deep`;
    }
    let proto: unknown = Object.getPrototypeOf(node);
    let isArray = Array.isArray(node);
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      return "it contains a class instance";
    }
    // Brackets, plus a comma between members; checked before the members are listed.
    let length = isArray ? (node as unknown[]).length : 0;
    if (spend(2 + Math.max(0, length - 1))) return over();
    let keys = Reflect.ownKeys(node);
    if (isArray ? keys.length !== length + 1 : spend(Math.max(0, keys.length - 1))) {
      return isArray ? "it contains a sparse array or one with extra properties" : over();
    }
    ancestors.add(node);
    for (let key of keys) {
      if (isArray && key === "length") continue;
      if (typeof key === "symbol") return "it contains a symbol key";
      // With the key count checked, every other key being an index below the length makes the
      // array dense with nothing extra.
      if (isArray && !(INDEX.test(key) && Number(key) < length)) {
        return "it contains a sparse array or one with extra properties";
      }
      let descriptor = Object.getOwnPropertyDescriptor(node, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        return "it contains an accessor or non-enumerable property";
      }
      if (!isArray && spend(jsonStringBytes(key, maxBytes - used) + 1)) return over();
      let problem = walk(descriptor.value, depth + 1);
      if (problem !== null) return problem;
    }
    ancestors.delete(node);
    return null;
  };
  return walk(value, 0);
}

/**
 * Parses the bytes a tool's runner returned into its result envelope, or throws an `Error` naming
 * the first rule they fail. They must be at most `WIDGET_TOOL_LIMITS.envelopeBytes` of strict UTF-8
 * JSON, exactly `{t: "ok", v}` with `v` matching `output` (`widgetToolValueProblem` at the output
 * cap), or exactly `{t: "err", m, len}` with `m` at most `WIDGET_TOOL_LIMITS.errorLength`
 * characters and `len` at least its length. The error never quotes the bytes.
 */
export function parseToolEnvelope(bytes: Uint8Array, output: WidgetToolSchema): WidgetToolEnvelope {
  if (bytes.byteLength > WIDGET_TOOL_LIMITS.envelopeBytes) {
    throw new Error(`the result is over ${WIDGET_TOOL_LIMITS.envelopeBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new Error("the result is not UTF-8 JSON");
  }
  let shape = "the result is not an ok or err envelope";
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(shape);
  }
  let envelope = parsed as Record<string, unknown>;
  let keys = Object.keys(envelope).toSorted().join();
  if (envelope.t === "ok" && keys === "t,v") {
    let problem = widgetToolValueProblem(output, envelope.v, WIDGET_TOOL_LIMITS.outputBytes);
    if (problem !== null) {
      throw new Error(`the result does not match the output schema: ${problem}`);
    }
    return { t: "ok", v: envelope.v };
  }
  if (envelope.t === "err" && keys === "len,m,t") {
    let { m, len } = envelope;
    if (typeof m !== "string" || codePoints(m) > WIDGET_TOOL_LIMITS.errorLength) {
      throw new Error(`the error is not a string of at most ${WIDGET_TOOL_LIMITS.errorLength} ` +
          "characters");
    }
    if (typeof len !== "number" || !Number.isSafeInteger(len) || len < codePoints(m)) {
      throw new Error("the error's length is not a whole number at least its message's");
    }
    return { t: "err", m, len };
  }
  throw new Error(shape);
}

// `raw` as a JSON object with every `required` key and no keys beyond `optional`.
function fields(raw: unknown, at: string, required: string[],
    optional: string[] = []): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${at} is not an object`);
  }
  let object = raw as Record<string, unknown>;
  for (let key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(`${at} has ${/^[\w$]{1,32}$/.test(key) ? `"${key}", which` : "a key that"} ` +
          "is not supported");
    }
  }
  let missing = required.find(key => !Object.hasOwn(object, key));
  if (missing !== undefined) throw new Error(`${at} has no "${missing}"`);
  return object;
}

// A schema's `properties` as checked names, at most `max` of them, mapped through `check`.
function propertiesOf(raw: unknown, at: string, max: number,
    check: (schema: unknown, at: string) => WidgetToolSchema): Record<string, WidgetToolSchema> {
  let properties = fields(raw, `${at}'s properties`, [], Object.keys(raw ?? {}));
  let names = Object.keys(properties);
  if (names.length > max) throw new Error(`${at} has more than ${max} properties`);
  let checked: Record<string, WidgetToolSchema> = {};
  for (let name of names) {
    if (!PROPERTY_NAME.test(name)) {
      throw new Error(`${at} has a property name that is not a letter, then at most ` +
          `${WIDGET_TOOL_LIMITS.nameLength - 1} letters, digits and underscores`);
    }
    checked[name] = check(properties[name], `${at}.${name}`);
  }
  return checked;
}

// An object schema's `required` and `additionalProperties`, checked against its properties.
function closedObject(schema: Record<string, unknown>, at: string,
    properties: Record<string, WidgetToolSchema>, mayOmitClosed: boolean): WidgetToolSchema {
  let result: WidgetToolSchema = { type: "object", properties };
  if (schema.additionalProperties !== false &&
      !(mayOmitClosed && schema.additionalProperties === undefined)) {
    throw new Error(`${at} must set "additionalProperties": false`);
  }
  if (schema.additionalProperties === false) result.additionalProperties = false;
  if (schema.required !== undefined) {
    let required = schema.required;
    if (!Array.isArray(required) || required.some(name =>
        typeof name !== "string" || !Object.hasOwn(properties, name)) ||
        new Set(required).size !== required.length) {
      throw new Error(`${at}'s "required" must list distinct declared properties`);
    }
    result.required = [...required as string[]];
  }
  return result;
}

// Every keyword any schema may use; `typeOf` refuses others before it reads the type.
const KEYWORDS = ["properties", "required", "additionalProperties", "items", "maxItems",
  "maxLength", "enum", "minimum", "maximum"];

function typeOf(raw: unknown, at: string): unknown {
  return fields(raw, at, ["type"], KEYWORDS).type;
}

// A tool's input: no input, or a flat closed object of builder-written choices.
function inputSchema(raw: unknown, at: string): WidgetToolSchema {
  if (typeOf(raw, at) !== "object") throw new Error(`${at} must be an object schema`);
  let schema = fields(raw, at, ["type", "properties"], ["required", "additionalProperties"]);
  let properties = propertiesOf(schema.properties, at, WIDGET_TOOL_LIMITS.inputProperties,
      inputProperty);
  return closedObject(schema, at, properties, Object.keys(properties).length === 0);
}

function inputProperty(raw: unknown, at: string): WidgetToolSchema {
  let type = typeOf(raw, at);
  switch (type) {
    case "string": {
      let schema = fields(raw, at, ["type"], ["enum"]);
      if (schema.enum === undefined) {
        throw new Error(`${at} is a free string, which an input cannot take; list its choices ` +
            `in "enum"`);
      }
      return { type, enum: enumValues(schema.enum, at) };
    }
    case "boolean":
      fields(raw, at, ["type"]);
      return { type };
    case "integer": {
      let { minimum, maximum } = fields(raw, at, ["type"], ["minimum", "maximum"]);
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) {
        throw new Error(`${at} is an unranged integer; give it a whole "minimum" and "maximum"`);
      }
      let [min, max] = [minimum as number, maximum as number];
      if (min > max || max - min + 1 > WIDGET_TOOL_LIMITS.integerValues) {
        throw new Error(`${at}'s range must hold 1 to ${WIDGET_TOOL_LIMITS.integerValues} values`);
      }
      return { type, minimum: min, maximum: max };
    }
    case "number":
      throw new Error(`${at} is a number, which an input cannot take; use an integer with a ` +
          `range of at most ${WIDGET_TOOL_LIMITS.integerValues} values`);
    case "object":
    case "array":
      throw new Error(`${at} is ${type === "object" ? "an object" : "an array"}, but an input's ` +
          "properties must be flat");
    default:
      throw new Error(`${at}'s type must be "string" with "enum", "boolean" or "integer"`);
  }
}

function enumValues(raw: unknown, at: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WIDGET_TOOL_LIMITS.enumValues) {
    throw new Error(`${at}'s "enum" must list 1 to ${WIDGET_TOOL_LIMITS.enumValues} values`);
  }
  for (let value of raw) {
    let problem = typeof value === "string"
        ? plainLineProblem(value, WIDGET_TOOL_LIMITS.enumValueLength) : "is not a string";
    if (problem !== null) throw new Error(`a value of ${at}'s "enum" ${problem}`);
  }
  if (new Set(raw).size !== raw.length) throw new Error(`${at}'s "enum" repeats a value`);
  return [...raw as string[]];
}

// A tool's output, with `depth` objects and arrays around it.
function outputSchema(raw: unknown, at: string, depth: number): WidgetToolSchema {
  let type = typeOf(raw, at);
  if ((type === "object" || type === "array") && depth >= WIDGET_TOOL_LIMITS.outputDepth) {
    throw new Error(`${at} nests objects and arrays more than ` +
        `${WIDGET_TOOL_LIMITS.outputDepth} deep`);
  }
  switch (type) {
    case "object": {
      let schema = fields(raw, at, ["type", "properties", "additionalProperties"], ["required"]);
      let properties = propertiesOf(schema.properties, at, Infinity,
          (property, propertyAt) => outputSchema(property, propertyAt, depth + 1));
      return closedObject(schema, at, properties, false);
    }
    case "array": {
      let { items, maxItems } = fields(raw, at, ["type", "items", "maxItems"]);
      return {
        type, maxItems: bound(maxItems, WIDGET_TOOL_LIMITS.outputMaxItems, `${at}'s "maxItems"`),
        items: outputSchema(items, `${at}[]`, depth + 1),
      };
    }
    case "string": {
      let { maxLength } = fields(raw, at, ["type", "maxLength"]);
      return {
        type,
        maxLength: bound(maxLength, WIDGET_TOOL_LIMITS.outputMaxLength, `${at}'s "maxLength"`),
      };
    }
    case "integer":
    case "number": {
      let { minimum, maximum } = fields(raw, at, ["type", "minimum", "maximum"]);
      let whole = type === "integer";
      let valid = (end: unknown): end is number =>
        whole ? Number.isSafeInteger(end) : Number.isFinite(end);
      if (!valid(minimum) || !valid(maximum) || minimum > maximum) {
        throw new Error(`${at} needs a ${whole ? "whole " : "finite "}"minimum" no greater ` +
            `than its "maximum"`);
      }
      return { type, minimum, maximum };
    }
    case "boolean":
    case "null":
      fields(raw, at, ["type"]);
      return { type };
    default:
      throw new Error(`${at}'s type must be "object", "array", "string", "integer", "number", ` +
          `"boolean" or "null"`);
  }
}

function bound(raw: unknown, max: number, at: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > max) {
    throw new Error(`${at} must be a whole number from 0 to ${max}`);
  }
  return raw as number;
}

// Why `value` (already plain JSON) does not match `schema`. `at` is built from declared names only.
function matchProblem(schema: WidgetToolSchema, value: unknown, at: string): string | null {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${at} is not an object`;
      }
      let object = value as Record<string, unknown>;
      if (Object.keys(object).some(key => !Object.hasOwn(schema.properties, key))) {
        return `${at} has an undeclared property`;
      }
      let missing = schema.required?.find(name => !Object.hasOwn(object, name));
      if (missing !== undefined) return `${at}.${missing} is missing`;
      for (let [name, property] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(object, name)) continue;
        let problem = matchProblem(property, object[name], `${at}.${name}`);
        if (problem !== null) return problem;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${at} is not an array`;
      if (value.length > schema.maxItems) return `${at} has more than ${schema.maxItems} items`;
      for (let [index, item] of value.entries()) {
        let problem = matchProblem(schema.items, item, `${at}[${index}]`);
        if (problem !== null) return problem;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${at} is not a string`;
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        return `${at} is not one of its choices`;
      }
      if (schema.maxLength !== undefined && codePoints(value) > schema.maxLength) {
        return `${at} is longer than ${schema.maxLength} characters`;
      }
      return null;
    case "integer":
    case "number":
      if (typeof value !== "number" ||
          (schema.type === "integer" && !Number.isSafeInteger(value))) {
        return `${at} is not ${schema.type === "integer" ? "an integer" : "a number"}`;
      }
      return value < schema.minimum || value > schema.maximum
        ? `${at} is outside ${schema.minimum} to ${schema.maximum}` : null;
    case "boolean":
      return typeof value === "boolean" ? null : `${at} is not a boolean`;
    case "null":
      return value === null ? null : `${at} is not null`;
  }
}

// Why `text` is not one line of 1 to `max` characters of plain text.
function plainLineProblem(text: string, max: number): string | null {
  if (text.length === 0 || codePoints(text) > max) return `must be 1 to ${max} characters`;
  return NOT_PLAIN_LINE.test(text) ? "must be one line of plain text" : null;
}

// Characters as JSON Schema counts them: code points, a surrogate pair being one.
function codePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    let unit = text.charCodeAt(i);
    if (unit < 0xdc00 || unit > 0xdfff || i === 0 || !isHighSurrogate(text.charCodeAt(i - 1))) {
      count++;
    }
  }
  return count;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

// `text`'s UTF-8 length, or any number over `cap` once it passes it. A lone surrogate counts as
// the 3 bytes of U+FFFD that encoding it writes.
function utf8Length(text: string, cap: number): number {
  // Every UTF-16 code unit is at least one UTF-8 byte.
  if (text.length > cap) return text.length;
  let bytes = 0;
  for (let i = 0; i < text.length && bytes <= cap; i++) {
    let unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (isHighSurrogate(unit) && i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

// The UTF-8 length of `text` as `JSON.stringify` writes it, quotes and escapes included, or any
// number over `cap` once it passes it.
function jsonStringBytes(text: string, cap: number): number {
  // Two quotes, and at least one byte per UTF-16 code unit.
  if (text.length + 2 > cap) return text.length + 2;
  let bytes = 2;
  for (let i = 0; i < text.length && bytes <= cap; i++) {
    let unit = text.charCodeAt(i);
    if (unit === 0x22 || unit === 0x5c) bytes += 2;
    else if (unit < 0x20) bytes += "\b\f\n\r\t".includes(String.fromCharCode(unit)) ? 2 : 6;
    else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit < 0xd800 || unit > 0xdfff) bytes += 3;
    else if (isHighSurrogate(unit) && i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 6; // A lone surrogate is written as a \uXXXX escape.
  }
  return bytes;
}
