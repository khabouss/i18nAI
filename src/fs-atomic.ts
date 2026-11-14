import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Writes `data` to `file` via a temp file in the same directory, then an atomic
 * rename, so a reader (or this process, re-run after being killed) never sees a
 * partially-written file — `file` itself is untouched until the rename succeeds.
 * Used for the lock file and target locale files, both of which fail loudly on
 * invalid/truncated content rather than silently treating it as empty.
 *
 * Carries over `file`'s own permissions (a rename replaces the directory entry
 * with the temp file's, which would otherwise silently reset any custom mode back
 * to the process' default), and removes the temp file on a failed rename — e.g. an
 * `EPERM`/`EBUSY` on Windows when an editor or antivirus scan has `file` open —
 * rather than leaving it behind forever.
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tmp, data);
  try {
    const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode;
    if (mode !== undefined) fs.chmodSync(tmp, mode);
  } catch {
    // best-effort — a mode we can't read or set is no worse than the default
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
