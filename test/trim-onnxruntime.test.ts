/**
 * Unit tests for the postinstall/CLI-startup onnxruntime-node trimmer. These exercise the
 * exported helper functions directly against constructed temp directories rather than the
 * real node_modules tree, since `trim()` itself resolves onnxruntime-node relative to this
 * script's own location (not a path we can easily fake in a test).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error — plain CommonJS script, no type declarations.
import { hasOtherConsumer, isPnpmVirtualStore, rootDependsOnOnnx } from "../scripts/trim-onnxruntime.cjs";

test("isPnpmVirtualStore: detects node_modules/.pnpm/<pkg>/node_modules/<pkg>, not a real node_modules", () => {
  assert.equal(
    isPnpmVirtualStore(path.join("/proj", "node_modules", ".pnpm", "onnxruntime-node@1.0.0", "node_modules", "onnxruntime-node")),
    true,
  );
  assert.equal(isPnpmVirtualStore(path.join("/proj", "node_modules", "onnxruntime-node")), false);
});

test("hasOtherConsumer: finds a sibling package that depends on onnxruntime-node, ignores locale-ai itself", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-trim-"));
  fs.mkdirSync(path.join(dir, "onnxruntime-node"));
  fs.mkdirSync(path.join(dir, "locale-ai"));
  fs.writeFileSync(path.join(dir, "locale-ai", "package.json"), JSON.stringify({ name: "locale-ai", dependencies: { "onnxruntime-node": "1.0.0" } }));
  assert.equal(hasOtherConsumer(dir), false, "locale-ai's own dependency on onnxruntime-node isn't an 'other' consumer");

  fs.mkdirSync(path.join(dir, "some-gpu-pkg"));
  fs.writeFileSync(path.join(dir, "some-gpu-pkg", "package.json"), JSON.stringify({ name: "some-gpu-pkg", dependencies: { "onnxruntime-node": "1.0.0" } }));
  assert.equal(hasOtherConsumer(dir), true);
});

test("rootDependsOnOnnx: a consuming project's own direct dependency on onnxruntime-node is detected, but locale-ai's own repo isn't mistaken for one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-trim-root-"));
  const nodeModulesDir = path.join(dir, "node_modules");
  fs.mkdirSync(nodeModulesDir);

  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "consumer-app", dependencies: { "onnxruntime-node": "1.0.0", "locale-ai": "1.0.0" } }));
  assert.equal(rootDependsOnOnnx(nodeModulesDir), true);

  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "consumer-app", dependencies: { "locale-ai": "1.0.0" } }));
  assert.equal(rootDependsOnOnnx(nodeModulesDir), false);

  // Running from locale-ai's own repo: the root manifest's own onnxruntime-node dependency
  // is exactly the one this script exists to trim, not an "other" consumer to protect.
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "locale-ai", dependencies: { "onnxruntime-node": "1.0.0" } }));
  assert.equal(rootDependsOnOnnx(nodeModulesDir), false);
});

test("hasOtherConsumer: a pnpm virtual store directory (only ever containing onnxruntime-node itself) correctly reports no consumer there — isPnpmVirtualStore is what must catch this case before scanning it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lai-trim-pnpm-"));
  const storeDir = path.join(dir, "node_modules", ".pnpm", "onnxruntime-node@1.0.0", "node_modules");
  fs.mkdirSync(path.join(storeDir, "onnxruntime-node"), { recursive: true });
  // A real sibling consumer symlinked at the project's actual top-level node_modules —
  // invisible from inside the pnpm store directory, confirming why scanning it is unsafe.
  const topLevel = path.join(dir, "node_modules");
  fs.mkdirSync(path.join(topLevel, "some-gpu-pkg"));
  fs.writeFileSync(path.join(topLevel, "some-gpu-pkg", "package.json"), JSON.stringify({ name: "some-gpu-pkg", dependencies: { "onnxruntime-node": "1.0.0" } }));
  assert.equal(hasOtherConsumer(storeDir), false, "the real consumer lives one level up, not inside the pnpm store dir — isPnpmVirtualStore must bail before this is ever called");
  assert.equal(isPnpmVirtualStore(path.join(storeDir, "onnxruntime-node")), true);
});
