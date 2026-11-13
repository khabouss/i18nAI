import fs from "node:fs";
import path from "node:path";
import { Document, isMap, isScalar, parseDocument } from "yaml";
import { parseLocale } from "./lang.ts";

/**
 * Supported layouts:
 *   dir:        <root>/en/common.json, <root>/en/auth/login.json  ->  <root>/fr/...
 *   file:       <root>/en.json                                    ->  <root>/fr.json
 *   android:    <root>/values/strings.xml                         ->  <root>/values-fr/strings.xml
 *   xcstrings:  <file>.xcstrings (every locale, source included, lives inside this one file)
 *   xliff:      <file>.xlf (untagged source)                       ->  <file>.fr.xlf
 *
 * dir and file both accept ".json", ".yaml", ".yml", ".po", ".arb", ".strings" or
 * ".properties" files, independently per file. android is its own thing: the file is
 * always named "strings.xml", and the locale lives in the untagged "values" (source)
 * vs. "values-<qualifier>" (target) directory name instead of the file name. xcstrings
 * and xliff are both only ever reached via an explicit `--input <file>` rather than
 * auto-detected from CANDIDATES: xcstrings because there's no per-locale file to find
 * at all, xliff because its source file carries no locale tag in its name (the source
 * locale lives inside the file, as `source-language`) — only the convention this
 * project writes target files under (`<basename>.<locale>.xlf`) does. .NET's `.resx`
 * (its own kind "resx") is the same shape as xliff — untagged default resource file,
 * `<basename>.fr.resx` satellite resources — just with no source-language metadata
 * inside the file at all to cross-check `--from` against.
 */
export interface Layout {
  kind: "dir" | "file" | "android" | "xcstrings" | "xliff" | "resx";
  root: string;
  /** For kind "file": the source file's extension (e.g. ".json", ".po"). For kind "xliff"/"resx": ".xlf"/".xliff"/".resx". */
  ext?: string;
  /** For kind "file": a filename prefix shared by every locale file (Flutter's "app_en.arb"). */
  prefix?: string;
  /** For kind "dir": a suffix appended to the locale tag to name the directory (Apple's "en.lproj"). */
  dirSuffix?: string;
  /** For kind "xcstrings": the one catalog file every locale (including the source) lives in. For kind "xliff"/"resx": the source file. */
  file?: string;
}

const EXTENSIONS = [".json", ".yaml", ".yml", ".po", ".pot", ".arb", ".strings", ".properties", ".js", ".mjs", ".cjs", ".ts"];

/**
 * Java's `ResourceBundle` convention names a region-qualified `.properties` file
 * "fr_FR", not this project's BCP-47 "fr-FR" everywhere else — so the tag is
 * underscore-joined only at the filename boundary, for this one extension.
 */
const propertiesTag = (ext: string, tag: string) => (ext === ".properties" ? tag.replace("-", "_") : tag);
const tagFromPropertiesQualifier = (ext: string, qualifier: string) => (ext === ".properties" ? qualifier.replace("_", "-") : qualifier);

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
  "config/locales",
  "app/src/main/res",
  "src/main/res",
  "res",
  ".",
];

/** Android's `values-<qualifier>` folder suffix for a locale tag: "fr" -> "fr", "pt-BR" -> "pt-rBR". */
function androidQualifier(tag: string): string {
  const l = parseLocale(tag);
  if (l.script) throw new Error(`Android resource qualifiers for scripts (got "${tag}") aren't supported; use a plain language or language-region tag.`);
  return l.region ? `${l.lang}-r${l.region}` : l.lang;
}

/** Reverse of androidQualifier: "fr" -> "fr", "pt-rBR" -> "pt-BR". Undefined for a qualifier it can't parse (script/BCP-47 "b+..." variants). */
function tagFromAndroidQualifier(qualifier: string): string | undefined {
  const m = /^([a-z]{2,3})(?:-r([A-Za-z]{2}))?$/.exec(qualifier);
  return m ? (m[2] ? `${m[1]}-${m[2].toUpperCase()}` : m[1]) : undefined;
}

const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();

/** The source-locale file's extension, if `<root>/<from><ext>` exists for one of EXTENSIONS. */
function fileExtAt(root: string, from: string): string | undefined {
  return EXTENSIONS.find((ext) => isFile(path.join(root, `${propertiesTag(ext, from)}${ext}`)));
}

/**
 * A prefixed source-locale file, if `<root>/<prefix>_<from><ext>` exists for one of
 * EXTENSIONS — the convention `flutter gen-l10n` uses by default ("app_en.arb"), and
 * also how a Java `ResourceBundle` basename ("messages_en.properties") is found.
 */
function prefixedFileAt(root: string, from: string): { ext: string; prefix: string } | undefined {
  if (!isDir(root)) return undefined;
  for (const entry of fs.readdirSync(root)) {
    if (!isFile(path.join(root, entry))) continue;
    for (const ext of EXTENSIONS) {
      const suffix = `_${propertiesTag(ext, from)}${ext}`;
      if (entry.endsWith(suffix) && entry.length > suffix.length) {
        return { ext, prefix: entry.slice(0, -suffix.length) };
      }
    }
  }
  return undefined;
}

/** Android's default (untagged) `values/strings.xml` resource folder, if present. */
function androidLayoutAt(root: string): Layout | undefined {
  return isFile(path.join(root, "values", "strings.xml")) ? { kind: "android", root } : undefined;
}

function layoutAt(root: string, from: string): Layout | undefined {
  const dir = path.join(root, from);
  if (isDir(dir) && listLocaleFiles(dir).length > 0) return { kind: "dir", root };
  const lprojDir = path.join(root, `${from}.lproj`);
  if (isDir(lprojDir) && listLocaleFiles(lprojDir).length > 0) return { kind: "dir", root, dirSuffix: ".lproj" };
  const android = androidLayoutAt(root);
  if (android) return android;
  const ext = fileExtAt(root, from);
  if (ext) return { kind: "file", root, ext };
  const prefixed = prefixedFileAt(root, from);
  if (prefixed) return { kind: "file", root, ext: prefixed.ext, prefix: prefixed.prefix };
  return undefined;
}

const dirNameFor = (layout: Layout, tag: string) => `${tag}${layout.dirSuffix ?? ""}`;
const fileNameFor = (layout: Layout, tag: string, ext: string) =>
  `${layout.prefix ? `${layout.prefix}_` : ""}${propertiesTag(ext, tag)}${ext}`;

export function detectLayout(cwd: string, from: string, input?: string): Layout {
  if (input) {
    const abs = path.resolve(cwd, input);
    // Accept pointing at the source locale itself: --input locales/en or locales/en.json
    if (path.basename(abs) === from && isDir(abs)) return { kind: "dir", root: path.dirname(abs) };
    if (path.basename(abs) === `${from}.lproj` && isDir(abs)) {
      return { kind: "dir", root: path.dirname(abs), dirSuffix: ".lproj" };
    }
    if (path.basename(abs) === "values" && isFile(path.join(abs, "strings.xml"))) {
      return { kind: "android", root: path.dirname(abs) };
    }
    if (abs.endsWith(".xcstrings") && isFile(abs)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readText(abs));
      } catch (e) {
        throw new Error(`Invalid .xcstrings (JSON) in ${input}: ${(e as Error).message}`);
      }
      const sourceLanguage = (raw as { sourceLanguage?: unknown } | null)?.sourceLanguage;
      if (typeof sourceLanguage === "string" && sourceLanguage !== from) {
        throw new Error(`${input} has sourceLanguage "${sourceLanguage}", not "${from}" — pass --from ${sourceLanguage}.`);
      }
      return { kind: "xcstrings", root: path.dirname(abs), file: abs };
    }
    if ((abs.endsWith(".xlf") || abs.endsWith(".xliff")) && isFile(abs)) {
      const t = readText(abs);
      const fileTag = /<file\b[^>]*>/.exec(t);
      if (!fileTag) throw new Error(`Invalid XLIFF in ${input}: no <file> element found.`);
      const sourceLanguage = /\bsource-language="([^"]*)"/.exec(fileTag[0])?.[1];
      if (sourceLanguage !== undefined && sourceLanguage !== from) {
        throw new Error(`${input} has source-language "${sourceLanguage}", not "${from}" — pass --from ${sourceLanguage}.`);
      }
      return { kind: "xliff", root: path.dirname(abs), file: abs, ext: abs.endsWith(".xliff") ? ".xliff" : ".xlf" };
    }
    if (abs.endsWith(".resx") && isFile(abs)) {
      return { kind: "resx", root: path.dirname(abs), file: abs, ext: ".resx" };
    }
    const base = path.basename(abs);
    const directExt = EXTENSIONS.find((ext) => base === `${propertiesTag(ext, from)}${ext}`);
    if (directExt && isFile(abs)) return { kind: "file", root: path.dirname(abs), ext: directExt };
    const prefixedExt = EXTENSIONS.find((ext) => {
      const suffix = `_${propertiesTag(ext, from)}${ext}`;
      return base.endsWith(suffix) && base.length > suffix.length;
    });
    if (prefixedExt && isFile(abs)) {
      const suffix = `_${propertiesTag(prefixedExt, from)}${prefixedExt}`;
      return { kind: "file", root: path.dirname(abs), ext: prefixedExt, prefix: base.slice(0, -suffix.length) };
    }
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
  if (layout.kind === "android") return [path.join(layout.root, "values", "strings.xml")];
  if (layout.kind === "xcstrings" || layout.kind === "xliff" || layout.kind === "resx") return [layout.file!];
  return layout.kind === "dir"
    ? listLocaleFiles(path.join(layout.root, dirNameFor(layout, from)))
    : [path.join(layout.root, fileNameFor(layout, from, layout.ext!))];
}

/** A translated file is a real PO, never a template, regardless of what the source was. */
const outputExt = (ext: string) => (ext === ".pot" ? ".po" : ext);

export function targetFile(layout: Layout, from: string, to: string, src: string): string {
  if (layout.kind === "android") return path.join(layout.root, `values-${androidQualifier(to)}`, "strings.xml");
  if (layout.kind === "xcstrings") return layout.file!;
  if (layout.kind === "xliff" || layout.kind === "resx") {
    return path.join(layout.root, `${path.basename(layout.file!, layout.ext!)}.${to}${layout.ext!}`);
  }
  if (layout.kind === "file") return path.join(layout.root, fileNameFor(layout, to, outputExt(layout.ext!)));
  const rel = path.relative(path.join(layout.root, dirNameFor(layout, from)), src);
  const ext = path.extname(rel);
  return path.join(layout.root, dirNameFor(layout, to), ext === ".pot" ? `${rel.slice(0, -ext.length)}.po` : rel);
}

/** True when `tag` parses as a locale (e.g. "fr", "pt-BR") — rejects names like "__mocks__" or "schemas". */
function looksLikeLocale(tag: string): boolean {
  try {
    parseLocale(tag);
    return true;
  } catch {
    return false;
  }
}

/** Locale tags already translated alongside `from` in this layout (for `locale-ai check`). */
export function existingTargets(layout: Layout, from: string): string[] {
  if (layout.kind === "xcstrings") {
    let raw: unknown;
    try {
      raw = JSON.parse(readText(layout.file!));
    } catch {
      return [];
    }
    const strings = isObj(raw) && isObj((raw as Obj).strings) ? ((raw as Obj).strings as Obj) : {};
    const tags = new Set<string>();
    for (const entry of Object.values(strings)) {
      if (!isObj(entry) || !isObj(entry.localizations)) continue;
      for (const tag of Object.keys(entry.localizations as Obj)) tags.add(tag);
    }
    tags.delete(from);
    return [...tags].filter(looksLikeLocale).sort();
  }
  if (layout.kind === "xliff" || layout.kind === "resx") {
    const base = path.basename(layout.file!, layout.ext!);
    const prefix = `${base}.`;
    const ext = layout.ext!;
    return fs
      .readdirSync(layout.root)
      .filter((f) => f.startsWith(prefix) && f.endsWith(ext) && f.length > prefix.length + ext.length)
      .map((f) => f.slice(prefix.length, -ext.length))
      .filter((tag) => tag !== from && looksLikeLocale(tag))
      .sort();
  }
  if (layout.kind === "android") {
    return fs
      .readdirSync(layout.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^values-/.test(e.name) && isFile(path.join(layout.root, e.name, "strings.xml")))
      .map((e) => tagFromAndroidQualifier(e.name.slice("values-".length)))
      .filter((tag): tag is string => tag !== undefined && tag !== from)
      .sort();
  }
  if (layout.kind === "file") {
    const ext = layout.ext!;
    const prefix = layout.prefix ? `${layout.prefix}_` : "";
    return fs
      .readdirSync(layout.root)
      .filter((f) => f.startsWith(prefix) && f.endsWith(ext))
      .map((f) => tagFromPropertiesQualifier(ext, f.slice(prefix.length, -ext.length)))
      .filter((tag) => tag !== from && looksLikeLocale(tag))
      .sort();
  }
  const suffix = layout.dirSuffix ?? "";
  return fs
    .readdirSync(layout.root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name.endsWith(suffix))
    .map((e) => (suffix ? e.name.slice(0, -suffix.length) : e.name))
    .filter((name) => name !== from)
    .filter(looksLikeLocale)
    .filter((name) => listLocaleFiles(path.join(layout.root, dirNameFor(layout, name))).length > 0)
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

/** Renames a single-key document's top-level key, keeping that key's own comments. */
function rewrapKey(doc: Document, tag: string): void {
  const map = doc.contents;
  if (isMap(map) && map.items.length === 1 && isScalar(map.items[0].key)) {
    map.items[0].key.value = tag;
  } else {
    doc.contents = doc.createNode({ [tag]: doc.toJS() ?? {} }) as typeof doc.contents;
  }
}

/**
 * Writes every string/number/boolean leaf of `v` into `doc` at `base` (plus the
 * leaf's own key path). `Document#setIn` mutates an existing scalar node's value in
 * place rather than replacing it, so any comment already attached to that node (a
 * trailing `# ...`, or one on its own line above) survives untouched; a leaf with no
 * existing node there yet is simply inserted, with no comment of its own.
 */
function setLeaves(doc: Document, base: Array<string | number>, v: unknown): void {
  if (Array.isArray(v)) v.forEach((item, i) => setLeaves(doc, [...base, i], item));
  else if (isObj(v)) for (const [k, val] of Object.entries(v)) setLeaves(doc, [...base, k], val);
  else doc.setIn(base, v);
}

/**
 * Rails and some other frameworks nest an entire YAML locale file under a single
 * top-level key matching the locale tag itself (`en:\n  hello: Hi`), so the file is
 * valid wherever it's loaded from. Detect that wrapper and unwrap it before handing
 * `data` to the rest of the pipeline (which otherwise treats "en" as just another
 * translatable key), then re-wrap under the target's own tag on serialize.
 *
 * Re-serializing edits an existing YAML document (the target file's own, when it
 * already exists, otherwise a clone of the source's) in place via `setIn` instead of
 * building a plain object and stringifying it from scratch — the latter would throw
 * away every `#` comment in the file on every run.
 */
function readYamlDoc(file: string, text: string, tag: string): LocaleDoc {
  let srcDoc: Document;
  try {
    srcDoc = parseDocument(text);
  } catch (e) {
    throw new Error(`Invalid YAML in ${file}: ${(e as Error).message}`);
  }
  if (srcDoc.errors.length) throw new Error(`Invalid YAML in ${file}: ${srcDoc.errors[0].message}`);
  const raw = srcDoc.toJS() ?? {};
  const indent = Number(/\n( +)\S/.exec(text)?.[1].length) || 2;
  const keepNewline = finalNewline(text);
  const keys = isObj(raw) ? Object.keys(raw) : [];
  const wrapped = keys.length === 1 && keys[0] === tag;
  const data = wrapped ? (raw as Obj)[tag] : raw;
  const serialize = (d: unknown, targetTag: string, existingText?: string): string => {
    let base: Document | undefined;
    if (existingText !== undefined) {
      try {
        const parsed = parseDocument(existingText);
        if (parsed.errors.length === 0) base = parsed;
      } catch {
        // Fall through to the source clone below.
      }
    }
    base ??= srcDoc.clone();
    if (wrapped) rewrapKey(base, targetTag);
    setLeaves(base, wrapped ? [targetTag] : [], d);
    return withNewline(base.toString({ indent }), keepNewline);
  };
  return { data, serialize };
}

/** Apple .strings: `"key" = "value";`, optionally preceded by a `/* ... *\/` comment. */
function unescapeC(s: string): string {
  return s.replace(/\\(?:U([0-9a-fA-F]{4})|(.))/g, (_, hex: string | undefined, c: string | undefined) => {
    // \Uxxxx is a UTF-16 code unit; two in a row combine into one character via
    // ordinary JS string concatenation when they're a surrogate pair.
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    return ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" })[c!] ?? c!;
  });
}
function escapeC(s: string): string {
  return s.replace(/[\\"\n\t\r]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r" })[c]!);
}

function readStringsDoc(file: string, text: string): LocaleDoc {
  // A key's preceding comment is either a /* ... */ block, or one or more consecutive // lines.
  // The old NeXT/Apple plist-string format allows a bare, unquoted key (no spaces,
  // "=" or ";") as well as a quoted one — Xcode itself only ever writes quoted keys,
  // but hand-edited or third-party-exported .strings files sometimes have both.
  const PAIR =
    /(?:((?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n[ \t]*\/\/[^\r\n]*)*))[ \t]*\r?\n+)?[ \t]*(?:"((?:\\.|[^"\\])*)"|([^\s"=;]+))\s*=\s*"((?:\\.|[^"\\])*)"\s*;/g;
  const data = newObj();
  const entries: Array<{ key: string; comment?: string }> = [];
  for (const m of text.matchAll(PAIR)) {
    const key = m[2] !== undefined ? unescapeC(m[2]) : m[3];
    data[key] = unescapeC(m[4]);
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

/** Java `.properties`: `\n`, `\t`, `\r`, `\f`, `\\` and `\uXXXX` escapes, plus an escaped separator/leading-space. */
function unescapeProperties(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_m, esc: string) => {
    if (esc[0] === "u" && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", f: "\f" } as Record<string, string>)[esc] ?? esc;
  });
}
function escapeProperties(s: string): string {
  let out = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
  if (out[0] === " ") out = `\\${out}`;
  return out;
}

/** True when `s` ends in an odd run of backslashes — Java's line-continuation rule. */
const endsWithContinuation = (s: string) => (/\\*$/.exec(s)![0].length % 2 === 1);

/** Splits `key<ws>?[=:]<ws>?value` at the first unescaped `=`/`:`, skipping `\X` pairs. Undefined if there's none (a key-only or malformed line). */
function splitPropertyLine(line: string): { key: string; valueStart: number } | undefined {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "=" || c === ":") {
      const key = unescapeProperties(line.slice(0, i).trimEnd());
      let v = i + 1;
      while (v < line.length && (line[v] === " " || line[v] === "\t")) v++;
      return { key, valueStart: v };
    }
    i++;
  }
  return undefined;
}

type PropBlock = { text: string } | { key: string; prefix: string };

/** Parses `.properties` text into passthrough lines (comments, blank lines, unparsable lines) and key/value entries. */
function parsePropertiesBlocks(text: string): { blocks: PropBlock[]; data: Obj } {
  const physical = text.split(/\r?\n/);
  const blocks: PropBlock[] = [];
  const data = newObj();
  let i = 0;
  while (i < physical.length) {
    const line = physical[i];
    const trimmedStart = line.replace(/^[ \t\f]+/, "");
    if (trimmedStart === "" || trimmedStart[0] === "#" || trimmedStart[0] === "!") {
      blocks.push({ text: line });
      i++;
      continue;
    }
    const split = splitPropertyLine(line);
    if (!split) {
      blocks.push({ text: line });
      i++;
      continue;
    }
    let valueRaw = line.slice(split.valueStart);
    while (endsWithContinuation(valueRaw) && i + 1 < physical.length) {
      valueRaw = valueRaw.slice(0, -1) + physical[++i].replace(/^[ \t\f]+/, "");
    }
    data[split.key] = unescapeProperties(valueRaw);
    blocks.push({ key: split.key, prefix: line.slice(0, split.valueStart) });
    i++;
  }
  return { blocks, data };
}

/**
 * Java `ResourceBundle` `.properties`: a flat `key=value` (or `key: value`) list, one
 * per line, `#`/`!` line comments, `\`-continued multi-line values, and `\uXXXX`/`\n`/
 * `\t` escapes. There's no plural or array convention of its own — a value containing
 * ICU `{count, plural, ...}` syntax is still handled generically by the ICU extractor
 * elsewhere, same as any other format.
 *
 * Unlike Android/ARB/`.xcstrings` (which regenerate the whole file from the source's
 * own structure every run), this edits an existing target file's lines in place, the
 * same as YAML/`.po`: untouched entries, comments and blank lines keep their exact
 * text and position, and a value that didn't change is never rewritten. A multi-line
 * (`\`-continued) value is always collapsed to one line when it's rewritten, though —
 * only an *unchanged* continued value keeps its original multi-line layout. A line
 * with no unescaped `=`/`:` at all (so not a recognizable `key=value` pair) is passed
 * through untouched rather than guessed at.
 */
function readPropertiesDoc(file: string, text: string): LocaleDoc {
  const { blocks, data } = parsePropertiesBlocks(text);
  const serialize = (d: unknown, _targetTag: string, existingText?: string): string => {
    const obj = isObj(d) ? d : newObj();
    const baseBlocks = existingText !== undefined ? parsePropertiesBlocks(existingText).blocks : blocks;
    const seen = new Set<string>();
    const lines = baseBlocks.map((b) => {
      if (!("key" in b)) return b.text;
      seen.add(b.key);
      return `${b.prefix}${escapeProperties(typeof obj[b.key] === "string" ? (obj[b.key] as string) : "")}`;
    });
    for (const k of Object.keys(obj)) {
      if (seen.has(k) || typeof obj[k] !== "string") continue;
      lines.push(`${k}=${escapeProperties(obj[k] as string)}`);
    }
    return lines.join("\n");
  };
  return { data, serialize };
}

/** Android's `&entity;` plus its own backslash escapes (`\'`, `\"`, `\n`, `\t`) and `<![CDATA[...]]>`. */
function unescapeAndroidXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\\(.)/g, (_m, c: string) => ({ n: "\n", t: "\t" })[c] ?? c);
}
function escapeAndroidXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

interface AndroidEntry {
  comment?: string;
  name: string;
  translatable: boolean;
  kind: "string" | "array" | "plural";
}

/**
 * Android `strings.xml`: `<string>`/`<string-array>`/`<plurals>` elements under a
 * single `<resources>` root, each optionally preceded by an `<!-- ... -->` translator
 * comment and marked `translatable="false"` for text that must stay verbatim (an app ID,
 * a format string nobody localizes). A `<plurals>` element's `quantity="one|other|..."`
 * items become a nested one/other/... object — the same shape Rails-style nested
 * plurals use, so `addNestedPluralForms` fills in whatever categories the target
 * language needs with zero format-specific code.
 *
 * This is a simpler round-trip than YAML/.po/.strings: comments are kept from the
 * source on first write, but a rerun regenerates the whole file from `data` rather
 * than editing an existing target in place (so a translator's own XML comment edits in
 * an already-translated file won't survive a rerun) — the same level of fidelity ARB
 * already has in this project.
 */
function readAndroidXmlDoc(file: string, text: string): LocaleDoc {
  const openMatch = /<resources\b[^>]*>/.exec(text);
  const closeMatch = /<\/resources>/.exec(text);
  if (!openMatch || !closeMatch) throw new Error(`Invalid Android strings.xml in ${file}: missing a <resources> element.`);
  const before = text.slice(0, openMatch.index + openMatch[0].length);
  const after = text.slice(closeMatch.index);
  const body = text.slice(openMatch.index + openMatch[0].length, closeMatch.index);

  const data = newObj();
  const entries: AndroidEntry[] = [];
  const elementRe = /(?:(<!--[\s\S]*?-->)\s*\r?\n\s*)?<(string-array|string|plurals)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\2>)/g;
  for (const m of body.matchAll(elementRe)) {
    const [, comment, tag, attrsRaw, inner] = m;
    const nameMatch = /\bname="([^"]*)"/.exec(attrsRaw);
    if (!nameMatch) continue;
    const name = unescapeAndroidXml(nameMatch[1]);
    const translatable = !/\btranslatable\s*=\s*"false"/.test(attrsRaw);
    if (tag === "string") {
      entries.push({ comment, name, translatable, kind: "string" });
      if (translatable) data[name] = unescapeAndroidXml((inner ?? "").trim());
    } else if (tag === "string-array") {
      entries.push({ comment, name, translatable, kind: "array" });
      const items = [...(inner ?? "").matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map((im) => unescapeAndroidXml(im[1].trim()));
      if (translatable) data[name] = items;
    } else {
      entries.push({ comment, name, translatable, kind: "plural" });
      if (translatable) {
        const plural = newObj();
        for (const im of (inner ?? "").matchAll(/<item\s+quantity="(\w+)"[^>]*>([\s\S]*?)<\/item>/g)) {
          plural[im[1]] = unescapeAndroidXml(im[2].trim());
        }
        data[name] = plural;
      }
    }
  }
  if (entries.length === 0 && body.trim() !== "") {
    throw new Error(`No <string>/<string-array>/<plurals> entries found in ${file}`);
  }
  const indent = /\r?\n([ \t]+)</.exec(body)?.[1] ?? "    ";
  const keepNewline = finalNewline(text);
  const raw = newObj();
  for (const m of body.matchAll(elementRe)) raw[/\bname="([^"]*)"/.exec(m[3])![1]] = m[0];

  const serialize = (d: unknown): string => {
    const obj = isObj(d) ? d : newObj();
    const blocks: string[] = [];
    for (const e of entries) {
      const attr = e.translatable ? "" : ' translatable="false"';
      let tag: string;
      if (!e.translatable) {
        tag = (raw[e.name] as string).replace(/^<!--[\s\S]*?-->\s*\r?\n\s*/, "");
      } else if (e.kind === "string") {
        const v = typeof obj[e.name] === "string" ? (obj[e.name] as string) : "";
        tag = `<string name="${escapeAndroidXml(e.name)}"${attr}>${escapeAndroidXml(v)}</string>`;
      } else if (e.kind === "array") {
        const items = Array.isArray(obj[e.name]) ? (obj[e.name] as unknown[]) : [];
        const lines = items.map((v) => `${indent}${indent}<item>${escapeAndroidXml(typeof v === "string" ? v : "")}</item>`);
        tag = `<string-array name="${escapeAndroidXml(e.name)}"${attr}>\n${lines.join("\n")}\n${indent}</string-array>`;
      } else {
        const plural = isObj(obj[e.name]) ? (obj[e.name] as Obj) : newObj();
        const lines = CATEGORIES.filter((c) => typeof plural[c] === "string").map(
          (c) => `${indent}${indent}<item quantity="${c}">${escapeAndroidXml(plural[c] as string)}</item>`,
        );
        tag = `<plurals name="${escapeAndroidXml(e.name)}"${attr}>\n${lines.join("\n")}\n${indent}</plurals>`;
      }
      blocks.push(e.comment ? `${indent}${e.comment}\n${indent}${tag}` : `${indent}${tag}`);
    }
    return withNewline(`${before}\n${blocks.join("\n")}\n${after}`, keepNewline);
  };
  return { data, serialize };
}

/** XLIFF's `&entity;` references and `<![CDATA[...]]>` — there's no backslash-escape convention to also handle, unlike Android's XML. */
function unescapeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Any opening/closing/self-closing tag — the same generic shape placeholders.ts already protects (`<b>`, `<x id="..."/>`, `<g id="1">...</g>`). */
const XML_TAG_RE = /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>/g;

/** Escapes `&`/`<`/`>` in plain text while leaving any inline tag (see XML_TAG_RE) completely untouched, so a translated value's own `<x .../>`/`<g>...</g>` markup — carried through verbatim by the placeholder masking — stays valid, literal XML instead of getting entity-escaped into text. */
function escapeXmlKeepTags(s: string): string {
  const escapeText = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let out = "";
  let last = 0;
  for (const m of s.matchAll(XML_TAG_RE)) {
    out += escapeText(s.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + escapeText(s.slice(last));
}

/** Sets (inserting if absent) one attribute on a single opening XML tag's raw text. */
function setXmlAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*"[^"]*"`);
  return re.test(tag) ? tag.replace(re, `${name}="${value}"`) : tag.replace(/\/?>$/, (end) => ` ${name}="${value}"${end}`);
}

interface XliffUnit {
  id: string;
  attrsRaw: string;
  translatable: boolean;
  sourceInner: string;
  targetInner?: string;
  noteBlock: string;
  whole: string;
  /** The opening `<trans-unit>` tag's own indent, so a regenerated unit matches its actual nesting depth, not a single document-wide guess. */
  indent: string;
}
type XliffSegment = { text: string } | { unit: number };

/** Splits XLIFF text into literal passthrough segments and parsed `<trans-unit>` entries, ignoring the surrounding `<file>`/`<body>`/`<group>` nesting (it's never rewritten, just reproduced). */
function parseXliffUnits(text: string): { segments: XliffSegment[]; units: XliffUnit[] } {
  const unitRe = /<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/g;
  const segments: XliffSegment[] = [];
  const units: XliffUnit[] = [];
  let last = 0;
  for (const m of text.matchAll(unitRe)) {
    const before = text.slice(last, m.index);
    segments.push({ text: before });
    const [whole, attrsRaw, inner] = m;
    const idMatch = /\bid="([^"]*)"/.exec(attrsRaw);
    const sourceMatch = /<source\b[^>]*>([\s\S]*?)<\/source>/.exec(inner);
    if (!idMatch || !sourceMatch) {
      segments.push({ text: whole });
    } else {
      const targetMatch = /<target\b[^>]*>([\s\S]*?)<\/target>/.exec(inner);
      const noteMatch = /<note\b[^>]*>[\s\S]*?<\/note>/.exec(inner);
      const translatable = !/\btranslate\s*=\s*"no"/.test(attrsRaw) && !/<(?:bpt|ept)\b/.test(sourceMatch[1]);
      const lineIndent = /[ \t]*$/.exec(before)![0];
      units.push({
        id: unescapeXml(idMatch[1]),
        attrsRaw,
        translatable,
        sourceInner: sourceMatch[1],
        targetInner: targetMatch?.[1],
        noteBlock: noteMatch?.[0] ?? "",
        whole,
        indent: before.includes("\n") ? lineIndent : "",
      });
      segments.push({ unit: units.length - 1 });
    }
    last = m.index! + whole.length;
  }
  segments.push({ text: text.slice(last) });
  return { segments, units };
}

/**
 * XLIFF 1.2 (`<xliff version="1.2">`, the default for Qt Linguist, Angular's
 * `ng extract-i18n`, and most CAT tools): each `<trans-unit id="...">` holds a
 * `<source>` (always present) and a `<target>` (present once translated). A unit's
 * inline markup — Angular's `<x id="INTERPOLATION" .../>`, or a generic `<g id="1">
 * ... </g>` — is carried through to translation as literal text rather than stripped:
 * it's exactly the shape `placeholders.ts` already protects for HTML-ish i18n values
 * (`<b>`, `<Trans/>`), so it survives untouched with zero extra code. `translate="no"`
 * units, and the rarer `<bpt>`/`<ept>` paired-tag markup (a different, non-nesting
 * convention XLIFF also allows but modern tools rarely emit), are left completely
 * untouched instead. `<note>` comments are kept from the source.
 *
 * Like Android/ARB/`.xcstrings`, this regenerates each unit from the *source's* own
 * structure every run rather than editing an existing target in place — a translator's
 * own `<target state="...">` attribute (if any) won't survive a rerun, the same
 * documented tradeoff Android already makes for its own comments.
 *
 * Only reached via `--input <file>.xlf`/`.xliff`: the source file's name carries no
 * locale tag at all (XLIFF puts it in `source-language` instead), so there's no
 * filename convention to auto-detect from.
 */
function readXliffDoc(file: string, text: string, isSource: boolean): LocaleDoc {
  if (!/<file\b[^>]*>/.test(text)) throw new Error(`Invalid XLIFF in ${file}: no <file> element found.`);
  const { segments, units } = parseXliffUnits(text);
  const data = newObj();
  for (const u of units) {
    if (!u.translatable) continue;
    const v = isSource ? u.sourceInner : u.targetInner;
    if (v !== undefined) data[u.id] = unescapeXml(v);
  }
  const step = /\r?\n([ \t]+)</.exec(text)?.[1] ?? "    ";
  const keepNewline = finalNewline(text);
  const serialize = (d: unknown, targetTag: string): string => {
    const obj = isObj(d) ? d : newObj();
    let patchedFileTag = false;
    const parts = segments.map((seg) => {
      if ("text" in seg) {
        if (!patchedFileTag && /<file\b[^>]*>/.test(seg.text)) {
          patchedFileTag = true;
          return seg.text.replace(/<file\b[^>]*>/, (tag) => setXmlAttr(tag, "target-language", targetTag));
        }
        return seg.text;
      }
      const u = units[seg.unit];
      if (!u.translatable) return u.whole;
      const v = typeof obj[u.id] === "string" ? (obj[u.id] as string) : "";
      const inner = u.indent + step;
      const noteLine = u.noteBlock ? `\n${inner}${u.noteBlock}` : "";
      return `<trans-unit${u.attrsRaw}>\n${inner}<source>${u.sourceInner}</source>\n${inner}<target>${escapeXmlKeepTags(v)}</target>${noteLine}\n${u.indent}</trans-unit>`;
    });
    return withNewline(parts.join(""), keepNewline);
  };
  return { data, serialize };
}

interface ResxEntry {
  name: string;
  translatable: boolean;
  valueInner?: string;
  comment?: string;
  attrsRaw: string;
  whole: string;
  indent: string;
}
type ResxSegment = { text: string } | { entry: number };

/** Splits .resx text into literal passthrough segments (the `<root>` wrapper, `<resheader>` boilerplate) and parsed `<data>` entries. */
function parseResxEntries(text: string): { segments: ResxSegment[]; entries: ResxEntry[] } {
  const dataRe = /<data\b([^>]*)>([\s\S]*?)<\/data>/g;
  const segments: ResxSegment[] = [];
  const entries: ResxEntry[] = [];
  let last = 0;
  for (const m of text.matchAll(dataRe)) {
    const before = text.slice(last, m.index);
    segments.push({ text: before });
    const [whole, attrsRaw, inner] = m;
    const nameMatch = /\bname="([^"]*)"/.exec(attrsRaw);
    if (!nameMatch) {
      segments.push({ text: whole });
    } else {
      const nonString = /\btype\s*=\s*"[^"]*"/.test(attrsRaw) || /\bmimetype\s*=\s*"[^"]*"/.test(attrsRaw);
      const valueMatch = /<value\b[^>]*>([\s\S]*?)<\/value>/.exec(inner);
      const commentMatch = /<comment\b[^>]*>([\s\S]*?)<\/comment>/.exec(inner);
      const lineIndent = /[ \t]*$/.exec(before)![0];
      entries.push({
        name: unescapeXml(nameMatch[1]),
        translatable: !nonString && !!valueMatch,
        valueInner: valueMatch?.[1],
        comment: commentMatch ? unescapeXml(commentMatch[1]) : undefined,
        attrsRaw,
        whole,
        indent: before.includes("\n") ? lineIndent : "",
      });
      segments.push({ entry: entries.length - 1 });
    }
    last = m.index! + whole.length;
  }
  segments.push({ text: text.slice(last) });
  return { segments, entries };
}

/**
 * .NET `.resx`: each string resource is `<data name="Key" xml:space="preserve">
 * <value>...</value></data>` under `<root>`, alongside required `<resheader>`
 * boilerplate (`resmimetype`, `version`, the reader/writer class names — kept
 * untouched) and possibly non-string resources: `<data type="...">` or a `mimetype`
 * attribute marks an image, icon or other base64-encoded binary blob, left
 * completely alone rather than mistaken for text. An optional `<comment>` sibling is
 * a developer note, kept from the source. There's no plural convention of its own; a
 * `{0}`-style .NET format placeholder is already protected by the same generic
 * `{name}`/`{0}` pattern every other format gets.
 *
 * Like Android/ARB/`.xcstrings`/XLIFF, each entry is regenerated from the source's
 * own structure every run rather than edited in place. Unlike every XML format here
 * except xliff, .resx carries no locale metadata of its own to cross-check `--from`
 * against — the file's culture comes entirely from its name.
 */
function readResxDoc(file: string, text: string): LocaleDoc {
  if (!/<root\b[^>]*>/.test(text)) throw new Error(`Invalid .resx in ${file}: no <root> element found.`);
  const { segments, entries } = parseResxEntries(text);
  const data = newObj();
  for (const e of entries) if (e.translatable && e.valueInner !== undefined) data[e.name] = unescapeXml(e.valueInner);
  const step = /\r?\n([ \t]+)</.exec(text)?.[1] ?? "  ";
  const keepNewline = finalNewline(text);
  const serialize = (d: unknown): string => {
    const obj = isObj(d) ? d : newObj();
    const parts = segments.map((seg) => {
      if ("text" in seg) return seg.text;
      const e = entries[seg.entry];
      if (!e.translatable) return e.whole;
      const v = typeof obj[e.name] === "string" ? (obj[e.name] as string) : "";
      const inner = e.indent + step;
      const commentLine = e.comment !== undefined ? `\n${inner}<comment>${escapeXmlKeepTags(e.comment)}</comment>` : "";
      return `<data${e.attrsRaw}>\n${inner}<value>${escapeXmlKeepTags(v)}</value>${commentLine}\n${e.indent}</data>`;
    });
    return withNewline(parts.join(""), keepNewline);
  };
  return { data, serialize };
}

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
  [key: string]: { comment?: string; nested?: JsMetaNode };
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
    if (comment !== undefined || childMeta) meta[key] = { comment, nested: childMeta };
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
    return `${commentLine}${pad}${jsKeyLiteral(k, quote)}: ${serializeJsValue(obj[k], m?.nested, level + 1, step, quote)}`;
  });
  return `{\n${lines.join(",\n")},\n${step.repeat(level)}}`;
}

function readJsModuleDoc(file: string, text: string): LocaleDoc {
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

/** True when `entry` uses a per-device variant (`variations.iphone`/`.ipad`/...) for `tag`, not just a plural. */
function xcstringsHasDeviceVariant(entry: Obj): boolean {
  const locs = entry.localizations;
  if (!isObj(locs)) return false;
  return Object.values(locs).some(
    (loc) => isObj(loc) && isObj(loc.variations) && Object.keys(loc.variations as Obj).some((k) => k !== "plural"),
  );
}

/** `shouldTranslate: false`, multi-variable `substitutions`, or any per-device variant — left untouched. */
function xcstringsSkip(entry: unknown): boolean {
  return !isObj(entry) || entry.shouldTranslate === false || entry.substitutions !== undefined || xcstringsHasDeviceVariant(entry);
}

/** An entry's value for one locale: a plain string, a `{zero,one,...}` plural object, or undefined if untranslated. */
function xcstringsValue(entry: Obj, tag: string): unknown {
  const loc = (entry.localizations as Obj | undefined)?.[tag] as Obj | undefined;
  if (!loc) return undefined;
  const plural = (loc.variations as Obj | undefined)?.plural as Obj | undefined;
  if (plural) {
    const out = newObj();
    for (const cat of CATEGORIES) {
      const v = ((plural[cat] as Obj | undefined)?.stringUnit as Obj | undefined)?.value;
      if (typeof v === "string") out[cat] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  const v = (loc.stringUnit as Obj | undefined)?.value;
  return typeof v === "string" ? v : undefined;
}

/**
 * Apple's `.xcstrings` String Catalog (Xcode 15+'s default, replacing `.strings`):
 * unlike every other format here, ALL locales — source included — live in ONE JSON
 * file, keyed by the string's own identifier under `strings`. Each entry's
 * `localizations.<tag>` holds either a plain `stringUnit` or, for a plural string, a
 * `variations.plural` object whose zero/one/two/few/many/other categories are exactly
 * the shape `addNestedPluralForms` already understands (see Android/Rails), so it's
 * reused unchanged. An entry with no `localizations.<sourceLanguage>` at all falls
 * back to its own key as the source text, matching Xcode's own convention for a
 * string that was never given explicit source content.
 *
 * `shouldTranslate: false`, Xcode's per-device variants (`variations.iphone`/`.ipad`),
 * and multi-variable strings (`substitutions`, used with `%#@name@`-style format
 * references) are all left completely untouched rather than mistranslated — a bigger
 * matrix than a single cardinal plural isn't supported yet.
 *
 * `targetFile`/`sourceFiles` point every locale at this same one file, so each
 * locale's turn re-reads it fresh (via `existingText`) before writing — the same
 * read-then-write-fresh sequencing the CLI already does per locale, which is what
 * lets several locales share one file safely in a single run without clobbering each
 * other. A key's translated value is only ever replaced, never its `state`/metadata,
 * when the value hasn't actually changed — so a translator's own "needs_review" flag
 * on an untouched entry survives a rerun.
 */
function readXcstringsDoc(file: string, text: string, tag: string, isSource: boolean): LocaleDoc {
  let raw: Obj;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid .xcstrings (JSON) in ${file}: ${(e as Error).message}`);
  }
  const strings = isObj(raw.strings) ? (raw.strings as Obj) : {};
  const data = newObj();
  for (const key of Object.keys(strings)) {
    const entry = strings[key];
    if (xcstringsSkip(entry)) continue;
    const v = xcstringsValue(entry as Obj, tag);
    if (v !== undefined) data[key] = v;
    else if (isSource) data[key] = key;
  }
  const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? 2;
  const keepNewline = finalNewline(text);

  const serialize = (d: unknown, targetTag: string, existingText?: string): string => {
    const obj = isObj(d) ? d : newObj();
    let out: Obj = raw;
    if (existingText !== undefined) {
      try {
        out = JSON.parse(existingText);
      } catch {
        out = raw;
      }
    }
    const outStrings = isObj(out.strings) ? (out.strings as Obj) : (out.strings = newObj());
    for (const key of Object.keys(obj)) {
      const entry = outStrings[key];
      if (xcstringsSkip(entry)) continue;
      const newVal = obj[key];
      const curVal = xcstringsValue(entry as Obj, targetTag);
      if (JSON.stringify(curVal) === JSON.stringify(newVal)) continue;
      const locs = isObj((entry as Obj).localizations) ? ((entry as Obj).localizations as Obj) : ((entry as Obj).localizations = newObj());
      if (isObj(newVal)) {
        const plural = newObj();
        for (const cat of CATEGORIES) {
          if (typeof (newVal as Obj)[cat] === "string") {
            plural[cat] = { stringUnit: { state: "translated", value: (newVal as Obj)[cat] } };
          }
        }
        locs[targetTag] = { variations: { plural } };
      } else if (typeof newVal === "string") {
        locs[targetTag] = { stringUnit: { state: "translated", value: newVal } };
      }
    }
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

/** Adds a `#, fuzzy` gettext flag to a comment block, merging onto an existing `#,` line rather than duplicating it. */
function withFuzzyFlag(comments: string[]): string[] {
  const i = comments.findIndex((c) => /^#,/.test(c));
  if (i === -1) return [...comments, "#, fuzzy"];
  if (/\bfuzzy\b/.test(comments[i])) return comments;
  return comments.map((c, j) => (j === i ? `${c}, fuzzy` : c));
}

function readPoDoc(file: string, text: string, isSource: boolean, fuzzy: boolean): LocaleDoc {
  const { entries, leading } = parsePo(text);
  const data = newObj();
  for (const e of entries) {
    if (e.isHeader) continue;
    if (e.msgidPlural === undefined) {
      // A template (.pot) or a project that keeps the English text in msgid and
      // leaves the source .po's own msgstr empty: fall back to msgid so the source
      // text isn't just "", which would otherwise translate every entry to nothing
      // with no warning. Never done for a target file, where an empty msgstr
      // legitimately means "not translated yet".
      data[poKey(e)] = isSource && e.msgstr === "" ? e.msgid : e.msgstr;
    } else {
      // Like msgstr for a singular entry, msgstrPlural holds this FILE's own text: the
      // English source form in the source .po, the translated forms in a target .po
      // (msgid/msgid_plural are the stable keys, identical across every locale).
      const forms = e.msgstrPlural ?? [];
      const useMsgid = isSource && forms.every((f) => f === "");
      data[pluralOneKey(e)] = useMsgid ? e.msgid : forms[0] ?? "";
      data[pluralOtherKey(e)] = useMsgid ? e.msgidPlural! : forms[forms.length - 1] ?? forms[0] ?? "";
    }
  }
  const keepNewline = finalNewline(text);
  const serialize = (d: unknown, targetTag: string, existingText?: string): string => {
    const obj = isObj(d) ? d : newObj();
    const seen = new Set<string>();
    const blocks: string[] = leading.length ? [leading.join("\n")] : [];
    const existingEntries = existingText ? parsePo(existingText).entries : [];
    // A previous run may have left a header a translator then hand-fixed (a corrected
    // Plural-Forms, an added Last-Translator, ...). Keep it as-is rather than
    // regenerating from the source every time; only a brand-new target file gets a
    // freshly computed header.
    const existingHeader = existingEntries.find((e) => e.isHeader);
    // Comments (translator notes, `#, fuzzy` flags, ...) a translator may have added
    // directly to the target file, keyed the same way entries are. Previously
    // serialize always used the SOURCE's own comments for every entry, silently
    // wiping anything a translator had added to the target on the very next run.
    const existingByKey = new Map(existingEntries.filter((e) => !e.isHeader).map((e) => [poKey(e), e]));
    for (const e of entries) {
      if (e.isHeader) {
        const lines = [...e.comments, `msgid ""`];
        const header = existingHeader
          ? existingHeader.msgstr
          : e.msgstr.replace(/^Language:.*$/m, `Language: ${targetTag}`).replace(/^Plural-Forms:.*$/m, `Plural-Forms: ${pluralFormsHeader(targetTag)}`);
        lines.push(`msgstr "${escapeC(header)}"`);
        blocks.push(lines.join("\n"));
        continue;
      }
      const existingEntry = existingByKey.get(poKey(e));
      let comments = existingEntry?.comments ?? e.comments;
      const content: string[] = [];
      if (e.msgctxt !== undefined) content.push(`msgctxt "${escapeC(e.msgctxt)}"`);
      let changed: boolean;
      if (e.msgidPlural !== undefined) {
        content.push(`msgid "${escapeC(e.msgid)}"`, `msgid_plural "${escapeC(e.msgidPlural)}"`);
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
        for (let i = 0; i < n; i++) content.push(`msgstr[${i}] "${escapeC(n === 1 ? other : i === 0 ? one : other)}"`);
        const forms = existingEntry?.msgstrPlural;
        changed = !forms || forms[0] !== one || forms[forms.length - 1] !== other;
      } else {
        const key = poKey(e);
        seen.add(key);
        const v = typeof obj[key] === "string" ? (obj[key] as string) : "";
        content.push(`msgid "${escapeC(e.msgid)}"`, `msgstr "${escapeC(v)}"`);
        changed = existingEntry?.msgstr !== v;
      }
      if (fuzzy && changed) comments = withFuzzyFlag(comments);
      blocks.push([...comments, ...content].join("\n"));
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

/**
 * Decodes a locale file's raw bytes to text, detecting a UTF-16 BOM first — Xcode's
 * traditional default for `.strings` files, which `fs.readFileSync(file, "utf8")`
 * would otherwise mangle into unreadable text (and then "no entries found").
 */
function readText(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8").replace(/^﻿/, "");
}

/**
 * `tag` is the locale this file is for (the source tag, or an existing target's own
 * tag). `isSource` marks this as the FROM-locale file being read as the thing to
 * translate (as opposed to an already-existing target) — only then does a `.po`
 * entry's empty `msgstr` fall back to `msgid` as the source text (see readPoDoc).
 * `fuzzy`, for `.po`/`.pot` only, marks every entry this run actually (re)translated
 * with gettext's standard `#, fuzzy` "needs review" flag.
 */
export function readLocaleDoc(file: string, tag: string, isSource = false, fuzzy = false): LocaleDoc {
  const text = readText(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return readYamlDoc(file, text, tag);
  if (ext === ".po" || ext === ".pot") return readPoDoc(file, text, isSource, fuzzy);
  if (ext === ".arb") return readArbDoc(file, text);
  if (ext === ".strings") return readStringsDoc(file, text);
  if (ext === ".properties") return readPropertiesDoc(file, text);
  if (ext === ".xml") return readAndroidXmlDoc(file, text);
  if (ext === ".xcstrings") return readXcstringsDoc(file, text, tag, isSource);
  if (ext === ".xlf" || ext === ".xliff") return readXliffDoc(file, text, isSource);
  if (ext === ".resx") return readResxDoc(file, text);
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts") return readJsModuleDoc(file, text);
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
  isStale?: (path: string, source: string) => boolean,
): string[] {
  const out: string[] = [];
  const visit = (s: unknown, e: unknown, path: string): void => {
    if (typeof s === "string") {
      if (!isProtected?.(path) && (needsTranslation(e, overwrite) || !!isStale?.(path, s))) out.push(s);
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
 * translations kept (unless overwrite or stale), new strings from `translate`,
 * and keys that only exist in the target preserved at the end. A string at a
 * protected path (see keyPathProtect) is always copied from the source
 * verbatim. `isStale` (see the lock module) forces re-translation of a
 * non-empty target when its source string has changed since it was last
 * translated.
 */
export function buildTarget(
  source: unknown,
  existing: unknown,
  translate: (s: string) => string,
  overwrite: boolean,
  isProtected?: (path: string) => boolean,
  isStale?: (path: string, source: string) => boolean,
): unknown {
  const visit = (s: unknown, e: unknown, path: string): unknown => {
    if (typeof s === "string") {
      if (isProtected?.(path)) return s;
      return needsTranslation(e, overwrite) || isStale?.(path, s) ? translate(s) : e;
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
 * True for the file extensions that use i18next's `key_one`/`key_other` plural-key
 * convention (flat JSON/YAML locale trees). A `.po`, `.arb` or `.strings` file might
 * happen to have a key ending the same way without meaning it as an i18next plural,
 * so addPluralForms should only ever run on these.
 */
export function usesI18nextPlurals(file: string): boolean {
  return /\.(json|ya?ml)$/i.test(file);
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

/**
 * Rails and some other frameworks nest plural forms under the key itself
 * (`item:\n  one: "%{count} item"\n  other: "%{count} items"`) instead of i18next's
 * `item_one`/`item_other` suffix convention. A value is treated as a plural group
 * when every one of its keys is a CLDR plural category and "other" (the mandatory
 * fallback) is among them and there's at least one more alongside it — a single
 * `{ other: "..." }` object is too common as an ordinary translation value (e.g. a
 * key literally named "other") to treat as a plural group on its own.
 */
export function addNestedPluralForms(doc: unknown, targetLang: string): { doc: unknown; added: number } {
  let added = 0;
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (!isObj(v)) return v;
    const keys = Object.keys(v);
    const isGroup =
      keys.length >= 2 && keys.includes("other") && keys.every((k) => CATEGORIES.includes(k) && typeof v[k] === "string");
    if (!isGroup) {
      const out = newObj();
      for (const k of keys) out[k] = visit(v[k]);
      return out;
    }
    let needed: string[];
    try {
      needed = new Intl.PluralRules(targetLang).resolvedOptions().pluralCategories as string[];
    } catch {
      needed = keys;
    }
    const other = v.other as string;
    const out = newObj();
    for (const cat of CATEGORIES) {
      if (keys.includes(cat)) out[cat] = v[cat];
      else if (needed.includes(cat)) {
        out[cat] = other;
        added++;
      }
    }
    return out;
  };
  return { doc: visit(doc), added };
}
