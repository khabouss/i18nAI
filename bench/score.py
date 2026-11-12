"""Scores hypothesis files against the Tatoeba sample: python score.py <lang> <hyps.json>..."""
import json, os, sys
import sacrebleu

here = os.path.dirname(os.path.abspath(__file__))
lang = sys.argv[1]
refs = [x["ref"] for x in json.load(open(os.path.join(here, "tatoeba-sample.json"), encoding="utf8"))[lang]]
tok = {"zh": "zh", "ja": "char", "ko": "char"}.get(lang, "13a")
for f in sys.argv[2:]:
    d = json.load(open(f, encoding="utf8"))
    chrf = sacrebleu.corpus_chrf(d["hyps"], [refs]).score
    try:
        bleu = sacrebleu.corpus_bleu(d["hyps"], [refs], tokenize=tok).score
    except Exception:
        bleu = sacrebleu.corpus_bleu(d["hyps"], [refs], tokenize="char").score
    print(f"{lang:3} chrF {chrf:5.1f}  BLEU {bleu:5.1f}  {d.get('secs', 0):6.1f}s  {os.path.basename(f)}")
