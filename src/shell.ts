import { windowsClient } from "./api";

export function shellArgument(value: string, windows = windowsClient) {
  const quoted = windows ? value.replace(/['‘’]/g, "$&$&") : value.replaceAll("'", "'\\''");
  return `'${quoted}'`;
}

export function changeShellDirectory(path: string, windows = windowsClient) {
  if (windows) return `Set-Location -LiteralPath ${shellArgument(path, true)} -ErrorAction Stop`;
  if (!/\p{Cc}/u.test(path)) return `cd -- ${shellArgument(path, false)}`;
  // Send PTY control characters as text and preserve trailing newlines in the decoded path.
  const escaped = Array.from(new TextEncoder().encode(path), (byte) => "\\0" + byte.toString(8).padStart(3, "0")).join("");
  return `__dirlume_path=$(printf '%b.' '${escaped}') && cd -- "\${__dirlume_path%.}"`;
}
