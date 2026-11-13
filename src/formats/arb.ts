import { finalNewline, isObj, type LocaleDoc, newObj, type Obj, withNewline } from "./shared.ts";

/** ARB (Flutter): plain JSON, but "@key" / "@@locale" entries are metadata, not translatable content. */
export function readArbDoc(file: string, text: string): LocaleDoc {
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
