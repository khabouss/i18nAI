import { escapeC, finalNewline, isObj, type LocaleDoc, newObj, unescapeC, withNewline } from "./shared.ts";

/** Apple .strings: `"key" = "value";`, optionally preceded by a `/* ... *\/` comment. */
export function readStringsDoc(file: string, text: string): LocaleDoc {
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
