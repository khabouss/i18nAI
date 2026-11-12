import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Supported layouts:
 *   dir:  <root>/en/common.json, <root>/en/auth/login.json  ->  <root>/fr/...
 *   file: <root>/en.json                                    ->  <root>/fr.json
 *
 * Both layouts accept ".json", ".yaml" or ".yml" files, independently per file.
 */
export interface Layout {
  kind: "dir" | "file";
  root: string;
  /** For kind "file": the source file's extension (".json", ".yaml" or ".yml"). */
  ext?: string;
}

const EXTENSIONS = [".json", ".yaml", ".yml"];

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
    if (!l) throw new Error(`No "${from}" locale found in ${input} (looked for ${from}/*.json and ${from}.json/.yaml/.yml).`);
    return l;
  }
  for (const c of CANDIDATES) {
    const l = layoutAt(path.resolve(cwd, c), from);
    if (l) return l;
  }
  throw new Error(
    `Could not find "${from}" locale files. Use --input <dir> to point at the folder containing ${from}/ or ${from}.json/.yaml/.yml.`,
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

/** A parsed locale file plus enough of its original style to re-render an edited copy the same way. */
export interface LocaleDoc {
  data: unknown;
  /** Renders `data` (the built target, or the unchanged source) in this file's format and style. */
  serialize(data: unknown): string;
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

function readYamlDoc(file: string, text: string): LocaleDoc {
  let data: unknown;
  try {
    data = parseYaml(text) ?? {};
  } catch (e) {
    throw new Error(`Invalid YAML in ${file}: ${(e as Error).message}`);
  }
  const indent = Number(/\n( +)\S/.exec(text)?.[1].length) || 2;
  const keepNewline = finalNewline(text);
  return { data, serialize: (d) => withNewline(stringifyYaml(d, { indent }), keepNewline) };
}

export function readLocaleDoc(file: string): LocaleDoc {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  return /\.ya?ml$/i.test(file) ? readYamlDoc(file, text) : readJsonDoc(file, text);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Null-prototype object so keys such as "__proto__" are stored as plain data. */
const newObj = (): Obj => Object.create(null) as Obj;

/** A string needs translating when the target has no non-empty string at the same path. */
const needsTranslation = (existing: unknown, overwrite: boolean) =>
  overwrite || typeof existing !== "string" || existing === "";

export function pendingStrings(source: unknown, existing: unknown, overwrite: boolean, out: string[] = []): string[] {
  if (typeof source === "string") {
    if (needsTranslation(existing, overwrite)) out.push(source);
  } else if (Array.isArray(source)) {
    source.forEach((v, i) => pendingStrings(v, Array.isArray(existing) ? existing[i] : undefined, overwrite, out));
  } else if (isObj(source)) {
    for (const k of Object.keys(source)) pendingStrings(source[k], isObj(existing) ? existing[k] : undefined, overwrite, out);
  }
  return out;
}

/**
 * Builds the target document: source structure and key order, existing
 * translations kept (unless overwrite), new strings from `translate`, and keys
 * that only exist in the target preserved at the end.
 */
export function buildTarget(
  source: unknown,
  existing: unknown,
  translate: (s: string) => string,
  overwrite: boolean,
): unknown {
  if (typeof source === "string") {
    return needsTranslation(existing, overwrite) ? translate(source) : existing;
  }
  if (Array.isArray(source)) {
    return source.map((v, i) => buildTarget(v, Array.isArray(existing) ? existing[i] : undefined, translate, overwrite));
  }
  if (isObj(source)) {
    const out = newObj();
    for (const k of Object.keys(source)) {
      out[k] = buildTarget(source[k], isObj(existing) ? existing[k] : undefined, translate, overwrite);
    }
    if (isObj(existing)) for (const k of Object.keys(existing)) if (!(k in out)) out[k] = existing[k];
    return out;
  }
  return source;
}

const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_KEY = /^(.+?)(_ordinal)?_(zero|one|two|few|many|other)$/;

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
