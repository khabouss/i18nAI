# Contributing

Thanks for considering a contribution to locale-ai.

## Setup

```bash
git clone https://github.com/khabouss/locale-ai.git
cd locale-ai
npm install
```

## Development loop

```bash
npm test            # unit tests (no models, fast)
npm run test:e2e    # real models, downloads ~115 MB once
npm run dev -- translate --to fr   # run from source
npm run build       # compile to dist/
npm run typecheck
```

## Before opening a PR

- `npm run build && npm test` must pass (this is what CI and `npm publish` both run).
- If you touched translation quality, tokenization, or beam search, run the relevant benchmark in `bench/` (see `bench/README.md`) and include before/after numbers in the PR description.
- Keep changes focused — unrelated formatting or refactors make review harder.

## Adding a language or model

See the [Add a language, or a better model](README.md#add-a-language-or-a-better-model) section of the README. If you convert and validate a new model, a PR adding it to the benchmark table and `Languages` section is very welcome.

## Cutting a release

Releases are tag-triggered, not merge-triggered — merging to `main` never publishes anything by itself.

```bash
npm version patch   # or minor / major — bumps package.json, commits, tags locally
git push && git push --tags
```

Pushing a tag matching `v*.*.*` triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds, tests, runs `npm publish`, and creates a GitHub Release with auto-generated notes from the commits since the last tag.

This uses npm's [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no `NPM_TOKEN` secret to store or rotate. It's configured once on the npm package's settings page (Publishing access → Trusted Publisher → GitHub Actions), pointing at `khabouss/locale-ai` and `.github/workflows/release.yml`; from then on, npm trusts that exact workflow run and nothing else.

## Reporting bugs

Open an [issue](https://github.com/khabouss/locale-ai/issues) with:
- the command you ran
- expected vs actual output
- your Node version (`node -v`) and OS

## Questions

Open a [discussion](https://github.com/khabouss/locale-ai/discussions) or an issue — there's no dumb question.
