import path from "node:path";
import { parseLocale, type Locale } from "./lang.ts";

/**
 * One translation model: a MarianMT / OPUS-MT checkpoint converted to ONNX
 * (encoder + merged decoder, vocab.json, source.spm, config.json).
 *
 * Built-in entries point at Hugging Face repos; projects can add their own
 * (local folders or repos) in locale-ai.config.json.
 */
export interface ModelEntry {
  /** Stable id used on the command line, e.g. "en-fr". */
  id: string;
  /** Hugging Face repository holding the ONNX conversion. */
  repo?: string;
  /** Local folder holding the ONNX conversion (custom models). */
  path?: string;
  /** Project-configured models win over built-ins for the same pair. */
  custom?: boolean;
  /** Source language codes this model accepts. */
  sources: string[];
  /** Target language codes this model produces. */
  targets: string[];
  /**
   * Multi-target models need a ">>xx<<" token at the start of every input to pick
   * the output language. Returns undefined when the model is single-target.
   */
  prefix?: (target: Locale) => string;
}

/** A model applied to one leg of a translation route. */
export interface Hop {
  model: ModelEntry;
  prefix?: string;
}

const pair = (src: string, tgt: string): ModelEntry => ({
  id: `${src}-${tgt}`,
  repo: `Xenova/opus-mt-${src}-${tgt}`,
  sources: [src],
  targets: [tgt],
});

const DIRECT = [
  "af-en", "ar-en", "cs-en", "da-de", "da-en", "de-en", "de-es", "de-fr",
  "en-af", "en-cs", "en-da", "en-de", "en-es", "en-fi", "en-fr", "en-hi",
  "en-hu", "en-id", "en-it", "en-nl", "en-ro", "en-ru", "en-sv", "en-uk",
  "en-xh", "es-de", "es-en", "es-fr", "es-it", "es-ru", "et-en", "fi-de",
  "fi-en", "fr-de", "fr-en", "fr-es", "fr-ro", "fr-ru", "hi-en", "hu-en",
  "id-en", "it-en", "it-es", "it-fr", "ja-en", "ko-en", "nl-en", "nl-fr",
  "no-de", "pl-en", "ro-fr", "ru-en", "ru-es", "ru-fr", "ru-uk", "sv-en",
  "th-en", "tr-en", "uk-en", "uk-ru", "vi-en", "xh-en", "zh-en",
];

const ROMANCE = ["es", "pt", "ca", "gl", "oc", "it", "ro", "fr"];

export const CATALOG: ModelEntry[] = [
  ...DIRECT.map((p) => {
    const [s, t] = p.split("-");
    return pair(s, t);
  }),
  {
    // Note: the model card lists Moroccan Arabic ("ary") but its vocabulary has no
    // >>ary<< token, so Darija is not supported.
    ...pair("en", "ar"),
    prefix: () => ">>ara<<",
  },
  {
    ...pair("en", "zh"),
    prefix: (t) =>
      t.script === "Hant" || ["TW", "HK", "MO"].includes(t.region ?? "") ? ">>cmn_Hant<<" : ">>cmn_Hans<<",
  },
  { ...pair("en", "vi"), prefix: () => ">>vie<<" },
  {
    id: "en-ROMANCE",
    repo: "Xenova/opus-mt-en-ROMANCE",
    sources: ["en"],
    targets: ROMANCE,
    prefix: (t) => {
      if (t.lang === "pt" && t.region === "BR") return ">>pt_BR<<";
      if (t.lang === "pt" && t.region === "PT") return ">>pt_PT<<";
      return `>>${t.lang}<<`;
    },
  },
  {
    id: "ROMANCE-en",
    repo: "Xenova/opus-mt-ROMANCE-en",
    sources: ROMANCE,
    targets: ["en"],
  },
];

/** A model declared in locale-ai.config.json. */
export interface CustomModelConfig {
  id?: string;
  source: string | string[];
  target: string | string[];
  /** Hugging Face repo with the ONNX conversion... */
  repo?: string;
  /** ...or a local folder (relative to the config file). */
  path?: string;
  /** ">>xx<<" token for multi-target models: one for all targets, or per target. */
  prefix?: string | Record<string, string>;
}

const asList = (v: string | string[]) => (Array.isArray(v) ? v : [v]).map((x) => parseLocale(x).lang);

export function customEntries(models: CustomModelConfig[] | undefined, configDir: string): ModelEntry[] {
  return (models ?? []).map((c, i) => {
    if (!c.repo === !c.path) throw new Error(`models[${i}]: set exactly one of "repo" or "path".`);
    if (!c.source || !c.target) throw new Error(`models[${i}]: "source" and "target" are required.`);
    const sources = asList(c.source);
    const targets = asList(c.target);
    const prefix = c.prefix;
    return {
      id: c.id ?? `custom:${sources.join("+")}-${targets.join("+")}`,
      repo: c.repo,
      path: c.path ? path.resolve(configDir, c.path) : undefined,
      custom: true,
      sources,
      targets,
      prefix:
        prefix === undefined
          ? undefined
          : (t: Locale) => (typeof prefix === "string" ? prefix : (prefix[t.tag] ?? prefix[t.lang])),
    };
  });
}

export function findById(id: string, catalog: ModelEntry[] = CATALOG): ModelEntry | undefined {
  const lower = id.toLowerCase();
  return catalog.find((m) => m.id.toLowerCase() === lower || m.repo?.toLowerCase() === lower);
}

/** Best single model for a pair: custom models first, then dedicated pair models over multi-target ones. */
function direct(src: string, tgt: Locale, catalog: ModelEntry[]): Hop | undefined {
  const candidates = catalog.filter((m) => m.sources.includes(src) && m.targets.includes(tgt.lang));
  const rank = (m: ModelEntry) => (m.custom ? 0 : 1000) + m.targets.length + m.sources.length;
  candidates.sort((a, b) => rank(a) - rank(b));
  const model = candidates[0];
  return model && { model, prefix: model.prefix?.(tgt) };
}

const EN: Locale = { tag: "en", lang: "en" };

/**
 * Finds the models needed to go from `source` to `target`: a direct model when one
 * exists, otherwise a pivot through English. Returns undefined when unsupported.
 */
export function resolveRoute(source: Locale, target: Locale, catalog: ModelEntry[] = CATALOG): Hop[] | undefined {
  if (source.lang === target.lang) return undefined;
  const d = direct(source.lang, target, catalog);
  if (d) return [d];
  if (source.lang === "en" || target.lang === "en") return undefined;
  const a = direct(source.lang, EN, catalog);
  const b = direct("en", target, catalog);
  return a && b ? [a, b] : undefined;
}

/** Every language code reachable from `source` (direct or via English). */
export function reachableTargets(source: string, catalog: ModelEntry[] = CATALOG): string[] {
  const out = new Set<string>();
  for (const m of catalog) if (m.sources.includes(source)) m.targets.forEach((t) => out.add(t));
  if (source !== "en" && out.has("en")) {
    for (const m of catalog) if (m.sources.includes("en")) m.targets.forEach((t) => out.add(t));
  }
  out.delete(source);
  return [...out].sort();
}
