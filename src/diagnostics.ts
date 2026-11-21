import { invoke, isTauri, type InvokeArgs } from "@tauri-apps/api/core";

type ErrorCode = "native_error" | "os_error" | "permission_denied" | "not_found" | "timeout"
  | "javascript_error" | "type_error" | "syntax_error" | "range_error" | "unhandled_rejection";

type FrontendOrigin = "window_error" | "unhandled_rejection" | "react";
type FrontendSource = { asset: string; line: number; column: number };
type FrontendReport = { origin: FrontendOrigin; source: FrontendSource | null };

const reported = new WeakSet<object>();

function send(operation: string, code: ErrorCode, osCode?: number, detail?: string, frontend?: FrontendReport) {
  if (!isTauri()) return;
  void invoke("report_diagnostic", { operation, code, osCode, detail, frontend }).catch(() => {});
}

function bundledSource(location: string, line: number, column: number): FrontendSource | null {
  if (location.length > 512 || !Number.isInteger(line) || !Number.isInteger(column) ||
      line < 1 || line > 1_000_000 || column < 1 || column > 10_000_000) return null;
  try {
    const url = new URL(location);
    if (url.protocol !== window.location.protocol || url.host !== window.location.host ||
        url.username || url.password || url.search || url.hash) return null;
    const match = /^\/assets\/([\w-]{1,100}-[\w-]{8}\.js)$/.exec(url.pathname);
    return match ? { asset: match[1], line, column } : null;
  } catch {
    return null;
  }
}

function stackSource(error: unknown): FrontendSource | null {
  if (!(error instanceof Error)) return null;
  try {
    if (typeof error.stack !== "string") return null;
    // V8 and WebKit both end stack frames with a URL, line, and column.
    for (const frame of error.stack.slice(0, 12_288).split("\n", 32)) {
      const location = /(?:^|[(@\s])((?:https?|tauri):\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/.exec(frame);
      if (!location) continue;
      const source = bundledSource(location[1], Number(location[2]), Number(location[3]));
      if (source) return source;
    }
  } catch {
    // Error subclasses may supply a custom stack getter.
  }
  return null;
}

export function reportFrontendError(operation: string, error: unknown, fallback: ErrorCode = "javascript_error",
  origin?: FrontendOrigin, source?: FrontendSource | null) {
  if (typeof error === "object" && error !== null) {
    if (reported.has(error)) return;
    reported.add(error);
    if (error instanceof Error && typeof error.cause === "object" && error.cause !== null) {
      if (error.cause !== error && reported.has(error.cause)) return;
      reported.add(error.cause);
    }
  }
  const code = error instanceof TypeError ? "type_error"
    : error instanceof SyntaxError ? "syntax_error"
    : error instanceof RangeError ? "range_error" : fallback;
  send(operation, code, undefined, undefined, origin ? { origin, source: source ?? stackSource(error) } : undefined);
}

export function reportReactError(error: unknown) {
  reportFrontendError("react_render", error, "javascript_error", "react");
}

export async function invokeWithDiagnostics<T>(command: string, args?: InvokeArgs, detail?: string): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (failure) {
    const reportedRead = command === "read_text" && typeof failure === "object" && failure !== null &&
      "readCause" in failure && "message" in failure && typeof failure.message === "string" ? failure.message : undefined;
    const error = failure instanceof Error ? failure : new Error(reportedRead ?? String(failure));
    reported.add(error);
    // Native read diagnostics and panic reports are written before the rejection reaches JavaScript.
    if (reportedRead === undefined && error.message !== "An internal operation panicked.") {
      const osCode = /\(os error (\d{1,5})\)$/.exec(error.message)?.[1];
      const code = osCode ? "os_error"
        : /permission denied|access (?:is )?denied/i.test(error.message) ? "permission_denied"
        : /not found|no such file/i.test(error.message) ? "not_found"
        : /timed? ?out|deadline exceeded/i.test(error.message) ? "timeout" : "native_error";
      send(command, code, osCode ? Number(osCode) : undefined, detail);
    }
    throw error;
  }
}

export function installDiagnosticListeners() {
  window.addEventListener("error", (event) => reportFrontendError("javascript", event.error, "javascript_error", "window_error",
    bundledSource(event.filename, event.lineno, event.colno)));
  window.addEventListener("unhandledrejection", (event) =>
    reportFrontendError("javascript", event.reason, "unhandled_rejection", "unhandled_rejection"));
}
