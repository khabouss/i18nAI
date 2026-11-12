"""Reference: HF transformers (PyTorch fp32) beam search. python ref_python.py <hf-model> <lang> <beams> <out> [prefix]"""
import json, os, sys, time, torch
from transformers import MarianMTModel, MarianTokenizer
name, lang, beams, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
prefix = sys.argv[5] + " " if len(sys.argv) > 5 else ""
here = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(here, "tatoeba-sample.json"), encoding="utf8"))[lang]
tok = MarianTokenizer.from_pretrained(name); model = MarianMTModel.from_pretrained(name).eval()
hyps = [None] * len(data); order = sorted(range(len(data)), key=lambda i: len(data[i]["src"]))
t = time.time()
for i in range(0, len(order), 32):
    idx = order[i:i + 32]
    enc = tok([prefix + data[j]["src"] for j in idx], return_tensors="pt", padding=True)
    with torch.inference_mode():
        o = model.generate(**enc, num_beams=beams, max_new_tokens=256)
    for j, s in zip(idx, tok.batch_decode(o, skip_special_tokens=True)): hyps[j] = s
json.dump({"hyps": hyps, "secs": time.time() - t}, open(out, "w"), ensure_ascii=False)
