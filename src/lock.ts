import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Tracks, per source file and key path, the source string last translated and
 * the output last written for each target locale — so a rerun can tell a
 * source edit (re-translate) apart from a translator edit (flag, don't
 * overwrite) apart from "nothing changed" (skip), instead of treating any
 * non-empty target string as done forever.
 */
export interface LockFile {
  version: 1;
  files: Record<string, Record<string, LockEntry>>;
}

interface LockEntry {
  /** Hash of the source string as of the last run that translated or confirmed it. */
  source: string;
  /** Per target-locale tag: hash of the text last written at this path. */
  mt: Record<string, string>;
}

export const LOCK_FILENAME = "locale-ai.lock.json";

export function hashOf(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

export function loadLock(file: string): LockFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockFile>;
    if (parsed && typeof parsed === "object" && parsed.files) return { version: 1, files: parsed.files };
  } catch {
    // Missing or invalid: start fresh rather than fail the run.
  }
  return { version: 1, files: {} };
}

export function saveLock(file: string, lock: LockFile): void {
  fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * True when `path`'s source string in `fileKey` has changed since it was last
 * translated — meaning the existing target text is stale and needs redoing
 * even though it's non-empty. False for a path the lock has never seen (new
 * adoption, or a brand-new key, both already handled by the empty-target check).
 */
export function isSourceStale(lock: LockFile, fileKey: string, path: string, source: string): boolean {
  const entry = lock.files[fileKey]?.[path];
  return entry !== undefined && entry.source !== hashOf(source);
}

/**
 * Key paths whose existing target text no longer matches the output this tool
 * last wrote there for `targetTag` — i.e. a translator edited it since. Only
 * reported; the edit is never overwritten.
 */
export function editedPaths(
  lock: LockFile,
  fileKey: string,
  targetTag: string,
  entries: Array<{ path: string; value: string }>,
): string[] {
  const file = lock.files[fileKey];
  if (!file) return [];
  const out: string[] = [];
  for (const { path, value } of entries) {
    const mt = file[path]?.mt[targetTag];
    if (mt !== undefined && mt !== hashOf(value)) out.push(path);
  }
  return out;
}

/** Records, for every path translated this run, the current source hash and the hash of what ended up on disk. */
export function recordEntries(
  lock: LockFile,
  fileKey: string,
  targetTag: string,
  entries: Array<{ path: string; source: string; written: string }>,
): void {
  const file = (lock.files[fileKey] ??= {});
  for (const { path, source, written } of entries) {
    const entry = (file[path] ??= { source: hashOf(source), mt: {} });
    entry.source = hashOf(source);
    entry.mt[targetTag] = hashOf(written);
  }
}
