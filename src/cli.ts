#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CATALOG,
  customEntries,
  findById,
  reachableTargets,
  resolveRoute,
  type Hop,
  type ModelEntry,
} from "./catalog.ts";
import { translateStrings, type Issue } from "./engine.ts";
import { CONFIG_FILE, glossaryLookup, loadConfig, protectRegex, type ProjectConfig } from "./glossary.ts";
import { intlCode, parseLocale, type Locale } from "./lang.ts";
import { editedPaths, isSourceStale, LOCK_FILENAME, loadLock, recordEntries, saveLock } from "./lock.ts";
import {
  addNestedPluralForms,
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
  usesI18nextPlurals,
  type LocaleDoc,
} from "./locales.ts";
import {
  cacheRoot,
  install,
  isInstalled,
  loadTranslator,
  localModelProblem,
  planInstall,
  readManifest,
  uninstall,
  type InstallPlan,
  type Translator,
} from "./models.ts";
import { hasTranslatableText, mask } from "./placeholders.ts";

/** Read from package.json so `npm version` is the single source of truth. */
const VERSION: string = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;

const HELP = `locale-ai ${VERSION} — translate i18n locale files locally, on CPU, for free.

Usage:
  locale-ai translate --to <locales> [options]
  locale-ai check [--from <locale>]
                        Validate that already-translated locales have the same keys and
                        placeholders as the source, without translating. Exits non-zero
                        on a mismatch (CI-friendly).
  locale-ai models list [--from <locale>]
  locale-ai models installed
  locale-ai models install <from-to | model-id> [--yes]
  locale-ai models remove <model-id>
  locale-ai models convert <hf-marian-model> --out <dir> [--source en --target ko]
                        Convert any Hugging Face MarianMT model (needs Python, see README)

Translate options:
  --from <locale>       Source locale (default: en)
  --to <locales>        Target locale(s), comma separated: fr,es,pt-BR
  --input <dir>         Folder containing <from>/ or <from>.json/.yaml/.yml/.po/.pot/.arb/.strings,
                        an Android res/ folder (values/strings.xml) (auto-detected),
                        a path straight to a .xcstrings catalog (not auto-detected),
                        or a path straight to a .xlf/.xliff file (not auto-detected)
  --overwrite           Re-translate strings that already have a translation
  --dry-run             Show what would be translated without downloading or writing
  --fast                Greedy decoding: ~2x faster, slightly lower quality
  --beams <n>           Beam width for decoding (default: 4, or 1 with --fast)
  --batch-size <n>      Strings translated per model batch (default: 32)
  --report <file>       Write a JSON report of strings that need review
  --fuzzy               For .po/.pot: flag every entry this run (re)translated as "#, fuzzy"
  --config <file>       Project config (default: ./${CONFIG_FILE} if present)
  -y, --yes             Download required models without asking

Models are cached in ${cacheRoot()} (override with LOCALE_AI_CACHE).
`;

const isTTY = process.stderr.isTTY;
const log = (msg = "") => process.stderr.write(msg + "\n");
const status = (msg: string) => {
  if (isTTY) process.stderr.write(`\r\x1b[2K${msg}`);
};
const endStatus = () => {
  if (isTTY) process.stderr.write("\r\x1b[2K");
};

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const rel = (p: string) => path.relative(process.cwd(), p) || ".";
/** Portable lock-file key: forward slashes regardless of platform. */
const fileKey = (p: string) => rel(p).split(path.sep).join("/");

/**
 * `Number("abc")` is NaN, and NaN silently poisons everything downstream (an
 * all-garbage translation batch, or a raw ONNX crash deep in the model) instead of
 * a clear error at the CLI boundary where the bad flag value actually came from.
 */
function positiveInt(raw: string | undefined, flag: string, fallback?: number): number {
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`Missing --${flag}.`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid --${flag} "${raw}": expected a positive integer.`);
  return n;
}

function bar(done: number, total: number, width = 24): string {
  const ratio = total ? Math.min(1, done / total) : 1;
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(ratio * 100)}%`;
}

/**
 * A long download or translation batch can run for a minute or more. The `\r`-redrawn
 * bar only ever reaches a real terminal, so a non-TTY run (CI logs, piped output) would
 * otherwise print nothing at all between the start and the final result, indistinguishable
 * from a hang. This prints one plain line per 10% there instead.
 */
function makeProgress(render: (done: number, total: number) => string): (done: number, total: number) => void {
  let lastPct = -1;
  return (done, total) => {
    if (isTTY) {
      status(render(done, total));
      return;
    }
    const pct = total ? Math.floor((done / total) * 100) : 100;
    if (pct >= lastPct + 10 || (done >= total && lastPct < 100)) {
      lastPct = done >= total ? 100 : pct;
      log(render(done, total));
    }
  };
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new Error(`Cannot ask "${question.trim()}" in a non-interactive shell. Re-run with --yes to allow downloads.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`${question} (Y/n) `)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
}

async function ensureInstalled(models: ModelEntry[], yes: boolean): Promise<void> {
  for (const m of new Set(models)) {
    const problem = localModelProblem(m);
    if (problem) throw new Error(`Model ${m.id}: ${problem}`);
  }
  const missing = [...new Set(models)].filter((m) => !m.path && !isInstalled(m));
  if (!missing.length) return;
  status("Checking model sizes...");
  const plans: InstallPlan[] = [];
  for (const m of missing) plans.push(await planInstall(m));
  endStatus();
  const total = plans.reduce((s, p) => s + p.bytes, 0);
  log("Models to download (one time, then cached for every project):");
  for (const p of plans) log(`  ${p.model.id.padEnd(12)} ${mb(p.bytes).padStart(7)}  ${p.model.repo ?? p.model.path}`);
  if (!(await confirm(`Download ${mb(total)}?`, yes))) throw new Error("Download declined.");
  for (const p of plans) {
    await install(p, makeProgress((d, t) => `Downloading ${p.model.id} ${bar(d, t)} ${mb(d)}/${mb(t)}`));
    endStatus();
    log(`✓ Installed ${p.model.id}`);
  }
}

interface FileJob {
  source: string;
  target: string;
  doc: LocaleDoc;
  existing: unknown;
  pending: string[];
}

interface TargetJob {
  locale: Locale;
  route: Hop[];
  files: FileJob[];
  unique: number;
}

async function cmdTranslate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string", default: "en" },
      to: { type: "string" },
      input: { type: "string" },
      overwrite: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "batch-size": { type: "string", default: "32" },
      fast: { type: "boolean", default: false },
      beams: { type: "string" },
      report: { type: "string" },
      config: { type: "string" },
      fuzzy: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  if (!values.to) throw new Error("Missing --to. Example: locale-ai translate --from en --to fr,es");
  const from = parseLocale(values.from!);
  const targets = values.to.split(",").map((t) => t.trim()).filter(Boolean).map(parseLocale);
  const batchSize = positiveInt(values["batch-size"], "batch-size");
  const beams = positiveInt(values.beams, "beams", values.fast ? 1 : 4);

  const config = loadConfig(process.cwd(), values.config);
  const catalog = catalogFor(config);
  const protect = protectRegex(config);
  const isProtectedKey = keyPathProtect(config.doNotTranslateKeys);
  const layout = detectLayout(process.cwd(), from.tag, values.input);
  const lockPath = path.resolve(process.cwd(), LOCK_FILENAME);
  const lock = loadLock(lockPath);
  const sources = sourceFiles(layout, from.tag).map((f) => ({ file: f, doc: readLocaleDoc(f, from.tag, true, values.fuzzy!) }));
  const singularHints = new Set(sources.flatMap(({ doc }) => [...pluralOneStrings(doc.data)]));
  log(`locale-ai ${VERSION}`);
  log(
    layout.kind === "xcstrings"
      ? `Found ${from.tag} strings in ${rel(layout.file!)}`
      : `Found ${sources.length} ${from.tag} file${sources.length === 1 ? "" : "s"} in ${rel(layout.root)}/` +
          (layout.kind === "dir" ? `${from.tag}${layout.dirSuffix ?? ""}/` : ""),
  );

  let failures = 0;
  const jobs: TargetJob[] = [];
  for (const locale of targets) {
    const route = resolveRoute(from, locale, catalog);
    if (!route) {
      failures++;
      const options = reachableTargets(from.lang, catalog);
      log(`✗ ${locale.tag}: no local model for ${from.lang} → ${locale.lang}.`);
      log(`  Available from ${from.lang}: ${options.join(", ") || "(none)"}`);
      continue;
    }
    const files = sources.map(({ file, doc }): FileJob => {
      const target = targetFile(layout, from.tag, locale.tag, file);
      const existing = fs.existsSync(target) ? readLocaleDoc(target, locale.tag).data : undefined;
      const isStale = (p: string, s: string) => isSourceStale(lock, fileKey(file), p, s);
      return {
        source: file,
        target,
        doc,
        existing,
        pending: pendingStrings(doc.data, existing, values.overwrite!, isProtectedKey, isStale),
      };
    });
    const unique = new Set(files.flatMap((f) => f.pending)).size;
    jobs.push({ locale, route, files, unique });
  }

  if (values["dry-run"]) {
    for (const j of jobs) {
      const models = j.route
        .map((h) => `${h.model.id}${isInstalled(h.model) ? "" : " (not installed)"}`)
        .join(" → ");
      log(`${j.locale.tag.padEnd(8)} ${String(j.unique).padStart(5)} strings to translate   model: ${models}`);
      for (const f of j.files) if (f.pending.length) log(`         ${rel(f.target)}  +${f.pending.length}`);
    }
    return failures ? 1 : 0;
  }

  const active = jobs.filter((j) => j.unique > 0);
  await ensureInstalled(
    active.flatMap((j) => j.route.map((h) => h.model)),
    values.yes!,
  );

  const allIssues: Array<Issue & { locale: string }> = [];
  const loaded = new Map<string, Translator>();
  const key = (h: Hop) => `${h.model.id}|${h.prefix ?? ""}`;
  const remainingUses = (repoKey: string, from: number) =>
    active.slice(from).filter((j) => j.route.some((h) => key(h) === repoKey)).length;

  for (const job of jobs) {
    const started = Date.now();
    let translations = new Map<string, string>();
    if (job.unique > 0) {
      const translators: Translator[] = [];
      for (const hop of job.route) {
        if (!loaded.has(key(hop))) {
          status(`${job.locale.tag}: loading ${hop.model.id}...`);
          loaded.set(key(hop), await loadTranslator(hop, { beams }));
        }
        translators.push(loaded.get(key(hop))!);
      }
      const strings = job.files.flatMap((f) => f.pending);
      const result = await translateStrings(strings, translators, {
        sourceLang: intlCode(from),
        targetLang: intlCode(job.locale),
        batchSize,
        protect,
        lookup: glossaryLookup(from, job.locale, config),
        singularHints,
        onProgress: makeProgress((d, t) => `${job.locale.tag}: translating ${bar(d, t)} ${d}/${t}`),
      });
      endStatus();
      translations = result.translations;
      allIssues.push(...result.issues.map((i) => ({ ...i, locale: job.locale.tag })));
      for (const hop of job.route) {
        const k = key(hop);
        if (remainingUses(k, active.indexOf(job) + 1) === 0 && loaded.has(k)) {
          await loaded.get(k)!.dispose();
          loaded.delete(k);
        }
      }
    }

    let written = 0;
    let pluralsAdded = 0;
    for (const f of job.files) {
      const lockKey = fileKey(f.source);
      const isStale = (p: string, s: string) => isSourceStale(lock, lockKey, p, s);
      if (f.existing !== undefined) {
        for (const editedPath of editedPaths(lock, lockKey, job.locale.tag, flattenStrings(f.existing))) {
          allIssues.push({ source: editedPath, kind: "edited", locale: job.locale.tag });
        }
      }
      const built = buildTarget(f.doc.data, f.existing, (s) => translations.get(s) ?? s, values.overwrite!, isProtectedKey, isStale);
      let plural = usesI18nextPlurals(f.source) ? addPluralForms(built, intlCode(job.locale)) : { doc: built, added: 0 };
      const nested = addNestedPluralForms(plural.doc, intlCode(job.locale));
      plural = { doc: nested.doc, added: plural.added + nested.added };
      pluralsAdded += plural.added;
      const before = fs.existsSync(f.target) ? fs.readFileSync(f.target, "utf8") : undefined;
      const text = f.doc.serialize(plural.doc, job.locale.tag, before);
      if (text !== before) {
        fs.mkdirSync(path.dirname(f.target), { recursive: true });
        fs.writeFileSync(f.target, text);
        written++;
      }
      const outFlat = new Map(flattenStrings(plural.doc).map((e) => [e.path, e.value]));
      recordEntries(
        lock,
        lockKey,
        job.locale.tag,
        flattenStrings(f.doc.data).map(({ path: p, value }) => ({ path: p, source: value, written: outFlat.get(p) ?? "" })),
      );
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const issues = allIssues.filter((i) => i.locale === job.locale.tag).length;
    const via = job.route.length > 1 ? ` (via ${job.route.map((h) => h.model.id).join(" → ")})` : "";
    log(
      `✓ ${job.locale.tag.padEnd(7)} ${String(job.unique).padStart(5)} strings translated, ${written} file${written === 1 ? "" : "s"} written in ${secs}s${via}` +
        (pluralsAdded ? `, ${pluralsAdded} plural forms added` : "") +
        (issues ? `, ${issues} to review` : ""),
    );
  }
  for (const t of loaded.values()) await t.dispose();
  if (jobs.length) saveLock(lockPath, lock);

  if (allIssues.length) {
    log();
    log(`${allIssues.length} string${allIssues.length === 1 ? "" : "s"} worth a quick review:`);
    for (const i of allIssues.slice(0, 10)) {
      log(`  [${i.locale}] ${i.kind}: ${JSON.stringify(i.source)}${i.output ? ` → ${JSON.stringify(i.output)}` : ""}`);
    }
    if (allIssues.length > 10) log(`  ... and ${allIssues.length - 10} more${values.report ? "" : " (use --report <file>)"}`);
  }
  if (values.report) {
    fs.writeFileSync(values.report, JSON.stringify({ version: VERSION, from: from.tag, issues: allIssues }, null, 2) + "\n");
    log(`Report written to ${values.report}`);
  }
  return failures ? 1 : 0;
}

/** Runs scripts/convert-marian.py and prints the config entry for the new model. */
function convertModel(
  model: string | undefined,
  opts: { out?: string; source?: string; target?: string; python?: string },
): number {
  if (!model || !opts.out) throw new Error("Usage: locale-ai models convert <hf-marian-model> --out <dir>");
  const script = fileURLToPath(new URL("../scripts/convert-marian.py", import.meta.url));
  const python = opts.python ?? process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const res = spawnSync(python, [script, model, "--out", opts.out], { stdio: "inherit" });
  if (res.error || res.status !== 0) {
    log(`\nConversion failed. It needs Python 3.10+ with: pip install "optimum-onnx[onnxruntime]" accelerate sentencepiece`);
    log(`(use --python <path> to pick an interpreter, e.g. a virtualenv)`);
    return 1;
  }
  const entry: Record<string, unknown> = {
    source: opts.source ?? "en",
    target: opts.target ?? "<target language code>",
    path: path.relative(process.cwd(), path.resolve(opts.out)) || ".",
  };
  try {
    const vocab = JSON.parse(fs.readFileSync(path.join(opts.out, "vocab.json"), "utf8")) as Record<string, number>;
    const codes = Object.keys(vocab).filter((k) => /^>>[\w-]+<<$/.test(k));
    if (codes.length) {
      entry.prefix = "<one of the target tokens below>";
      log(`\nThis model is multi-target; its target tokens: ${codes.join(" ")}`);
    }
  } catch {
    // vocab.json missing: the script would have failed already.
  }
  log(`\nAdd to ${CONFIG_FILE} under "models":\n${JSON.stringify(entry, null, 2)}`);
  return 0;
}

/** Built-in models plus the project's own (which take priority). */
function catalogFor(config: ProjectConfig): ModelEntry[] {
  return [...customEntries(config.models, config.dir ?? process.cwd()), ...CATALOG];
}

async function cmdModels(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      from: { type: "string" },
      config: { type: "string" },
      out: { type: "string" },
      source: { type: "string" },
      target: { type: "string" },
      python: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  const catalog = catalogFor(loadConfig(process.cwd(), values.config));
  switch (sub) {
    case "list": {
      const filter = values.from ? parseLocale(values.from).lang : undefined;
      for (const m of catalog) {
        if (filter && !m.sources.includes(filter)) continue;
        const state = isInstalled(m) ? "installed" : "";
        log(`${m.id.padEnd(12)} ${m.sources.join(",")} → ${m.targets.join(",").padEnd(22)} ${state}`);
      }
      if (filter) log(`\nReachable from ${filter} (direct or via English): ${reachableTargets(filter, catalog).join(", ")}`);
      return 0;
    }
    case "installed": {
      const list = catalog.map((m) => ({ m, man: readManifest(m) })).filter((x) => x.man);
      if (!list.length) log("No models installed.");
      for (const { m, man } of list) log(`${m.id.padEnd(12)} ${mb(man!.bytes).padStart(7)}  ${man!.installedAt.slice(0, 10)}`);
      return 0;
    }
    case "install": {
      if (!positionals[0]) throw new Error("Usage: locale-ai models install <from-to | model-id>");
      let models: ModelEntry[];
      const byId = findById(positionals[0], catalog);
      if (byId) models = [byId];
      else {
        const [a, ...b] = positionals[0].split("-");
        const route = resolveRoute(parseLocale(a), parseLocale(b.join("-")), catalog);
        if (!route) throw new Error(`No model for ${positionals[0]}. See: locale-ai models list`);
        models = route.map((h) => h.model);
      }
      const already = models.filter(isInstalled);
      already.forEach((m) => log(`✓ ${m.id} already installed`));
      await ensureInstalled(models, values.yes!);
      return 0;
    }
    case "remove": {
      const m = positionals[0] && findById(positionals[0], catalog);
      if (!m) throw new Error("Usage: locale-ai models remove <model-id>  (see: locale-ai models installed)");
      log((await uninstall(m)) ? `Removed ${m.id}` : `${m.id} is not installed`);
      return 0;
    }
    case "convert":
      return convertModel(positionals[0], values);
    default:
      log(HELP);
      return sub ? 1 : 0;
  }
}

/**
 * Validates already-translated locales against the source without translating:
 * same key structure, and the same placeholders in each matching string. Meant for
 * CI, so a mismatch (a key a translator dropped, a {name} a translation lost) fails
 * the build instead of shipping silently.
 */
async function cmdCheck(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string", default: "en" },
      input: { type: "string" },
    },
  });
  const from = parseLocale(values.from!);
  const layout = detectLayout(process.cwd(), from.tag, values.input);
  const sources = sourceFiles(layout, from.tag).map((f) => ({ file: f, doc: readLocaleDoc(f, from.tag, true) }));
  const targets = existingTargets(layout, from.tag);
  if (!targets.length) {
    log(`No translated locales found next to ${from.tag}.`);
    return 0;
  }

  let problems = 0;
  let identicalTotal = 0;
  for (const to of targets) {
    let missing = 0;
    let mismatched = 0;
    let identical = 0;
    for (const { file, doc } of sources) {
      const target = targetFile(layout, from.tag, to, file);
      if (!fs.existsSync(target)) {
        missing += flattenStrings(doc.data).length;
        log(`✗ ${to}: ${rel(target)} is missing entirely`);
        continue;
      }
      const srcFlat = flattenStrings(doc.data);
      const tgtByPath = new Map(flattenStrings(readLocaleDoc(target, to).data).map((e) => [e.path, e.value]));
      for (const { path: p, value: srcVal } of srcFlat) {
        const tgtVal = tgtByPath.get(p);
        if (tgtVal === undefined) {
          missing++;
          log(`✗ ${to}: ${rel(target)} missing key "${p}"`);
          continue;
        }
        const srcMasked = mask(srcVal, "natural");
        const tgtTokens = mask(tgtVal, "natural").tokens.toSorted();
        if (srcMasked.tokens.toSorted().join("\u0001") !== tgtTokens.join("\u0001")) {
          mismatched++;
          log(`✗ ${to}: ${rel(target)} "${p}" placeholders differ: source [${srcMasked.tokens.toSorted().join(", ")}], target [${tgtTokens.join(", ")}]`);
          continue;
        }
        if (tgtVal === srcVal && hasTranslatableText(srcMasked.text)) {
          identical++;
          log(`⚠ ${to}: ${rel(target)} "${p}" is untouched, identical to the ${from.tag} source`);
        }
      }
    }
    identicalTotal += identical;
    if (missing || mismatched) problems++;
    else log(`✓ ${to}${identical ? ` (${identical} left identical to ${from.tag})` : ""}`);
  }
  if (identicalTotal) log(`\n${identicalTotal} string${identicalTotal === 1 ? "" : "s"} left identical to the source — not a failure, but worth a look.`);
  return problems ? 1 : 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "translate":
      return cmdTranslate(rest);
    case "check":
      return cmdCheck(rest);
    case "models":
      return cmdModels(rest);
    case "-v":
    case "--version":
      console.log(VERSION);
      return 0;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      log(HELP);
      return 0;
    default:
      log(`Unknown command "${cmd}".\n`);
      log(HELP);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    endStatus();
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
