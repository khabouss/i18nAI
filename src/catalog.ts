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
  /**
   * Commit this repo is pinned to, so every install gets the exact same files
   * instead of silently following wherever the repo's "main" branch goes next
   * (every built-in model is pinned — see PINNED_REVISIONS below). Undefined
   * resolves "main" at install time; only reachable for a project's own custom
   * `models` config entry, which has no pin of its own.
   */
  revision?: string;
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

/**
 * Every repo this catalog downloads from — Xenova's and this project's own
 * `khabouss/*` alike — pinned to the commit that was current when each pair was
 * added (or last re-pinned), so every install gets the exact same files instead of
 * silently following wherever a repo's "main" branch moves to next, with no
 * changelog entry or version bump on our side to explain why translations changed.
 * This also covers a compromised or merely careless upload to one of our own repos:
 * it can't silently reach installed users either. The cost is that publishing a
 * better `khabouss/*` conversion means also bumping its entry here as part of that
 * same release — a deliberate tradeoff, not an oversight.
 */
const PINNED_REVISIONS: Record<string, string> = {
  "Xenova/opus-mt-ROMANCE-en": "f60feaabe8bb435a5871e7702b25f53a01e770f8",
  "Xenova/opus-mt-af-en": "0eba4e40af86c6ad316a58fc9a7ed1134b05fd90",
  "Xenova/opus-mt-ar-en": "09c7556866400dcc53562ba8d7035119e7d9a2c1",
  "Xenova/opus-mt-cs-en": "c9f7336d1cf49ba5b7a412cba3b86999fa781716",
  "Xenova/opus-mt-da-de": "3784087953108e4ee9957c8f9eff11c0bf0cabda",
  "Xenova/opus-mt-da-en": "6496d5e47a016552357be8f06294096609256ac4",
  "Xenova/opus-mt-de-en": "399dfd68706739fffd503f876093e455ae268a06",
  "Xenova/opus-mt-de-es": "d339419ee3bda301bdcd00249d4436b74664ee7e",
  "Xenova/opus-mt-de-fr": "e783da03d247c4d16778e938530e9b5d7bd1523d",
  "Xenova/opus-mt-en-ROMANCE": "9d2ba69ac80c8e8453c3d9a1e2323a0e7b8ca3cd",
  "Xenova/opus-mt-en-af": "3d48312617d092d77cb5aef9f9e9636ad639dd8d",
  "Xenova/opus-mt-en-cs": "ed163ca109a93297e2f055eb3397bd33230141ad",
  "Xenova/opus-mt-en-da": "33862dc071a5cc43e821e60742553c501c587e77",
  "Xenova/opus-mt-en-de": "1ca130c44c4c5441ef16d48aae521a424ab644f7",
  "Xenova/opus-mt-en-es": "4b002a4c7edd54a7ced58877258b87f7efd3f892",
  "Xenova/opus-mt-en-fi": "4e5799273dbd7cce94c1e99cc9d3acb9f191b8eb",
  "Xenova/opus-mt-en-hi": "7aad72006a1588a9c3485ed6203aed99eebbc872",
  "Xenova/opus-mt-en-hu": "1b7df958c1bd8f094eff1ce76d536468923ed7e3",
  "Xenova/opus-mt-en-id": "b3b41f654c2fb3286d007dee1da7b0f47fd27d82",
  "Xenova/opus-mt-en-it": "075406e3c8c2c30634d4a1bd8f00c21d9e162011",
  "Xenova/opus-mt-en-nl": "c3a0541231a7329b4492809fc2bd7ab7d2ceb0bc",
  "Xenova/opus-mt-en-ro": "3d816891778276930df2a45cbfb70689b3fe8981",
  "Xenova/opus-mt-en-sv": "33d522d806c041cdebecd549c558d22a2b9b4ea4",
  "Xenova/opus-mt-en-vi": "30bcd461c0d7338ad106b36314d3eedc2d4e998c",
  "Xenova/opus-mt-en-xh": "1ab9c4f4400ea4805f220ff5d551d3d0169b7a96",
  "Xenova/opus-mt-en-zh": "046f55aec303cdee3e0318604406d4df20f1e8ea",
  "Xenova/opus-mt-es-de": "7f493e4b81b684478396f37de4c1ebc28ecd5855",
  "Xenova/opus-mt-es-en": "eadfd7c658a9d8929ac3b8e996b68a68e2c7d480",
  "Xenova/opus-mt-es-fr": "3bef5f612825d503f6fb85e0527a1fe30f2578c2",
  "Xenova/opus-mt-es-it": "596c67cda7cb919f0d67221f3a31bd7df79f19d0",
  "Xenova/opus-mt-es-ru": "268ccd60bde3cabde17068d482ca6930512f1a85",
  "Xenova/opus-mt-et-en": "58104952b730220eb7a9cdbbe19533a064f40dc0",
  "Xenova/opus-mt-fi-de": "6d93339597e19574f543259315d2400939067c1e",
  "Xenova/opus-mt-fi-en": "a623e4812687be788e3ab720c8a950ab64704793",
  "Xenova/opus-mt-fr-de": "7eea1996b4480d073cf560fcba6d4480aaf9a2bb",
  "Xenova/opus-mt-fr-en": "6b166a182780e118c997879d0ad5be4b53671644",
  "Xenova/opus-mt-fr-es": "962338be51033b548c13dbb6f4da3ddb8c8aba0e",
  "Xenova/opus-mt-fr-ro": "d2b0db550987291ebb35cdeb3a5394d176ecdcc6",
  "Xenova/opus-mt-fr-ru": "c2ec732b045ae9f0e1ae1ea9267840145a8c03fe",
  "Xenova/opus-mt-hi-en": "99853100ed9d932987a6816e8cf7b1b6742a6116",
  "Xenova/opus-mt-hu-en": "c9e8a7617fb4cb4fca3785c5bb22cfe457cde00b",
  "Xenova/opus-mt-id-en": "c38ef36c843b71177da903442835c3c870975fd6",
  "Xenova/opus-mt-it-en": "fd0b89b9c052adc1f2f64152f555aa17353728be",
  "Xenova/opus-mt-it-es": "0eba27fe6da2208231ea5e7047b0f62241ffc2bb",
  "Xenova/opus-mt-it-fr": "7843e3b7137d19face19cb32e27256888d26fe84",
  "Xenova/opus-mt-ja-en": "1a906cfaaf7c8f4193f67f5885c082aa6dbd9d16",
  "Xenova/opus-mt-ko-en": "d9fa1ac6008242100fecb4fff9b0a5917a1be81f",
  "Xenova/opus-mt-nl-en": "82c42d95d1508037cbe7172d85fd4e940a2f3584",
  "Xenova/opus-mt-nl-fr": "6c8ebb68522ffd80cf3474b2dc44f4b5f741e9cd",
  "Xenova/opus-mt-no-de": "5ed60d1d245fe19d3ee80a172de6b38724642eb3",
  "Xenova/opus-mt-pl-en": "aeaf0e003b045248c28a559a5ce6027b54ebdaba",
  "Xenova/opus-mt-ro-fr": "48d206ed25c6f5b869a49a79207906c401334727",
  "Xenova/opus-mt-ru-en": "afe8c6c738ec81b6d033fd8f44f9678a639a7c67",
  "Xenova/opus-mt-ru-es": "9cb5fb9fae4d5c0c731dcc3ba74c4e0a87f15eb0",
  "Xenova/opus-mt-ru-fr": "c7275f468246036d24bfe14ce8465e94e1037af9",
  "Xenova/opus-mt-ru-uk": "6d8a744ed6eafd9003bcc2b052c4575de0485e1e",
  "Xenova/opus-mt-sv-en": "63a40256869b6a2b29a84e47aa7f03524fa5f3a2",
  "Xenova/opus-mt-th-en": "7f0406b972f742985cfbe3be8f61dead9f1bc0e3",
  "Xenova/opus-mt-tr-en": "78247f41f354af036d24e6f0f8a3d02c6806f96e",
  "Xenova/opus-mt-uk-en": "b2ad6afa424aaeff8913ff350860b7a7b7c0a607",
  "Xenova/opus-mt-uk-ru": "cfb76ccd207734d7847679664fa4538cda5ed597",
  "Xenova/opus-mt-vi-en": "541dfd72ec07e8f1563795e0224408ad8d729e80",
  "Xenova/opus-mt-xh-en": "f2950c1503ae17ba532ea858914ea13838bc2ab1",
  "Xenova/opus-mt-zh-en": "39d480d52a9ea3065a1f117adfe4dbc55de10e6f",
  "khabouss/opus-mt-tc-big-en-fr-onnx": "9918f53b1e4f418cba1356c372e4b9609186b6f5",
  "khabouss/opus-mt-tc-big-en-es-onnx": "064225d59b49d0576d146ddb2d614bc4f4bb3064",
  "khabouss/opus-mt-tc-big-en-it-onnx": "622b8d6756434a6098d42d38a0102f4d707f20de",
  "khabouss/opus-mt-tc-big-en-tr-onnx": "c0990f0849820af39f7c3ebdf6d0397c8cc98636",
  "khabouss/opus-mt-tc-big-en-pt-onnx": "0a2c1eee261899b161f3dc62ab1d085f630b2555",
  "khabouss/opus-mt-tc-big-en-zle-onnx": "189d0095a48a85f47e5a62a648fbe451ff01e6c1",
  "khabouss/opus-mt-en-sla-onnx": "0552b42699fde609980b57ff1f7a2af3ca2e2145",
  "khabouss/opus-mt-tc-big-en-ar-onnx": "b5a4f26d632c3bfbbd38a007b4c62d193382f156",
};

/** Applies PINNED_REVISIONS by the entry's final `repo` (after any override), not by where `pair()` first pointed it. */
function pinned(entries: ModelEntry[]): ModelEntry[] {
  return entries.map((m) => ({
    ...m,
    revision: m.repo ? PINNED_REVISIONS[m.repo] : undefined,
  }));
}

export const CATALOG: ModelEntry[] = pinned([
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
]);

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
