import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const windows = process.platform === "win32";
const linux = process.platform === "linux";
if (linux && !process.env.DISPLAY) {
  run("xvfb-run", ["-a", "dbus-run-session", "--", "sh", "-c", `
    set -eu
    openbox --sm-disable &
    manager=$!
    trap 'kill "$manager" 2>/dev/null || true' EXIT
    attempt=0
    until xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; do
      attempt=$((attempt + 1))
      if [ "$attempt" -ge 50 ]; then
        echo "The X11 window manager did not start." >&2
        exit 1
      fi
      sleep 0.1
    done
    GDK_BACKEND=x11 "$@"
  `, "dirlume-updater-display", process.execPath, ...process.argv.slice(1)]);
  process.exit(0);
}
const targetName = { win32: "windows", linux: "linux", darwin: "darwin" }[process.platform];
const architecture = { x64: "x86_64", arm64: "aarch64" }[process.arch];
assert.ok(targetName && architecture, "The updater smoke test needs a supported desktop platform.");
const target = `${targetName}-${architecture}`;
const product = "Dirlume Updater Smoke";
const identifier = "io.github.agrynco.dirlume.updater-smoke";
const installedVersion = "0.0.1";
const nextVersion = "0.0.2";
const scratch = await realpath(tmpdir());
const work = await mkdtemp(join(scratch, "dirlume-updater-"));
const install = join(work, "installed");
await mkdir(install);
const webview = join(work, "webview");
const keyFile = join(work, "signing.key");
const configFile = join(work, "bundle.json");
const resultFile = join(work, "result.json");
const fixtureFile = join(work, "fixture.json");
const cargoTarget = resolve("src-tauri/target/updater-smoke");
const cli = resolve("node_modules/@tauri-apps/cli/tauri.js");
const bundle = windows ? "nsis" : linux ? "appimage" : "app";
const extension = windows ? "-setup.exe" : linux ? ".AppImage" : ".app.tar.gz";
let server;
let child;

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw result.error ?? new Error(`${basename(file)} exited with ${result.status}.`);
}

async function build(version, publicKey, privateKey) {
  await writeFile(configFile, JSON.stringify({
    productName: product, identifier, version,
    ...(windows ? { app: { windows: [{ label: "main", title: product, dataDirectory: webview }] } } : {}),
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: publicKey, requireSignedVersion: true, windows: { installMode: "quiet" } } },
  }));
  run(process.execPath, [cli, "build", "--ci", "--bundles", bundle, "--features", "ui-automation", "--config", configFile, "--", "--locked"], {
    env: {
      ...process.env, CARGO_TARGET_DIR: cargoTarget,
      TAURI_SIGNING_PRIVATE_KEY: privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    },
  });
  const output = join(cargoTarget, "release", "bundle", bundle === "app" ? "macos" : bundle);
  const assets = (await readdir(output)).filter((name) => name.startsWith(product) && name.endsWith(extension) &&
    (bundle === "app" || name.includes(`_${version}_`)));
  assert.equal(assets.length, 1, `Expected one ${target} updater package for ${version}.`);
  const source = join(output, assets[0]);
  const path = join(work, `update-${version}${extension}`);
  await copyFile(source, path);
  return { path, signature: (await readFile(`${source}.sig`, "utf8")).trim() };
}

function startApp(executable) {
  const env = { ...process.env };
  if (linux) {
    env.APPIMAGE_EXTRACT_AND_RUN = "1";
    env.WEBKIT_DISABLE_COMPOSITING_MODE = "1";
  }
  return spawn(executable, ["--updater-fixture", fixtureFile], { env, stdio: "inherit", windowsHide: true });
}

async function reportedVersion() {
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const result = JSON.parse(await readFile(resultFile, "utf8"));
      assert.equal(result.error, null);
      return result.version;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(500);
  }
  throw new Error("The installed app did not report an updater result.");
}

try {
  run(process.execPath, [cli, "signer", "generate", "--ci", "--write-keys", keyFile], { stdio: "ignore" });
  const publicKey = (await readFile(`${keyFile}.pub`, "utf8")).trim();
  const privateKey = (await readFile(keyFile, "utf8")).trim();
  const before = await build(installedVersion, publicKey, privateKey);
  const after = await build(nextVersion, publicKey, privateKey);

  let executable;
  if (windows) {
    run(before.path, ["/S", `/D=${install}`], { windowsVerbatimArguments: true, windowsHide: true });
    executable = join(install, "dirlume.exe");
  } else if (linux) {
    executable = join(install, "dirlume.AppImage");
    await copyFile(before.path, executable);
    await chmod(executable, 0o755);
  } else {
    run("tar", ["-xzf", before.path, "-C", install]);
    executable = join(install, `${product}.app`, "Contents", "MacOS", "dirlume");
  }
  assert.ok((await stat(executable)).isFile());

  const bytes = await readFile(after.path);
  let reject = true;
  let downloads = 0;
  server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/package") {
      response.writeHead(404).end();
      return;
    }
    downloads++;
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length + Number(reject) });
    response.end(reject ? Buffer.concat([bytes, Buffer.from([0])]) : bytes);
  });
  await new Promise((ready, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", ready);
  });
  const url = `http://127.0.0.1:${server.address().port}/package`;
  const metadata = { version: nextVersion, platforms: { [target]: { url, signature: after.signature } } };
  for (const rejectPackage of [true, false]) {
    reject = rejectPackage;
    const previousDownloads = downloads;
    await writeFile(fixtureFile, JSON.stringify({ result: resultFile, expected: nextVersion, reject, metadata }));
    child = startApp(executable);
    const version = await Promise.race([
      reportedVersion(),
      new Promise((_, failed) => child.once("error", failed)),
    ]);
    assert.equal(version, reject ? installedVersion : nextVersion);
    assert.ok(downloads > previousDownloads, "Dirlume did not download the test package.");
    await rm(resultFile);
    console.log(reject ? `Rejected a modified ${target} installer.` : `Installed ${nextVersion} over ${installedVersion} and restored saved pane settings on ${target}.`);
  }
} finally {
  child?.kill();
  server?.close();
  const resolvedWork = await realpath(work);
  assert.equal(dirname(resolvedWork), scratch);
  assert.ok(basename(resolvedWork).startsWith("dirlume-updater-"));
  if (windows) {
    const uninstaller = join(resolvedWork, "installed", "uninstall.exe");
    const installed = await stat(uninstaller).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (installed?.isFile()) run(uninstaller, ["/S"], { windowsHide: true });
  }
  await rm(resolvedWork, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
