import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Tracks, per source file, key path and TARGET LOCALE, the source string last
 * translated for that locale and the output last written there — so a rerun
 * can tell a source edit (re-translate) apart from a translator edit (flag as
 * a conflict, never silently overwrite) apart from "nothing changed" (skip),
 * instead of treating any non-empty target string as done forever. Source and
 * written hashes are kept per locale (not shared across locales translated at
 * different times) so that translating "es" today doesn't make a stale "fr"
 * look up to date tomorrow.
 */
export interface LockFile {
  version: 2;
  files: Record<string, Record<string, LockEntry>>;
}

/** Per target-locale state for one key path. */
interface LocaleState {
  /** Hash of the source string as of the last run that translated or confirmed it for this locale. */
  source: string;
  /** Hash of the text this tool last wrote at this path for this locale. */
  written: string;
}

interface LockEntry {
  mt: Record<string, LocaleState>;
}

/** Shape written by locale-ai < 0.7.0: one source hash shared by every locale. */
interface LockEntryV1 {
  source: string;
  mt: Record<string, string>;
}

export const LOCK_FILENAME = "locale-ai.lock.json";

export function hashOf(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

/**
 * Loads the lock, migrating a pre-0.7.0 (version 1) file in memory: its one
 * shared `source` hash becomes that path's `source` for every locale it had
 * already written a hash for. That's an approximation (the real per-locale
 * source hash at the time each locale was last translated is not recoverable),
 * but it only risks one extra re-translation per locale, never a missed one,
 * and never a silent overwrite.
 */
export function loadLock(file: string): LockFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown; files?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.files || typeof parsed.files !== "object") {
      return { version: 2, files: {} };
    }
    if (parsed.version === 2) return { version: 2, files: parsed.files as LockFile["files"] };
    const v1 = parsed.files as Record<string, Record<string, LockEntryV1>>;
    const files: LockFile["files"] = {};
    for (const [fileKey, entries] of Object.entries(v1)) {
      const migrated: Record<string, LockEntry> = {};
      for (const [path, entry] of Object.entries(entries ?? {})) {
        const mt: Record<string, LocaleState> = {};
        for (const [tag, written] of Object.entries(entry?.mt ?? {})) mt[tag] = { source: entry.source, written };
        migrated[path] = { mt };
      }
      files[fileKey] = migrated;
    }
    return { version: 2, files };
  } catch {
    // Missing or invalid: start fresh rather than fail the run.
  }
  return { version: 2, files: {} };
}

export function saveLock(file: string, lock: LockFile): void {
  fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * True when `path`'s source string in `fileKey` has changed, for `targetTag`
 * specifically, since that locale was last translated — meaning the existing
 * target text is stale and needs redoing even though it's non-empty. False
 * for a path/locale the lock has never seen (new adoption, or a brand-new
 * key, both already handled by the empty-target check).
 */
export function isSourceStale(lock: LockFile, fileKey: string, path: string, targetTag: string, source: string): boolean {
  const state = lock.files[fileKey]?.[path]?.mt[targetTag];
  return state !== undefined && state.source !== hashOf(source);
}

/**
 * True when the text currently on disk at `path` for `targetTag` doesn't
 * match what this tool itself last wrote there — i.e. a translator (or
 * anyone else) edited it since. Only reported; the edit is never silently
 * overwritten, and a source change alone never clears this (see
 * `editedPaths`'s caller, which treats stale + edited as a conflict rather
 * than re-translating).
 */
export function isEdited(lock: LockFile, fileKey: string, path: string, targetTag: string, currentValue: string): boolean {
  const state = lock.files[fileKey]?.[path]?.mt[targetTag];
  return state !== undefined && state.written !== hashOf(currentValue);
}

/** Key paths whose existing target text for `targetTag` was edited since this tool last wrote it (see `isEdited`). */
export function editedPaths(
  lock: LockFile,
  fileKey: string,
  targetTag: string,
  entries: Array<{ path: string; value: string }>,
): string[] {
  const out: string[] = [];
  for (const { path, value } of entries) if (isEdited(lock, fileKey, path, targetTag, value)) out.push(path);
  return out;
}

/** Records, for every path actually (re)translated this run, the current source hash and the hash of what ended up on disk, for `targetTag`. */
export function recordEntries(
  lock: LockFile,
  fileKey: string,
  targetTag: string,
  entries: Array<{ path: string; source: string; written: string }>,
): void {
  const file = (lock.files[fileKey] ??= {});
  for (const { path, source, written } of entries) {
    const entry = (file[path] ??= { mt: {} });
    entry.mt[targetTag] = { source: hashOf(source), written: hashOf(written) };
  }
}

/** Removes lock entries (for every locale) whose key path no longer exists in the current source — so a deleted key doesn't linger forever. */
export function pruneDeletedKeys(lock: LockFile, fileKey: string, currentPaths: Iterable<string>): void {
  const file = lock.files[fileKey];
  if (!file) return;
  const keep = new Set(currentPaths);
  for (const path of Object.keys(file)) if (!keep.has(path)) delete file[path];
}
