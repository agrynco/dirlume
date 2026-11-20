import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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
const documentFile = join(work, "document-mode-fixture.txt");
const webview = join(work, "webview");
const keyFile = join(work, "signing.key");
const configFile = join(work, "bundle.json");
const resultFile = join(work, "result.json");
const phaseFile = join(work, "phase.txt");
const fixtureFile = join(work, "fixture.json");
const cargoTarget = resolve("src-tauri/target/updater-smoke");
const cli = resolve("node_modules/@tauri-apps/cli/tauri.js");
const bundle = windows ? "nsis" : linux ? "appimage" : "app";
const extension = windows ? "-setup.exe" : linux ? ".AppImage" : ".app.tar.gz";
let server;
let child;
let macPainter;
let macInput;

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
  const signature = (await readFile(`${source}.sig`, "utf8")).trim();
  if (!windows) return { path, signature };
  const directory = join(work, `portable-${version}`);
  const executable = join(directory, "Dirlume.exe");
  const zip = join(work, `portable-${version}.zip`);
  await mkdir(directory);
  await copyFile(join(cargoTarget, "release", "dirlume.exe"), executable);
  await writeFile(join(directory, ".dirlume-portable"), "");
  await writeFile(join(directory, "LICENSE"), version);
  run("tar", ["--format", "zip", "-cf", zip, "Dirlume.exe", ".dirlume-portable", "LICENSE"], { cwd: directory });
  run(process.execPath, [cli, "signer", "sign", "--app-version", version, zip], {
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" },
  });
  return { path, signature, portable: { directory, executable, path: zip, signature: (await readFile(zip + ".sig", "utf8")).trim() } };
}

function startApp(executable) {
  const env = { ...process.env };
  if (linux) {
    env.APPIMAGE_EXTRACT_AND_RUN = "1";
    env.WEBKIT_DISABLE_COMPOSITING_MODE = "1";
  }
  return spawn(executable, ["--updater-fixture", fixtureFile], { env, stdio: "inherit", windowsHide: true });
}

async function startMacPainter() {
  macPainter = spawn(macInput, [], { stdio: ["ignore", "pipe", "inherit"] });
  const [output] = await Promise.race([
    once(macPainter.stdout, "data"),
    once(macPainter, "exit").then(([code]) => { throw new Error(`The macOS screen color fixture stopped (${code}).`); }),
    delay(10000).then(() => { throw new Error("The macOS screen color fixture did not open."); }),
  ]);
  assert.match(String(output), /ready/);
}

async function reportedVersion() {
  const inputs = new Set();
  let escapeAttempts = 0;
  let nextEscape = 0;
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const result = JSON.parse(await readFile(resultFile, "utf8"));
      assert.equal(result.error, null);
      return result.version;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const phase = await readFile(phaseFile, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    for (const action of ["an in-place document update", "a replaced document"]) {
      if (!phase.endsWith(action) || inputs.has(action)) continue;
      inputs.add(action);
      if (action === "an in-place document update") await writeFile(documentFile, "Edited in place");
      else {
        const replacement = join(work, "document-replacement.tmp");
        await writeFile(replacement, "Replaced file");
        await rename(replacement, documentFile);
      }
    }
    if (macInput) {
      const input = phase.endsWith("the native screen color cancellation") ? "escape" :
        phase.endsWith("the external screen color") ? "click" : undefined;
      if (input === "escape" && escapeAttempts < 4 && Date.now() >= nextEscape) {
        escapeAttempts++;
        nextEscape = Date.now() + 1500;
        await delay(600);
        run(macInput, [input]);
      }
      if (input === "click" && !inputs.has(input)) {
        inputs.add(input);
        await delay(600);
        run(macInput, [input]);
      }
    }
    await delay(500);
  }
  const phase = await readFile(phaseFile, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return "The fixture did not load.";
  });
  throw new Error(`The installed app did not report an updater result. Last checkpoint: ${phase}`);
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
  if (process.platform === "darwin" && process.env.CI === "true") {
    const helper = join(work, "screen-color-fixture");
    run("swiftc", ["scripts/screen-color-macos.swift", "-o", helper]);
    const access = spawnSync(helper, ["preflight"], { stdio: "inherit" });
    if (access.status === 0) {
      macInput = helper;
    } else if (access.status === 78) {
      console.log("The macOS runner does not permit interactive input for the external color fixture.");
    } else {
      throw access.error ?? new Error("The macOS input preflight failed.");
    }
  }

  let bytes = await readFile(after.path);
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
  async function exercise(executable, target, signature, { tampered = false, replacementFailure = false } = {}) {
    reject = tampered;
    const metadata = { version: nextVersion, platforms: { [target]: { url, signature } } };
    const previousDownloads = downloads;
    await rm(phaseFile, { force: true });
    await writeFile(documentFile, "Document mode fixture");
    await writeFile(fixtureFile, JSON.stringify({
      result: resultFile, phase: phaseFile, expected: nextVersion, reject, metadata,
      replacement_failure: replacementFailure,
      check_clipboard: process.env.CI === "true" && !target.endsWith("-portable"),
      check_screen_color: !!macInput,
    }));
    // Keep the painter behind the sampler without opening another window during sampling.
    if (macInput && !tampered && !replacementFailure && !macPainter) await startMacPainter();
    child = startApp(executable);
    const version = await Promise.race([
      reportedVersion(),
      new Promise((_, failed) => child.once("error", failed)),
    ]);
    assert.equal(version, reject || replacementFailure ? installedVersion : nextVersion);
    assert.ok(downloads > previousDownloads, "Dirlume did not download the test package.");
    await rm(resultFile);
    if (child.exitCode === null) await Promise.race([new Promise((ready) => child.once("exit", ready)), delay(5000)]);
    console.log(reject ? `Rejected a modified ${target} package.` : replacementFailure
      ? `Restored ${installedVersion} after a replacement failure on ${target}.`
      : `Installed ${nextVersion} over ${installedVersion} and restored saved pane settings on ${target}.`);
    if (macInput && !reject) console.log("Verified macOS screen color sampling from another app and Escape cancellation.");
  }
  await exercise(executable, target, after.signature, { tampered: true });
  await exercise(executable, target, after.signature);

  if (windows) {
    const portableTarget = target + "-portable";
    const first = before.portable.directory;
    bytes = await readFile(after.portable.path);
    const settings = "dirlume-settings.json";
    const portablePreferences = async (directory) => JSON.parse(await readFile(join(directory, settings), "utf8"));
    await exercise(before.portable.executable, portableTarget, after.portable.signature, { tampered: true });
    const previous = await portablePreferences(first);
    assert.equal(previous.viewFontSizes.left, 23);
    assert.equal(await readFile(join(first, "LICENSE"), "utf8"), installedVersion);

    const moved = join(work, "relocated-portable");
    await mkdir(moved);
    for (const name of ["Dirlume.exe", ".dirlume-portable", settings]) await copyFile(join(first, name), join(moved, name));
    const relocated = { ...previous, terminalResizeRows: 4 };
    await writeFile(join(moved, settings), JSON.stringify(relocated));
    await mkdir(join(moved, "LICENSE"));
    const portableExecutable = join(moved, "Dirlume.exe");
    await exercise(portableExecutable, portableTarget, after.portable.signature, { replacementFailure: true });
    assert.deepEqual(await portablePreferences(moved), relocated);
    await rmdir(join(moved, "LICENSE"));
    await exercise(portableExecutable, portableTarget, after.portable.signature);
    assert.equal(await readFile(join(moved, "LICENSE"), "utf8"), nextVersion);
    assert.equal((await portablePreferences(moved)).mainMenuAlignment, "right");
    assert.equal((await portablePreferences(moved)).terminalResizeRows, 4);
    assert.deepEqual(await portablePreferences(first), previous);
    assert.equal(await readFile(join(first, "LICENSE"), "utf8"), installedVersion);
  }
} finally {
  child?.kill();
  if (macPainter?.exitCode === null && macPainter.pid) {
    const stopped = once(macPainter, "exit");
    macPainter.kill();
    await stopped;
  }
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
