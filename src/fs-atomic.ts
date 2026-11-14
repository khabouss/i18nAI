import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Writes `data` to `file` via a temp file in the same directory, then an atomic
 * rename, so a reader (or this process, re-run after being killed) never sees a
 * partially-written file — `file` itself is untouched until the rename succeeds.
 * Used for the lock file and target locale files, both of which fail loudly on
 * invalid/truncated content rather than silently treating it as empty.
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
