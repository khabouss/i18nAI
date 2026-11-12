/**
 * vue-i18n's plural syntax: forms separated by a literal `|`, chosen by count at
 * runtime (`"no items | one item | {count} items"`). The `|` carries no meaning to
 * a translation model — it reads as stray punctuation and gets dropped or garbles
 * the sentence around it — so each form is translated on its own and the `|`
 * separators are kept untouched, exactly where they were.
 */

export interface PipeUnits {
  /** The text of each form, trimmed of the whitespace that surrounded its `|`. */
  units: string[];
  rebuild(translations: string[]): string;
}

/** Returns undefined when the string has no top-level `|` (ignoring one inside `{...}`). */
export function extractPipePlural(s: string): PipeUnits | undefined {
  const segments: Array<{ lead: string; core: string; trail: string }> = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const seg = s.slice(start, end);
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(seg)!;
    segments.push({ lead: m[1], core: m[2], trail: m[3] });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === "|" && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  if (start === 0) return undefined; // no top-level '|'
  push(s.length);
  if (segments.some((p) => !p.core)) return undefined; // "a||b" or a leading/trailing '|': not a plural list

  return {
    units: segments.map((p) => p.core),
    rebuild: (translations) => segments.map((p, i) => p.lead + translations[i] + p.trail).join("|"),
  };
}
