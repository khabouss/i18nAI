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
