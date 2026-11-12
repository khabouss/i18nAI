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
// Best-effort: never fails the install, even if onnxruntime-node changes
// its layout in a future version.

const fs = require('fs');
const path = require('path');

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore — best-effort cleanup only
  }
}

try {
  const pkgJson = require.resolve('onnxruntime-node/package.json');
  const binRoot = path.join(path.dirname(pkgJson), 'bin', 'napi-v6');
  if (!fs.existsSync(binRoot)) process.exit(0);

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
