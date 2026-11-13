# Format notes

Per-format details on round-trip fidelity and edge cases — what survives a rerun, what gets regenerated, and conventions specific to each format. For the list of supported layouts and a general overview, see the [README](../README.md#what-it-handles).

## YAML (`.yaml`/`.yml`)

`#` comments (a translator note, an inline `# ...` after a value) survive a translation run — the target file is edited in place rather than rebuilt from scratch, so an existing comment's own value is updated without disturbing the comment, and a brand-new key is appended with no comment of its own. A newly added plural-category key is likewise appended rather than inserted between existing ones, so its position in the file won't always match the canonical `zero`/`one`/`two`/`few`/`many`/`other` order.

## gettext (`.po`/`.pot`)

`msgid` is the stable key (never changed) and `msgstr` is the translated value, as gettext expects — the English source's `msgstr` holds the source text when it's filled in (most generators do), and falls back to `msgid` itself when it's empty, which is normal for a `.pot` template or a project that just keeps the English text in `msgid`. That fallback only ever applies to the source file: an empty `msgstr` in an *existing target* still means "not translated yet", never "same as msgid".

`msgid_plural`/`msgstr[n]` plural entries are translated too (the singular and plural source forms), then expanded to however many `msgstr[n]` the target language's plural rules need (6 for Arabic, 1 for Japanese, ...) — not full grammatical inflection for in-between categories (`few`/`many`/...), which get the plural-sourced translation verbatim, the same simplification `addPluralForms` makes for i18next. `Plural-Forms` in the header is computed for the target language, not copied from the source; an existing target file's header, and any entry's own comments (a translator's note, a hand-added `#, fuzzy`), are otherwise left exactly as last edited instead of being regenerated from the source on every rerun.

`--fuzzy` flags every entry a run actually (re)translated with gettext's standard `#, fuzzy` "needs review" marker, merging onto an existing `#,` line rather than adding a second one. A `.pot` source always writes a `.po` target, never a `.pot`.

## Flutter ARB (`.arb`)

`@key` metadata and `@@locale` are never translated; `@@locale` is set to the target locale on output.

## Apple `.strings`

A file saved as UTF-16 (Xcode's traditional default) is read like a UTF-8 one, an unquoted key (`title = "Settings";`, without quotes around `title`) is read the same as a quoted one, and `\U00e9`-style escapes are decoded — output is always written as UTF-8 with quoted keys, regardless of how the source was saved.

## Android `strings.xml`

`translatable="false"` strings and each element's own `<!-- ... -->` comment are kept on first write, but — unlike YAML/`.po`/`.strings` — a rerun regenerates the file from scratch rather than editing an existing target in place, so a hand-edited comment in an already-translated file won't survive a rerun.

A value that's purely a reference to another resource (`@string/app_name`) is never translated, regardless of its own `translatable` attribute. Inline markup inside a value — most commonly `<xliff:g id="...">...</xliff:g>`, Android's own placeholder-wrapper tag — comes out as real, untouched XML rather than visible escaped text. A value entirely wrapped in a literal `"..."` pair (Android's own convention for preserving leading/trailing whitespace) keeps those quotes, and that whitespace, on write.

## Apple `.xcstrings`

Every target locale is written into the same one catalog file (each locale's run re-reads it first, so several locales share it safely in one invocation); an entry's `state` (e.g. a translator's `needs_review` flag) is only touched when the value it's attached to actually changes, so hand review survives a rerun.

## Java `.properties`

`#`/`!` comments and blank lines survive a rerun exactly like YAML's — the target file is edited in place rather than rebuilt from scratch; a `\`-continued multi-line value is read correctly but gets collapsed onto one line if it's ever actually rewritten (an untouched one keeps its original layout), and a line with no unescaped `=`/`:` at all is left completely alone rather than guessed at. `.properties` has no plural convention of its own, so ICU `{count, plural, ...}` inside a value is handled the same generic way it is everywhere else.

A key whose source value uses `\uXXXX` escapes (rather than literal UTF-8) keeps using them when rewritten, instead of switching to raw UTF-8 — the convention is tracked per key, from whichever file is actually being edited (the existing target file's own convention when one exists, otherwise the source's).

## XLIFF 1.2 (`.xlf`/`.xliff`)

Unlike Android/ARB/`.xcstrings` (which regenerate the whole entry from the source every run), only the `<target>` element itself is ever replaced — every other child a `<trans-unit>` can have (`<note>`, `<context-group>` recording where the string is used in the app's own source, `<alt-trans>`, ...) rides through completely untouched, in its original position. A translator's own `<target state="...">` attribute is the one exception: a fresh `<target>` (no attributes) replaces it wholesale on a rerun, the same documented tradeoff Android already makes for comments on an already-translated string. `<file target-language="...">` is set to the target locale on output.

## .NET `.resx`

Gets the same regenerate-from-source treatment as XLIFF/Android/ARB/`.xcstrings`.

## JS/TS locale modules

The exported object is regenerated from the source's own key order on every run (with each key's own preceding `//`/`/* */` comment, if any, kept) rather than edited in place; everything outside the object itself — imports, other top-level code, a trailing `as const`/`satisfies ...` — is passed through completely unchanged.
