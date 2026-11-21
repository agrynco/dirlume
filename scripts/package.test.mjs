import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

test("release metadata pairs the signed packages with their platform and exact version", async () => {
  const scratch = await realpath(tmpdir());
  const directory = await mkdtemp(join(scratch, "dirlume-package-"));
  const release = join(directory, "release");
  await mkdir(release);
  const runner = resolve("scripts/package.mjs");
  const product = "2.1.3";
  const label = `${product}-build.66001`;
  const formats = {
    "windows-x64": ["setup.exe", "setup.exe.sig"],
    "linux-x64": ["deb", "AppImage", "AppImage.sig"],
    "macos-x64": ["dmg", "app.tar.gz", "app.tar.gz.sig"],
    "macos-arm64": ["dmg", "app.tar.gz", "app.tar.gz.sig"],
  };
  try {
    for (const [platform, extensions] of Object.entries(formats)) {
      const files = extensions.map((extension) => `Dirlume-${label}-${platform}.${extension}`);
      files.push(`Dirlume-Server-${label}-${platform}.tar.gz`, `Dirlume-${label}-${platform}-portable.zip`);
      if (platform === "windows-x64") files.push(`Dirlume-${label}-${platform}-portable.zip.sig`);
      for (const path of files) {
        await writeFile(join(release, path), path);
        await writeFile(join(release, `${path}.sha256`), "placeholder checksum");
      }
    }
    const run = (tag) => spawnSync(process.execPath, [runner, "verify-release"], {
      cwd: directory, encoding: "utf8", env: { ...process.env,
        DIRLUME_PRODUCT_VERSION: product, DIRLUME_BUILD_NUMBER: "66001", TAG: tag, GITHUB_REPOSITORY: "agrynco/dirlume" },
    });
    assert.notEqual(run("v2.1.4").status, 0);
    assert.notEqual(run(`v${product}`).status, 0, "Stable packages require highlights.");
    await mkdir(join(directory, "release-highlights"));
    const summary = join(directory, "release-highlights", `${product}.json`);
    await writeFile(summary, JSON.stringify({ version: "2.1.4", highlights: ["The wrong version."] }));
    assert.notEqual(run(`v${product}`).status, 0);
    await writeFile(summary, JSON.stringify({ version: product, highlights: ["A fixture change."] }));
    const result = run(`v${product}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^## What's new\n\n- A fixture change\./);
    for (const [platform, extensions] of Object.entries(formats)) {
      for (const suffix of [`.${extensions[0]}`, "-portable.zip"]) {
        assert.ok(result.stdout.includes(`https://github.com/agrynco/dirlume/releases/download/v${product}/Dirlume-${label}-${platform}${suffix}`));
      }
    }
    const manifest = JSON.parse(await readFile(join(release, "latest.json"), "utf8"));
    assert.equal(manifest.version, product);
    assert.equal(manifest.notes, "## What's new\n\n- A fixture change.");
    const packages = {
      "windows-x86_64": `Dirlume-${label}-windows-x64.setup.exe`,
      "windows-x86_64-portable": `Dirlume-${label}-windows-x64-portable.zip`,
      "linux-x86_64": `Dirlume-${label}-linux-x64.AppImage`,
      "darwin-x86_64": `Dirlume-${label}-macos-x64.app.tar.gz`,
      "darwin-aarch64": `Dirlume-${label}-macos-arm64.app.tar.gz`,
    };
    assert.deepEqual(manifest.platforms, Object.fromEntries(Object.entries(packages).map(([target, name]) => [target, {
      signature: `${name}.sig`, url: `https://github.com/agrynco/dirlume/releases/download/v${product}/${name}`,
    }])));
    await rm(join(release, "latest.json"));
    const zip = join(release, `Dirlume-${label}-windows-x64-portable.zip`);
    await rm(zip);
    assert.notEqual(run(`v${product}`).status, 0);
    await writeFile(zip, "portable package");
    await rm(`${zip}.sha256`);
    assert.notEqual(run(`v${product}`).status, 0);
    await writeFile(`${zip}.sha256`, "placeholder checksum");
    await rm(join(release, `${packages["linux-x86_64"]}.sig`));
    assert.notEqual(run(`v${product}`).status, 0);
  } finally {
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), scratch);
    assert.ok(basename(resolved).startsWith("dirlume-package-"));
    await rm(resolved, { recursive: true, force: true });
  }
});
