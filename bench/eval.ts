/**
 * Translates the Tatoeba sample for one language with one model configuration.
 *   node bench/eval.ts --dir <model dir> --lang fr [--prefix ">>ara<<"] [--beams 4] [--fp32] --out hyps.json
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { MarianModel } from "../src/marian.ts";

const { values: v } = parseArgs({
  options: {
    dir: { type: "string" },
    lang: { type: "string" },
    prefix: { type: "string" },
    beams: { type: "string", default: "4" },
    batch: { type: "string", default: "32" },
    fp32: { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const here = path.dirname(new URL(import.meta.url).pathname);
const data = JSON.parse(fs.readFileSync(path.join(here, "tatoeba-sample.json"), "utf8"))[v.lang!] as Array<{ src: string; ref: string }>;
const onnx = fs.existsSync(path.join(v.dir!, "onnx")) ? path.join(v.dir!, "onnx") : v.dir!;
const suffix = v.fp32 ? "" : "_quantized";
const model = await MarianModel.load({
  dir: v.dir!,
  encoder: path.join(onnx, `encoder_model${suffix}.onnx`),
  decoder: path.join(onnx, `decoder_model_merged${suffix}.onnx`),
});
const order = data.map((_, i) => i).sort((a, b) => data[a].src.length - data[b].src.length);
const hyps = new Array<string>(data.length);
const t = Date.now();
const bs = Number(v.batch);
for (let i = 0; i < order.length; i += bs) {
  const idx = order.slice(i, i + bs);
  const out = await model.translate(idx.map((j) => data[j].src), v.prefix, { beams: Number(v.beams) });
  idx.forEach((j, n) => (hyps[j] = out[n]));
}
const secs = (Date.now() - t) / 1000;
await model.dispose();
fs.writeFileSync(v.out!, JSON.stringify({ hyps, secs }));
console.error(`${v.lang} ${path.basename(v.dir!)} beams=${v.beams} ${v.fp32 ? "fp32" : "int8"}: ${secs.toFixed(1)}s (${(data.length / secs).toFixed(0)} sent/s)`);
