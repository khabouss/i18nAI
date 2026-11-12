import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Hop, ModelEntry } from "./catalog.ts";
import { MarianModel, type MarianPaths } from "./marian.ts";

/** Bumped when the downloaded file set changes; forces a re-install (files are reused). */
const FORMAT_VERSION = 2;
const MANIFEST = "locale-ai.json";
const HF = (process.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/$/, "");

const REQUIRED = ["config.json", "vocab.json", "source.spm"];
const OPTIONAL = ["tokenizer_config.json", "generation_config.json", "target_vocab.json"];

/**
 * ONNX weights in order of preference. int8 is ~4x smaller than fp32 with no
 * measurable quality loss (chrF 68.9 vs 69.0 on en-fr, 47.8 vs 47.8 on en-ar).
 */
const ENCODERS = ["encoder_model_quantized.onnx", "encoder_model_int8.onnx", "encoder_model.onnx"];
const DECODERS = ["decoder_model_merged_quantized.onnx", "decoder_model_merged_int8.onnx", "decoder_model_merged.onnx"];

export function cacheRoot(): string {
  if (process.env.LOCALE_AI_CACHE) return path.resolve(process.env.LOCALE_AI_CACHE);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "locale-ai");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "locale-ai");
}

const modelsRoot = () => path.join(cacheRoot(), "models");

/** Where a model's files live: its local folder, or its cache folder. */
export const modelDir = (m: ModelEntry) => m.path ?? path.join(modelsRoot(), ...m.repo!.split("/"));

export interface Manifest {
  format: number;
  repo: string;
  revision: string;
  installedAt: string;
  bytes: number;
  encoder: string;
  decoder: string;
}

export function readManifest(m: ModelEntry): Manifest | undefined {
  if (m.path) return undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(modelDir(m), MANIFEST), "utf8")) as Manifest;
    return manifest.format === FORMAT_VERSION ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the ONNX files in a local model folder (root or onnx/). */
function findLocal(dir: string): MarianPaths | undefined {
  const pick = (names: string[]) => {
    for (const sub of ["onnx", "."]) {
      for (const n of names) {
        const p = path.join(dir, sub, n);
        if (fs.existsSync(p)) return p;
      }
    }
    return undefined;
  };
  const encoder = pick(ENCODERS);
  const decoder = pick(DECODERS);
  if (!encoder || !decoder || !REQUIRED.every((f) => fs.existsSync(path.join(dir, f)))) return undefined;
  return { dir, encoder, decoder };
}

export function modelPaths(m: ModelEntry): MarianPaths | undefined {
  if (m.path) return findLocal(m.path);
  const man = readManifest(m);
  if (!man) return undefined;
  const dir = modelDir(m);
  return { dir, encoder: path.join(dir, man.encoder), decoder: path.join(dir, man.decoder) };
}

export const isInstalled = (m: ModelEntry) => modelPaths(m) !== undefined;

/** Explains why a local model folder cannot be used. */
export function localModelProblem(m: ModelEntry): string | undefined {
  if (!m.path) return undefined;
  if (!fs.existsSync(m.path)) return `folder not found: ${m.path}`;
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(m.path!, f)));
  if (missing.length) return `missing ${missing.join(", ")} in ${m.path}`;
  return findLocal(m.path)
    ? undefined
    : `no encoder/merged decoder ONNX files in ${m.path} (convert it with scripts/convert-marian.py)`;
}

interface RemoteFile {
  path: string;
  size: number;
  /** sha256 for LFS files. */
  sha256?: string;
  /** git blob sha1 for small, non-LFS files. */
  gitSha1?: string;
}

export interface InstallPlan {
  model: ModelEntry;
  revision: string;
  files: RemoteFile[];
  bytes: number;
  encoder: string;
  decoder: string;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetchWithRetry(url);
  return res.json();
}

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "locale-ai" } });
      if (res.ok) return res;
      if (res.status === 404 || res.status === 401) throw new Error(`Not found: ${url}`);
      last = new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Not found")) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  throw new Error(`Download failed: ${last instanceof Error ? last.message : String(last)}`);
}

/** Resolves the exact files, sizes and checksums to download for a model. */
export async function planInstall(m: ModelEntry): Promise<InstallPlan> {
  if (!m.repo) throw new Error(`${m.id} is a local model; nothing to download.`);
  const info = (await getJson(`${HF}/api/models/${m.repo}/revision/main`)) as { sha: string };
  const tree = (await getJson(`${HF}/api/models/${m.repo}/tree/${info.sha}?recursive=true`)) as Array<{
    path: string;
    size: number;
    oid: string;
    lfs?: { oid: string; size: number };
  }>;
  const byPath = new Map(tree.map((e) => [e.path, e]));
  const pick = (names: string[]) => {
    for (const sub of ["onnx/", ""]) for (const n of names) if (byPath.has(sub + n)) return sub + n;
    return undefined;
  };
  const encoder = pick(ENCODERS);
  const decoder = pick(DECODERS);
  if (!encoder || !decoder) {
    throw new Error(`${m.repo} has no encoder + merged decoder ONNX files (see scripts/convert-marian.py).`);
  }
  const wanted = [...REQUIRED, ...OPTIONAL.filter((f) => byPath.has(f)), encoder, decoder];
  const files = wanted.map((f): RemoteFile => {
    const entry = byPath.get(f);
    if (!entry) throw new Error(`${m.repo} is missing ${f}; this model cannot be used.`);
    return entry.lfs
      ? { path: f, size: entry.lfs.size, sha256: entry.lfs.oid }
      : { path: f, size: entry.size, gitSha1: entry.oid };
  });
  return { model: m, revision: info.sha, files, bytes: files.reduce((s, f) => s + f.size, 0), encoder, decoder };
}

function newHash(file: RemoteFile): Hash {
  if (file.sha256) return createHash("sha256");
  const h = createHash("sha1");
  h.update(`blob ${file.size}\0`);
  return h;
}

/** True when `p` already holds exactly this file (lets upgrades skip re-downloading). */
async function matches(p: string, file: RemoteFile): Promise<boolean> {
  try {
    if ((await fsp.stat(p)).size !== file.size) return false;
    const h = newHash(file);
    for await (const chunk of fs.createReadStream(p)) h.update(chunk as Buffer);
    return h.digest("hex") === (file.sha256 ?? file.gitSha1);
  } catch {
    return false;
  }
}

async function download(url: string, dest: string, file: RemoteFile, onBytes: (n: number) => void): Promise<void> {
  const res = await fetchWithRetry(url);
  if (!res.body) throw new Error(`Empty response for ${url}`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const hash = newHash(file);
  const out = fs.createWriteStream(dest);
  let written = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      written += chunk.length;
      onBytes(chunk.length);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  if (written !== file.size || hash.digest("hex") !== (file.sha256 ?? file.gitSha1)) {
    throw new Error(`Checksum mismatch for ${file.path} (got ${written} bytes). Please retry.`);
  }
}

export async function install(plan: InstallPlan, onProgress?: (done: number, total: number) => void): Promise<void> {
  const dir = modelDir(plan.model);
  const tmp = `${dir}.partial-${process.pid}`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  let done = 0;
  try {
    for (const f of plan.files) {
      const dest = path.join(tmp, f.path);
      const previous = path.join(dir, f.path);
      if (await matches(previous, f)) {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(previous, dest);
        done += f.size;
        onProgress?.(done, plan.bytes);
        continue;
      }
      const url = `${HF}/${plan.model.repo}/resolve/${plan.revision}/${f.path}`;
      for (let attempt = 0; ; attempt++) {
        const before = done;
        try {
          await download(url, dest, f, (n) => {
            done += n;
            onProgress?.(done, plan.bytes);
          });
          break;
        } catch (e) {
          done = before;
          if (attempt >= 2) throw e;
        }
      }
    }
    const manifest: Manifest = {
      format: FORMAT_VERSION,
      repo: plan.model.repo!,
      revision: plan.revision,
      installedAt: new Date().toISOString(),
      bytes: plan.bytes,
      encoder: plan.encoder,
      decoder: plan.decoder,
    };
    await fsp.writeFile(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 2));
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(tmp, dir);
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

export async function uninstall(m: ModelEntry): Promise<boolean> {
  if (m.path) throw new Error(`${m.id} is a local model in ${m.path}; remove it from your config instead.`);
  if (!fs.existsSync(modelDir(m))) return false;
  await fsp.rm(modelDir(m), { recursive: true, force: true });
  return true;
}

export interface Translator {
  translate(texts: string[]): Promise<string[]>;
  dispose(): Promise<void>;
}

export interface LoadOptions {
  /** Beam width; 1 = greedy (fastest). */
  beams: number;
  threads?: number;
}

export async function loadTranslator(hop: Hop, opts: LoadOptions): Promise<Translator> {
  const paths = modelPaths(hop.model);
  if (!paths) throw new Error(localModelProblem(hop.model) ?? `${hop.model.id} is not installed.`);
  const model = await MarianModel.load(paths, opts.threads);
  if (hop.prefix && !model.hasToken(hop.prefix)) {
    await model.dispose();
    throw new Error(`${hop.model.id} does not support the target code ${hop.prefix}.`);
  }
  return {
    translate: (texts) => model.translate(texts, hop.prefix, { beams: opts.beams }),
    dispose: () => model.dispose(),
  };
}
