import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { reachableTargets, resolveRoute } from "../src/catalog.ts";
import { translateStrings } from "../src/engine.ts";
import { extractIcu } from "../src/icu.ts";
import { extractPipePlural } from "../src/vue-plural.ts";
import { parseLocale } from "../src/lang.ts";
import {
  addPluralForms,
  buildTarget,
  detectLayout,
  existingTargets,
  flattenStrings,
  keyPathProtect,
  pendingStrings,
  pluralOneStrings,
  readLocaleDoc,
  sourceFiles,
  targetFile,
} from "../src/locales.ts";
import type { Translator } from "../src/models.ts";
import { hasTranslatableText, mask, unmask } from "../src/placeholders.ts";
import { splitSentences } from "../src/segment.ts";

test("mask protects common placeholder syntaxes", () => {
  const cases: Array<[string, string[]]> = [
    ["Hello {name}!", ["{name}"]],
    ["Hi {{user.name}}, {{count}} new", ["{{user.name}}", "{{count}}"]],
    ["%s of %d, %1$s, %.2f, %@", ["%s", "%d", "%1$s", "%.2f", "%@"]],
    ["Value: %(amount)s and %{total}", ["%(amount)s", "%{total}"]],
    ["Click <a href=\"https://x.io/a\">here</a>", ['<a href="https://x.io/a">', "</a>"]],
    ["Press <0>Save</0> then <1/>", ["<0>", "</0>", "<1/>"]],
    ["See $t(common.terms) and @:app.name", ["$t(common.terms)", "@:app.name"]],
    ["Mail support@acme.com or visit https://acme.com.", ["support@acme.com", "https://acme.com"]],
    ["The :attribute field is required", [":attribute"]],
    ["Tom&nbsp;&amp;&nbsp;Jerry", ["&nbsp;", "&amp;", "&nbsp;"]],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(mask(input).tokens, expected, input);
  }
});

test("mask leaves ordinary text alone", () => {
  for (const s of ["100% sure", "Note: read this", "Price $5", "a < b > c", "Hello world."]) {
    assert.deepEqual(mask(s).tokens, [], s);
  }
});

test("natural markers: {n} for variables, <n>…</n> for tags", () => {
  assert.equal(mask("Hi {{name}}, see <a href=\"/x\">this</a><br/> or <b>that</b>").text, "Hi {0}, see <0>this</0><1/> or <2>that</2>");
  assert.equal(mask("Press <0>Save</0> then <1/>").text, "Press <0>Save</0> then <1/>");
  assert.equal(mask("Hi {{name}} <b>x</b>", "opaque").text, "Hi _P0_ _P1_x_P2_");
});

test("unmask restores markers and tolerates light damage", () => {
  const m = mask("Hello {name}, you have {count} messages");
  assert.equal(unmask("Bonjour {0}, vous avez {1} messages", m), "Bonjour {name}, vous avez {count} messages");
  assert.equal(unmask("Bonjour { 0 }, vous avez {1 } messages", m), "Bonjour {name}, vous avez {count} messages");
  assert.equal(unmask("Bonjour, vous avez {1} messages", m), undefined, "missing marker");
  assert.equal(unmask("{0} {0} {1}", m), undefined, "duplicated marker");
  assert.equal(unmask("{0} {1} {2}", m), undefined, "invented marker");
  const o = mask("Hello {name}", "opaque");
  assert.equal(unmask("Bonjour __ P0 __", o), "Bonjour {name}");
});

test("unmask rejects swapped tags but allows reordered pairs", () => {
  const m = mask("<b>Bold</b> and <i>italic</i>");
  assert.equal(unmask("<1>italique</1> et <0>gras</0>", m), "<i>italique</i> et <b>gras</b>");
  assert.equal(unmask("</0>gras<0> et <1>italique</1>", m), undefined);
});

test("hasTranslatableText needs real words", () => {
  assert.equal(hasTranslatableText("{0} / {1}"), false);
  assert.equal(hasTranslatableText("123 - 456"), false);
  assert.equal(hasTranslatableText("v{0}"), false);
  assert.equal(hasTranslatableText("{0} items"), true);
});

test("splitSentences keeps separators and splits sentences", () => {
  const pieces = splitSentences("Upload failed. Please try again.\nThanks!", "en");
  assert.deepEqual(
    pieces.filter((p) => p.translate).map((p) => p.value),
    ["Upload failed.", "Please try again.", "Thanks!"],
  );
  assert.equal(pieces.map((p) => p.value).join(""), "Upload failed. Please try again.\nThanks!");
});

test("ICU plural/select extraction and rebuild", () => {
  const s = "{count, plural, =0 {No files} one {# file} other {# files}} in {folder}";
  const icu = extractIcu(s)!;
  assert.deepEqual(icu.units, ["No files", "{__HASH__} file", "{__HASH__} files", " in {folder}"]);
  const out = icu.rebuild(["Aucun fichier", "{__HASH__} fichier", "{__HASH__} fichiers", " dans {folder}"]);
  assert.equal(out, "{count, plural, =0 {Aucun fichier} one {# fichier} other {# fichiers}} dans {folder}");

  const nested = extractIcu("{gender, select, male {He has {n, plural, one {# cat} other {# cats}}} other {They have pets}}")!;
  assert.deepEqual(nested.units, ["He has ", "{__HASH__} cat", "{__HASH__} cats", "They have pets"]);
  assert.equal(extractIcu("{count, plural, one {broken}"), undefined);
  assert.equal(extractIcu("Hello {name}"), undefined);
});

test("vue-i18n pipe plural extraction and rebuild", () => {
  const s = "no items | one item | {count} items";
  const p = extractPipePlural(s)!;
  assert.deepEqual(p.units, ["no items", "one item", "{count} items"]);
  assert.equal(p.rebuild(["aucun article", "un article", "{count} articles"]), "aucun article | un article | {count} articles");

  // No spaces around the pipe: the rebuilt string keeps that shape too.
  const tight = extractPipePlural("a|b|{n} c")!;
  assert.deepEqual(tight.units, ["a", "b", "{n} c"]);
  assert.equal(tight.rebuild(["x", "y", "{n} z"]), "x|y|{n} z");

  assert.equal(extractPipePlural("just one message"), undefined);
  assert.equal(extractPipePlural("{choices, select, a {x|y} other {z}}"), undefined); // '|' only inside braces
  assert.equal(extractPipePlural("leading | | double pipe"), undefined); // empty form: not a plural list
});

test("routes: direct, multi-target prefix, pivot, unsupported", () => {
  const en = parseLocale("en");
  assert.deepEqual(resolveRoute(en, parseLocale("fr"))!.map((h) => h.model.id), ["en-fr"]);
  const pt = resolveRoute(en, parseLocale("pt-BR"))!;
  assert.equal(pt[0].model.id, "en-pt");
  assert.equal(pt[0].prefix, ">>pob<<");
  assert.equal(resolveRoute(en, parseLocale("zh-TW"))![0].prefix, ">>cmn_Hant<<");
  assert.equal(resolveRoute(en, parseLocale("ar"))![0].prefix, ">>ara<<");
  assert.deepEqual(resolveRoute(parseLocale("ja"), parseLocale("fr"))!.map((h) => h.model.id), ["ja-en", "en-fr"]);
  assert.equal(resolveRoute(en, parseLocale("en-GB")), undefined);
  assert.equal(resolveRoute(en, parseLocale("tlh")), undefined);
  assert.ok(reachableTargets("en").includes("de"));
});

test("parseLocale normalizes tags", () => {
  assert.deepEqual(parseLocale("pt_br"), { tag: "pt_br", lang: "pt", region: "BR" });
  assert.deepEqual(parseLocale("zh-hant-TW"), { tag: "zh-hant-TW", lang: "zh", script: "Hant", region: "TW" });
  assert.equal(parseLocale("nb").lang, "no");
  assert.throws(() => parseLocale("../etc"));
});

test("buildTarget keeps existing translations, order and extra keys", () => {
  const src = { a: "Hello", b: { c: "World", d: 3 }, e: ["One", "Two"], f: "" };
  const existing = { b: { c: "Monde" }, zz: "kept" };
  assert.deepEqual(pendingStrings(src, existing, false), ["Hello", "One", "Two", ""]);
  const out = buildTarget(src, existing, (s) => `[${s}]`, false);
  assert.equal(JSON.stringify(out), JSON.stringify({ a: "[Hello]", b: { c: "Monde", d: 3 }, e: ["[One]", "[Two]"], f: "[]", zz: "kept" }));
  assert.equal(JSON.stringify(buildTarget(src, existing, (s) => `[${s}]`, true)).includes("[World]"), true);
});

test("buildTarget treats __proto__ keys as data", () => {
  const src = JSON.parse('{"__proto__": {"polluted": "yes"}}');
  const out = buildTarget(src, undefined, (s) => s, false) as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(JSON.stringify(out), '{"__proto__":{"polluted":"yes"}}');
});

test("keyPathProtect: protects an exact path and everything nested under it (an enum array)", () => {
  const src = {
    brand: { name: "Acme", tagline: "Acme makes your work easier" },
    config: { statusEnum: ["ACTIVE", "PENDING"] },
    greeting: "Welcome",
  };
  const isProtected = keyPathProtect(["brand.name", "config.statusEnum"]);
  assert.deepEqual(pendingStrings(src, undefined, false, isProtected).sort(), [
    "Acme makes your work easier",
    "Welcome",
  ]);
  const built = buildTarget(src, undefined, () => "[translated]", false, isProtected) as typeof src;
  assert.equal(built.brand.name, "Acme", "protected leaf is copied verbatim");
  assert.deepEqual(built.config.statusEnum, ["ACTIVE", "PENDING"], "protected array is untouched");
  assert.equal(built.brand.tagline, "[translated]", "an unprotected sibling still translates");
  assert.equal(built.greeting, "[translated]");

  assert.equal(keyPathProtect(undefined), undefined);
  assert.equal(keyPathProtect([]), undefined);
});

test("addPluralForms adds the forms the target language needs", () => {
  const doc = { item_one: "1 élément", item_other: "{{count}} éléments", gender_other: "Autre", x: 1 };
  const ar = addPluralForms(doc, "ar");
  assert.deepEqual(Object.keys(ar.doc as object), [
    "item_zero", "item_one", "item_two", "item_few", "item_many", "item_other", "gender_other", "x",
  ]);
  assert.equal(ar.added, 4);
  assert.equal(addPluralForms(doc, "ja").added, 0);
  // Idempotent: running again on the result changes nothing.
  const again = addPluralForms(ar.doc, "ar");
  assert.equal(again.added, 0);
  assert.equal(JSON.stringify(again.doc), JSON.stringify(ar.doc));
});

test("pluralOneStrings: finds cardinal _one values, ignores ordinals and other categories", () => {
  const doc = {
    itemCount_one: "{{count}} item",
    itemCount_other: "{{count}} items",
    nested: { fileCount_one: "You have {{count}} file", fileCount_other: "You have {{count}} files" },
    list: [{ rank_ordinal_one: "{{count}}st place" }],
    plain: "not a plural key",
  };
  assert.deepEqual(pluralOneStrings(doc), new Set(["{{count}} item", "You have {{count}} file"]));
});

test("detects dir and file layouts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-"));
  fs.mkdirSync(path.join(root, "src/locales/en/admin"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/locales/en/common.json"), "{}");
  fs.writeFileSync(path.join(root, "src/locales/en/admin/users.json"), "{}");
  const l = detectLayout(root, "en");
  assert.deepEqual(l, { kind: "dir", root: path.join(root, "src/locales") });
  const files = sourceFiles(l, "en");
  assert.equal(files.length, 2);
  assert.equal(targetFile(l, "en", "fr", files[0]), path.join(root, "src/locales/fr/admin/users.json"));

  fs.mkdirSync(path.join(root, "messages"));
  fs.writeFileSync(path.join(root, "messages/en.json"), "{}");
  const f = detectLayout(root, "en", "messages");
  assert.equal(targetFile(f, "en", "de", sourceFiles(f, "en")[0]), path.join(root, "messages/de.json"));
  assert.throws(() => detectLayout(root, "xx"));
});

test("flattenStrings: key paths for nested objects and arrays", () => {
  assert.deepEqual(flattenStrings({ a: "x", b: { c: "y" }, d: ["p", "q"] }), [
    { path: "a", value: "x" },
    { path: "b.c", value: "y" },
    { path: "d[0]", value: "p" },
    { path: "d[1]", value: "q" },
  ]);
  assert.deepEqual(flattenStrings("just a string"), [{ path: "(root)", value: "just a string" }]);
});

test("existingTargets: finds already-translated locales, dir and file layout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-targets-"));
  fs.mkdirSync(path.join(root, "locales/en"), { recursive: true });
  fs.mkdirSync(path.join(root, "locales/fr"), { recursive: true });
  fs.mkdirSync(path.join(root, "locales/empty")); // no locale files inside: not a target
  fs.writeFileSync(path.join(root, "locales/en/common.json"), "{}");
  fs.writeFileSync(path.join(root, "locales/fr/common.json"), "{}");
  const l = detectLayout(root, "en");
  assert.deepEqual(existingTargets(l, "en"), ["fr"]);

  const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lai-targets-file-"));
  fs.writeFileSync(path.join(fileRoot, "en.json"), "{}");
  fs.writeFileSync(path.join(fileRoot, "fr.json"), "{}");
  fs.writeFileSync(path.join(fileRoot, "de.json"), "{}");
  const f = detectLayout(fileRoot, "en");
  assert.deepEqual(existingTargets(f, "en"), ["de", "fr"]);
});

test("YAML locale files: dir layout (mixed with JSON), file layout, and round-trip style", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-"));
  fs.mkdirSync(path.join(root, "locales/en"), { recursive: true });
  fs.writeFileSync(path.join(root, "locales/en/common.json"), "{}");
  fs.writeFileSync(path.join(root, "locales/en/auth.yaml"), "login:\n  submit: Sign in\n");

  const l = detectLayout(root, "en");
  assert.equal(l.kind, "dir");
  const files = sourceFiles(l, "en");
  assert.deepEqual(
    files.map((f) => path.basename(f)).sort(),
    ["auth.yaml", "common.json"],
  );
  const yamlSrc = files.find((f) => f.endsWith(".yaml"))!;
  assert.equal(targetFile(l, "en", "fr", yamlSrc), path.join(root, "locales/fr/auth.yaml"));

  const doc = readLocaleDoc(yamlSrc, "en");
  assert.deepEqual(doc.data, { login: { submit: "Sign in" } });
  // Unchanged data re-serializes to the same text (indent and trailing newline preserved).
  assert.equal(doc.serialize(doc.data, "en"), "login:\n  submit: Sign in\n");
  // An edited value keeps the same style.
  assert.equal(doc.serialize({ login: { submit: "Se connecter" } }, "fr"), "login:\n  submit: Se connecter\n");

  // File layout: <root>/en.yaml -> <root>/fr.yaml, not .json.
  const fileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-file-"));
  fs.writeFileSync(path.join(fileRoot, "en.yml"), "greeting: Hello\n");
  const fl = detectLayout(fileRoot, "en");
  assert.equal(fl.kind, "file");
  assert.equal(targetFile(fl, "en", "fr", sourceFiles(fl, "en")[0]), path.join(fileRoot, "fr.yml"));
});

test("Rails-style YAML: single top-level key matching the locale tag is unwrapped, and rewrapped under the target's tag", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-yaml-rails-"));
  const file = path.join(root, "en.yml");
  fs.writeFileSync(file, "en:\n  hello: Hello\n  greeting: Hi %{name}\n");

  const doc = readLocaleDoc(file, "en");
  assert.deepEqual(doc.data, { hello: "Hello", greeting: "Hi %{name}" });
  assert.equal(doc.serialize(doc.data, "en"), "en:\n  hello: Hello\n  greeting: Hi %{name}\n");

  const built = { hello: "Bonjour", greeting: "Bonjour %{name}" };
  assert.equal(doc.serialize(built, "fr"), "fr:\n  hello: Bonjour\n  greeting: Bonjour %{name}\n");

  // A plain (unwrapped) YAML file is untouched even if it happens to have one top-level key,
  // as long as that key isn't the source locale's own tag.
  const plain = path.join(root, "en2.yml");
  fs.writeFileSync(plain, "login:\n  submit: Sign in\n");
  const plainDoc = readLocaleDoc(plain, "en");
  assert.deepEqual(plainDoc.data, { login: { submit: "Sign in" } });
  assert.equal(plainDoc.serialize(plainDoc.data, "fr"), "login:\n  submit: Sign in\n");
});

test("Apple .strings: comments kept per key, round-trip style, new keys appended", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-strings-"));
  const file = path.join(root, "en.strings");
  fs.writeFileSync(file, '/* Shown on launch */\n"greeting" = "Hello, %@!";\n\n"farewell" = "Goodbye";\n');
  const doc = readLocaleDoc(file, "en");
  assert.equal(JSON.stringify(doc.data), '{"greeting":"Hello, %@!","farewell":"Goodbye"}');
  assert.equal(doc.serialize(doc.data, "en"), '/* Shown on launch */\n"greeting" = "Hello, %@!";\n\n"farewell" = "Goodbye";\n');
  assert.equal(
    doc.serialize({ greeting: "Bonjour, %@!", farewell: "Au revoir", extra: "New" }, "fr"),
    '/* Shown on launch */\n"greeting" = "Bonjour, %@!";\n\n"farewell" = "Au revoir";\n\n"extra" = "New";\n',
  );
});

test("Apple .strings: // line comments (single and consecutive) are kept per key too", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-strings-linecomment-"));
  const file = path.join(root, "en.strings");
  fs.writeFileSync(
    file,
    '// Shown on launch\n"greeting" = "Hello, %@!";\n\n// Shown twice\n// when the user signs out\n"farewell" = "Goodbye";\n',
  );
  const doc = readLocaleDoc(file, "en");
  assert.equal(JSON.stringify(doc.data), '{"greeting":"Hello, %@!","farewell":"Goodbye"}');
  assert.equal(
    doc.serialize(doc.data, "en"),
    '// Shown on launch\n"greeting" = "Hello, %@!";\n\n// Shown twice\n// when the user signs out\n"farewell" = "Goodbye";\n',
  );
});

test("ARB: @key metadata and @@locale are not translatable and are reinserted; @@locale follows the target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-arb-"));
  const file = path.join(root, "en.arb");
  fs.writeFileSync(
    file,
    JSON.stringify(
      { "@@locale": "en", greeting: "Hello, {name}!", "@greeting": { description: "Greeting", placeholders: { name: {} } } },
      null,
      2,
    ),
  );
  const doc = readLocaleDoc(file, "en");
  assert.equal(JSON.stringify(doc.data), '{"greeting":"Hello, {name}!"}');
  const built = { greeting: "Bonjour, {name}!" };
  const out = JSON.parse(doc.serialize(built, "fr"));
  assert.equal(out["@@locale"], "fr");
  assert.equal(out.greeting, "Bonjour, {name}!");
  assert.deepEqual(out["@greeting"], { description: "Greeting", placeholders: { name: {} } });
});

test("gettext .po: msgid is the stable key; plural entries are translated and expanded to the target's plural count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-po-"));
  const file = path.join(root, "en.po");
  fs.writeFileSync(
    file,
    [
      'msgid ""',
      'msgstr "Language: \\n"',
      "",
      "#: src/app.js:10",
      'msgid "greeting"',
      'msgstr "Hello!"',
      "",
      'msgid "items"',
      'msgid_plural "items_plural"',
      'msgstr[0] "one item"',
      'msgstr[1] "many items"',
      "",
    ].join("\n"),
  );
  const doc = readLocaleDoc(file, "en");
  assert.equal(
    JSON.stringify(doc.data),
    '{"\\u0004greeting":"Hello!","\\u0004items\\u0005one":"one item","\\u0004items\\u0005other":"many items"}',
  );
  const built = {
    "\u0004greeting": "Bonjour!",
    "\u0004items\u0005one": "un article",
    "\u0004items\u0005other": "plusieurs articles",
  };
  const text = doc.serialize(built, "fr");
  assert.match(text, /msgstr "Language: fr\\n"/);
  assert.match(text, /#: src\/app\.js:10\nmsgid "greeting"\nmsgstr "Bonjour!"/);
  // French (nplurals=2): index 0 from the singular-sourced translation, index 1 from the plural-sourced one.
  assert.match(text, /msgid_plural "items_plural"\nmsgstr\[0\] "un article"\nmsgstr\[1\] "plusieurs articles"/);

  // Arabic (nplurals=6): all indices past 0 get the plural-sourced translation.
  const arBuilt = { "\u0004items\u0005one": "عنصر واحد", "\u0004items\u0005other": "عناصر" };
  const arText = doc.serialize(arBuilt, "ar");
  assert.match(arText, /msgstr\[0\] "عنصر واحد"/);
  for (let i = 1; i < 6; i++) assert.match(arText, new RegExp(`msgstr\\[${i}\\] "عناصر"`));

  // A target with no translation yet falls back to the English msgid/msgid_plural, not empty strings.
  const untouched = doc.serialize({}, "es");
  assert.match(untouched, /msgstr\[0\] "items"\nmsgstr\[1\] "items_plural"/);
});

test("gettext .po: Plural-Forms is computed per target language, and a hand-fixed existing header survives a rerun", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lai-po-header-"));
  const file = path.join(root, "en.po");
  fs.writeFileSync(
    file,
    ['msgid ""', 'msgstr "Language: \\nPlural-Forms: nplurals=2; plural=(n != 1);\\n"', "", 'msgid "greeting"', 'msgstr "Hello!"', ""].join(
      "\n",
    ),
  );
  const doc = readLocaleDoc(file, "en");
  const built = { "\u0004greeting": "مرحبا!" };

  // Brand-new target file: Plural-Forms is computed for Arabic (6 categories), not copied from English (2).
  const fresh = doc.serialize(built, "ar");
  assert.match(fresh, /Language: ar/);
  assert.match(fresh, /Plural-Forms: nplurals=6;/);

  // An existing target file whose header a translator hand-fixed (e.g. a corrected
  // Plural-Forms) keeps that header verbatim on a rerun, instead of it reverting.
  const handFixed = ['msgid ""', 'msgstr "Language: ar\\nPlural-Forms: nplurals=6; plural=(n==0 ? 0 : 5);\\nLast-Translator: Alex\\n"', "", 'msgid "greeting"', 'msgstr "مرحبا!"', ""].join(
    "\n",
  );
  const rerun = doc.serialize(built, "ar", handFixed);
  assert.match(rerun, /Last-Translator: Alex/);
  assert.match(rerun, /Plural-Forms: nplurals=6; plural=\(n==0 \? 0 : 5\);/);
});

/** A fake model: uppercases words, keeps tokens, optionally drops one. */
function fakeTranslator(fn: (s: string) => string): Translator {
  return { translate: async (texts) => texts.map(fn), dispose: async () => {} };
}

test("engine: sentences, placeholders, caps, punctuation, fallback", async () => {
  const tr = fakeTranslator((s) => {
    if (s.includes("drop")) return s.replace(/\{1\}|_P1_|901/, "");
    return `«${s.replace(/\.$/, "")}».`;
  });
  const { translations, issues } = await translateStrings(
    ["Hello {name}. Bye.", "SAVE", "Settings", "{{count}}", "keep __P0__ drop {a} {b}", "{n, plural, one {# day} other {# days}}"],
    [tr],
    { sourceLang: "en", targetLang: "fr", batchSize: 2 },
  );
  assert.equal(translations.get("Hello {name}. Bye."), "«Hello {name}». «Bye».");
  assert.equal(translations.get("SAVE"), "«SAVE»");
  assert.equal(translations.get("Settings"), "«Settings»", "no trailing period added to labels");
  assert.equal(translations.get("{{count}}"), "{{count}}", "placeholder-only strings are copied");
  assert.equal(translations.get("{n, plural, one {# day} other {# days}}"), "{n, plural, one {«# day»} other {«# days»}}");
  assert.ok(issues.some((i) => i.kind === "placeholder-fallback"));
  const fb = translations.get("keep __P0__ drop {a} {b}")!;
  assert.ok(fb.includes("{a}") && fb.includes("{b}"), fb);
});

test("glossary: built-in UI terms, project overrides, casing and punctuation", async () => {
  const { glossaryLookup, protectRegex } = await import("../src/glossary.ts");
  const en = parseLocale("en");
  const fr = glossaryLookup(en, parseLocale("fr"), { glossary: { fr: { Home: "Page d'accueil" } } });
  assert.equal(fr("Sign in"), "Se connecter");
  assert.equal(fr("SIGN IN"), "SE CONNECTER");
  assert.equal(fr("Loading…"), "Chargement…");
  assert.equal(fr("Password:"), "Mot de passe :");
  assert.equal(fr("Home"), "Page d'accueil", "project glossary wins");
  assert.equal(fr("Sign in to continue"), undefined, "whole strings only");
  assert.equal(glossaryLookup(en, parseLocale("pt-PT"), {})("Save"), undefined, "pt-BR terms not used for pt-PT");
  assert.equal(glossaryLookup(parseLocale("de"), parseLocale("fr"), {})("Save"), undefined, "English sources only");
  const re = protectRegex({ doNotTranslate: ["Acme", "Acme Pro"] })!;
  assert.deepEqual(mask("Upgrade to Acme Pro today", "natural", re).tokens, ["Acme Pro"]);
  assert.deepEqual(mask("Acmeville is not Acme", "natural", re).tokens, ["Acme"]);
});

test("engine: count stays before the noun, tag spacing restored", async () => {
  const tr = fakeTranslator((s) => (s === "{0} file" ? "Fichier {0}" : s.replace("<0>", "<0> ")));
  const { translations } = await translateStrings(["{n} file", "Read the <b>terms</b>"], [tr], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
  });
  assert.equal(translations.get("{n} file"), "{n} fichier");
  assert.equal(translations.get("Read the <b>terms</b>"), "Read the <b>terms</b>");
});

test("numeric markers: restore, reject collisions", async () => {
  const { numericStyleSafe } = await import("../src/placeholders.ts");
  const m = mask("Hi {name}, <b>{count}</b> new", "numeric");
  assert.equal(m.text, "Hi 900, 901 new");
  assert.equal(unmask("Привет, 900, 901 новых", m), "Привет, {name}, <b>{count}</b> новых");
  assert.equal(unmask("Привет, 900 новых", m), undefined);
  assert.equal(numericStyleSafe("Call 911 now"), false);
  assert.equal(numericStyleSafe("Call 1911 or 9000"), true);
});

test("engine: retries a failing style with numeric markers; fallback keeps punctuation", async () => {
  // Drops brace markers (like en-ru does) but keeps numbers.
  const tr = fakeTranslator((s) => s.replace(/\{\d+\}/g, "").replace("Hello", "Привет"));
  const { translations, issues } = await translateStrings(["Hello {{name}}, welcome"], [tr], {
    sourceLang: "en",
    targetLang: "ru",
    batchSize: 4,
  });
  assert.equal(translations.get("Hello {{name}}, welcome"), "Привет {{name}}, welcome");
  assert.equal(issues.length, 0);

  const dropAll = fakeTranslator((s) => s.replace(/\{\d+\}|9\d\d|_P\d+_/g, "").replace("you have", "у вас"));
  const r = await translateStrings(["Hello {{name}}, you have {{n}} messages"], [dropAll], {
    sourceLang: "en",
    targetLang: "ru",
    batchSize: 4,
  });
  assert.equal(r.translations.get("Hello {{name}}, you have {{n}} messages"), "Hello {{name}}, у вас {{n}} messages");
});

test("engine: a suspicious batched output is retried alone, and the clean retry is kept silently", async () => {
  // Simulates batch-dependent quantization noise: translating "Good morning" alongside
  // other strings in one batch hallucinates a repeating garble, but translating it
  // alone (batch of 1) is clean.
  const flaky: Translator = {
    translate: async (texts) => texts.map((s) => (s === "Good morning" && texts.length > 1 ? "non non non non non" : "Bonjour")),
    dispose: async () => {},
  };
  const { translations, issues } = await translateStrings(["Good morning", "Good night"], [flaky], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
  });
  assert.equal(translations.get("Good morning"), "Bonjour");
  assert.equal(issues.length, 0, "the retry succeeded, so nothing is reported");

  // When even the solo retry is still suspicious, the (flawed) output ships and is reported.
  const stuck: Translator = { translate: async (texts) => texts.map(() => "non non non non non"), dispose: async () => {} };
  const r2 = await translateStrings(["Good morning"], [stuck], { sourceLang: "en", targetLang: "fr", batchSize: 4 });
  assert.equal(r2.translations.get("Good morning"), "Non non non non non");
  assert.ok(r2.issues.some((i) => i.kind === "repetition"));
});

test("engine: an i18next _one string is retranslated with a literal 1, fixing the wrong plural noun", async () => {
  // Simulates a measured real bug: given the masked {0} marker, the model infers the
  // target's PLURAL noun form even though the English source is singular; given the
  // real number "1" instead, it gets the grammar right.
  const grammarSensitive: Translator = {
    translate: async (texts) =>
      texts.map((s) => {
        if (s === "You have {0} file") return "Vous avez {0} fichiers";
        if (s === "You have 1 file") return "Vous avez 1 fichier";
        return s;
      }),
    dispose: async () => {},
  };
  const source = "You have {{count}} file";
  const withoutHint = await translateStrings([source], [grammarSensitive], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
  });
  assert.equal(withoutHint.translations.get(source), "Vous avez {{count}} fichiers", "unfixed without the hint");

  const withHint = await translateStrings([source], [grammarSensitive], {
    sourceLang: "en",
    targetLang: "fr",
    batchSize: 4,
    singularHints: new Set([source]),
  });
  assert.equal(withHint.translations.get(source), "Vous avez {{count}} fichier");
});

test("custom models: config entries win over built-ins, prefixes per target", async () => {
  const { customEntries, resolveRoute, CATALOG } = await import("../src/catalog.ts");
  const custom = customEntries(
    [
      { source: "en", target: ["ar", "ary"], path: "models/en-ar", prefix: { ar: ">>ara<<", ary: ">>ary<<" } },
      { id: "my-ko", source: "en", target: "ko", repo: "me/opus-mt-en-ko-onnx" },
    ],
    "/project",
  );
  const catalog = [...custom, ...CATALOG];
  const en = parseLocale("en");
  const ar = resolveRoute(en, parseLocale("ar"), catalog)!;
  assert.equal(ar[0].model.path, path.resolve("/project", "models/en-ar"));
  assert.equal(ar[0].prefix, ">>ara<<");
  assert.equal(resolveRoute(en, parseLocale("ary"), catalog)![0].prefix, ">>ary<<");
  assert.equal(resolveRoute(en, parseLocale("ko"), catalog)![0].model.id, "my-ko");
  assert.equal(resolveRoute(en, parseLocale("ko")), undefined, "not available without config");
  // Pivot through a custom model: ja -> en (built-in) -> ko (custom).
  assert.deepEqual(resolveRoute(parseLocale("ja"), parseLocale("ko"), catalog)!.map((h) => h.model.id), ["ja-en", "my-ko"]);
  assert.throws(() => customEntries([{ source: "en", target: "ko" }], "/"), /exactly one of "repo" or "path"/);
});

test("SentencePiece encoder matches the reference segmentation (if a model is cached)", async (t) => {
  const { SentencePiece } = await import("../src/spm.ts");
  const { cacheRoot } = await import("../src/models.ts");
  const spm = path.join(cacheRoot(), "models/Xenova/opus-mt-en-fr/source.spm");
  if (!fs.existsSync(spm)) return t.skip("en-fr model not installed");
  const sp = new SentencePiece(fs.readFileSync(spm));
  // Expected values produced by Python sentencepiece 0.2.
  assert.deepEqual(sp.encode("This action cannot be undone."), ["▁This", "▁action", "▁cannot", "▁be", "▁und", "one", "."]);
  assert.deepEqual(sp.encode("Zero​width"), ["▁Zero", "▁width"]);
  assert.deepEqual(sp.encode("  Hello   world\t\tagain  "), sp.encode("Hello world again"));
  assert.deepEqual(sp.encode(""), []);
});
