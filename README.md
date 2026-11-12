# locale-ai

[![npm version](https://img.shields.io/npm/v/locale-ai.svg)](https://www.npmjs.com/package/locale-ai)
[![npm downloads](https://img.shields.io/npm/dm/locale-ai.svg)](https://www.npmjs.com/package/locale-ai)
[![CI](https://github.com/khabouss/locale-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/khabouss/locale-ai/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/locale-ai.svg)](LICENSE)
[![node](https://img.shields.io/node/v/locale-ai.svg)](package.json)

Translate your i18n locale files **locally, on CPU, for free**. No API keys, no Python, nothing leaves your machine.

<video src="https://github.com/khabouss/locale-ai/raw/main/media/demo.mp4" controls width="100%"></video>

```bash
npx locale-ai translate --from en --to fr,es,de
```

```
locale-ai 0.2.0
Found 3 en files in locales/en/
Models to download (one time, then cached for every project):
  en-fr         345 MB  khabouss/opus-mt-tc-big-en-fr-onnx
  ...
Download 577 MB? (Y/n)
✓ fr         43 strings translated, 3 files written in 2.7s, 1 plural forms added
✓ es         43 strings translated, 3 files written in 2.5s, 1 plural forms added
✓ de         43 strings translated, 3 files written in 2.1s
```

## What it handles

- **Layouts**: `locales/en/*.json` (nested folders too) → `locales/fr/...`, or `messages/en.json` → `messages/fr.json`. `.json`, `.yaml`, `.yml`, `.po` (gettext), `.arb` (Flutter) and `.strings` (Apple) are all supported, mixed freely in the same project. Common folders (`locales`, `src/locales`, `public/locales`, `src/i18n`, `messages`, `lang`, ...) are found automatically, or pass `--input`.
- **Placeholders are never translated or lost**: `{name}`, `{{count}}`, `%s`, `%1$s`, `%(name)s`, `%{name}`, `${name}`, `:attribute`, `$t(key)`, `@:key`, `<b>…</b>`, `<0>…</0>`, `&nbsp;`, URLs, e-mails.
- **ICU MessageFormat**: `{count, plural, one {# file} other {# files}}`, `select`, nesting. Only the text is translated.
- **i18next plurals**: adds the forms the target language needs (`_few`, `_many` for Arabic, Russian, Polish...).
- **Incremental**: only missing keys are translated, existing translations are kept, re-runs are no-ops. `--overwrite` re-translates everything.
- **Structure**: key order, numbers, booleans, arrays, indentation and trailing newline are preserved.

**Format notes**: for `.po`, `msgid` is the stable key (never changed) and `msgstr` is the translated value, as gettext expects — the English `.po` file's `msgstr` must hold the source text (most generators already fill it; an empty `msgstr` is treated as empty, not inherited from `msgid`), and `msgid_plural`/`msgstr[n]` plural entries pass through untranslated (translate those by hand, or use ICU plurals in `.arb`/JSON/YAML instead). For `.arb`, `@key` metadata and `@@locale` are never translated; `@@locale` is set to the target locale on output.

## Why locale-ai?

- **No API keys, no cloud bill.** Google/DeepL/OpenAI-based translation tools work well but mean an account, a key, a per-character cost, and your strings leaving your machine. locale-ai runs the model on your own CPU.
- **Built for i18n files, not plain text.** General MT tools translate strings; they don't know that `{count}`, `<0>bold</0>`, or `$t(common.footer.tagline)` must survive untouched. locale-ai is built around i18next/ICU conventions specifically, so placeholders, plurals, and nested references come out intact instead of mangled or dropped.
- **Incremental by default.** Add one new key to `en.json` and only that key gets translated — existing translations in `fr.json`/`es.json`/etc. are left alone, so re-runs are cheap and safe to automate in CI.
- **Honest about quality.** The [Languages](#languages) section tells you which pairs are review-light vs. which need a human pass, instead of presenting every language as equally production-ready.

**When *not* to use it**: if you need professional/legal-grade translation, or languages outside the [supported list](#languages), use a human translator or a larger cloud model instead — locale-ai is built for keeping UI strings in sync across languages during development, with a review pass before shipping.

## Commands

```bash
locale-ai translate --to fr,pt-BR [--from en] [--input dir] [--dry-run] [--overwrite] [--fast] [--report file] [-y]
locale-ai models list [--from en]     # supported language pairs
locale-ai models installed
locale-ai models install en-de        # pre-download (e.g. in CI)
locale-ai models remove en-de
locale-ai models convert <hf-marian-model> --out <dir>   # bring your own model (see below)
```

`translate` uses beam search (4 beams) by default. `--fast` uses greedy decoding: 2–3x faster, about 0.5 chrF lower.

Models are cached once per machine in `~/.cache/locale-ai` (`LOCALE_AI_CACHE` to change). In CI, pass `--yes`.

## Project config (optional)

`locale-ai.config.json` in the project root:

```json
{
  "doNotTranslate": ["Acme", "Acme Pro"],
  "glossary": {
    "fr": { "Workspace": "Espace de travail" },
    "de": { "Sign in": "Einloggen" }
  }
}
```

`glossary` entries replace whole strings. `models` adds your own translation models (next section). A built-in glossary covers ~60 standard UI labels ("Sign in", "Settings", "Log out", ...) for fr, es, de, it, pt-BR, nl and ar, because one-to-three word labels are where sentence-level MT is weakest.

## Add a language, or a better model

Any [MarianMT / OPUS-MT](https://huggingface.co/Helsinki-NLP) model on Hugging Face can be used. Convert it once (needs Python):

```bash
pip install "optimum-onnx[onnxruntime]" accelerate sentencepiece
locale-ai models convert Helsinki-NLP/opus-mt-tc-big-en-tr --out models/en-tr --source en --target tr
```

then declare it in `locale-ai.config.json`:

```json
{
  "models": [
    { "source": "en", "target": "tr", "path": "models/en-tr" },
    { "source": "en", "target": ["ru", "uk"], "path": "models/en-zle", "prefix": { "ru": ">>rus<<", "uk": ">>ukr<<" } },
    { "source": "en", "target": "he", "repo": "your-org/opus-mt-en-he-onnx" }
  ]
}
```

- `path` is a local folder (relative to the config file); `repo` is a Hugging Face repo with the converted files (uploaded output folder), downloaded and cached like built-in models.
- `prefix` is required for multi-target models (`convert` lists the model's `>>xx<<` tokens).
- Project models take priority over built-ins for their language pairs and can be used for pivoting (e.g. `ja → en → tr`).

**Recommended for quality**: the `opus-mt-tc-big-en-*` models (es, it, pt, ar, tr, and `zle` for ru/uk). They are ~3x larger (270–370 MB int8) and ~1.5x slower, and clearly better. `en-fr` already uses one of these as its built-in model (see [Languages](#languages)), hosted at [khabouss/opus-mt-tc-big-en-fr-onnx](https://huggingface.co/khabouss/opus-mt-tc-big-en-fr-onnx) — no conversion needed for it.

| Target | Built-in model, chrF / BLEU | tc-big model, chrF / BLEU |
|---|---|---|
| es | 72.9 / 56.9 | **73.6 / 57.4** |
| it | 73.8 / 54.9 | **75.3 / 58.2** |
| pt | 68.3 / 44.4 | **70.6 / 47.7** (`>>por<<`, or `>>pob<<` for pt-BR) |
| ru | 65.7 / 46.0 | **68.2 / 48.1** (`>>rus<<`) |
| ar | 47.8 / 16.6 | **49.7 / 19.9** (`>>ara<<`, with `--fast`) |
| tr | — | **67.4 / 42.1** |

300 Tatoeba test sentences per language, int8, beam 4 unless noted; reproduce with `bench/` (see `bench/README.md`). `opus-mt-tc-big-en-ko` is broken upstream (garbage output even in PyTorch) and is not recommended.

Also new: **pl** (chrF 62.6 / BLEU 40.3, `>>pol<<`), hosted at [khabouss/opus-mt-en-sla-onnx](https://huggingface.co/khabouss/opus-mt-en-sla-onnx) — no tc-big `en-pl` checkpoint exists, so this uses Helsinki-NLP's multi-target Slavic model instead.

## Languages

From English: af, ar, ca, cs, da, de, es, fi, fr, gl, hi, hu, id, it, nl, oc, pl, pt (pt-BR, pt-PT), ro, ru, sv, uk, vi, xh, zh (zh-CN, zh-TW). Other source languages are supported directly or through English (`locale-ai models list --from fr`).

Measured on a sample app (see `test/fixtures`):

| Quality (built-in models) | Languages |
|---|---|
| Good — light review | fr, es, de, pt-BR, nl |
| Usable — review before shipping | it, ar, ru, pl, zh-CN, zh-TW |
| Untested | the other pairs in `locale-ai models list` |

`en-fr` is already on the tc-big model (chrF 72.5 / BLEU 55.9) as a built-in, no config needed. With the other tc-big models above, it, ar and ru move up a tier, and tr and pl become available. Not available yet: ja, ko and others; he works with a converted `opus-mt-en-he` (weaker). Moroccan Arabic (Darija): the tc-big en-ar model has a `>>ary<<` token, but its output is close to Modern Standard Arabic — not supported.

## How it works

- **Models**: [OPUS-MT](https://huggingface.co/Helsinki-NLP) (MarianMT) in ONNX, int8-quantized (int8 vs fp32 measured equal: en-fr chrF 68.9 vs 69.0, en-ar 47.8 vs 47.8). Downloads are pinned to a commit and verified (sha256 / git blob hash).
- **Own runtime** on [onnxruntime](https://onnxruntime.ai) (`src/marian.ts`), no transformers.js:
  - a SentencePiece Unigram tokenizer including the model's precompiled normalisation map, identical to Python `sentencepiece` on 3,577/3,577 test sentences across 5 models (`src/spm.ts`);
  - real beam search with Hugging Face semantics, identical to `transformers` PyTorch beam search on 599/600 sentences; log-softmax + top-k run natively in a tiny embedded ONNX graph (`scripts/make-topk-graph.py`);
  - KV cache with batch compaction: finished sentences leave the batch, so short and long strings share batches cheaply.
- **Sentence splitting**: OPUS-MT drops sentences from multi-sentence inputs, so each sentence is translated separately.
- **Placeholder masking** with three marker styles tried in order (`{0}` / `<0>…</0>`, then numbers `900`, then `_P0_`), validating every marker; numbers survive models that mangle braces (en-zh, en-ru). A last-resort fallback translates around placeholders, and anything that needed it is listed for review.
- **Speed** (20-core CPU, ~1 GB RAM): sample app (43 strings) in ~3 s per language with beam search, ~2 s with `--fast`; full sentences at ~18/s (built-in, beam 4), ~12/s (tc-big, beam 4), ~33/s (tc-big, `--fast`).
- **Install size**: `onnxruntime-node` bundles binaries for every platform, and on linux/x64 downloads a ~260 MB CUDA provider by default — locale-ai only ever runs on CPU (`executionProviders: ["cpu"]`), so a `postinstall` script ([`scripts/trim-onnxruntime.cjs`](scripts/trim-onnxruntime.cjs)) removes the unused platforms and GPU providers after install, cutting it from ~550 MB to ~45 MB on your current platform.

## Development

```bash
npm install
npm test            # unit tests (no models)
npm run test:e2e    # real models, downloads ~345 MB once (en-fr, tc-big)
node bench/eval.ts --dir <model dir> --lang fr --beams 4 --out out.json   # quality benchmark (see bench/README.md)
npm run dev -- translate --to fr   # run from source (Node ≥ 22.18 strips types)
npm run build       # → dist/
```

## Next steps

1. **More languages**: ja, ko have no usable OPUS-MT model yet; a different model family would be needed.
