/**
 * End-to-end test with real models. Downloads ~345 MB on first run (en-fr, tc-big).
 * Run with: npm run test:e2e
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "../src/cli.ts");

test("translates the fixture app to French", { skip: !process.env.LOCALE_AI_E2E, timeout: 600_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-e2e-"));
  fs.cpSync(path.join(here, "fixtures/app"), dir, { recursive: true });
  const run = () => execFileSync(process.execPath, [cli, "translate", "--to", "fr", "--yes"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  run();

  const fr = JSON.parse(fs.readFileSync(path.join(dir, "locales/fr/common.json"), "utf8"));
  const auth = JSON.parse(fs.readFileSync(path.join(dir, "locales/fr/auth.json"), "utf8"));
  const dash = JSON.parse(fs.readFileSync(path.join(dir, "locales/fr/dashboard.json"), "utf8"));
  const settingsText = fs.readFileSync(path.join(dir, "locales/fr/settings.yaml"), "utf8");
  const settings = parseYaml(settingsText);
  const stringsText = fs.readFileSync(path.join(dir, "locales/fr/extra.strings"), "utf8");
  const arb = JSON.parse(fs.readFileSync(path.join(dir, "locales/fr/app.arb"), "utf8"));
  const poText = fs.readFileSync(path.join(dir, "locales/fr/messages.po"), "utf8");

  // Structure and non-strings preserved.
  assert.equal(dash.limit, 25);
  assert.equal(dash.beta, true);
  assert.equal(dash.steps.length, 3);
  // Placeholders survive.
  assert.match(fr.greeting, /\{\{name\}\}.*\{\{count\}\}/);
  assert.match(fr.terms, /<0>[^<]+<\/0>.*<1>[^<]+<\/1>/);
  assert.match(auth.errors.tooShort, /%d/);
  assert.match(auth.errors.required, /:attribute/);
  assert.match(fr.contact, /support@acme\.com/);
  assert.match(fr.files, /^\{count, plural, =0 \{[^{}]+\} one \{[^{}]*#[^{}]*\} other \{[^{}]*#[^{}]*\}\}/);
  // Multi-sentence strings keep every sentence, multiline keeps the newline.
  assert.match(fr.actions.retry, /échoué\. .*réessayer/);
  assert.equal(fr.multiline.split("\n").length, 2);
  // Regression for cross-sentence agreement lost by always translating sentence-by-
  // sentence (src/engine.ts's whole-string-first attempt): "exportation" is feminine,
  // so the second sentence's pronoun must agree with it as "Elle", not "Il" — only
  // possible when both sentences are translated together, with shared context.
  assert.match(fr.multiline, /^Votre exportation est prête\.\nElle /);
  // Regression for the <unk>-dropping bug (src/marian.ts): the vocab has no
  // uppercase Ê, so without blocking <unk> at generation time this came back
  // "Tes-vous sûr..." — a dropped letter steered the beam to a different word
  // entirely, not just a missing character in the right one.
  assert.match(fr.actions.confirmDelete, /^Voulez-vous/);
  // Glossary, casing, untranslatable strings.
  assert.equal(auth.login.submit, "Se connecter");
  assert.equal(fr.actions.cta, fr.actions.cta.toUpperCase());
  assert.equal(fr.version, "v{{version}}");
  assert.equal(fr.separator, " / ");
  // French plural form added for i18next.
  assert.ok("item_many" in fr);

  // YAML locale files are translated too, with structure, style, and plurals preserved.
  assert.equal(settings.seatsLeft, 10);
  assert.ok(settings.title && settings.title !== "Settings");
  assert.match(settings.member_one, /\{\{count\}\}/);
  assert.ok("member_many" in settings);
  assert.ok(settingsText.startsWith("title:"), "stays YAML, not reformatted as JSON");

  // Apple .strings: comment kept, placeholder survives, stays .strings style.
  assert.match(stringsText, /\/\* Shown on the welcome screen \*\//);
  assert.match(stringsText, /"welcome" = "[^"]*%@[^"]*";/);
  assert.notEqual(/"welcome" = "([^"]*)"/.exec(stringsText)![1], "Welcome back, %@!");

  // ARB: translatable string translated, @key metadata and @@locale untouched except the locale itself.
  assert.equal(arb["@@locale"], "fr");
  assert.notEqual(arb.upgrade, "Upgrade to Pro");
  assert.deepEqual(arb["@itemCount"], { description: "Number of items in the cart", placeholders: { count: {} } });
  assert.match(arb.itemCount, /\{count, plural, =0 \{[^{}]+\} one \{#[^{}]*\} other \{#[^{}]*\}\}/);

  // .po: msgid stays the stable key, msgstr is translated, the header's Language follows the target.
  assert.match(poText, /Language: fr\\n/);
  assert.match(poText, /msgid "support"\nmsgstr "[^"]*support@acme\.com[^"]*"/);
  assert.doesNotMatch(poText, /msgstr "UPGRADE NOW"/);

  // A second run is a no-op, across every supported format.
  const targets = ["common.json", "settings.yaml", "extra.strings", "app.arb", "messages.po"];
  const before = targets.map((f) => fs.readFileSync(path.join(dir, "locales/fr", f), "utf8"));
  run();
  targets.forEach((f, i) => assert.equal(fs.readFileSync(path.join(dir, "locales/fr", f), "utf8"), before[i]));
});
