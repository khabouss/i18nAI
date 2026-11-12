/** A parsed BCP-47-ish locale tag such as "pt-BR", "zh_Hant", "en". */
export interface Locale {
  /** The tag as the user wrote it (used for directory / file names). */
  tag: string;
  /** Lower-case primary language subtag, e.g. "pt". */
  lang: string;
  /** Upper-case region, e.g. "BR". */
  region?: string;
  /** Title-case script, e.g. "Hant". */
  script?: string;
}

/** Language codes that are aliases of the code used by the translation models. */
const ALIASES: Record<string, string> = {
  nb: "no",
  nn: "no",
  iw: "he",
  in: "id",
  jw: "jv",
};

export function parseLocale(tag: string): Locale {
  const parts = tag.trim().replace(/_/g, "-").split("-").filter(Boolean);
  if (parts.length === 0 || !/^[a-zA-Z]{2,3}$/.test(parts[0])) {
    throw new Error(`Invalid locale "${tag}". Expected something like "fr", "pt-BR" or "zh-Hant".`);
  }
  const raw = parts[0].toLowerCase();
  const locale: Locale = { tag, lang: ALIASES[raw] ?? raw };
  for (const p of parts.slice(1)) {
    if (/^[a-zA-Z]{4}$/.test(p)) locale.script = p[0].toUpperCase() + p.slice(1).toLowerCase();
    else if (/^([a-zA-Z]{2}|\d{3})$/.test(p)) locale.region = p.toUpperCase();
  }
  return locale;
}

/** Locale code understood by Intl APIs (plural rules, segmentation, casing). */
export function intlCode(l: Locale): string {
  return [l.lang, l.script, l.region].filter(Boolean).join("-");
}
