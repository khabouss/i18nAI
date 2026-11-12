import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Supported layouts:
 *   dir:  <root>/en/common.json, <root>/en/auth/login.json  ->  <root>/fr/...
 *   file: <root>/en.json                                    ->  <root>/fr.json
 *
 * Both layouts accept ".json", ".yaml", ".yml", ".po", ".arb" or ".strings" files,
 * independently per file.
 */
export interface Layout {
  kind: "dir" | "file";
  root: string;
  /** For kind "file": the source file's extension (e.g. ".json", ".po"). */
  ext?: string;
}

const EXTENSIONS = [".json", ".yaml", ".yml", ".po", ".arb", ".strings"];

const CANDIDATES = [
  "locales",
  "src/locales",
  "public/locales",
  "src/i18n/locales",
  "src/i18n",
  "i18n",
  "src/assets/i18n",
  "assets/i18n",
  "src/assets/locales",
  "messages",
  "src/messages",
  "translations",
  "src/translations",
  "lang",
  "src/lang",
  "locale",
  "src/locale",
  "app/i18n",
  "static/locales",
  ".",
];

const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();

/** The source-locale file's extension, if `<root>/<from><ext>` exists for one of EXTENSIONS. */
function fileExtAt(root: string, from: string): string | undefined {
  return EXTENSIONS.find((ext) => isFile(path.join(root, `${from}${ext}`)));
}

function layoutAt(root: string, from: string): Layout | undefined {
  const dir = path.join(root, from);
  if (isDir(dir) && listLocaleFiles(dir).length > 0) return { kind: "dir", root };
  const ext = fileExtAt(root, from);
  if (ext) return { kind: "file", root, ext };
  return undefined;
}

export function detectLayout(cwd: string, from: string, input?: string): Layout {
  if (input) {
    const abs = path.resolve(cwd, input);
    // Accept pointing at the source locale itself: --input locales/en or locales/en.json
    if (path.basename(abs) === from && isDir(abs)) return { kind: "dir", root: path.dirname(abs) };
    const base = path.basename(abs);
    const directExt = EXTENSIONS.find((ext) => base === `${from}${ext}`);
    if (directExt && isFile(abs)) return { kind: "file", root: path.dirname(abs), ext: directExt };
    const l = layoutAt(abs, from);
    if (!l) throw new Error(`No "${from}" locale found in ${input} (looked for ${from}/* and ${from}${EXTENSIONS.join("/")}).`);
    return l;
  }
  for (const c of CANDIDATES) {
    const l = layoutAt(path.resolve(cwd, c), from);
    if (l) return l;
  }
  throw new Error(
    `Could not find "${from}" locale files. Use --input <dir> to point at the folder containing ${from}/ or ${from}${EXTENSIONS.join("/")}.`,
  );
}

function listLocaleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listLocaleFiles(p));
    else if (e.isFile() && EXTENSIONS.includes(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out.sort();
}

export function sourceFiles(layout: Layout, from: string): string[] {
  return layout.kind === "dir" ? listLocaleFiles(path.join(layout.root, from)) : [path.join(layout.root, `${from}${layout.ext}`)];
}

export function targetFile(layout: Layout, from: string, to: string, src: string): string {
  if (layout.kind === "file") return path.join(layout.root, `${to}${layout.ext}`);
  return path.join(layout.root, to, path.relative(path.join(layout.root, from), src));
}

/** Locale tags already translated alongside `from` in this layout (for `locale-ai check`). */
export function existingTargets(layout: Layout, from: string): string[] {
  if (layout.kind === "file") {
    const ext = layout.ext!;
    return fs
      .readdirSync(layout.root)
      .filter((f) => f.endsWith(ext) && f.slice(0, -ext.length) !== from)
      .map((f) => f.slice(0, -ext.length))
      .sort();
  }
  return fs
    .readdirSync(layout.root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== from)
    .map((e) => e.name)
    .filter((name) => listLocaleFiles(path.join(layout.root, name)).length > 0)
    .sort();
}

/** A parsed locale file plus enough of its original style to re-render an edited copy the same way. */
export interface LocaleDoc {
  data: unknown;
  /**
   * Renders `data` (the built target, or the unchanged source) in this file's format
   * and style. `targetTag` is the locale being written (e.g. "fr", "pt-BR"); formats
   * that carry their own locale metadata (ARB's "@@locale", a .po header's "Language:")
   * use it to fix that metadata up. Formats without such metadata ignore it.
   * `existingText`, when the target file already exists, is its current raw content —
   * formats whose metadata can be hand-edited by a translator (a .po header's
   * `Plural-Forms`) check it first so a rerun doesn't silently revert that edit.
   */
  serialize(data: unknown, targetTag: string, existingText?: string): string;
}

const finalNewline = (text: string) => text === "" || text.endsWith("\n");
const withNewline = (text: string, keep: boolean) => text.replace(/\n*$/, keep ? "\n" : "");

function readJsonDoc(file: string, text: string): LocaleDoc {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${(e as Error).message}`);
  }
  const indent = /^[{[]\r?\n([ \t]+)/.exec(text)?.[1] ?? (text.includes("\n") ? 2 : 0);
  const keepNewline = finalNewline(text);
  return { data, serialize: (d) => withNewline(JSON.stringify(d, null, indent), keepNewline) };
}

/**
 * Rails and some other frameworks nest an entire YAML locale file under a single
 * top-level key matching the locale tag itself (`en:\n  hello: Hi`), so the file is
 * valid wherever it's loaded from. Detect that wrapper and unwrap it before handing
 * `data` to the rest of the pipeline (which otherwise treats "en" as just another
 * translatable key), then re-wrap under the target's own tag on serialize.
 */
function readYamlDoc(file: string, text: string, tag: string): LocaleDoc {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (e) {
    throw new Error(`Invalid YAML in ${file}: ${(e as Error).message}`);
  }
  const indent = Number(/\n( +)\S/.exec(text)?.[1].length) || 2;
  const keepNewline = finalNewline(text);
  const keys = isObj(raw) ? Object.keys(raw) : [];
  const wrapped = keys.length === 1 && keys[0] === tag;
  const data = wrapped ? (raw as Obj)[tag] : raw;
  const serialize = (d: unknown, targetTag: string): string =>
    withNewline(stringifyYaml(wrapped ? { [targetTag]: d } : d, { indent }), keepNewline);
  return { data, serialize };
}

/** Apple .strings: `"key" = "value";`, optionally preceded by a `/* ... *\/` comment. */
function unescapeC(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) =>
    ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" })[c] ?? c,
  );
}
function escapeC(s: string): string {
  return s.replace(/[\\"\n\t\r]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r" })[c]!);
}

function readStringsDoc(file: string, text: string): LocaleDoc {
  // A key's preceding comment is either a /* ... */ block, or one or more consecutive // lines.
  const PAIR =
    /(?:((?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n[ \t]*\/\/[^\r\n]*)*))[ \t]*\r?\n+)?[ \t]*"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)"\s*;/g;
  const data = newObj();
  const entries: Array<{ key: string; comment?: string }> = [];
  for (const m of text.matchAll(PAIR)) {
    const key = unescapeC(m[2]);
    data[key] = unescapeC(m[3]);
    entries.push({ key, comment: m[1] });
  }
  if (entries.length === 0 && text.trim() !== "") {
    throw new Error(`No "key" = "value"; entries found in ${file}`);
  }
  const keepNewline = finalNewline(text);
  const serialize = (d: unknown): string => {
    const obj = isObj(d) ? d : newObj();
    const seen = new Set<string>();
    const blocks: string[] = [];
    for (const e of entries) {
      seen.add(e.key);
      const v = typeof obj[e.key] === "string" ? (obj[e.key] as string) : "";
      blocks.push((e.comment ? e.comment + "\n" : "") + `"${escapeC(e.key)}" = "${escapeC(v)}";`);
    }
    for (const k of Object.keys(obj)) {
      if (seen.has(k) || typeof obj[k] !== "string") continue;
      blocks.push(`"${escapeC(k)}" = "${escapeC(obj[k] as string)}";`);
    }
    return withNewline(blocks.join("\n\n"), keepNewline);
  };
  return { data, serialize };
}

/** ARB (Flutter): plain JSON, but "@key" / "@@locale" entries are metadata, not translatable content. */
function readArbDoc(file: string, text: string): LocaleDoc {
  let raw: Obj;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid ARB (JSON) in ${file}: ${(e as Error).message}`);
  }
  const data = newObj();
  for (const k of Object.keys(raw)) if (!k.startsWith("@") && typeof raw[k] === "string") data[k] = raw[k];
  const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? (text.includes("\n") ? 2 : 0);
  const keepNewline = finalNewline(text);
  const hasLocale = typeof raw["@@locale"] === "string";
  const serialize = (d: unknown, targetTag: string): string => {
    const obj = isObj(d) ? d : newObj();
    const out = newObj();
    if (hasLocale) out["@@locale"] = targetTag;
    for (const k of Object.keys(raw)) {
      if (k === "@@locale" || k.startsWith("@")) continue;
      out[k] = typeof obj[k] === "string" ? obj[k] : raw[k];
      if (`@${k}` in raw) out[`@${k}`] = raw[`@${k}`];
    }
    for (const k of Object.keys(obj)) if (!(k in out) && !k.startsWith("@")) out[k] = obj[k];
    return withNewline(JSON.stringify(out, null, indent), keepNewline);
  };
  return { data, serialize };
}

/**
 * gettext .po: `msgid` is the stable key (kept identical across locales, as gettext
 * requires); the translatable value is `msgstr`. Plural entries (`msgid_plural` /
 * `msgstr[n]`) and the "" header entry are carried through unchanged (not translated).
 */
interface PoEntry {
  comments: string[];
  msgctxt?: string;
  msgid: string;
  msgidPlural?: string;
  msgstrPlural?: string[];
  msgstr: string;
  isHeader: boolean;
}
const poKey = (e: { msgctxt?: string; msgid: string }) => (e.msgctxt ?? "") + "\u0004" + e.msgid;

/**
 * gettext's well-established Plural-Forms formulas, keyed by language. Copying the
 * source header's line verbatim (as a naive patch does) is wrong whenever the target
 * needs a different count — Arabic needs 6 categories, an English source's line says
 * 2, and anything consuming the .po indexes msgstr[] short or drops forms silently.
 */
const PLURAL_FORMS: Record<string, string> = {
  ja: "nplurals=1; plural=0;",
  zh: "nplurals=1; plural=0;",
  ko: "nplurals=1; plural=0;",
  th: "nplurals=1; plural=0;",
  vi: "nplurals=1; plural=0;",
  id: "nplurals=1; plural=0;",
  ms: "nplurals=1; plural=0;",
  fr: "nplurals=2; plural=(n > 1);",
  pt: "nplurals=2; plural=(n != 1);",
  cs: "nplurals=3; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2;",
  sk: "nplurals=3; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2;",
  pl: "nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);",
  ru: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);",
  uk: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);",
  ro: "nplurals=3; plural=(n==1 ? 0 : (n==0 || (n%100 > 0 && n%100 < 20)) ? 1 : 2);",
  ar: "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 && n%100<=99 ? 4 : 5);",
};

/**
 * Falls back to CLDR's plural category count (via Intl.PluralRules) for a language
 * not in the table above: not necessarily linguistically exact (it buckets purely by
 * small integer value), but it keeps nplurals correct, which is the part that breaks
 * gettext consumers when wrong.
 */
function pluralFormsHeader(lang: string): string {
  const known = PLURAL_FORMS[lang];
  if (known) return known;
  let n: number;
  try {
    n = new Intl.PluralRules(lang).resolvedOptions().pluralCategories.length;
  } catch {
    n = 2;
  }
  if (n <= 1) return "nplurals=1; plural=0;";
  if (n === 2) return "nplurals=2; plural=(n != 1);";
  const branches = Array.from({ length: n - 1 }, (_, i) => `n==${i + 1} ? ${i} :`).join(" ");
  return `nplurals=${n}; plural=(${branches} ${n - 1});`;
}

/** The `nplurals=N` count from pluralFormsHeader, for expanding msgstr[] to the right length. */
function pluralCount(lang: string): number {
  return Number(/nplurals=(\d+)/.exec(pluralFormsHeader(lang))![1]);
}

function parsePo(text: string): { entries: PoEntry[]; leading: string[] } {
  const entries: PoEntry[] = [];
  let leading: string[] = [];
  let cur = { comments: [] as string[] } as Partial<PoEntry> & { comments: string[] };
  let field: string | null = null;
  let buf = "";
  const flushField = () => {
    if (field === null) return;
    const val = unescapeC(buf);
    if (field === "msgctxt") cur.msgctxt = val;
    else if (field === "msgid") cur.msgid = val;
    else if (field === "msgid_plural") cur.msgidPlural = val;
    else if (field === "msgstr") cur.msgstr = val;
    else (cur.msgstrPlural ??= [])[Number(field.slice(7, -1))] = val;
    field = null;
    buf = "";
  };
  const flushEntry = () => {
    flushField();
    if (cur.msgid !== undefined) {
      entries.push({ comments: cur.comments, msgctxt: cur.msgctxt, msgid: cur.msgid, msgidPlural: cur.msgidPlural,
        msgstrPlural: cur.msgstrPlural, msgstr: cur.msgstr ?? "", isHeader: cur.msgid === "" && cur.msgctxt === undefined });
    } else if (entries.length === 0 && cur.comments.length && leading.length === 0) {
      leading = cur.comments;
    }
    cur = { comments: [] };
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      flushEntry();
      continue;
    }
    let m: RegExpExecArray | null;
    if (/^#/.test(line)) {
      flushField();
      cur.comments.push(line);
    } else if ((m = /^msgctxt\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = "msgctxt";
      buf = m[1];
    } else if ((m = /^msgid_plural\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = "msgid_plural";
      buf = m[1];
    } else if ((m = /^msgid\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = "msgid";
      buf = m[1];
    } else if ((m = /^msgstr\[(\d+)\]\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = `msgstr[${m[1]}]`;
      buf = m[2];
    } else if ((m = /^msgstr\s+"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      flushField();
      field = "msgstr";
      buf = m[1];
    } else if ((m = /^"((?:\\.|[^"\\])*)"\s*$/.exec(line))) {
      buf += m[1];
    }
  }
  flushEntry();
  return { entries, leading };
}

/** Synthetic data keys for a plural entry's two translatable forms. */
const pluralOneKey = (e: { msgctxt?: string; msgid: string }) => poKey(e) + "\u0005one";
const pluralOtherKey = (e: { msgctxt?: string; msgid: string }) => poKey(e) + "\u0005other";

function readPoDoc(file: string, text: string): LocaleDoc {
  const { entries, leading } = parsePo(text);
  const data = newObj();
  for (const e of entries) {
    if (e.isHeader) continue;
    if (e.msgidPlural === undefined) data[poKey(e)] = e.msgstr;
    else {
      // Like msgstr for a singular entry, msgstrPlural holds this FILE's own text: the
      // English source form in the source .po, the translated forms in a target .po
      // (msgid/msgid_plural are the stable keys, identical across every locale).
      const forms = e.msgstrPlural ?? [];
      data[pluralOneKey(e)] = forms[0] ?? "";
      data[pluralOtherKey(e)] = forms[forms.length - 1] ?? forms[0] ?? "";
    }
  }
  const keepNewline = finalNewline(text);
  const serialize = (d: unknown, targetTag: string, existingText?: string): string => {
    const obj = isObj(d) ? d : newObj();
    const seen = new Set<string>();
    const blocks: string[] = leading.length ? [leading.join("\n")] : [];
    // A previous run may have left a header a translator then hand-fixed (a corrected
    // Plural-Forms, an added Last-Translator, ...). Keep it as-is rather than
    // regenerating from the source every time; only a brand-new target file gets a
    // freshly computed header.
    const existingHeader = existingText && parsePo(existingText).entries.find((e) => e.isHeader);
    for (const e of entries) {
      const lines = [...e.comments];
      if (e.msgctxt !== undefined) lines.push(`msgctxt "${escapeC(e.msgctxt)}"`);
      if (e.isHeader) {
        lines.push(`msgid ""`);
        const header = existingHeader
          ? existingHeader.msgstr
          : e.msgstr.replace(/^Language:.*$/m, `Language: ${targetTag}`).replace(/^Plural-Forms:.*$/m, `Plural-Forms: ${pluralFormsHeader(targetTag)}`);
        lines.push(`msgstr "${escapeC(header)}"`);
      } else if (e.msgidPlural !== undefined) {
        lines.push(`msgid "${escapeC(e.msgid)}"`, `msgid_plural "${escapeC(e.msgidPlural)}"`);
        const oneKey = pluralOneKey(e);
        const otherKey = pluralOtherKey(e);
        seen.add(oneKey);
        seen.add(otherKey);
        const one = typeof obj[oneKey] === "string" ? (obj[oneKey] as string) : e.msgid;
        const other = typeof obj[otherKey] === "string" ? (obj[otherKey] as string) : e.msgidPlural;
        const n = pluralCount(targetTag);
        // Not full grammatical inflection (same simplification as addPluralForms for
        // i18next): index 0 gets the singular-sourced form, every other index the
        // plural-sourced one. A language with only one category (ja, zh, ...) gets
        // just the plural form, since it has no separate singular count.
        for (let i = 0; i < n; i++) lines.push(`msgstr[${i}] "${escapeC(n === 1 ? other : i === 0 ? one : other)}"`);
      } else {
        const key = poKey(e);
        seen.add(key);
        const v = typeof obj[key] === "string" ? (obj[key] as string) : "";
        lines.push(`msgid "${escapeC(e.msgid)}"`, `msgstr "${escapeC(v)}"`);
      }
      blocks.push(lines.join("\n"));
    }
    for (const k of Object.keys(obj)) {
      if (seen.has(k) || typeof obj[k] !== "string") continue;
      const i = k.indexOf("\u0004");
      const ctx = i === -1 ? undefined : k.slice(0, i);
      const id = i === -1 ? k : k.slice(i + 1);
      const lines = ctx ? [`msgctxt "${escapeC(ctx)}"`] : [];
      lines.push(`msgid "${escapeC(id)}"`, `msgstr "${escapeC(obj[k] as string)}"`);
      blocks.push(lines.join("\n"));
    }
    return withNewline(blocks.join("\n\n"), keepNewline);
  };
  return { data, serialize };
}

/** `tag` is the locale this file is for (the source tag, or an existing target's own tag). */
export function readLocaleDoc(file: string, tag: string): LocaleDoc {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return readYamlDoc(file, text, tag);
  if (ext === ".po") return readPoDoc(file, text);
  if (ext === ".arb") return readArbDoc(file, text);
  if (ext === ".strings") return readStringsDoc(file, text);
  return readJsonDoc(file, text);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Null-prototype object so keys such as "__proto__" are stored as plain data. */
const newObj = (): Obj => Object.create(null) as Obj;

/** A string needs translating when the target has no non-empty string at the same path. */
const needsTranslation = (existing: unknown, overwrite: boolean) =>
  overwrite || typeof existing !== "string" || existing === "";

/** Flattens a locale tree into key-path -> string-value pairs (for `locale-ai check`). */
export function flattenStrings(
  data: unknown,
  prefix = "",
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  if (typeof data === "string") out.push({ path: prefix || "(root)", value: data });
  else if (Array.isArray(data)) data.forEach((v, i) => flattenStrings(v, `${prefix}[${i}]`, out));
  else if (isObj(data)) for (const k of Object.keys(data)) flattenStrings(data[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/**
 * True when `path` is, or is nested under, one of `doNotTranslateKeys` — the same
 * dot/`[i]` notation flattenStrings produces (e.g. "brand.name", "config.statusEnum").
 * Protecting a path that points at an object or array protects every string nested
 * under it too, which is what makes an enum array ("statusEnum": ["ACTIVE", ...])
 * protectable without enumerating each value as a doNotTranslate term.
 */
export function keyPathProtect(doNotTranslateKeys: string[] | undefined): ((path: string) => boolean) | undefined {
  const keys = (doNotTranslateKeys ?? []).filter(Boolean);
  if (!keys.length) return undefined;
  return (path: string) => keys.some((k) => path === k || path.startsWith(`${k}.`) || path.startsWith(`${k}[`));
}

export function pendingStrings(
  source: unknown,
  existing: unknown,
  overwrite: boolean,
  isProtected?: (path: string) => boolean,
): string[] {
  const out: string[] = [];
  const visit = (s: unknown, e: unknown, path: string): void => {
    if (typeof s === "string") {
      if (!isProtected?.(path) && needsTranslation(e, overwrite)) out.push(s);
    } else if (Array.isArray(s)) {
      s.forEach((v, i) => visit(v, Array.isArray(e) ? e[i] : undefined, `${path}[${i}]`));
    } else if (isObj(s)) {
      for (const k of Object.keys(s)) visit(s[k], isObj(e) ? e[k] : undefined, path ? `${path}.${k}` : k);
    }
  };
  visit(source, existing, "");
  return out;
}

/**
 * Builds the target document: source structure and key order, existing
 * translations kept (unless overwrite), new strings from `translate`, and keys
 * that only exist in the target preserved at the end. A string at a protected
 * path (see keyPathProtect) is always copied from the source verbatim.
 */
export function buildTarget(
  source: unknown,
  existing: unknown,
  translate: (s: string) => string,
  overwrite: boolean,
  isProtected?: (path: string) => boolean,
): unknown {
  const visit = (s: unknown, e: unknown, path: string): unknown => {
    if (typeof s === "string") {
      if (isProtected?.(path)) return s;
      return needsTranslation(e, overwrite) ? translate(s) : e;
    }
    if (Array.isArray(s)) return s.map((v, i) => visit(v, Array.isArray(e) ? e[i] : undefined, `${path}[${i}]`));
    if (isObj(s)) {
      const out = newObj();
      for (const k of Object.keys(s)) out[k] = visit(s[k], isObj(e) ? e[k] : undefined, path ? `${path}.${k}` : k);
      if (isObj(e)) for (const k of Object.keys(e)) if (!(k in out)) out[k] = e[k];
      return out;
    }
    return s;
  };
  return visit(source, existing, "");
}

const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_KEY = /^(.+?)(_ordinal)?_(zero|one|two|few|many|other)$/;

/**
 * Source strings at a cardinal i18next "_one" plural key ("itemCount_one": "{{count}}
 * item"). These are grammatically singular in English, but the model sometimes infers
 * the TARGET's plural form anyway because {{count}} reads as an opaque marker rather
 * than a concrete number — the engine uses this set to retranslate with a real "1" in
 * place of {{count}} and recover the correct grammatical number (see engine.ts).
 */
export function pluralOneStrings(data: unknown, out: Set<string> = new Set()): Set<string> {
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!isObj(v)) return;
    for (const k of Object.keys(v)) {
      const m = PLURAL_KEY.exec(k);
      if (m && !m[2] && m[3] === "one" && typeof v[k] === "string") out.add(v[k] as string);
      visit(v[k]);
    }
  };
  visit(data);
  return out;
}

/**
 * i18next stores plurals as `key_one` / `key_other`. Languages such as Arabic,
 * Russian or Polish need more forms (`_few`, `_many` ...) and i18next does not fall
 * back to `_other` for them, so missing forms are added with the `_other` text.
 * Returns the new document and the number of keys added.
 */
export function addPluralForms(doc: unknown, targetLang: string): { doc: unknown; added: number } {
  let added = 0;
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (!isObj(v)) return v;
    const keys = Object.keys(v);
    const groups = new Map<string, { cats: Map<string, string>; last: string; ordinal: boolean }>();
    for (const k of keys) {
      const m = PLURAL_KEY.exec(k);
      if (!m || typeof v[k] !== "string") continue;
      const id = m[1] + (m[2] ?? "");
      const g = groups.get(id) ?? { cats: new Map(), last: k, ordinal: !!m[2] };
      g.cats.set(m[3], k);
      g.last = k;
      groups.set(id, g);
    }
    // Qualifying groups are written contiguously in canonical order at the
    // position of their first key, so re-runs produce byte-identical files.
    const groupOf = new Map<string, string>();
    const needed = new Map<string, string[]>();
    for (const [id, g] of groups) {
      if (!g.cats.has("other") || g.cats.size < 2) continue;
      try {
        needed.set(
          id,
          new Intl.PluralRules(targetLang, { type: g.ordinal ? "ordinal" : "cardinal" }).resolvedOptions()
            .pluralCategories as string[],
        );
      } catch {
        continue;
      }
      for (const k of g.cats.values()) groupOf.set(k, id);
    }
    const out = newObj();
    const emitted = new Set<string>();
    for (const k of keys) {
      const id = groupOf.get(k);
      if (id === undefined) {
        out[k] = visit(v[k]);
        continue;
      }
      if (emitted.has(id)) continue;
      emitted.add(id);
      const g = groups.get(id)!;
      const other = v[g.cats.get("other")!] as string;
      for (const cat of CATEGORIES) {
        const existing = g.cats.get(cat);
        if (existing) out[existing] = v[existing];
        else if (needed.get(id)!.includes(cat)) {
          out[`${id}_${cat}`] = other;
          added++;
        }
      }
    }
    return out;
  };
  return { doc: visit(doc), added };
}
