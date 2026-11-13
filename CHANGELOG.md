# Changelog

## 0.7.10

Three editorial/feature items, not bugs ([khabouss/locale-ai#14](https://github.com/khabouss/locale-ai/issues/14)):

- **`src/locales.ts` (2041 lines) is now split into `src/formats/`**, one module per file format (JSON/YAML, Apple `.strings`, Java `.properties`, Android `strings.xml`, XLIFF, `.resx`, JS/TS modules, ARB, `.xcstrings`, gettext `.po`), plus a shared module for the primitives every reader uses (the `LocaleDoc` shape, trailing-newline bookkeeping, CLDR plural categories, C-style and generic-XML escaping). `locales.ts` itself is now layout detection, the `readLocaleDoc` dispatcher, and the core flatten/build/plural-sync logic — a pure mechanical move, re-exporting the same symbols with identical behavior.
- **Added a programmatic (non-CLI) library API.** `import { translate, check } from "locale-ai"` runs the same pipeline `locale-ai translate`/`locale-ai check` do, as plain async functions returning structured results instead of printing — for a build script or test that wants to drive it in-process rather than shelling out. Unlike the CLI, it never prompts: a model download either proceeds (`yes: true`, or a `confirmDownload` hook) or the call rejects; an `onEvent` hook reports the same progress/status information the CLI renders as bars and log lines. `src/cli.ts` is now a thin wrapper around this same API, so the two can't drift apart. See the README's new "Library API" section.
- **README fixes**: the `## Commands` section was missing the `accept` command entirely (despite being referenced elsewhere in the README) and the `--fuzzy`/`--config` flags on `translate`/`check`; both are now listed. Fixed a "commiting" → "committing" typo.

## 0.7.9

Four more gaps from the same external review, verified with reproductions before fixing ([khabouss/locale-ai#12](https://github.com/khabouss/locale-ai/issues/12)):

- **The onnxruntime-node trimmer's "other consumer" check couldn't see a pnpm virtual store.** Under pnpm, `require.resolve` follows the symlink straight into `node_modules/.pnpm/onnxruntime-node@<version>/node_modules/`, which only ever contains onnxruntime-node itself — a real sibling consumer symlinked into the project's actual top-level `node_modules` was invisible to the scan. Trimming is now skipped entirely when a pnpm virtual store is detected, rather than risk a false "no other consumer".
- **The check never looked at the consuming project's own `package.json`**, only at sibling packages inside `node_modules` — a project that directly depends on onnxruntime-node itself (for its own GPU use) had it trimmed anyway. The root manifest is now checked too.
- **`release.yml` never verified the pushed tag matches `package.json`'s version**, so a tag pushed out of sync with the version bump would publish under the wrong version with no failure. It's now checked before anything else runs.
- **`release.yml` ran `npm ci` (arbitrary third-party `postinstall` scripts) in the same job that held `contents: write` and `id-token: write`.** Dependency install, build, and test now run in a separate, unprivileged job that hands only a pre-built tarball to a minimal `publish` job — the only one that holds those permissions, and the only one that touches the registry.

## 0.7.8

Five more parsing/engine bugs from the same external review, verified with reproductions before fixing ([khabouss/locale-ai#10](https://github.com/khabouss/locale-ai/issues/10)):

- **Android `strings.xml`: `translatable='false'` (single quotes) wasn't recognized**, so a string marked that way was translated anyway. Both quote styles are now accepted.
- **Android `strings.xml`: a commented-out `<string>` not immediately followed by a real element was read as live content** — the parser only recognized a `<!-- ... -->` block as a comment when it directly preceded another tag; a standalone one (at the end of the file, or followed by another comment) was scanned straight through, and tag-shaped text inside it got picked up as a real entry. Every comment not immediately attached to a following element is now excluded from matching entirely.
- **XLIFF: `translate='no'` (single quotes) wasn't recognized**, same bug as the Android one above for XLIFF's own non-translatable flag.
- **XLIFF: a self-closing `<target/>` produced a duplicate `<target>` on write** — the parser didn't recognize it as an existing target to replace, so serialize inserted a brand-new one right after `</source>` while leaving the original self-closing tag in place too. It's now replaced in place like any other `<target>`.
- **The `_one` plural-grammar fix (retranslating with a literal "1" to get the right singular noun form) could restore the wrong "1".** If the source string already had its own unrelated literal "1" and translation reordered the two, the fix could silently freeze the actual count as a literal "1" while corrupting the unrelated one into `{{count}}`. It's now only applied when exactly one standalone "1" survives in the output — ambiguous results are left alone, keeping the normal (unfixed but uncorrupted) translation instead.

## 0.7.7

Six correctness gaps in the incremental lock/rebuild pipeline, from an external code review verified against the source before fixing ([khabouss/locale-ai#8](https://github.com/khabouss/locale-ai/issues/8)):

- **`_few`/`_many` plural forms, derived once from `_other`, were never resynced.** When `_other`'s source text changed and got re-translated, its already-derived `_few`/`_many`/etc. stayed frozen with the original wording forever, with no warning from `check`. They now resync whenever `_other` is re-translated — unless a translator hand-edited that specific derived form, in which case it's left alone and flagged as a conflict (same "never silently overwrite an edit" rule as every other key) instead of being resynced or re-flagged twice.
- **`locale-ai accept` with no keys given accepted every key, not just hand-edited ones** — silently marking a genuinely outdated (source-changed-since-translated) entry as reviewed too, so `check` stopped catching it. It now only auto-accepts entries actually flagged as edited; an explicit `accept <key>` still accepts that exact key unconditionally, and can now also clear a conflict on a plural-derived key (previously impossible, since derived keys have no source counterpart for `accept` to match against).
- **A lockfile that failed to parse was treated identically to a missing one** — silently discarded, then overwritten by the next save. Since the README tells teams to commit the lockfile, an unresolved merge conflict (stray `<<<<<<<` markers) destroyed all edit/staleness history with no warning. It now throws instead of guessing.
- **The project config was only looked up in the exact working directory.** Running from a subdirectory (or with `--input ../locales`) silently missed a `locale-ai.config.json` at the project root. It now walks up parent directories like eslint/prettier, stopping at the first `.git` it finds.
- **A translation that fell back to the untranslated source text was recorded as done**, and never retried on a later run. Such entries are now excluded from the lock, so the next run retries them.
- **The lock file was saved once, after every locale in a run finished**, so interrupting the process after locale 1 of 3 lost locale 1's lock updates too, even though its target file was already written. It's now saved after each locale finishes.

## 0.7.6

Findings from testing the published package as a real first-time user (a French-source app adding en/ar/pt):

- **`©`/`®`/`™` could be silently dropped on a pivoted (two-hop) translation.** A footer like "© 2026 Acme. All rights reserved." kept its `©` translating `fr → en` directly, but lost it on `fr → en → ar`/`fr → en → pt`. These symbols are now masked and restored like every other placeholder, no config needed, so they survive any number of hops. ([khabouss/locale-ai#5](https://github.com/khabouss/locale-ai/issues/5))
- **Forgetting `--from` on a non-English-source project gave no hint.** `--from` defaults to `en`; a project whose source is actually, say, `fr` just got "Could not find en locale files" with no pointer to what *was* there. The error now scans the same folders and suggests the locale it actually found (`Found "fr" instead — did you mean --from fr?`). ([khabouss/locale-ai#4](https://github.com/khabouss/locale-ai/issues/4))
- **Docs**: explained the `install-scripts` warning npm 11.20+ prints on a fresh install (harmless — locale-ai's CUDA-trim safety net runs regardless), and added guidance on pivot-translation error propagation (fixing the intermediate language doesn't fix a pivoted target) and glossary-ing known MT weak spots (brand transliteration, false-cognate traps, untranslated domain slang) up front. ([khabouss/locale-ai#3](https://github.com/khabouss/locale-ai/issues/3), [khabouss/locale-ai#6](https://github.com/khabouss/locale-ai/issues/6))

## 0.7.5

A follow-up round from the same external review:

- **There was no way to approve a hand edit.** Once the lock flagged a target string as "edited", it stayed flagged forever — the only way out was `--overwrite`, which re-translates everything and wipes every *other* hand edit too. `locale-ai accept [--to <locales>] [key...]` now records the current on-disk text as approved (for one key, several, or every key with none given) without touching the file or retranslating anything.
- **The lock file didn't scale.** Its old (version 2) shape nested `files[fileKey][path].mt[locale]` objects several levels deep with 16-character hashes — a 5,000-key, 4-locale project produced a multi-megabyte file where every run touched lines scattered throughout it, a dedicated source of merge conflicts for teams committing it. It's now flat (one `"<fileKey>#<path>"` entry per key, one line each) with 8-character hashes, roughly 10x smaller for a project that size; a pre-0.7.5 lock is migrated automatically, with no spurious re-translation.
- **XLIFF dropped a translator's `state="final"`/`state="needs-review"` attribute** even on a run that retranslated nothing — any `<target>` got replaced with a fresh, attribute-less one regardless. An unchanged `<target>` is now left completely untouched.
- **A JS/TS locale module's same-line trailing comment (`home: 'Home', // note`) moved onto the next key** on a rewrite, so it looked like it described the wrong entry. It now stays attached to the key it was actually commenting on.
- A small changelog correction: the 0.7.0 entry below previously said that review "ran the CLI end-to-end against real cached models" — it actually used a stub translator, since the reviewer's sandbox couldn't reach Hugging Face. Speed/quality benchmarks and the quantization-batching tradeoff the same review asked about were already measured and documented (see the README's "Speed" and "Known limitations" sections); re-verified against real cached models as part of this round, numbers unchanged. ja/ko are likewise already a documented gap (no usable OPUS-MT model), not a new one.

## 0.7.4

The last three items from the same external review:

- **The `_one` plural-grammar fix (retranslating with a literal "1" to get the right singular noun form) ran one separate, unbatched model call per plural key.** A project with hundreds of plural keys paid for every one of them individually. All qualifying keys are now retranslated in a single batched call, the same as every other translation pass.
- **A download failure's error message didn't say which host it couldn't reach**, just a generic "fetch failed". It now names the host, surfaces the actual underlying network error, and — when using the default `huggingface.co` — suggests `HF_ENDPOINT` for a mirror.
- **This project's own `khabouss/*` model repos were deliberately left unpinned** (documented rationale: "we only ever change those ourselves"). They're now pinned to a commit like every other built-in model, so a compromised account or a careless upload can't silently change installed users' translations either. This does mean remembering to bump the pin here when publishing a better conversion going forward.

## 0.7.3

More from the same external review:

- **XLIFF dropped `<context-group>`** (and any other `<trans-unit>` child besides `<source>`/`<target>`/`<note>`) when writing a target file. The target is now built by replacing only the `<target>` element in place rather than reconstructing the whole unit, so everything else — `<context-group>`, `<alt-trans>`, anything else XLIFF allows there — rides through untouched.
- **`.properties` wrote a translated value as raw UTF-8 even when the source used a `\uXXXX` escape for it.** The escape convention is now tracked per key and kept on write.
- The README's "Format notes" section (one ~700-word paragraph covering every format) is now [docs/formats.md](docs/formats.md), one section per format; the README itself stays a quickstart.

## 0.7.2

Three Android `strings.xml` bugs found by the same external review, all from its regex-based parsing not accounting for Android-specific value conventions:

- **Inline markup (`<xliff:g id="...">...</xliff:g>`, Android's own placeholder-wrapper tag) came out HTML-escaped** — visible as literal `&lt;xliff:g...&gt;` text on screen instead of real XML. It's now written the same tag-protected way XLIFF's own inline `<x>`/`<g>` markup already was.
- **A value that's purely a reference to another resource (`@string/app_name`) was sent to the translation model.** It's now left alone and reproduced byte-for-byte, regardless of its own `translatable` attribute.
- **A value wrapped in a literal `"..."` pair — Android's convention for preserving leading/trailing whitespace — lost its quotes and that whitespace.** Both are now kept on write.

## 0.7.1

- **`npm install` could fail entirely on a network that can't reach `api.nuget.org`** — `onnxruntime-node`'s own postinstall tries to download a ~260 MB CUDA provider locale-ai never uses (CPU only), and that download failing took the whole install down with it, which is common behind corporate proxies and in locked-down CI. The README now documents `ONNXRUNTIME_NODE_INSTALL=skip npm install locale-ai` to skip it up front (also a faster install either way: ~51 MB / ~3s). As defense in depth, locale-ai now also re-runs its own CUDA-provider cleanup on every CLI invocation, not just at install time, since npm doesn't guarantee the postinstall that's meant to remove it runs after onnxruntime-node's own download finishes.

## 0.7.0

Fixes to `locale-ai.lock.json`, the incremental-translation lock file, found by an external review that ran the CLI end-to-end against a stub translator (not real models — the reviewer's sandbox couldn't reach Hugging Face):

- **Per-locale source tracking.** The lock used to store one source-string hash shared by every target locale. Translating `--to es` after editing a source string would mark that string "up to date" for `es` *and* for a `--to fr` run that hadn't happened yet — so `fr` silently kept the outdated translation. The hash is now tracked per locale.
- **Hand edits are never silently adopted.** A translator's edit to a target file is detected and reported for review, same as before — but it used to be recorded as if the tool itself had written it, so a later run would stop reporting it, and a subsequent source change would overwrite the edit with no warning at all. The lock no longer updates its "last written" record for a path unless this run actually (re)translated it, so an unresolved edit keeps being reported every run. If the source changes *while* an edit is still pending, that's now reported as a **conflict** instead of either side winning silently. `--overwrite` still forces past all of this when that's what you want.
- **The lock lives next to your config file (or the locale files) now, not wherever you happened to run the command from.** Running from a subdirectory with a relative `--input` used to create a second, empty lock there; the key paths inside it are now relative to the lock's own location too, so the same project always resolves to the same lock regardless of invocation directory.
- **`locale-ai check` now reads the lock.** A translation that's gone stale (source changed, target never re-run) is now a check failure, which was the main point of having a lock file for CI in the first place.
- **Deleted keys are pruned from the lock** instead of lingering forever.
- **First-run notice.** Creating the lock file for the first time now prints a line telling you to commit it.
- A pre-0.7.0 lock file is read and migrated automatically; nothing needs to be deleted or regenerated by hand.
