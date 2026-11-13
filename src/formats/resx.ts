import { finalNewline, isObj, type LocaleDoc, newObj, withNewline } from "./shared.ts";
import { escapeXmlKeepTags, unescapeXml } from "./xml.ts";

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
export function readResxDoc(file: string, text: string): LocaleDoc {
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
