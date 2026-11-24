import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = join(root, "src-tauri", "Cargo.toml");
const manifestArgs = ["--manifest-path", manifest, "--locked"];
const limit = 30 * 1024 ** 3;

function exceedsLimit(directories) {
  let bytes = 0;
  const pending = directories.map((directory) => join(directory, "debug"));
  while (pending.length > 0) {
    const path = pending.pop();
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isDirectory()) {
      try {
        for (const name of readdirSync(path)) pending.push(join(path, name));
      } catch (error) {
        // A concurrent Cargo clean can remove the directory before it is read.
        if (error.code !== "ENOENT") throw error;
      }
    } else if (entry?.isFile()) {
      bytes += entry.size;
      if (bytes > limit) return true;
    }
  }
  return false;
}

const metadata = JSON.parse(execFileSync("cargo", [
  "metadata", "--format-version", "1", "--no-deps", ...manifestArgs,
], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
const directories = [...new Set([metadata.target_directory, metadata.build_directory])];
if (exceedsLimit(directories)) {
  console.log("Debug artifacts exceed 30 GiB. Cleaning Dirlume's dev artifacts.");
  execFileSync("cargo", ["clean", ...manifestArgs, "--profile", "dev", "-p", "dirlume"], {
    cwd: root,
    stdio: "inherit",
  });
}
