import { invoke, isTauri, type InvokeArgs } from "@tauri-apps/api/core";

type ErrorCode = "native_error" | "os_error" | "permission_denied" | "not_found" | "timeout"
  | "javascript_error" | "type_error" | "syntax_error" | "range_error" | "unhandled_rejection";

const reported = new WeakSet<object>();

function send(operation: string, code: ErrorCode, osCode?: number, detail?: string) {
  if (!isTauri()) return;
  void invoke("report_diagnostic", { operation, code, osCode, detail }).catch(() => {});
}

export function reportFrontendError(operation: string, error: unknown, fallback: ErrorCode = "javascript_error") {
  if (typeof error === "object" && error !== null) {
    if (reported.has(error)) return;
    reported.add(error);
    if (error instanceof Error && typeof error.cause === "object" && error.cause !== null &&
        reported.has(error.cause)) return;
  }
  const code = error instanceof TypeError ? "type_error"
    : error instanceof SyntaxError ? "syntax_error"
    : error instanceof RangeError ? "range_error" : fallback;
  send(operation, code);
}

export async function invokeWithDiagnostics<T>(command: string, args?: InvokeArgs, detail?: string): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure));
    reported.add(error);
    // The Rust panic hook already reports this failure before the rejection reaches JavaScript.
    if (error.message !== "An internal operation panicked.") {
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
  window.addEventListener("error", (event) => reportFrontendError("javascript", event.error));
  window.addEventListener("unhandledrejection", (event) => reportFrontendError("javascript", event.reason, "unhandled_rejection"));
}
