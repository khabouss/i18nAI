/**
 * locale-ai's programmatic API: everything `locale-ai translate`/`locale-ai check`/
 * `locale-ai accept` do, callable from code instead of a shell. See README.md's
 * "Library API" section for usage; `src/cli.ts` is the thin command-line wrapper
 * around these same functions.
 */
export {
  accept,
  check,
  translate,
  type AcceptOptions,
  type AcceptResult,
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
