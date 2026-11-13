# Changelog

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
