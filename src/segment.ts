/**
 * Splits text into translatable sentences while keeping every separator
 * (newlines, surrounding whitespace) so the original layout can be rebuilt.
 *
 * OPUS-MT silently drops sentences from multi-sentence inputs
 * ("Upload failed. Please try again later." -> "Veuillez réessayer plus tard."),
 * so each sentence is translated on its own.
 */

export interface Piece {
  /** True for text sent to the model, false for separators kept verbatim. */
  translate: boolean;
  value: string;
}

const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(lang: string): Intl.Segmenter {
  let s = segmenters.get(lang);
  if (!s) {
    s = new Intl.Segmenter(lang, { granularity: "sentence" });
    segmenters.set(lang, s);
  }
  return s;
}

export function splitSentences(text: string, lang: string): Piece[] {
  const pieces: Piece[] = [];
  const push = (translate: boolean, value: string) => {
    if (!value) return;
    const last = pieces[pieces.length - 1];
    if (last && !last.translate && !translate) last.value += value;
    else pieces.push({ translate, value });
  };
  for (const line of text.split(/(\r?\n)/)) {
    if (line === "\n" || line === "\r\n") {
      push(false, line);
      continue;
    }
    for (const { segment } of segmenter(lang).segment(line)) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment)!;
      push(false, m[1]);
      push(true, m[2]);
      push(false, m[3]);
    }
  }
  return pieces;
}
