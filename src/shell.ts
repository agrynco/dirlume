import { windowsClient } from "./api";

function posixPathBytes(path: string) {
  return Array.from(new TextEncoder().encode(path), (byte) => "\\0" + byte.toString(8).padStart(3, "0")).join("");
}

export function shellArgument(value: string, windows = windowsClient) {
  const quoted = windows ? value.replace(/['‘’]/g, "$&$&") : value.replaceAll("'", "'\\''");
  return `'${quoted}'`;
}

export function changeShellDirectory(path: string, windows = windowsClient) {
  if (windows) return `Set-Location -LiteralPath ${shellArgument(path, true)} -ErrorAction Stop`;
  if (!/\p{Cc}/u.test(path)) return `cd -- ${shellArgument(path, false)}`;
  // Send PTY control characters as text and preserve trailing newlines in the decoded path.
  return `__dirlume_path=$(printf '%b.' '${posixPathBytes(path)}') && cd -- "\${__dirlume_path%.}"`;
}

export function shellScriptCommand(name: string) {
  const path = "./" + name;
  if (!/\p{Cc}/u.test(path)) return shellArgument(path, false);
  return `__dirlume_script=$(printf '%b.' '${posixPathBytes(path)}') && "\${__dirlume_script%.}"`;
}
