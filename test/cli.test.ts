/**
 * CLI-level tests that need no model (`check` and `accept` never load one),
 * so they run in CI like everything else in `npm test` — unlike e2e.test.ts.
 * `translate` itself still can't be exercised here without a real model.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashOf, loadLock } from "../src/lock.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "../src/cli.ts");

/** Every log line in this CLI goes to stderr, so both streams are captured regardless of exit code. */
function run(args: string[], cwd: string): { status: number; output: string } {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? 1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** A project that looks like `translate --to fr` already ran once, successfully, for both keys. */
function setupTranslatedProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-cli-"));
  fs.mkdirSync(path.join(dir, "locales/en"), { recursive: true });
  fs.mkdirSync(path.join(dir, "locales/fr"), { recursive: true });
  fs.writeFileSync(path.join(dir, "locales/en/common.json"), JSON.stringify({ hello: "Hello", bye: "Goodbye" }, null, 2));
  fs.writeFileSync(path.join(dir, "locales/fr/common.json"), JSON.stringify({ hello: "Bonjour", bye: "Au revoir" }, null, 2));
  const entries = {
    "en/common.json#hello": { fr: `${hashOf("Hello")}:${hashOf("Bonjour")}` },
    "en/common.json#bye": { fr: `${hashOf("Goodbye")}:${hashOf("Au revoir")}` },
  };
  fs.writeFileSync(path.join(dir, "locales/locale-ai.lock.json"), JSON.stringify({ version: 3, entries }, null, 2));
  return dir;
}

test("accept with no keys only clears genuinely hand-edited entries, not every outdated one", () => {
  const dir = setupTranslatedProject();
  const lockPath = path.join(dir, "locales/locale-ai.lock.json");

  // A translator hand-edits "hello"; the English source for "bye" changes (so its fr
  // translation is now stale) but nobody has touched or reviewed "bye" at all.
  fs.writeFileSync(path.join(dir, "locales/fr/common.json"), JSON.stringify({ hello: "Salut", bye: "Au revoir" }, null, 2));
  fs.writeFileSync(path.join(dir, "locales/en/common.json"), JSON.stringify({ hello: "Hello", bye: "Goodbye!" }, null, 2));

  // `check` still only reports staleness/mismatch, not "edited" — confirm "bye" is flagged stale beforehand.
  const before = run(["check"], dir);
  assert.match(before.output, /"bye".*stale/);

  const accept = run(["accept"], dir);
  assert.equal(accept.status, 0);
  assert.match(accept.output, /Accepted 1 key/);

  const lock = loadLock(lockPath);
  assert.equal(lock.entries["en/common.json#hello"].fr, `${hashOf("Hello")}:${hashOf("Salut")}`, "the hand edit was accepted");
  assert.equal(
    lock.entries["en/common.json#bye"].fr,
    `${hashOf("Goodbye")}:${hashOf("Au revoir")}`,
    "the untouched, genuinely outdated key must keep its OLD recorded source hash — accept must not have silently marked it up to date",
  );

  const after = run(["check"], dir);
  assert.match(after.output, /"bye".*stale/, "still flagged after accept, since it was never actually reviewed");
});

test("accept <key> still accepts that exact key unconditionally, even if it isn't flagged as edited", () => {
  const dir = setupTranslatedProject();
  const accept = run(["accept", "hello"], dir);
  assert.equal(accept.status, 0);
  assert.match(accept.output, /Accepted 1 key/);
});

test("check flags a target plural/select with a dropped \"other\" or unbalanced braces, not just a placeholder mismatch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-cli-icu-"));
  fs.mkdirSync(path.join(dir, "locales/en"), { recursive: true });
  fs.mkdirSync(path.join(dir, "locales/fr"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "locales/en/common.json"),
    JSON.stringify({ files: "{count, plural, one {# file} other {# files}}" }, null, 2),
  );
  // A hand-edit dropped the mandatory "other" category.
  fs.writeFileSync(path.join(dir, "locales/fr/common.json"), JSON.stringify({ files: "{count, plural, one {# fichier}}" }, null, 2));

  const result = run(["check"], dir);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /"files".*broken plural\/select/);
});

test("a merge-conflicted lockfile fails loudly instead of being silently wiped", () => {
  const dir = setupTranslatedProject();
  fs.writeFileSync(
    path.join(dir, "locales/locale-ai.lock.json"),
    '{\n  "version": 3,\n  "entries": {\n<<<<<<< HEAD\n    "a": {}\n=======\n    "b": {}\n>>>>>>> branch\n  }\n}\n',
  );
  const result = run(["check"], dir);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /valid JSON|merge conflict/);
});
