"""Convert any Hugging Face MarianMT / OPUS-MT model into a locale-ai model folder.

    pip install "optimum[onnxruntime]" onnx sentencepiece
    python scripts/convert-marian.py Helsinki-NLP/opus-mt-tc-big-en-ko --out models/en-ko

Then declare it in locale-ai.config.json:

    { "models": [ { "source": "en", "target": "ko", "path": "models/en-ko" } ] }

The folder gets: config.json, vocab.json, source.spm, tokenizer_config.json,
generation_config.json and onnx/{encoder_model,decoder_model_merged}_quantized.onnx
(int8; pass --fp32 to keep full precision as well). Upload the folder to a
Hugging Face repo to share it, and use "repo" instead of "path".
"""
import argparse
import json
import os
import shutil
import tempfile

from huggingface_hub import snapshot_download
from onnxruntime.quantization import QuantType, quantize_dynamic
from optimum.exporters.onnx import main_export

TOKENIZER_FILES = [
    "config.json",
    "generation_config.json",
    "tokenizer_config.json",
    "vocab.json",
    "target_vocab.json",
    "source.spm",
    "target.spm",
    "special_tokens_map.json",
    "README.md",
]


def patch_optimum_for_py314() -> None:
    """Python 3.14 made functools.partial a method descriptor, so optimum's
    `NORMALIZED_CONFIG_CLASS = Config.with_args(...)` class attributes receive
    `self` as an extra argument ("got multiple values for argument 'allow_new'").
    Wrapping them in staticmethod restores the old behaviour."""
    import functools
    import sys

    if sys.version_info < (3, 14):
        return
    import optimum.exporters.onnx.model_configs as model_configs

    for module in [model_configs, sys.modules.get("optimum.exporters.onnx.config")]:
        for obj in vars(module).values() if module else []:
            if isinstance(obj, type):
                for name, value in list(vars(obj).items()):
                    if isinstance(value, functools.partial):
                        setattr(obj, name, staticmethod(value))


def merge_decoders(decoder: str, decoder_with_past: str, save_path: str) -> None:
    from optimum.onnx import merge_decoders as merge

    merge(decoder, decoder_with_past, save_path=save_path, strict=False)


def quantize(src: str, dst: str) -> None:
    # Weights only (dynamic int8): ~4x smaller, no measurable quality loss on OPUS-MT.
    quantize_dynamic(src, dst, weight_type=QuantType.QUInt8)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", help="Hugging Face model id or local folder of a MarianMT model")
    ap.add_argument("--out", required=True, help="output folder")
    ap.add_argument("--fp32", action="store_true", help="also keep the full-precision ONNX files")
    args = ap.parse_args()

    src = args.model if os.path.isdir(args.model) else snapshot_download(
        args.model, allow_patterns=TOKENIZER_FILES + ["*.safetensors", "pytorch_model.bin"]
    )
    with open(os.path.join(src, "config.json")) as f:
        cfg = json.load(f)
    if cfg.get("model_type") != "marian":
        raise SystemExit(f"{args.model} is a '{cfg.get('model_type')}' model; only MarianMT is supported.")

    out = os.path.abspath(args.out)
    onnx_out = os.path.join(out, "onnx")
    os.makedirs(onnx_out, exist_ok=True)
    patch_optimum_for_py314()
    with tempfile.TemporaryDirectory() as tmp:
        print("Exporting to ONNX...")
        # Keep decoder and decoder-with-past separate: quantize_dynamic does not
        # reach weights inside the merged model's If branches, so we quantize
        # first and merge afterwards.
        main_export(src, output=tmp, task="text2text-generation-with-past", device="cpu", no_post_process=True)
        t = lambda n: os.path.join(tmp, n)  # noqa: E731
        print("Quantizing to int8...")
        for name in ("encoder_model", "decoder_model", "decoder_with_past_model"):
            quantize(t(f"{name}.onnx"), t(f"{name}_quantized.onnx"))
        print("Merging decoders...")
        shutil.copy(t("encoder_model_quantized.onnx"), os.path.join(onnx_out, "encoder_model_quantized.onnx"))
        merge_decoders(
            t("decoder_model_quantized.onnx"),
            t("decoder_with_past_model_quantized.onnx"),
            os.path.join(onnx_out, "decoder_model_merged_quantized.onnx"),
        )
        if args.fp32:
            shutil.copy(t("encoder_model.onnx"), os.path.join(onnx_out, "encoder_model.onnx"))
            merge_decoders(
                t("decoder_model.onnx"),
                t("decoder_with_past_model.onnx"),
                os.path.join(onnx_out, "decoder_model_merged.onnx"),
            )

    for f in TOKENIZER_FILES:
        if os.path.exists(os.path.join(src, f)):
            shutil.copy(os.path.join(src, f), os.path.join(out, f))
    size = sum(os.path.getsize(os.path.join(onnx_out, f)) for f in os.listdir(onnx_out) if "quantized" in f)
    print(f"Done: {out} (int8 weights {size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
