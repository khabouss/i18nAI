/**
 * Primitives every per-format reader in this directory shares: the plain-object type
 * each format's `data` is built from, the `LocaleDoc` shape every `read*Doc` function
 * returns, trailing-newline bookkeeping, and the handful of CLDR plural categories
 * Android/Rails/`.xcstrings`'s nested plural shape (and `locales.ts`'s own i18next
 * plural-sync pass) all use the same way.
 */

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Null-prototype object so keys such as "__proto__" are stored as plain data. */
export const newObj = (): Obj => Object.create(null) as Obj;

export const finalNewline = (text: string) => text === "" || text.endsWith("\n");
export const withNewline = (text: string, keep: boolean) => text.replace(/\n*$/, keep ? "\n" : "");

export const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

/** A parsed locale file plus enough of its original style to re-render an edited copy the same way. */
export interface LocaleDoc {
  data: unknown;
  /**
   * Renders `data` (the built target, or the unchanged source) in this file's format
   * and style. `targetTag` is the locale being written (e.g. "fr", "pt-BR"); formats
   * that carry their own locale metadata (ARB's "@@locale", a .po header's "Language:")
   * use it to fix that metadata up. Formats without such metadata ignore it.
   * `existingText`, when the target file already exists, is its current raw content —
   * formats whose metadata can be hand-edited by a translator (a .po header's
   * `Plural-Forms`) check it first so a rerun doesn't silently revert that edit.
   */
  serialize(data: unknown, targetTag: string, existingText?: string): string;
}

/**
 * C-style backslash escaping (`\n`, `\t`, `\r`, `\"`, `\\`, `\Uxxxx`): Apple `.strings`'
 * own `"key" = "value";` convention, and also gettext `.po`'s quoted-string syntax,
 * which uses the same escapes (minus `\U`) for `msgid`/`msgstr`.
 */
export function unescapeC(s: string): string {
  return s.replace(/\\(?:U([0-9a-fA-F]{4})|(.))/g, (_, hex: string | undefined, c: string | undefined) => {
    // \Uxxxx is a UTF-16 code unit; two in a row combine into one character via
    // ordinary JS string concatenation when they're a surrogate pair.
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
    return ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" })[c!] ?? c!;
  });
}
export function escapeC(s: string): string {
  return s.replace(/[\\"\n\t\r]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r" })[c]!);
}
