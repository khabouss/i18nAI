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

/**
 * True when `onnxRoot` was resolved into a pnpm virtual store (`node_modules/.pnpm/
 * onnxruntime-node@<version>/node_modules/onnxruntime-node`) rather than a real project
 * `node_modules`. Node follows symlinks by default, so `require.resolve` lands there
 * directly; scanning that directory for siblings is useless — it only ever contains
 * `onnxruntime-node` itself, so a real consumer symlinked into the project's actual
 * top-level `node_modules` (pnpm's usual layout) is invisible to `hasOtherConsumer`.
 * Reliably walking pnpm's own dependency graph instead isn't worth the fragility this
 * best-effort script is trying to avoid, so this is treated the same as
 * LOCALE_AI_SKIP_TRIM: skip trimming rather than risk a false "no other consumer".
 */
function isPnpmVirtualStore(onnxRoot) {
  return onnxRoot.split(path.sep).includes(".pnpm");
}

/**
 * True when `dirent` (inside `parentDir`) is a directory OR a symlink to one — npm/yarn
 * workspaces and `npm link` represent a linked sibling package as a symlink, and
 * `Dirent.isDirectory()` alone reports `false` for those, making them invisible below.
 */
function isDirLike(parentDir, dirent) {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(parentDir, dirent.name)).isDirectory();
  } catch {
    return false;
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
    if (!isDirLike(nodeModulesDir, e) || e.name === 'onnxruntime-node' || e.name === '.bin') continue;
    const scopeDir = path.join(nodeModulesDir, e.name);
    const names = e.name.startsWith('@')
      ? fs.readdirSync(scopeDir, { withFileTypes: true })
          .filter((s) => isDirLike(scopeDir, s))
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

/**
 * True when the project that `nodeModulesDir` belongs to (one level up) directly depends
 * on onnxruntime-node itself — e.g. for its own GPU use, independent of locale-ai's. Unlike
 * `hasOtherConsumer`, which only looks at sibling packages *inside* node_modules, nothing
 * else scans the root manifest, so this consumer would otherwise go undetected. Excluded
 * when the root itself IS locale-ai (this repo's own checkout, where the root manifest's
 * own onnxruntime-node dependency is exactly the one this script exists to trim).
 */
function rootDependsOnOnnx(nodeModulesDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(nodeModulesDir), 'package.json'), 'utf8'));
    if (pkg.name === 'locale-ai') return false;
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies, ...pkg.devDependencies };
    return !!(deps && 'onnxruntime-node' in deps);
  } catch {
    return false;
  }
}

function trim() {
  if (process.env.LOCALE_AI_SKIP_TRIM) return;

  try {
    const pkgJson = require.resolve('onnxruntime-node/package.json');
    const onnxRoot = path.dirname(pkgJson);
    if (isPnpmVirtualStore(onnxRoot)) return;
    const nodeModulesDir = path.dirname(onnxRoot);
    if (hasOtherConsumer(nodeModulesDir) || rootDependsOnOnnx(nodeModulesDir)) return;

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

module.exports = { trim, hasOtherConsumer, rootDependsOnOnnx, isPnpmVirtualStore };

if (require.main === module) trim();
