import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { artifactVersion, manifestVersion } from "./build-version.mjs";

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

function artifactNames(platform, label) {
  return [
    ...formats[platform].map(([, , extension]) => `Dirlume-${label}-${platform}.${extension}`),
    `Dirlume-Server-${label}-${platform}.tar.gz`,
  ];
}

async function collect(platform) {
  if (!Object.hasOwn(formats, platform)) throw new Error("Unknown artifact platform.");
  const product = await version();
  const number = process.env.DIRLUME_BUILD_NUMBER;
  const outputs = artifactNames(platform, artifactVersion(product, number));
  const target = "src-tauri/target/release";
  await mkdir("release", { recursive: true });
  for (const [index, [kind, suffix]] of formats[platform].entries()) {
    const directory = join(target, "bundle", kind);
    const matches = (await readdir(directory)).filter((file) => file.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${kind} bundle, got ${matches.length}.`);
    await copyFile(join(directory, matches[0]), join("release", outputs[index]));
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
  const server = outputs.at(-1);
  const archive = spawnSync("tar", ["-czf", join("release", server), "-C", stage, executable, "LICENSE"], { stdio: "inherit" });
  if (archive.status !== 0) throw archive.error ?? new Error("Could not archive the server binary.");
  for (const file of outputs) {
    const path = join("release", file);
    if (!(await stat(path)).size) throw new Error(`Empty artifact ${file}.`);
    const sha = createHash("sha256");
    for await (const chunk of createReadStream(path)) sha.update(chunk);
    await writeFile(path + ".sha256", `${sha.digest("hex")}  ${file}\n`);
  }
}

async function verifyRelease() {
  const { DIRLUME_PRODUCT_VERSION, DIRLUME_BUILD_NUMBER, TAG } = process.env;
  if (!DIRLUME_BUILD_NUMBER || TAG !== `v${DIRLUME_PRODUCT_VERSION}`) {
    throw new Error("Release packages must match the resolved build number and tag.");
  }
  const label = artifactVersion(DIRLUME_PRODUCT_VERSION, DIRLUME_BUILD_NUMBER);
  const expected = Object.keys(formats).flatMap((platform) => artifactNames(platform, label))
    .flatMap((name) => [name, `${name}.sha256`]).sort();
  const actual = (await readdir("release")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("The release artifact set does not match the resolved version.");
}

if (process.argv[2] === "check") {
  console.log(`Dirlume v${artifactVersion(await version())}`);
} else if (process.argv[2] === "collect") {
  await collect(process.argv[3]);
} else if (process.argv[2] === "verify-release") {
  await verifyRelease();
} else {
  throw new Error("Use package.mjs check, collect <platform>, or verify-release.");
}
