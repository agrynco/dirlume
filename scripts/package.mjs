import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { artifactVersion, manifestVersion } from "./build-version.mjs";
import { releaseNotes } from "./release-highlights.mjs";

async function version() {
  const manifest = await manifestVersion();
  if (process.env.DIRLUME_PRODUCT_VERSION && manifest !== process.env.DIRLUME_PRODUCT_VERSION) {
    throw new Error("The package version does not match the resolved product version.");
  }
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${manifest}`) {
    throw new Error(`The release tag must match v${manifest}.`);
  }
  return manifest;
}

const formats = {
  "windows-x64": [["nsis", "-setup.exe", "setup.exe"]],
  "linux-x64": [["deb", ".deb", "deb"], ["appimage", ".AppImage", "AppImage"]],
  "macos-arm64": [["dmg", ".dmg", "dmg"]],
  "macos-x64": [["dmg", ".dmg", "dmg"]],
};

const platformLabels = {
  "windows-x64": "Windows x64",
  "linux-x64": "Ubuntu / Linux x64",
};

const updaterFormats = {
  "windows-x64": { target: "windows-x86_64", bundle: "nsis", suffix: "-setup.exe", extension: "setup.exe" },
  "linux-x64": { target: "linux-x86_64", bundle: "appimage", suffix: ".AppImage", extension: "AppImage" },
};

function bundleFormats(platform, signed) {
  if (!signed) return formats[platform];
  const format = updaterFormats[platform];
  if (!format) throw new Error(`Release publication is disabled for ${platform}.`);
  const { bundle, suffix, extension } = format;
  return [...formats[platform], [bundle, suffix + ".sig", extension + ".sig"]];
}

function artifactNames(platform, label, signed) {
  const portable = portableName(platform, label);
  return [
    ...bundleFormats(platform, signed).map(([, , extension]) => `Dirlume-${label}-${platform}.${extension}`),
    `Dirlume-Server-${label}-${platform}.tar.gz`,
    portable,
    ...(signed && platform === "windows-x64" ? [portable + ".sig"] : []),
  ];
}

function portableName(platform, label) {
  return `Dirlume-${label}-${platform}-portable.zip`;
}

async function findBundle(target, kind, suffix) {
  const directory = join(target, "bundle", kind);
  const matches = (await readdir(directory)).filter((file) => file.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`Expected exactly one ${kind} bundle ending with ${suffix}, got ${matches.length}.`);
  return join(directory, matches[0]);
}

async function collectPortable(platform, target, serverBinary, output) {
  const stage = await mkdtemp(join(await realpath(target), "portable-"));
  try {
    const server = join(stage, "server");
    await mkdir(server);
    await copyFile(serverBinary, join(server, platform === "windows-x64" ? "dirlume-server.exe" : "dirlume-server"));
    await copyFile("LICENSE", join(stage, "LICENSE"));

    if (platform === "windows-x64") {
      await copyFile(join(target, "dirlume.exe"), join(stage, "Dirlume.exe"));
      await writeFile(join(stage, ".dirlume-portable"), "");
      const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
      for (const [source, destination] of Object.entries(config.bundle.resources ?? {})) {
        if (destination === "archive-tools") continue;
        const path = join(stage, destination);
        await mkdir(dirname(path), { recursive: true });
        await cp(join("src-tauri", source), path, { recursive: true, verbatimSymlinks: true });
      }
      // Earlier Portable updaters only accept these existing package paths.
      await copyFile("src-tauri/archive-tools/License.txt", join(stage, "licenses", "7-Zip-LICENSE.txt"));
      await copyFile("src-tauri/archive-tools/NOTICE.txt", join(stage, "licenses", "7-Zip-NOTICE.txt"));
    } else if (platform === "linux-x64") {
      await copyFile(await findBundle(target, "appimage", ".AppImage"), join(stage, "Dirlume.AppImage"));
    } else {
      await cp(await findBundle(target, "macos", ".app"), join(stage, "Dirlume.app"), {
        recursive: true, verbatimSymlinks: true,
      });
    }

    const files = await readdir(stage);
    const path = resolve(output);
    const archive = process.platform === "win32"
      ? spawnSync("tar", ["--format", "zip", "-cf", path, ...files], { cwd: stage, stdio: "inherit" })
      : spawnSync("zip", ["-q", "-r", "-y", path, ...files], { cwd: stage, stdio: "inherit" });
    if (archive.status !== 0) throw archive.error ?? new Error(`Could not archive the portable package for ${platform}.`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function collect(platform) {
  if (!Object.hasOwn(formats, platform)) throw new Error("Unknown artifact platform.");
  const archiveFiles = platform === "windows-x64" ? ["7z.exe", "7z.dll", "7z.sfx"] : ["7zz"];
  for (const name of [...archiveFiles, "License.txt", "7z2606-src.tar.xz"]) {
    if (!(await stat(join("src-tauri", "archive-tools", name))).size) {
      throw new Error(`Missing or empty bundled 7-Zip resource ${name}.`);
    }
  }
  const product = await version();
  const number = process.env.DIRLUME_BUILD_NUMBER;
  const signed = process.env.DIRLUME_SIGNED_RELEASE === "true";
  const label = artifactVersion(product, number);
  const outputs = artifactNames(platform, label, signed);
  const target = "src-tauri/target/release";
  await mkdir("release", { recursive: true });
  for (const [index, [kind, suffix]] of bundleFormats(platform, signed).entries()) {
    await copyFile(await findBundle(target, kind, suffix), join("release", outputs[index]));
  }
  const stage = join("src-tauri", "target", "server-package");
  await mkdir(stage, { recursive: true });
  const executable = platform === "windows-x64" ? "dirlume-server.exe" : "dirlume-server";
  const binary = join(target, executable);
  const reported = spawnSync(binary, ["--version"], { encoding: "utf8" });
  const embedded = number ? `${product}+${number}` : product;
  if (reported.status !== 0 || !reported.stdout.trim().endsWith(` ${embedded}`)) {
    throw new Error(`The server binary must report version ${embedded}.`);
  }
  await copyFile(binary, join(stage, executable));
  await copyFile("LICENSE", join(stage, "LICENSE"));
  const server = `Dirlume-Server-${label}-${platform}.tar.gz`;
  const portable = portableName(platform, label);
  const archive = spawnSync("tar", ["-czf", join("release", server), "-C", stage, executable, "LICENSE"], { stdio: "inherit" });
  if (archive.status !== 0) throw archive.error ?? new Error("Could not archive the server binary.");
  await collectPortable(platform, target, binary, join("release", portable));
  if (signed && platform === "windows-x64") {
    const signature = spawnSync(process.execPath, [
      resolve("node_modules/@tauri-apps/cli/tauri.js"), "signer", "sign",
      "--app-version", product, resolve("release", portable),
    ], { stdio: "inherit" });
    if (signature.status !== 0) throw signature.error ?? new Error("Could not sign the Windows Portable package.");
  }
  for (const file of outputs) {
    const path = join("release", file);
    if (!(await stat(path)).size) throw new Error(`Empty artifact ${file}.`);
    const sha = createHash("sha256");
    for await (const chunk of createReadStream(path)) sha.update(chunk);
    await writeFile(path + ".sha256", `${sha.digest("hex")}  ${file}\n`);
  }
}

async function configureSigning() {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error("A release needs TAURI_SIGNING_PRIVATE_KEY.");
  }
  const directory = "src-tauri/target";
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "updater-config.json"), JSON.stringify({
    bundle: { createUpdaterArtifacts: true },
  }));
}

async function verifyRelease() {
  const { DIRLUME_PRODUCT_VERSION, DIRLUME_BUILD_NUMBER, TAG, GITHUB_REPOSITORY } = process.env;
  if (!DIRLUME_BUILD_NUMBER || TAG !== `v${DIRLUME_PRODUCT_VERSION}`) {
    throw new Error("Release packages must match the resolved build number and tag.");
  }
  const label = artifactVersion(DIRLUME_PRODUCT_VERSION, DIRLUME_BUILD_NUMBER);
  const expected = Object.keys(updaterFormats).flatMap((platform) => artifactNames(platform, label, true))
    .flatMap((name) => [name, `${name}.sha256`]).sort();
  const actual = (await readdir("release")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("The release artifact set does not match the resolved version.");
  if (!GITHUB_REPOSITORY) throw new Error("The release repository is missing.");
  const download = `https://github.com/${GITHUB_REPOSITORY}/releases/download/${TAG}`;
  const platforms = {};
  for (const [platform, { target, extension }] of Object.entries(updaterFormats)) {
    const name = `Dirlume-${label}-${platform}.${extension}`;
    const signature = (await readFile(join("release", `${name}.sig`), "utf8")).trim();
    if (!signature) throw new Error(`Missing updater signature for ${target}.`);
    platforms[target] = { signature, url: `${download}/${name}` };
  }
  const portable = portableName("windows-x64", label);
  const portableSignature = (await readFile(join("release", portable + ".sig"), "utf8")).trim();
  if (!portableSignature) throw new Error("Missing updater signature for Windows Portable.");
  platforms["windows-x86_64-portable"] = { signature: portableSignature, url: `${download}/${portable}` };
  const notes = await releaseNotes(DIRLUME_PRODUCT_VERSION);
  await writeFile(join("release", "latest.json"), JSON.stringify({
    version: DIRLUME_PRODUCT_VERSION,
    ...(notes ? { notes } : {}),
    platforms,
  }, null, 2) + "\n");
  const downloads = Object.entries(platformLabels).map(([platform, name]) => {
    const names = artifactNames(platform, label, true);
    return `| ${name} | [Installer](${download}/${names[0]}) | [ZIP](${download}/${portableName(platform, label)}) |`;
  });
  console.log([
    ...(notes ? [notes, ""] : []),
    "## Downloads", "",
    "| Platform | Installer | Portable ZIP |", "| --- | --- | --- |",
    ...downloads, "",
    "Extract the ZIP and open the desktop app. The optional standalone server is in the `server/` folder.",
    "Windows Portable can install signed updates in the same folder and keeps Options settings beside Dirlume.exe.",
  ].join("\n"));
}

if (process.argv[2] === "check") {
  console.log(`Dirlume v${artifactVersion(await version())}`);
} else if (process.argv[2] === "platforms") {
  console.log(JSON.stringify(Object.keys(process.argv[3] === "true" ? updaterFormats : formats)));
} else if (process.argv[2] === "collect") {
  await collect(process.argv[3]);
} else if (process.argv[2] === "verify-release") {
  await verifyRelease();
} else if (process.argv[2] === "configure-signing") {
  await configureSigning();
} else {
  throw new Error("Use package.mjs check, platforms <publish>, collect <platform>, configure-signing, or verify-release.");
}
