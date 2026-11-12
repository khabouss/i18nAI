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
  "en-af", "en-cs", "en-da", "en-de", "en-es", "en-fi", "en-hi",
  "en-hu", "en-id", "en-it", "en-nl", "en-ro", "en-sv",
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
  // tc-big: larger OPUS-MT checkpoints, clearly better than the defaults (see
  // bench/README.md). Converted and hosted per the README's "Add a language,
  // or a better model" section.
  { ...pair("en", "fr"), repo: "khabouss/opus-mt-tc-big-en-fr-onnx" }, // chrF 72.5 vs 68.9, BLEU 55.9 vs 53.7
  { ...pair("en", "es"), repo: "khabouss/opus-mt-tc-big-en-es-onnx" }, // chrF 73.6 vs 72.9, BLEU 57.4 vs 56.9
  { ...pair("en", "it"), repo: "khabouss/opus-mt-tc-big-en-it-onnx" }, // chrF 75.3 vs 73.8, BLEU 58.2 vs 54.9
  // New: Turkish, not supported by any built-in model before this.
  { ...pair("en", "tr"), repo: "khabouss/opus-mt-tc-big-en-tr-onnx" }, // chrF 67.4, BLEU 42.1
  {
    // Multi-target: >>por<< (European) / >>pob<< (Brazilian). No individual built-in
    // existed before; pt was only reachable via the weaker en-ROMANCE model.
    id: "en-pt",
    repo: "khabouss/opus-mt-tc-big-en-pt-onnx", // chrF 70.6 vs 68.3, BLEU 47.7 vs 44.4
    sources: ["en"],
    targets: ["pt"],
    prefix: (t) => (t.region === "BR" ? ">>pob<<" : ">>por<<"),
  },
  {
    // Multi-target East Slavic model, replaces the separate en-ru/en-uk built-ins.
    id: "en-zle",
    repo: "khabouss/opus-mt-tc-big-en-zle-onnx", // ru: chrF 68.2 vs 65.7, BLEU 48.1 vs 46.0
    sources: ["en"],
    targets: ["ru", "uk"],
    prefix: (t) => (t.lang === "ru" ? ">>rus<<" : ">>ukr<<"),
  },
  {
    // New: Polish, not supported by any built-in model before this. The tc-big
    // family has no en-pl checkpoint; this is Helsinki-NLP's multi-target Slavic
    // model, used for its >>pol<< target only.
    id: "en-pl",
    repo: "khabouss/opus-mt-en-sla-onnx", // chrF 62.6, BLEU 40.3
    sources: ["en"],
    targets: ["pl"],
    prefix: () => ">>pol<<",
  },
  {
    // Note: the model card lists Moroccan Arabic ("ary") but its output stays close
    // to Modern Standard Arabic, so Darija is not treated as supported.
    ...pair("en", "ar"),
    repo: "khabouss/opus-mt-tc-big-en-ar-onnx", // chrF 49.7 vs 47.8, BLEU 19.9 vs 16.6 (greedy)
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

/**
 * A Hugging Face repo id is always exactly "namespace/name". `models.ts` joins it
 * onto the cache root with no further checks, so a `repo` of "../../../etc" (or any
 * segment that isn't a real name) would resolve outside the cache directory — and
 * install() writes there, uninstall() recursively deletes there.
 */
function validRepo(repo: string): boolean {
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((p) => p !== "" && p !== "." && p !== ".." && !p.includes("\\"));
}

export function customEntries(models: CustomModelConfig[] | undefined, configDir: string): ModelEntry[] {
  return (models ?? []).map((c, i) => {
    if (!c.repo === !c.path) throw new Error(`models[${i}]: set exactly one of "repo" or "path".`);
    if (c.repo && !validRepo(c.repo)) {
      throw new Error(`models[${i}]: "repo" must look like "namespace/name" (a Hugging Face repo id), got "${c.repo}".`);
    }
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
