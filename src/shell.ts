import { windowsClient } from "./api";

export function shellArgument(value: string) {
  const quoted = windowsClient ? value.replace(/['‘’]/g, "$&$&") : value.replaceAll("'", "'\\''");
  return `'${quoted}'`;
}

export function changeShellDirectory(path: string) {
  if (windowsClient) return `Set-Location -LiteralPath ${shellArgument(path)} -ErrorAction Stop`;
  if (!/\p{Cc}/u.test(path)) return `cd -- ${shellArgument(path)}`;
  // Send PTY control characters as text and preserve trailing newlines in the decoded path.
  const escaped = Array.from(new TextEncoder().encode(path), (byte) => "\\0" + byte.toString(8).padStart(3, "0")).join("");
  return `__dirlume_path=$(printf '%b.' '${escaped}') && cd -- "\${__dirlume_path%.}"`;
}

export function shellCommand(command: string) {
  if (!/[\r\n]/.test(command)) return command;
  const bytes = new TextEncoder().encode(command);
  if (windowsClient) {
    const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
    return `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`;
  }
  const escaped = Array.from(bytes, (byte) => "\\0" + byte.toString(8).padStart(3, "0")).join("");
  return `eval "$(printf '%b' '${escaped}')"`;
}
