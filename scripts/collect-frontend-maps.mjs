import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const assets = "dist/assets";
const maps = "src-tauri/target/frontend-sourcemaps";
const names = (await readdir(assets)).filter((name) => name.endsWith(".map"));
if (names.length === 0) throw new Error("The frontend build did not produce any source maps.");

await mkdir(maps, { recursive: true });
await Promise.all(names.map((name) => rename(join(assets, name), join(maps, name))));
