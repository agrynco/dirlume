import { t } from "./i18n";

export const writeErrors: Record<string, string> = {
  stale: "The checked-out branch or staged changes changed. Review the refreshed changes and try again.",
  busy: "The Git index is locked. Finish the other Git operation and refresh.",
  operationInProgress: "Finish the current Git operation or resolve its conflicts before writing changes.",
  detached: "Switch to a branch to create a commit.",
  unsupportedChange: "Use Git in a terminal to change this submodule or directory entry.",
  emptyCommit: "Stage files and enter a commit message first.",
  gitTooOld: "Update Git to 2.29 or newer to commit from Git View.",
};

export function writeFailure(error: unknown) {
  return (error instanceof Error ? error.cause : error) as { kind?: string; detail?: unknown } | null;
}

export function writeError(error: unknown) {
  const failure = writeFailure(error);
  const message = failure?.kind ? writeErrors[failure.kind] : undefined;
  const detail = typeof failure?.detail === "string" && failure.detail;
  return t(message || detail || "Git could not complete the operation.");
}
