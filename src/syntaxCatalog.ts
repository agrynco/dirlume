import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { uncParts, windowsClient, type NamedFile, type TextPlace } from "./api";

const nginx = LanguageDescription.of({
  name: "Nginx",
  filename: /nginx.*\.conf$/i,
  load: () => import("./nginxSyntax").then(({ nginxSyntax }) => nginxSyntax),
});
const catalog = languages.map((language) => language.name === nginx.name ? nginx : language);
export const languageChoices = [...catalog].sort((left, right) => left.name.localeCompare(right.name));

function directorySegments(place: TextPlace) {
  if (place.kind === "kswitcher") return place.path.split(/[\\/]/).filter(Boolean);
  if (place.kind !== "local") return place.segments;
  const unc = uncParts(place.path);
  if (unc.length) return unc.slice(1);
  return place.path.split(windowsClient ? /[\\/]/ : "/").filter(Boolean);
}

export function detectLanguage({ name, place }: NamedFile) {
  const folders = directorySegments(place).map((folder) => folder.toLowerCase());
  const parent = folders.at(-1);
  if (folders.at(-2) === "nginx" && (parent === "sites-enabled" || parent === "sites-available")) return nginx;
  if (folders.includes("nginx") && /\.conf$/i.test(name)) return nginx;
  return LanguageDescription.matchFilename(catalog, name);
}
