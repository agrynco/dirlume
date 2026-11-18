import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

async function version() {
  const npm = JSON.parse(await readFile("package.json", "utf8")).version;
  const tauri = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8")).version;
  const cargo = (await readFile("src-tauri/Cargo.toml", "utf8")).match(/^version = "([^"]+)"$/m)?.[1];
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(npm) || npm !== tauri || npm !== cargo) {
    throw new Error("package.json, Cargo.toml and tauri.conf.json must have the same version.");
  }
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${npm}`) {
    throw new Error(`The release tag must match v${npm}.`);
  }
  return npm;
}

const formats = {
  "windows-x64": [["nsis", "-setup.exe", "setup.exe"]],
  "linux-x64": [["deb", ".deb", "deb"], ["appimage", ".AppImage", "AppImage"]],
  "macos-arm64": [["dmg", ".dmg", "dmg"]],
  "macos-x64": [["dmg", ".dmg", "dmg"]],
};

async function collect(platform) {
  if (!Object.hasOwn(formats, platform)) throw new Error("Unknown artifact platform.");
  const base = `Dirlume-${await version()}-${platform}`;
  const target = "src-tauri/target/release";
  await mkdir("release", { recursive: true });
  const outputs = [];
  for (const [kind, suffix, extension] of formats[platform]) {
    const directory = join(target, "bundle", kind);
    const matches = (await readdir(directory)).filter((file) => file.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${kind} bundle, got ${matches.length}.`);
    const file = `${base}.${extension}`;
    await copyFile(join(directory, matches[0]), join("release", file));
    outputs.push(file);
  }
  const stage = join("src-tauri", "target", "server-package");
  await mkdir(stage, { recursive: true });
  const executable = platform === "windows-x64" ? "dirlume-server.exe" : "dirlume-server";
  await copyFile(join(target, executable), join(stage, executable));
  await copyFile("LICENSE", join(stage, "LICENSE"));
  const server = `Dirlume-Server-${await version()}-${platform}.tar.gz`;
  const archive = spawnSync("tar", ["-czf", join("release", server), "-C", stage, executable, "LICENSE"], { stdio: "inherit" });
  if (archive.status !== 0) throw archive.error ?? new Error("Could not archive the server binary.");
  outputs.push(server);
  for (const file of outputs) {
    const path = join("release", file);
    if (!(await stat(path)).size) throw new Error(`Empty artifact ${file}.`);
    const sha = createHash("sha256");
    for await (const chunk of createReadStream(path)) sha.update(chunk);
    await writeFile(path + ".sha256", `${sha.digest("hex")}  ${file}\n`);
  }
}

if (process.argv[2] === "check") {
  console.log(`Dirlume v${await version()}`);
} else if (process.argv[2] === "collect") {
  await collect(process.argv[3]);
} else {
  throw new Error("Use package.mjs check or package.mjs collect <platform>.");
}
