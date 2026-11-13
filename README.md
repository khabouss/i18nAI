# locale-ai

[![npm version](https://img.shields.io/npm/v/locale-ai.svg)](https://www.npmjs.com/package/locale-ai)
[![npm downloads](https://img.shields.io/npm/dm/locale-ai.svg)](https://www.npmjs.com/package/locale-ai)
[![CI](https://github.com/khabouss/locale-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/khabouss/locale-ai/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/locale-ai.svg)](LICENSE)
[![node](https://img.shields.io/node/v/locale-ai.svg)](package.json)

Translate your i18n locale files **locally, on CPU, for free**. No API keys, no Python, nothing leaves your machine.

![demo](media/demo.gif)

```bash
npx locale-ai translate --from en --to fr,es,de
```

```
locale-ai 0.6.3
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

- **Layouts**: `locales/en/*.json` (nested folders too) → `locales/fr/...`, or `messages/en.json` → `messages/fr.json`. `.json`, `.yaml`, `.yml`, `.po`/`.pot` (gettext), `.arb` (Flutter) and `.strings` (Apple) are all supported, mixed freely in the same project. Common folders (`locales`, `src/locales`, `public/locales`, `src/i18n`, `messages`, `lang`, `config/locales` (Rails), ...) are found automatically, or pass `--input`. Framework-specific naming is also recognized: `flutter gen-l10n`'s `app_en.arb`/`app_fr.arb` filename prefix, and Apple's `en.lproj`/`fr.lproj` directory-suffix convention (`--input en.lproj` or just the project root both work), on both the source and the generated target side.
- **Android**: `res/values/strings.xml` → `res/values-fr/strings.xml` (or `values-pt-rBR` for a region). `<string>`, `<string-array>` and `<plurals>` are all translated; `translatable="false"` strings and `<!-- ... -->` comments are kept as-is. Resource-qualifier scripts/variants (`values-b+sr+Latn`) aren't supported — only a plain language or language-region qualifier.
- **Placeholders are never translated or lost**: `{name}`, `{{count}}`, `%s`, `%1$s`, `%(name)s`, `%{name}`, `${name}`, `:attribute`, `$t(key)`, `@:key`, `<b>…</b>`, `<0>…</0>`, `&nbsp;`, URLs, e-mails.
- **ICU MessageFormat**: `{count, plural, one {# file} other {# files}}`, `select`, nesting. Only the text is translated.
- **i18next plurals**: adds the forms the target language needs (`_few`, `_many` for Arabic, Russian, Polish...), so the app doesn't fall back to the English string — each added form copies the `_other` translation verbatim rather than inflecting it, so review and adjust the wording of `_zero`/`_two`/`_few`/`_many` by hand for languages where those forms use a different noun/adjective form. The `_one` form is translated with its `{{count}}` temporarily replaced by a literal "1", since the model otherwise sometimes picks the target's plural noun form despite the English source being grammatically singular. Rails-style nested plurals (`item:` with `one:`/`other:` children instead of `item_one`/`item_other`) get the same missing-forms treatment — Android's `<plurals>`/`<item quantity="...">` groups are the same shape and get it too.
- **Incremental, and edit-aware**: only missing or changed keys are translated; untouched translations are kept, so re-runs are no-ops. A small `locale-ai.lock.json` (commit it, like a package lock) remembers a hash of each source string and of the output last written for it per target locale — so editing a source string gets it re-translated automatically (it isn't enough for the target to already hold *some* text), while editing a target string by hand is detected and reported for review instead of being silently overwritten on the next run. `--overwrite` bypasses the lock and re-translates everything.
- **Structure**: key order, numbers, booleans, arrays, indentation and trailing newline are preserved.

**Format notes**: for `.yaml`/`.yml`, `#` comments (a translator note, an inline `# ...` after a value) survive a translation run — the target file is edited in place rather than rebuilt from scratch, so an existing comment's own value is updated without disturbing the comment, and a brand-new key is appended with no comment of its own. A newly added plural-category key (see above) is likewise appended rather than inserted between existing ones, so its position in the file won't always match the canonical `zero`/`one`/`two`/`few`/`many`/`other` order. For `.po`/`.pot`, `msgid` is the stable key (never changed) and `msgstr` is the translated value, as gettext expects — the English source's `msgstr` holds the source text when it's filled in (most generators do), and falls back to `msgid` itself when it's empty, which is normal for a `.pot` template or a project that just keeps the English text in `msgid`. That fallback only ever applies to the source file: an empty `msgstr` in an *existing target* still means "not translated yet", never "same as msgid". `msgid_plural`/`msgstr[n]` plural entries are translated too (the singular and plural source forms), then expanded to however many `msgstr[n]` the target language's plural rules need (6 for Arabic, 1 for Japanese, ...) — not full grammatical inflection for in-between categories (`few`/`many`/...), which get the plural-sourced translation verbatim, the same simplification `addPluralForms` makes for i18next. `Plural-Forms` in the header is computed for the target language, not copied from the source; an existing target file's header, and any entry's own comments (a translator's note, a hand-added `#, fuzzy`), are otherwise left exactly as last edited instead of being regenerated from the source on every rerun. `--fuzzy` flags every entry a run actually (re)translated with gettext's standard `#, fuzzy` "needs review" marker, merging onto an existing `#,` line rather than adding a second one. A `.pot` source always writes a `.po` target, never a `.pot`. For `.arb`, `@key` metadata and `@@locale` are never translated; `@@locale` is set to the target locale on output. For `.strings`, a file saved as UTF-16 (Xcode's traditional default) is read like a UTF-8 one, an unquoted key (`title = "Settings";`, without quotes around `title`) is read the same as a quoted one, and `\U00e9`-style escapes are decoded — output is always written as UTF-8 with quoted keys, regardless of how the source was saved. For Android `strings.xml`, `translatable="false"` strings and each element's own `<!-- ... -->` comment are kept on first write, but — unlike YAML/`.po`/`.strings` — a rerun regenerates the file from scratch rather than editing an existing target in place, so a hand-edited comment in an already-translated file won't survive a rerun.

## Why locale-ai?

- **No API keys, no cloud bill.** Google/DeepL/OpenAI-based translation tools work well but mean an account, a key, a per-character cost, and your strings leaving your machine. locale-ai runs the model on your own CPU.
- **Built for i18n files, not plain text.** General MT tools translate strings; they don't know that `{count}`, `<0>bold</0>`, or `$t(common.footer.tagline)` must survive untouched. locale-ai is built around i18next/ICU conventions specifically, so placeholders, plurals, and nested references come out intact instead of mangled or dropped.
- **Incremental by default.** Add one new key to `en.json` and only that key gets translated; edit an existing one and the lockfile catches it and re-translates just that key — existing, unrelated translations are left alone, so re-runs are cheap and safe to automate in CI.
- **Honest about quality.** The [Languages](#languages) section tells you which pairs are review-light vs. which need a human pass, instead of presenting every language as equally production-ready.

**When *not* to use it**: if you need professional/legal-grade translation, or languages outside the [supported list](#languages), use a human translator or a larger cloud model instead — locale-ai is built for keeping UI strings in sync across languages during development, with a review pass before shipping.

## Commands

```bash
locale-ai translate --to fr,pt-BR [--from en] [--input dir] [--dry-run] [--overwrite] [--fast] [--beams n] [--batch-size n] [--report file] [-y]
locale-ai check [--from en] [--input dir]   # CI: fails if a translated locale has missing keys or placeholder mismatches
                                             # (also warns, without failing, about strings left identical to the source)
locale-ai models list [--from en]     # supported language pairs
locale-ai models installed
locale-ai models install en-de        # pre-download (e.g. in CI)
locale-ai models remove en-de
locale-ai models convert <hf-marian-model> --out <dir>   # bring your own model (see below)
```

`translate` uses beam search (4 beams) by default; `--beams n` overrides the width directly. `--fast` uses greedy decoding (equivalent to `--beams 1`): 2–3x faster, about 0.5 chrF lower. `--batch-size n` (default 32) controls how many strings go through the model per batch — lower it if you're hitting memory limits, raise it for a bit more throughput on a machine with room to spare.

Models are cached once per machine in `~/.cache/locale-ai` (`LOCALE_AI_CACHE` to change). In CI, pass `--yes`.

Installing trims the `onnxruntime-node` dependency down to the one CPU binary locale-ai actually loads (it ships binaries for every platform/arch plus GPU providers locale-ai never uses) — but only when nothing else in your `node_modules` also depends on it, so a shared copy another package needs for GPU inference is left alone. Set `LOCALE_AI_SKIP_TRIM=1` to disable this entirely.

## Project config (optional)

`locale-ai.config.json` in the project root:

```json
{
  "doNotTranslate": ["Acme", "Acme Pro"],
  "doNotTranslateKeys": ["brand.name", "config.statusEnum"],
  "glossary": {
    "fr": { "Workspace": "Espace de travail" },
    "de": { "Sign in": "Einloggen" }
  }
}
```

`glossary` entries replace whole strings. `models` adds your own translation models (next section). A built-in glossary covers ~60 standard UI labels ("Sign in", "Settings", "Log out", ...) for fr, es, de, it, pt-BR, nl and ar, because one-to-three word labels are where sentence-level MT is weakest.

`doNotTranslate` protects a term everywhere it appears in any string. `doNotTranslateKeys` instead protects a key path (dot/`[i]` notation, e.g. `brand.name`, `items[0]`) — the whole value at that path, and everything nested under it if it's an object or array, is copied to every target verbatim. Use it for an enum array (`"statusEnum": ["ACTIVE", "PENDING"]`, which you'd otherwise have to list value-by-value in `doNotTranslate`) or a field a model might respell or inflect even when the word is listed in `doNotTranslate` elsewhere in the same string.

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

- `path` is a local folder (relative to the config file); `repo` is a Hugging Face repo with the converted files (uploaded output folder), downloaded and cached like built-in models — it must look like `namespace/name`, rejected otherwise (it's joined onto the cache directory with no further checks, so anything else could resolve outside it).
- `prefix` is required for multi-target models (`convert` lists the model's `>>xx<<` tokens).
- Project models take priority over built-ins for their language pairs and can be used for pivoting (e.g. `ja → en → tr`).

**Already built-in, no conversion needed**: `fr`, `es`, `it`, `pt`, `ar` and `tr` all use the larger, clearly-better `opus-mt-tc-big-en-*` checkpoints as their built-in model (~3x larger, 270–370 MB int8, ~1.5x slower than the plain OPUS-MT default); `ru`/`uk` use the tc-big `zle` multi-target checkpoint, and `pl` uses Helsinki-NLP's multi-target Slavic model (no tc-big `en-pl` checkpoint exists). The section above is for adding a language or model that *isn't* already built in.

| Target | Previous (plain OPUS-MT), chrF / BLEU | Built-in today (tc-big / better), chrF / BLEU |
|---|---|---|
| fr | 68.9 / 53.7 | **72.5 / 55.9** |
| es | 72.9 / 56.9 | **73.6 / 57.4** |
| it | 73.8 / 54.9 | **75.3 / 58.2** |
| pt | 68.3 / 44.4 | **70.6 / 47.7** (`>>por<<`, or `>>pob<<` for pt-BR) |
| ru | 65.7 / 46.0 | **68.2 / 48.1** (`>>rus<<`) |
| ar | 47.8 / 16.6 | **49.7 / 19.9** (`>>ara<<`, with `--fast`) |
| tr | — | **67.4 / 42.1** (not supported before) |
| pl | — | **62.6 / 40.3** (`>>pol<<`, not supported before) |

300 Tatoeba test sentences per language, int8, beam 4 unless noted; reproduce with `bench/` (see `bench/README.md`). `opus-mt-tc-big-en-ko` is broken upstream (garbage output even in PyTorch) and is not recommended.

## Languages

From English: af, ar, ca, cs, da, de, es, fi, fr, gl, hi, hu, id, it, nl, oc, pl, pt (pt-BR, pt-PT), ro, ru, sv, tr, uk, vi, xh, zh (zh-CN, zh-TW). Other source languages are supported directly or through English (`locale-ai models list --from fr`).

Measured on a sample app (see `test/fixtures`):

| Quality (built-in models) | Languages |
|---|---|
| Good — light review | fr, es, de, pt-BR, nl |
| Usable — review before shipping | it, ar, ru, pl, zh-CN, zh-TW |
| Untested | the other pairs in `locale-ai models list` |

`fr`, `es`, `it`, `pt`, `ar`, `ru`/`uk`, `tr` and `pl` all ship on the tc-big (or better) models above as built-ins already — no config needed. Not available yet: ja, ko and others; he works with a converted `opus-mt-en-he` (weaker). Moroccan Arabic (Darija): the tc-big en-ar model has a `>>ary<<` token, but its output is close to Modern Standard Arabic — not supported.

## How it works

- **Models**: [OPUS-MT](https://huggingface.co/Helsinki-NLP) (MarianMT) in ONNX, int8-quantized (int8 vs fp32 measured equal: en-fr chrF 68.9 vs 69.0, en-ar 47.8 vs 47.8). Downloads are pinned to a commit and verified (sha256 / git blob hash) — third-party repos (Xenova's OPUS-MT conversions) to a commit captured when that model was added, so an upstream change there never silently changes your translations; this project's own `khabouss/*` repos stay on their latest commit, since we only ever change those ourselves. Every model is OPUS-MT by Helsinki-NLP (Tiedemann & Thottingal, 2020 — cite this if you use the models); each is licensed individually (most CC-BY 4.0, some Apache 2.0 — check the model's own card). The larger `tc-big` and multi-target checkpoints are re-hosted as ONNX conversions under [khabouss/*](https://huggingface.co/khabouss), each model card carrying the original's license, crediting and citing it, and listing only the ONNX conversion and quantization as locale-ai's own addition.
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
2. **Rare batch-dependent mistranslation**: translating a short string (e.g. "© 2026 Acme Inc. All rights reserved.") can occasionally produce an unrelated/garbled result depending on which *other* strings share its translation batch — the same string translates correctly alone or in a different batch. Root cause: the built-in models are dynamically int8-quantized per-tensor, so the quantization scale for a batched activation tensor is computed from the whole batch, not per row; most of the time this is just quantization noise, but occasionally it's enough to tip beam search into a bad output with no warning. A fix would mean re-quantizing the models with static per-channel scales (or giving up CPU-batching speed) — out of scope for a quick patch; flagging here so it's a known, understood limitation rather than a silent one.
