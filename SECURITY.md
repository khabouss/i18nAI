# Security Policy

## Supported Versions

The latest published version on npm is supported. Please update before reporting an issue.

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Instead, report it privately via [GitHub Security Advisories](https://github.com/khabouss/locale-ai/security/advisories/new) for this repository, or by emailing the maintainer directly (see the npm package page for contact info).

Include:
- a description of the vulnerability and its impact
- steps to reproduce
- the version affected

We'll acknowledge reports as soon as possible and aim to release a fix promptly for confirmed issues.

## Scope notes

locale-ai runs translation models locally, on-device, via `onnxruntime-node`. It does not send your locale files, strings, or translations to any network service. Model downloads are pinned to a specific commit and verified against a published hash before use — see the [How it works](README.md#how-it-works) section of the README.

Two caveats to that guarantee:

- **It covers every built-in model, not a custom one.** A `repo`-based model added via `locale-ai.config.json`'s `models` option (see the README's [Add a language, or a better model](README.md#add-a-language-or-a-better-model) section) has no revision pin of its own — it resolves whatever that repo's `main` branch points to at install time. Pin it yourself by hosting a specific commit, or re-verify after any upstream change to that repo.
- **The hash itself comes from wherever `HF_ENDPOINT` points.** With the default `huggingface.co`, that's independent of the download. With a custom `HF_ENDPOINT` (e.g. a self-hosted mirror on a restricted network), both the file and the checksum used to verify it come from that same mirror — a compromised or malicious mirror could serve matching (and therefore "verified") but tampered files. Only point `HF_ENDPOINT` at a mirror you trust as much as huggingface.co itself.
