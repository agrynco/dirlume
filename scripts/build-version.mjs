import { appendFile, readFile, writeFile } from "node:fs/promises";
import { releaseNotes } from "./release-highlights.mjs";

const product = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const positiveInteger = /^[1-9]\d*$/;
const cargoVersion = /^version = "([^"]+)"$/m;
const cargoLockVersion = /(\[\[package\]\]\r?\nname = "dirlume"\r?\nversion = ")([^"]+)(")/;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function manifestVersion() {
  const [npm, tauri, cargo] = await Promise.all([
    readJson("package.json"), readJson("src-tauri/tauri.conf.json"), readFile("src-tauri/Cargo.toml", "utf8"),
  ]);
  if (!product.test(npm.version) || npm.version !== tauri.version || npm.version !== cargo.match(cargoVersion)?.[1]) {
    throw new Error("package.json, Cargo.toml, and tauri.conf.json must have the same product version.");
  }
  return npm.version;
}

function compareVersions(left, right) {
  const [, ...a] = left.match(product);
  const [, ...b] = right.match(product);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1;
  }
  if (!a[3] || !b[3]) return Number(!a[3]) - Number(!b[3]);
  const leftLabels = a[3].split(".");
  const rightLabels = b[3].split(".");
  for (let index = 0; index < Math.min(leftLabels.length, rightLabels.length); index++) {
    const label = leftLabels[index];
    const other = rightLabels[index];
    if (label === other) continue;
    const numeric = /^\d+$/.test(label);
    const otherNumeric = /^\d+$/.test(other);
    if (numeric && otherNumeric) {
      if (BigInt(label) !== BigInt(other)) return BigInt(label) > BigInt(other) ? 1 : -1;
    } else if (numeric !== otherNumeric) return numeric ? -1 : 1;
    else return label > other ? 1 : -1;
  }
  return leftLabels.length - rightLabels.length;
}

function advancesRelease(version, latest) {
  if (!product.test(version)) throw new Error("The release must use a valid product version.");
  if (latest && compareVersions(version, latest) <= 0) {
    throw new Error(`The release version ${version} must be higher than the published version ${latest}.`);
  }
}

export function resolveBuild(manifest, latest, { runNumber, runAttempt, refType, refName, publishRequested }) {
  if (!product.test(manifest) || (latest && !product.test(latest))) throw new Error("Invalid product version.");
  if (!positiveInteger.test(runNumber) || !positiveInteger.test(runAttempt) || BigInt(runAttempt) >= 1000n) {
    throw new Error("Invalid GitHub Actions run number or attempt.");
  }
  const number = String(BigInt(runNumber) * 1000n + BigInt(runAttempt));
  if (publishRequested && (refType !== "branch" || refName !== "main")) {
    throw new Error("Automatic and manual releases must be built from main.");
  }
  if (refType === "tag") {
    if (refName !== `v${manifest}`) throw new Error(`The release tag must match v${manifest}.`);
    advancesRelease(manifest, latest);
    return { version: manifest, number, publish: true };
  }
  if (publishRequested) {
    const [, major, minor, patch, prerelease] = (latest ?? manifest).match(product);
    const nextPatch = latest && !prerelease ? BigInt(patch) + 1n : patch;
    const next = `${major}.${minor}.${nextPatch}`;
    const sourceVersion = manifest.split("-")[0];
    const version = compareVersions(sourceVersion, next) > 0 ? sourceVersion : next;
    advancesRelease(version, latest);
    return { version, number, publish: true };
  }
  return { version: latest && compareVersions(latest, manifest) >= 0 ? latest : manifest, number, publish: false };
}

async function latestPublishedVersion() {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GH_TOKEN } = process.env;
  if (!GITHUB_API_URL || !GITHUB_REPOSITORY || !GH_TOKEN) throw new Error("GitHub release metadata is unavailable.");
  const url = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/releases`;
  let latest;
  for (let page = 1; ; page++) {
    const response = await fetch(`${url}?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`);
    const releases = await response.json();
    for (const { tag_name: tag, draft } of releases) {
      const version = tag.startsWith("v") ? tag.slice(1) : "";
      if (!draft && product.test(version) && (!latest || compareVersions(version, latest) > 0)) latest = version;
    }
    if (releases.length < 100) return latest;
  }
}

export function artifactVersion(version, number = process.env.DIRLUME_BUILD_NUMBER) {
  if (!product.test(version) || (number !== undefined && !positiveInteger.test(number))) {
    throw new Error("Invalid product version or build number.");
  }
  return number ? `${version}-build.${number}` : version;
}

async function prepare(version) {
  artifactVersion(version);
  const current = await manifestVersion();
  if (current === version) return;
  const [npm, lock, tauri, cargo, cargoLock] = await Promise.all([
    readJson("package.json"), readJson("package-lock.json"), readJson("src-tauri/tauri.conf.json"),
    readFile("src-tauri/Cargo.toml", "utf8"), readFile("src-tauri/Cargo.lock", "utf8"),
  ]);
  if (lock.version !== current || lock.packages?.[""]?.version !== current || cargoLock.match(cargoLockVersion)?.[2] !== current) {
    throw new Error("The lockfiles must match the source product version.");
  }
  npm.version = lock.version = lock.packages[""].version = tauri.version = version;
  const json = (value) => JSON.stringify(value, null, 2) + "\n";
  await Promise.all([
    writeFile("package.json", json(npm)), writeFile("package-lock.json", json(lock)),
    writeFile("src-tauri/tauri.conf.json", json(tauri)),
    writeFile("src-tauri/Cargo.toml", cargo.replace(cargoVersion, `version = "${version}"`)),
    writeFile("src-tauri/Cargo.lock", cargoLock.replace(cargoLockVersion, (_, prefix, _current, suffix) => prefix + version + suffix)),
  ]);
  if (await manifestVersion() !== version) throw new Error("Could not apply the resolved product version.");
}

if (import.meta.main) {
  const { GITHUB_RUN_NUMBER, GITHUB_RUN_ATTEMPT, GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_OUTPUT, PUBLISH_RELEASE, CHECK_NEXT_RELEASE_HIGHLIGHTS } = process.env;
  switch (process.argv[2]) {
    case "resolve": {
      const manifest = await manifestVersion();
      const latest = await latestPublishedVersion();
      const options = {
        runNumber: GITHUB_RUN_NUMBER, runAttempt: GITHUB_RUN_ATTEMPT,
        refType: GITHUB_REF_TYPE, refName: GITHUB_REF_NAME, publishRequested: PUBLISH_RELEASE === "true",
      };
      const build = resolveBuild(manifest, latest, options);
      if (build.publish) await releaseNotes(build.version);
      else if (CHECK_NEXT_RELEASE_HIGHLIGHTS === "true") {
        const candidate = resolveBuild(manifest, latest, { ...options, refType: "branch", refName: "main", publishRequested: true });
        await releaseNotes(candidate.version);
      }
      await appendFile(GITHUB_OUTPUT, `product-version=${build.version}\nbuild-number=${build.number}\npublish=${build.publish}\n`);
      break;
    }
    case "prepare":
      await prepare(process.env.DIRLUME_PRODUCT_VERSION);
      break;
    case "check-release":
      advancesRelease(process.env.DIRLUME_PRODUCT_VERSION, await latestPublishedVersion());
      break;
    default:
      throw new Error("Use build-version.mjs resolve, prepare, or check-release.");
  }
}
