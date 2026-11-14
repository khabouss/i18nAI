/**
 * MarianMT inference on onnxruntime: tokenizer, encoder, and an incremental
 * decoder (KV cache) with real beam search.
 *
 * Why not transformers.js: its `num_beams` keeps only the top candidate (it is
 * greedy decoding), finished sequences in a batch keep generating, and it ships
 * ~200 MB of dependencies we do not need. Owning the loop also lets us drop
 * finished sentences from the batch ("compaction") so long and short strings
 * can share a batch cheaply.
 */
import fs from "node:fs";
import path from "node:path";
import ort from "onnxruntime-node";
import { SentencePiece } from "./spm.ts";
import { TOPK_GRAPH } from "./topk-graph.ts";

export interface MarianPaths {
  dir: string;
  encoder: string;
  decoder: string;
}

export interface GenerateOptions {
  /** 1 = greedy. */
  beams: number;
  /** HF length_penalty: >1 favours longer outputs. */
  lengthPenalty?: number;
}

interface Config {
  d_model: number;
  decoder_attention_heads: number;
  decoder_layers: number;
  pad_token_id: number;
  eos_token_id: number;
  decoder_start_token_id: number;
  max_position_embeddings?: number;
}

type Tensor = ort.Tensor;

/** Cumulative timings (ms), for benchmarking. */
export const PROFILE = { encoder: 0, decoder: 0, select: 0, gather: 0 };

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

/** Gathers rows (first dimension) of a tensor; returns the input when unchanged. */
function gatherRows(t: Tensor, rows: ArrayLike<number>, identity: boolean): Tensor {
  if (identity && rows.length === t.dims[0]) return t;
  const rowSize = t.size / t.dims[0];
  const src = t.data as Float32Array | BigInt64Array;
  const out = new (src.constructor as Float32ArrayConstructor | BigInt64ArrayConstructor)(rows.length * rowSize);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // @ts-expect-error -- both typed array kinds support set/subarray with the same shape
    out.set(src.subarray(r * rowSize, (r + 1) * rowSize), i * rowSize);
  }
  return new ort.Tensor(t.type as "float32", out as Float32Array, [rows.length, ...t.dims.slice(1)]);
}

interface Hyp {
  tokens: number[];
  score: number;
}

interface Item {
  /** Index in the caller's batch. */
  index: number;
  beams: Hyp[];
  finished: Array<{ tokens: number[]; score: number }>;
  maxNew: number;
  done: boolean;
}

export class MarianModel {
  private readonly encoderSession: ort.InferenceSession;
  private readonly decoderSession: ort.InferenceSession;
  private readonly topkSession: ort.InferenceSession;
  private readonly sp: SentencePiece;
  private readonly vocab: Map<string, number>;
  private readonly targetPieces: string[];
  private readonly cfg: Config;
  private readonly special: Set<number>;
  private readonly unkId: number | undefined;

  private constructor(
    encoderSession: ort.InferenceSession,
    decoderSession: ort.InferenceSession,
    topkSession: ort.InferenceSession,
    sp: SentencePiece,
    vocab: Map<string, number>,
    targetPieces: string[],
    cfg: Config,
    special: Set<number>,
    unkId: number | undefined,
  ) {
    this.encoderSession = encoderSession;
    this.decoderSession = decoderSession;
    this.topkSession = topkSession;
    this.sp = sp;
    this.vocab = vocab;
    this.targetPieces = targetPieces;
    this.cfg = cfg;
    this.special = special;
    this.unkId = unkId;
  }

  static async load(paths: MarianPaths, threads?: number): Promise<MarianModel> {
    const cfg = readJson(path.join(paths.dir, "config.json")) as Config;
    const tokCfgPath = path.join(paths.dir, "tokenizer_config.json");
    const separate = fs.existsSync(tokCfgPath) && readJson(tokCfgPath).separate_vocabs === true;
    const vocab = new Map<string, number>(Object.entries(readJson(path.join(paths.dir, "vocab.json"))));
    const targetVocab = separate
      ? new Map<string, number>(Object.entries(readJson(path.join(paths.dir, "target_vocab.json"))))
      : vocab;
    const targetPieces: string[] = [];
    for (const [piece, id] of targetVocab) targetPieces[id] = piece;
    const sp = new SentencePiece(fs.readFileSync(path.join(paths.dir, "source.spm")));

    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      ...(threads ? { intraOpNumThreads: threads } : {}),
      // Three sessions run back to back; spinning thread pools would fight for cores.
      extra: { session: { intra_op: { allow_spinning: process.env.LAI_SPIN ?? "0" } } },
    };
    const [enc, dec, topk] = await Promise.all([
      ort.InferenceSession.create(paths.encoder, options),
      ort.InferenceSession.create(paths.decoder, options),
      ort.InferenceSession.create(Buffer.from(TOPK_GRAPH, "base64"), options),
    ]);
    const special = new Set<number>([cfg.pad_token_id, cfg.eos_token_id]);
    for (const tok of ["<unk>", "<pad>", "</s>"]) {
      const id = targetVocab.get(tok);
      if (id !== undefined) special.add(id);
    }
    return new MarianModel(enc, dec, topk, sp, vocab, targetPieces, cfg, special, targetVocab.get("<unk>"));
  }

  /** True when the model knows this ">>xx<<" target-language token. */
  hasToken(token: string): boolean {
    return this.vocab.has(token);
  }

  encodeText(text: string, prefix?: string): number[] {
    const unk = this.vocab.get("<unk>") ?? 1;
    const ids = this.sp.encode(text).map((p) => this.vocab.get(p) ?? unk);
    if (prefix) ids.unshift(this.vocab.get(prefix) ?? unk);
    const max = (this.cfg.max_position_embeddings ?? 512) - 1;
    if (ids.length > max) ids.length = max;
    ids.push(this.cfg.eos_token_id);
    return ids;
  }

  decodeIds(ids: number[]): string {
    let s = "";
    for (const id of ids) if (!this.special.has(id)) s += this.targetPieces[id] ?? "";
    return s.replace(/▁/g, " ").trim();
  }

  async translate(texts: string[], prefix: string | undefined, opts: GenerateOptions): Promise<string[]> {
    if (texts.length === 0) return [];
    const ids = texts.map((t) => this.encodeText(t, prefix));
    const out = await this.generate(ids, opts);
    return out.map((o) => this.decodeIds(o));
  }

  async generate(inputs: number[][], opts: GenerateOptions): Promise<number[][]> {
    const k = Math.max(1, opts.beams);
    const lp = opts.lengthPenalty ?? 1;
    const { pad_token_id: pad, eos_token_id: eos, decoder_start_token_id: start } = this.cfg;
    const unk = this.unkId;
    const B = inputs.length;
    const S = Math.max(...inputs.map((x) => x.length));

    // --- Encoder -----------------------------------------------------------
    const ids = new BigInt64Array(B * S).fill(BigInt(pad));
    const mask = new BigInt64Array(B * S);
    inputs.forEach((row, b) =>
      row.forEach((id, s) => {
        ids[b * S + s] = BigInt(id);
        mask[b * S + s] = 1n;
      }),
    );
    const maskTensor = new ort.Tensor("int64", mask, [B, S]);
    const tEnc = performance.now();
    const encOut = await this.encoderSession.run({
      input_ids: new ort.Tensor("int64", ids, [B, S]),
      attention_mask: maskTensor,
    });
    const hidden = encOut.last_hidden_state;
    PROFILE.encoder += performance.now() - tEnc;

    // --- Decoder state -----------------------------------------------------
    const items: Item[] = inputs.map((row, index) => ({
      index,
      beams: Array.from({ length: k }, (_, j) => ({ tokens: [], score: j === 0 ? 0 : -Infinity })),
      finished: [],
      maxNew: Math.min(511, Math.ceil(row.length * 2) + 10),
      done: false,
    }));
    let active = items.slice();
    // Rows are laid out item-major: row = activeIndex * k + beam.
    const expand = Int32Array.from({ length: B * k }, (_, r) => Math.floor(r / k));
    let encHidden = gatherRows(hidden, expand, false);
    let encMask = gatherRows(maskTensor, expand, false);
    const L = this.cfg.decoder_layers;
    const H = this.cfg.decoder_attention_heads;
    const Dh = this.cfg.d_model / H;
    const empty = () => new ort.Tensor("float32", new Float32Array(0), [active.length * k, H, 0, Dh]);
    let past: Record<string, Tensor> = {};
    for (let l = 0; l < L; l++) {
      for (const kind of ["decoder", "encoder"]) {
        past[`past_key_values.${l}.${kind}.key`] = empty();
        past[`past_key_values.${l}.${kind}.value`] = empty();
      }
    }
    let nextTokens = new BigInt64Array(B * k).fill(BigInt(start));
    const results: number[][] = new Array(B);

    for (let step = 0; active.length > 0; step++) {
      const R = active.length * k;
      const t0 = performance.now();
      const out = await this.decoderSession.run({
        input_ids: new ort.Tensor("int64", nextTokens, [R, 1]),
        encoder_hidden_states: encHidden,
        encoder_attention_mask: encMask,
        use_cache_branch: new ort.Tensor("bool", [step > 0], [1]),
        ...past,
      });
      PROFILE.decoder += performance.now() - t0;
      const t1 = performance.now();
      const logits = out.logits.data as Float32Array;
      const V = out.logits.dims[2];
      const seqLen = out.logits.dims[1];

      // Never generate <pad> (HF bad_words_ids) or <unk> — the vocab lacking a piece
      // (e.g. an uppercase accented letter) is otherwise silently dropped by decodeIds,
      // losing a character rather than steering the beam to a real word.
      const rowsStride = seqLen * V;
      const last = (seqLen - 1) * V;
      for (let r = 0; r < R; r++) {
        logits[r * rowsStride + last + pad] = -Infinity;
        if (unk !== undefined) logits[r * rowsStride + last + unk] = -Infinity;
      }

      // Beam search: log_softmax + top-k per row runs natively in onnxruntime.
      const want = k === 1 ? 1 : 2 * k;
      let topVals: Float32Array | undefined;
      let topIdx: BigInt64Array | undefined;
      if (k > 1) {
        const lastLogits =
          seqLen === 1
            ? new ort.Tensor("float32", logits, [R, V])
            : new ort.Tensor("float32", logits.filter((_, i) => i % rowsStride >= last), [R, V]);
        const tk = await this.topkSession.run({
          logits: lastLogits,
          k: new ort.Tensor("int64", BigInt64Array.of(BigInt(want)), [1]),
        });
        topVals = tk.values.data as Float32Array;
        topIdx = tk.indices.data as BigInt64Array;
      }

      // Select the next beams for every active item.
      const srcRows: number[] = [];
      const tokens: number[] = [];
      const survivors: Item[] = [];
      for (let a = 0; a < active.length; a++) {
        const item = active[a];
        const genLen = step + 1;
        const forceEos = genLen >= item.maxNew;
        const candScore = new Float64Array(want).fill(-Infinity);
        const candBeam = new Int32Array(want);
        const candTok = new Int32Array(want);
        const insert = (sc: number, j: number, v: number) => {
          if (sc <= candScore[want - 1]) return;
          let p = want - 1;
          while (p > 0 && candScore[p - 1] < sc) {
            candScore[p] = candScore[p - 1];
            candBeam[p] = candBeam[p - 1];
            candTok[p] = candTok[p - 1];
            p--;
          }
          candScore[p] = sc;
          candBeam[p] = j;
          candTok[p] = v;
        };
        for (let j = 0; j < k; j++) {
          const beamScore = item.beams[j].score;
          if (beamScore === -Infinity) continue;
          const r = a * k + j;
          const off = r * rowsStride + last;
          if (k === 1) {
            // Greedy: argmax, no normalisation needed.
            let max = -Infinity;
            let arg = 0;
            for (let v = 0; v < V; v++) {
              if (logits[off + v] > max) {
                max = logits[off + v];
                arg = v;
              }
            }
            insert(0, j, forceEos ? eos : arg);
          } else if (forceEos) {
            let max = -Infinity;
            for (let v = 0; v < V; v++) if (logits[off + v] > max) max = logits[off + v];
            let sum = 0;
            for (let v = 0; v < V; v++) sum += Math.exp(logits[off + v] - max);
            insert(beamScore + logits[off + eos] - max - Math.log(sum), j, eos);
          } else {
            // The global top-2k over all beams is contained in each row's top-2k.
            for (let c = 0; c < want; c++) insert(beamScore + topVals![r * want + c], j, Number(topIdx![r * want + c]));
          }
        }

        const next: Hyp[] = [];
        const nextSrc: number[] = [];
        for (let c = 0; c < want && next.length < k; c++) {
          if (candScore[c] === -Infinity) break;
          const beam = item.beams[candBeam[c]];
          if (candTok[c] === eos) {
            // HF semantics: an EOS outside the top-k candidates is ignored.
            if (c >= k) continue;
            this.addFinished(item, beam.tokens, candScore[c] / Math.pow(genLen, lp), k);
          } else {
            next.push({ tokens: [...beam.tokens, candTok[c]], score: candScore[c] });
            nextSrc.push(a * k + candBeam[c]);
          }
        }

        const bestRunning = next.length ? next[0].score / Math.pow(genLen, lp) : -Infinity;
        const worstFinished = item.finished.length >= k ? item.finished[item.finished.length - 1].score : -Infinity;
        if (next.length === 0 || forceEos || (k === 1 && item.finished.length > 0) || worstFinished >= bestRunning) {
          for (const h of next) this.addFinished(item, h.tokens, h.score / Math.pow(genLen, lp), k);
          item.done = true;
          results[item.index] = (item.finished[0]?.tokens ?? []);
          continue;
        }
        while (next.length < k) {
          next.push({ tokens: next[0].tokens, score: -Infinity });
          nextSrc.push(nextSrc[0]);
        }
        item.beams = next;
        survivors.push(item);
        srcRows.push(...nextSrc);
        for (const h of next) tokens.push(h.tokens[h.tokens.length - 1]);
      }

      PROFILE.select += performance.now() - t1;
      if (survivors.length === 0) break;
      const t2 = performance.now();
      // Reorder / compact the cache to the surviving beams.
      const compacted = survivors.length !== active.length;
      const identity = srcRows.every((r, i) => r === i);
      const newPast: Record<string, Tensor> = {};
      for (let l = 0; l < L; l++) {
        for (const kv of ["key", "value"]) {
          newPast[`past_key_values.${l}.decoder.${kv}`] = gatherRows(out[`present.${l}.decoder.${kv}`], srcRows, identity);
          const encKv = step === 0 ? out[`present.${l}.encoder.${kv}`] : past[`past_key_values.${l}.encoder.${kv}`];
          // Every beam of an item shares the same encoder cache, so it only changes on compaction.
          newPast[`past_key_values.${l}.encoder.${kv}`] = compacted ? gatherRows(encKv, srcRows, false) : encKv;
        }
      }
      if (compacted) {
        encHidden = gatherRows(encHidden, srcRows, false);
        encMask = gatherRows(encMask, srcRows, false);
      }
      PROFILE.gather += performance.now() - t2;
      past = newPast;
      active = survivors;
      nextTokens = BigInt64Array.from(tokens, (t) => BigInt(t));
    }
    return results;
  }

  private addFinished(item: Item, tokens: number[], score: number, k: number): void {
    item.finished.push({ tokens, score });
    item.finished.sort((a, b) => b.score - a.score);
    if (item.finished.length > k) item.finished.length = k;
  }

  async dispose(): Promise<void> {
    await Promise.all([this.encoderSession.release(), this.decoderSession.release(), this.topkSession.release()]);
  }
}
