/**
 * End-to-end test with real models. Downloads ~115 MB on first run.
 * Run with: npm run test:e2e
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  // Glossary, casing, untranslatable strings.
  assert.equal(auth.login.submit, "Se connecter");
  assert.equal(fr.actions.cta, fr.actions.cta.toUpperCase());
  assert.equal(fr.version, "v{{version}}");
  assert.equal(fr.separator, " / ");
  // French plural form added for i18next.
  assert.ok("item_many" in fr);

  // A second run is a no-op.
  const before = fs.readFileSync(path.join(dir, "locales/fr/common.json"), "utf8");
  run();
  assert.equal(fs.readFileSync(path.join(dir, "locales/fr/common.json"), "utf8"), before);
});
