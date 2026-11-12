/**
 * Minimal reader for SentencePiece model files (*.spm), which are protobuf-encoded
 * `ModelProto` messages. We only need the vocabulary pieces and their scores.
 *
 * ModelProto { repeated SentencePiece pieces = 1; ... }
 * SentencePiece { string piece = 1; float score = 2; Type type = 3; }
 */

export const PieceType = {
  Normal: 1,
  Unknown: 2,
  Control: 3,
  UserDefined: 4,
  Unused: 5,
  Byte: 6,
} as const;

export interface Piece {
  score: number;
  type: number;
}

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  readonly end: number;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.end = buf.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new Error("Truncated SentencePiece model");
      // Avoid bitwise ops past 31 bits; values we care about are small.
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
    }
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2: {
        // Read the length first: `this.pos += this.varint()` would use the stale pos.
        const len = this.varint();
        this.pos += len;
        break;
      }
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
}

export function readSpmPieces(buf: Uint8Array): Map<string, Piece> {
  const pieces = new Map<string, Piece>();
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const decoder = new TextDecoder();
  const r = new Reader(buf);
  while (r.pos < r.end) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field !== 1 || wire !== 2) {
      r.skip(wire);
      continue;
    }
    const len = r.varint();
    const end = r.pos + len;
    let piece = "";
    let score = 0;
    let type: number = PieceType.Normal;
    while (r.pos < end) {
      const k = r.varint();
      const f = Math.floor(k / 8);
      const w = k & 7;
      if (f === 1 && w === 2) {
        const l = r.varint();
        piece = decoder.decode(buf.subarray(r.pos, r.pos + l));
        r.pos += l;
      } else if (f === 2 && w === 5) {
        score = view.getFloat32(r.pos, true);
        r.pos += 4;
      } else if (f === 3 && w === 0) {
        type = r.varint();
      } else {
        r.skip(w);
      }
    }
    r.pos = end;
    pieces.set(piece, { score, type });
  }
  if (pieces.size === 0) throw new Error("SentencePiece model contains no pieces");
  return pieces;
}

interface NormalizerSpec {
  name: string;
  addDummyPrefix: boolean;
  removeExtraWhitespaces: boolean;
  charsmap?: Uint8Array;
}

function readNormalizerSpec(buf: Uint8Array): NormalizerSpec {
  const spec: NormalizerSpec = { name: "", addDummyPrefix: true, removeExtraWhitespaces: true };
  const r = new Reader(buf);
  // Find ModelProto.normalizer_spec (field 3).
  while (r.pos < r.end) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field !== 3 || wire !== 2) {
      r.skip(wire);
      continue;
    }
    const len = r.varint();
    const end = r.pos + len;
    while (r.pos < end) {
      const k = r.varint();
      const f = Math.floor(k / 8);
      const w = k & 7;
      if (f === 1 && w === 2) {
        const l = r.varint();
        spec.name = new TextDecoder().decode(buf.subarray(r.pos, r.pos + l));
        r.pos += l;
      } else if (f === 2 && w === 2) {
        const l = r.varint();
        spec.charsmap = buf.slice(r.pos, r.pos + l);
        r.pos += l;
      } else if (f === 3 && w === 0) spec.addDummyPrefix = r.varint() !== 0;
      else if (f === 4 && w === 0) spec.removeExtraWhitespaces = r.varint() !== 0;
      else r.skip(w);
    }
    break;
  }
  return spec;
}

/**
 * sentencepiece's precompiled normalisation map: a darts-clone double-array trie
 * over UTF-8 bytes whose values index a blob of NUL-terminated replacements.
 * This is what "nmt_nfkc" really is (it differs from Unicode NFKC in places).
 */
class Charsmap {
  private readonly units: Uint32Array;
  private readonly blob: Uint8Array;
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();

  constructor(data: Uint8Array) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const trieSize = view.getUint32(0, true);
    this.units = new Uint32Array(trieSize / 4);
    for (let i = 0; i < this.units.length; i++) this.units[i] = view.getUint32(4 + i * 4, true);
    this.blob = data.subarray(4 + trieSize);
  }

  /** Longest match at `pos`: [matched byte length, replacement bytes] or undefined. */
  private longest(bytes: Uint8Array, pos: number): [number, Uint8Array] | undefined {
    const u = this.units;
    let node = 0;
    let unit = u[node];
    node ^= offset(unit);
    let found: [number, number] | undefined;
    for (let i = pos; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 0) break;
      node ^= c;
      unit = u[node];
      if (unit === undefined || label(unit) !== c) break;
      node ^= offset(unit);
      if (hasLeaf(unit)) found = [i - pos + 1, value(u[node])];
    }
    if (!found) return undefined;
    let end = found[1];
    while (end < this.blob.length && this.blob[end] !== 0) end++;
    return [found[0], this.blob.subarray(found[1], end)];
  }

  normalize(text: string): string {
    const bytes = this.enc.encode(text);
    const out: number[] = [];
    let pos = 0;
    while (pos < bytes.length) {
      const hit = this.longest(bytes, pos);
      if (hit) {
        for (const b of hit[1]) out.push(b);
        pos += hit[0];
      } else {
        const len = utf8Len(bytes[pos]);
        for (let k = 0; k < len && pos + k < bytes.length; k++) out.push(bytes[pos + k]);
        pos += len;
      }
    }
    return this.dec.decode(new Uint8Array(out));
  }
}

const hasLeaf = (unit: number) => ((unit >>> 8) & 1) === 1;
const value = (unit: number) => unit & 0x7fffffff;
const label = (unit: number) => (unit & (0x80000000 | 0xff)) >>> 0;
const offset = (unit: number) => (unit >>> 10) << ((unit & (1 << 9)) >>> 6);
const utf8Len = (b: number) => (b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4);

const SPACE = "▁";
/** sentencepiece's penalty for unknown characters, relative to the lowest piece score. */
const UNK_PENALTY = 10;

/**
 * SentencePiece Unigram encoder, matching the reference C++ implementation on
 * the inputs we care about: NFKC normalisation (Marian models use "nmt_nfkc"),
 * whitespace collapsing, dummy prefix, Viterbi segmentation, and merged runs of
 * unknown characters.
 */
export class SentencePiece {
  private readonly pieces: Map<string, Piece>;
  private readonly maxLen: number;
  private readonly unkScore: number;
  private readonly spec: NormalizerSpec;
  private readonly charsmap?: Charsmap;

  constructor(buf: Uint8Array) {
    this.pieces = new Map();
    let min = Infinity;
    let maxLen = 1;
    for (const [p, info] of readSpmPieces(buf)) {
      if (info.type !== PieceType.Normal && info.type !== PieceType.UserDefined) continue;
      this.pieces.set(p, info);
      if (info.score < min) min = info.score;
      if (p.length > maxLen) maxLen = p.length;
    }
    this.maxLen = maxLen;
    this.unkScore = min - UNK_PENALTY;
    this.spec = readNormalizerSpec(buf);
    if (this.spec.charsmap?.length) this.charsmap = new Charsmap(this.spec.charsmap);
  }

  normalize(text: string): string {
    let t = this.charsmap ? this.charsmap.normalize(text) : text;
    // After normalisation only U+0020 counts as whitespace, as in sentencepiece.
    if (this.spec.removeExtraWhitespaces) t = t.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ");
    if (!t) return "";
    if (this.spec.addDummyPrefix) t = " " + t;
    return t.replace(/ /g, SPACE);
  }

  /** Returns the pieces of `text`; unknown spans are returned as their surface text. */
  encode(text: string): string[] {
    const s = this.normalize(text);
    const n = s.length;
    if (n === 0) return [];
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    const unk = new Uint8Array(n + 1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      // Low surrogates are never a segmentation boundary.
      if (i > 0 && isLowSurrogate(s.charCodeAt(i))) continue;
      let single = false;
      const limit = Math.min(n, i + this.maxLen);
      for (let j = i + 1; j <= limit; j++) {
        if (j < n && isLowSurrogate(s.charCodeAt(j))) continue;
        const p = this.pieces.get(s.slice(i, j));
        if (!p) continue;
        const charLen = j - i === 1 || (j - i === 2 && isHighSurrogate(s.charCodeAt(i)));
        if (charLen) single = true;
        const score = best[i] + p.score;
        if (score > best[j]) {
          best[j] = score;
          from[j] = i;
          unk[j] = 0;
        }
      }
      if (!single) {
        const j = i + (isHighSurrogate(s.charCodeAt(i)) ? 2 : 1);
        const score = best[i] + this.unkScore;
        if (score > best[j]) {
          best[j] = score;
          from[j] = i;
          unk[j] = 1;
        }
      }
    }
    const out: Array<{ piece: string; unk: boolean }> = [];
    for (let j = n; j > 0; j = from[j]) out.push({ piece: s.slice(from[j], j), unk: unk[j] === 1 });
    out.reverse();
    // Merge consecutive unknown pieces, like sentencepiece does.
    const merged: string[] = [];
    let prevUnk = false;
    for (const { piece, unk: u } of out) {
      if (u && prevUnk) merged[merged.length - 1] += piece;
      else merged.push(piece);
      prevUnk = u;
    }
    return merged;
  }
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
