/** Generic XML entity/tag helpers shared by XLIFF, .resx, and (for XML_TAG_RE only) Android's own escaping. */

/** XLIFF/.resx's `&entity;` references and `<![CDATA[...]]>` — there's no backslash-escape convention to also handle, unlike Android's XML. */
export function unescapeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Any opening/closing/self-closing tag — the same generic shape placeholders.ts already protects (`<b>`, `<x id="..."/>`, `<g id="1">...</g>`). */
export const XML_TAG_RE = /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>/g;

/** Escapes `&`/`<`/`>` in plain text while leaving any inline tag (see XML_TAG_RE) completely untouched, so a translated value's own `<x .../>`/`<g>...</g>` markup — carried through verbatim by the placeholder masking — stays valid, literal XML instead of getting entity-escaped into text. */
export function escapeXmlKeepTags(s: string): string {
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
export function setXmlAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*"[^"]*"`);
  return re.test(tag) ? tag.replace(re, `${name}="${value}"`) : tag.replace(/\/?>$/, (end) => ` ${name}="${value}"${end}`);
}
