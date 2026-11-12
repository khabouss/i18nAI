# Quality benchmark

`tatoeba-sample.json`: 300 random sentence pairs per language (seed 42) from the
[Tatoeba-Challenge](https://github.com/Helsinki-NLP/Tatoeba-Challenge) test sets
(CC-BY 2.0), English → fr, es, de, it, pt, ru, zh (cmn_Hans), ar (ara), nl, ko, tr, ja.

```bash
# translate with a model folder (cache dir, converted folder, ...)
node bench/eval.ts --dir ~/.cache/locale-ai/models/Xenova/opus-mt-en-fr --lang fr --beams 4 --out out/fr.json
node bench/eval.ts --dir models/tc-big-en-zle --lang ru --prefix ">>rus<<" --beams 4 --out out/ru.json

# score (pip install sacrebleu)
python bench/score.py fr out/fr.json

# reference: Hugging Face transformers (PyTorch) beam search
python bench/ref_python.py Helsinki-NLP/opus-mt-en-fr fr 4 out/fr-python.json
```

`bench/models/` and `bench/out/` are git-ignored.
