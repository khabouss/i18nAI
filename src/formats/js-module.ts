import { finalNewline, isObj, type LocaleDoc, newObj, type Obj, withNewline } from "./shared.ts";

/**
 * A narrow, non-executing parser for `.js`/`.mjs`/`.cjs`/`.ts` locale modules: only an
 * `export default {...}` / `module.exports = {...}` / `exports.default = {...}` whose
 * value is a plain object literal of strings/numbers/booleans/null/nested
 * objects/arrays — the JSON-compatible subset of JS object-literal syntax, with
 * JS-only relaxations (bare identifier keys, single/double/backtick-quoted strings
 * with no `${...}` interpolation, `//`/`\/* *\/` comments, trailing commas). A
 * function, template-literal interpolation, import/spread, or computed key (anything
 * outside that subset) is a clear parse error, never a silent guess — this is
 * deliberately not a JS/TS engine: real code in the file (helper functions, a type
 * import) is never evaluated, only this one literal is read as data.
 */
const JS_EXPORT_RE = /\b(?:export\s+default|module\.exports\s*=|exports\.default\s*=)\s*/;

interface JsMetaNode {
  [key: string]: { comment?: string; trailing?: string; nested?: JsMetaNode };
}

/** Skips whitespace and `//`/`/* *\/` comments, returning the last comment seen (if any) immediately before the next token. */
function skipJsTrivia(text: string, pos: { i: number }): string | undefined {
  let lastComment: string | undefined;
  for (;;) {
    while (pos.i < text.length && /\s/.test(text[pos.i])) pos.i++;
    if (text.startsWith("//", pos.i)) {
      const end = text.indexOf("\n", pos.i);
      lastComment = text.slice(pos.i, end === -1 ? text.length : end);
      pos.i = end === -1 ? text.length : end;
      continue;
    }
    if (text.startsWith("/*", pos.i)) {
      const end = text.indexOf("*/", pos.i + 2);
      if (end === -1) throw new Error("Unterminated /* comment in JS module");
      lastComment = text.slice(pos.i, end + 2);
      pos.i = end + 2;
      continue;
    }
    break;
  }
  return lastComment;
}

function parseJsKey(text: string, pos: { i: number }): string {
  const c = text[pos.i];
  if (c === '"' || c === "'" || c === "`") return parseJsString(text, pos);
  const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(pos.i));
  if (!m) throw new Error(`Unsupported object key at offset ${pos.i} in JS module (computed keys aren't supported)`);
  pos.i += m[0].length;
  return m[0];
}

function parseJsString(text: string, pos: { i: number }): string {
  const quote = text[pos.i];
  const start = pos.i;
  pos.i++;
  let out = "";
  while (pos.i < text.length && text[pos.i] !== quote) {
    if (text[pos.i] === "\\") {
      const esc = text[pos.i + 1];
      if (esc === "u") {
        out += String.fromCharCode(parseInt(text.slice(pos.i + 2, pos.i + 6), 16));
        pos.i += 6;
      } else if (esc === "x") {
        out += String.fromCharCode(parseInt(text.slice(pos.i + 2, pos.i + 4), 16));
        pos.i += 4;
      } else {
        out += ({ n: "\n", t: "\t", r: "\r", "0": "\0" } as Record<string, string>)[esc] ?? esc;
        pos.i += 2;
      }
    } else if (quote === "`" && text[pos.i] === "$" && text[pos.i + 1] === "{") {
      throw new Error(`Template literal interpolation isn't supported (offset ${pos.i} in JS module)`);
    } else {
      out += text[pos.i];
      pos.i++;
    }
  }
  if (text[pos.i] !== quote) throw new Error(`Unterminated string starting at offset ${start} in JS module`);
  pos.i++;
  return out;
}

function parseJsNumber(text: string, pos: { i: number }): number {
  const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos.i));
  if (!m) throw new Error(`Unsupported numeric literal at offset ${pos.i} in JS module`);
  pos.i += m[0].length;
  return Number(m[0]);
}

function parseJsArray(text: string, pos: { i: number }): unknown[] {
  pos.i++; // '['
  const out: unknown[] = [];
  for (;;) {
    skipJsTrivia(text, pos);
    if (text[pos.i] === "]") {
      pos.i++;
      break;
    }
    out.push(parseJsValue(text, pos).value);
    skipJsTrivia(text, pos);
    if (text[pos.i] === ",") {
      pos.i++;
      continue;
    }
    skipJsTrivia(text, pos);
    if (text[pos.i] === "]") {
      pos.i++;
      break;
    }
    throw new Error(`Expected "," or "]" at offset ${pos.i} in JS module`);
  }
  return out;
}

/**
 * A same-line trailing comment right after a value's comma (`home: 'Home', // note`) —
 * never a comment on its own line, which belongs to the *next* key instead (that one's
 * picked up by `skipJsTrivia` at the top of the next loop iteration). Only recognized
 * when an actual comma precedes it: that keeps a missing-comma typo a clear parse error
 * (the normal comma/`}` check below still runs) rather than a silently forgiven one.
 * Consumes the comma together with the comment when both are found, so the caller never
 * has to tell them apart; otherwise consumes nothing; leaving the comma, if any, for the
 * caller's own check.
 */
function skipJsTrailingComment(text: string, pos: { i: number }): string | undefined {
  let i = pos.i;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  if (text[i] !== ",") return undefined;
  i++;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  let comment: string | undefined;
  let end = i;
  if (text.startsWith("//", i)) {
    end = text.indexOf("\n", i);
    if (end === -1) end = text.length;
    comment = text.slice(i, end);
  } else if (text.startsWith("/*", i)) {
    const close = text.indexOf("*/", i + 2);
    if (close !== -1) {
      end = close + 2;
      comment = text.slice(i, end);
    }
  }
  if (comment === undefined) return undefined; // comma present but nothing to attach on this line; leave it for the normal check
  pos.i = end;
  return comment;
}

function parseJsObject(text: string, pos: { i: number }): { value: Obj; meta: JsMetaNode } {
  pos.i++; // '{'
  const value = newObj();
  const meta: JsMetaNode = {};
  for (;;) {
    const comment = skipJsTrivia(text, pos);
    if (text[pos.i] === "}") {
      pos.i++;
      break;
    }
    if (pos.i >= text.length) throw new Error("Unexpected end of file inside object literal in JS module");
    const key = parseJsKey(text, pos);
    skipJsTrivia(text, pos);
    if (text[pos.i] !== ":") throw new Error(`Expected ":" after key "${key}" at offset ${pos.i} in JS module`);
    pos.i++;
    skipJsTrivia(text, pos);
    const { value: v, meta: childMeta } = parseJsValue(text, pos);
    value[key] = v;
    const trailing = skipJsTrailingComment(text, pos);
    if (comment !== undefined || trailing !== undefined || childMeta) meta[key] = { comment, trailing, nested: childMeta };
    if (trailing !== undefined) {
      // The comma (this key's own separator) and its trailing comment are both already consumed.
      skipJsTrivia(text, pos);
      if (text[pos.i] === "}") {
        pos.i++;
        break;
      }
      continue;
    }
    skipJsTrivia(text, pos);
    if (text[pos.i] === ",") {
      pos.i++;
      continue;
    }
    skipJsTrivia(text, pos);
    if (text[pos.i] === "}") {
      pos.i++;
      break;
    }
    throw new Error(`Expected "," or "}" at offset ${pos.i} in JS module`);
  }
  return { value, meta };
}

function parseJsValue(text: string, pos: { i: number }): { value: unknown; meta?: JsMetaNode } {
  const c = text[pos.i];
  if (c === "{") return parseJsObject(text, pos);
  if (c === "[") return { value: parseJsArray(text, pos) };
  if (c === '"' || c === "'" || c === "`") return { value: parseJsString(text, pos) };
  if (c !== undefined && /[0-9+-]/.test(c)) return { value: parseJsNumber(text, pos) };
  if (/^true\b/.test(text.slice(pos.i))) {
    pos.i += 4;
    return { value: true };
  }
  if (/^false\b/.test(text.slice(pos.i))) {
    pos.i += 5;
    return { value: false };
  }
  if (/^null\b/.test(text.slice(pos.i))) {
    pos.i += 4;
    return { value: null };
  }
  throw new Error(`Unsupported JS syntax at offset ${pos.i}: ${JSON.stringify(text.slice(pos.i, pos.i + 30))}`);
}

function jsKeyLiteral(key: string, quote: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quoteJsString(key, quote);
}

function quoteJsString(s: string, quote: string): string {
  const body = s.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`).replace(/\n/g, "\\n");
  return `${quote}${body}${quote}`;
}

function serializeJsValue(v: unknown, meta: JsMetaNode | undefined, level: number, step: string, quote: string): string {
  if (typeof v === "string") return quoteJsString(v, quote);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const pad = step.repeat(level + 1);
    const items = v.map((item) => `${pad}${serializeJsValue(item, undefined, level + 1, step, quote)}`);
    return `[\n${items.join(",\n")},\n${step.repeat(level)}]`;
  }
  if (isObj(v)) return serializeJsObject(v, meta, level, step, quote);
  return "null";
}

function serializeJsObject(obj: Obj, meta: JsMetaNode | undefined, level: number, step: string, quote: string): string {
  const keys = Object.keys(obj);
  if (!keys.length) return "{}";
  const pad = step.repeat(level + 1);
  const lines = keys.map((k) => {
    const m = meta?.[k];
    const commentLine = m?.comment ? `${pad}${m.comment}\n` : "";
    const trailing = m?.trailing ? ` ${m.trailing}` : "";
    return `${commentLine}${pad}${jsKeyLiteral(k, quote)}: ${serializeJsValue(obj[k], m?.nested, level + 1, step, quote)},${trailing}`;
  });
  return `{\n${lines.join("\n")}\n${step.repeat(level)}}`;
}

export function readJsModuleDoc(file: string, text: string): LocaleDoc {
  const m = JS_EXPORT_RE.exec(text);
  if (!m) throw new Error(`No "export default", "module.exports =" or "exports.default =" found in ${file}`);
  const pos = { i: m.index + m[0].length };
  skipJsTrivia(text, pos);
  if (text[pos.i] !== "{") {
    throw new Error(
      `${file}: the exported value must be a plain object literal — only { key: "value" } (strings, numbers, booleans, null, nested objects/arrays) is supported for JS/TS locale modules, not a reference to a separately-declared constant, a function, or anything requiring real JS evaluation.`,
    );
  }
  const before = text.slice(0, pos.i);
  let value: Obj, meta: JsMetaNode;
  try {
    ({ value, meta } = parseJsObject(text, pos));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const bodyText = text.slice(before.length, pos.i);
  const hadSemi = text[pos.i] === ";";
  const after = text.slice(hadSemi ? pos.i + 1 : pos.i);
  const step = /\n([ \t]+)\S/.exec(bodyText)?.[1] ?? "  ";
  const quote = /[:,{]\s*'/.test(bodyText) ? "'" : '"';
  const keepNewline = finalNewline(text);
  const serialize = (d: unknown): string => {
    const obj = isObj(d) ? d : newObj();
    return withNewline(`${before}${serializeJsObject(obj, meta, 0, step, quote)}${hadSemi ? ";" : ""}${after}`, keepNewline);
  };
  return { data: value, serialize };
}
