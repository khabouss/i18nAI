#!/usr/bin/env node
'use strict';

// locale-ai only ever runs onnxruntime-node with executionProviders: ["cpu"]
// (see src/marian.ts) and only ever runs on one platform/arch per install.
// onnxruntime-node still bundles binaries for every platform, and on
// linux/x64 its own postinstall downloads a 260 MB CUDA provider we never
// use (see its script/install-metadata.js). This trims all of that after
// onnxruntime-node has finished installing, shrinking a ~550 MB unpacked
// dependency down to the one binary locale-ai actually loads.
//
// Node's resolution can hoist onnxruntime-node to a node_modules shared with
// other packages, so this only trims when nothing else next to it in that
// same node_modules also depends on it — another consumer there might need a
// GPU provider, or run on a different platform than this machine (e.g. a
// node_modules folder built here and later mounted into a container). Set
// LOCALE_AI_SKIP_TRIM=1 to disable this entirely, e.g. if node_modules is
// going to be reused somewhere this check can't see (a different machine, a
// Docker image built from it later).
//
// Best-effort: never fails the install, even if onnxruntime-node changes
// its layout in a future version.
//
// Also exported as `trim()` and called again on every `locale-ai` CLI
// invocation (see src/cli.ts): npm doesn't guarantee this postinstall script
// runs after onnxruntime-node's own postinstall finishes downloading that
// CUDA provider (observed in practice with `--foreground-scripts`), so the
// file can still be there right after install. Calling trim() again at CLI
// startup is cheap (a handful of fs checks) and catches that race.

const fs = require('fs');
const path = require('path');

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore — best-effort cleanup only
  }
}

/** Any OTHER package in `nodeModulesDir` that itself depends on onnxruntime-node. */
function hasOtherConsumer(nodeModulesDir) {
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'onnxruntime-node' || e.name === '.bin') continue;
    const names = e.name.startsWith('@')
      ? fs.readdirSync(path.join(nodeModulesDir, e.name), { withFileTypes: true })
          .filter((s) => s.isDirectory())
          .map((s) => `${e.name}/${s.name}`)
      : [e.name];
    for (const name of names) {
      if (name === 'locale-ai') continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(nodeModulesDir, name, 'package.json'), 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
        if (deps && 'onnxruntime-node' in deps) return true;
      } catch {
        // Not a real package (or unreadable) — ignore.
      }
    }
  }
  return false;
}

function trim() {
  if (process.env.LOCALE_AI_SKIP_TRIM) return;

  try {
    const pkgJson = require.resolve('onnxruntime-node/package.json');
    const onnxRoot = path.dirname(pkgJson);
    const nodeModulesDir = path.dirname(onnxRoot);
    if (hasOtherConsumer(nodeModulesDir)) return;

    const binRoot = path.join(onnxRoot, 'bin', 'napi-v6');
    if (!fs.existsSync(binRoot)) return;

    const platform = process.platform;
    const arch = process.arch;

    for (const entry of fs.readdirSync(binRoot)) {
      const platformDir = path.join(binRoot, entry);
      if (entry !== platform) {
        rm(platformDir);
        continue;
      }
      // Same platform: drop every other architecture.
      for (const archEntry of fs.readdirSync(platformDir)) {
        if (archEntry !== arch) rm(path.join(platformDir, archEntry));
      }
      // Drop GPU execution providers locale-ai never requests.
      const archDir = path.join(platformDir, arch);
      for (const name of fs.readdirSync(archDir)) {
        if (/^libonnxruntime_providers_(cuda|tensorrt|rocm|dml)\./.test(name)) {
          rm(path.join(archDir, name));
        }
      }
    }
  } catch {
    // onnxruntime-node not installed, or its layout changed — nothing to do.
  }
}

module.exports = { trim };

if (require.main === module) trim();
