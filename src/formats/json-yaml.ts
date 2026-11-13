import { Document, isMap, isScalar, parseDocument } from "yaml";
import { finalNewline, isObj, type LocaleDoc, type Obj, withNewline } from "./shared.ts";

export function readJsonDoc(file: string, text: string): LocaleDoc {
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
export function readYamlDoc(file: string, text: string, tag: string): LocaleDoc {
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
