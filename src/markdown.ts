import type { NamedFile } from "./api";

export type MarkdownPosition = { fragment: string } | { scrollTop: number };
export type MarkdownLocation = { file: NamedFile; position: MarkdownPosition };
export type OpenMarkdownLink = (file: NamedFile, newTab: boolean, position?: MarkdownPosition) => void;

export function isMarkdownFile(name: string) {
  return /\.(md|markdown)$/i.test(name);
}
