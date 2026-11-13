/**
 * locale-ai's programmatic API: everything `locale-ai translate`/`locale-ai check`
 * do, callable from code instead of a shell. See README.md's "Library API" section
 * for usage; `src/cli.ts` is the thin command-line wrapper around the same two
 * functions.
 */
export {
  check,
  translate,
  type CheckIssue,
  type CheckLocaleResult,
  type CheckOptions,
  type CheckResult,
  type DownloadPlan,
  type TranslateDryRunLocale,
  type TranslateEvent,
  type TranslateLocaleResult,
  type TranslateOptions,
  type TranslateResult,
} from "./api.ts";
export type { Issue, IssueKind } from "./engine.ts";
export type { Locale } from "./lang.ts";
