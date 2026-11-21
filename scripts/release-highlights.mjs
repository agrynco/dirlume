import { readFile } from "node:fs/promises";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export async function releaseNotes(version) {
  if (!stableVersion.test(version)) return "";
  const path = `release-highlights/${version}.json`;
  let release;
  try {
    release = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read release highlights for ${version}.`, { cause: error });
  }
  const { version: recorded, highlights } = release ?? {};
  if (recorded !== version || !Array.isArray(highlights) || highlights.length === 0 || highlights.length > 8 ||
      highlights.some((line) => typeof line !== "string" || !line || line.trim() !== line ||
        [...line].length > 240 || /\p{Cc}/u.test(line) || /[<>&`]/.test(line))) {
    throw new Error(`Invalid release highlights for ${version}. Use one to eight plain-text sentences.`);
  }
  return ["## What's new", "", ...highlights.map((line) => "- " + line)].join("\n");
}
