import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { artifactVersion, resolveBuild } from "./build-version.mjs";

const run = { runNumber: "42", runAttempt: "1", refType: "branch", refName: "main" };

test("CI numbers increase across runs and full retries", () => {
  const first = resolveBuild("0.1.0", "0.1.2", run);
  const retry = resolveBuild("0.1.0", "0.1.2", { ...run, runAttempt: "2" });
  const next = resolveBuild("0.1.0", "0.1.2", { ...run, runNumber: "43" });
  assert.deepEqual(first, { version: "0.1.2", number: "42001", publish: false });
  assert.ok(BigInt(first.number) < BigInt(retry.number));
  assert.ok(BigInt(retry.number) < BigInt(next.number));
  assert.equal(artifactVersion(first.version, first.number), "0.1.2-build.42001");
  assert.throws(() => resolveBuild("0.1.0", undefined, { ...run, runAttempt: "1000" }), /run number or attempt/);
});

test("manual release picks the next patch or a higher source version and is restricted to main", () => {
  const release = { ...run, publishRequested: true };
  assert.deepEqual(resolveBuild("0.1.0", "0.1.9", release), { version: "0.1.10", number: "42001", publish: true });
  assert.equal(resolveBuild("1.0.0", "0.1.9", release).version, "1.0.0");
  assert.equal(resolveBuild("0.1.0", undefined, release).version, "0.1.0");
  assert.equal(resolveBuild("0.1.0", "0.2.0-beta.10", release).version, "0.2.0");
  assert.throws(() => resolveBuild("0.1.0", "0.1.9", { ...release, refName: "other" }), /from main/);
  assert.throws(() => resolveBuild("0.2.0", "0.1.9", { ...release, refType: "tag", refName: "v0.2.0" }), /from main/);
});

test("tagged release requires matching source manifests and a higher version", () => {
  const tag = { ...run, refType: "tag", refName: "v0.2.0" };
  assert.deepEqual(resolveBuild("0.2.0", "0.1.9", tag), { version: "0.2.0", number: "42001", publish: true });
  assert.throws(() => resolveBuild("0.1.0", "0.1.9", tag), /tag must match/);
  assert.throws(() => resolveBuild("0.2.0", "0.2.0", tag), /must be higher/);
  assert.throws(() => resolveBuild("0.2.0-beta.2", "0.2.0-beta.10", { ...tag, refName: "v0.2.0-beta.2" }), /must be higher/);
});

test("the resolved product version is stamped into both manifests and lockfiles", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "dirlume-version-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "src-tauri"));
  const paths = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
  for (const path of paths) await copyFile(new URL(`../${path}`, import.meta.url), join(directory, path));

  const resolved = "99.88.77";
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build-version.mjs", import.meta.url)), "prepare"], {
    cwd: directory, env: { ...process.env, DIRLUME_PRODUCT_VERSION: resolved }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const [npm, npmLock, tauri, cargo, cargoLock] = await Promise.all(paths.map((path) => readFile(join(directory, path), "utf8")));
  assert.equal(JSON.parse(npm).version, resolved);
  assert.equal(JSON.parse(npmLock).version, resolved);
  assert.equal(JSON.parse(npmLock).packages[""].version, resolved);
  assert.equal(JSON.parse(tauri).version, resolved);
  assert.match(cargo, /^version = "99\.88\.77"$/m);
  assert.match(cargoLock, /\[\[package\]\]\r?\nname = "dirlume"\r?\nversion = "99\.88\.77"/);
});
