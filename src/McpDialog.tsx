import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { api, describeError, type McpConnection } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { errorText, t } from "./i18n";
import { executeMcp, type McpAction, type McpApproval, type McpContext, type McpRevisions } from "./mcp";

export function McpRequests({ context }: { context: McpContext }) {
  const current = useRef(context);
  current.current = context;
  const [approval, setApproval] = useState<McpApproval | null>(null);
  const revisions = useRef<McpRevisions>(new Map());
  useEffect(() => {
    if (!isTauri()) return;
    const subscriptions = [
      listen<McpAction>("mcp-action", ({ payload }) => {
        void executeMcp(payload, current.current, revisions.current).then(
          (result) => api.mcpResult(payload.id, { result }),
          (failure: unknown) => api.mcpResult(payload.id, { error: describeError(failure) }),
        ).catch(() => {});
      }),
      listen<McpApproval>("mcp-approval", ({ payload }) => setApproval(payload)),
    ];
    return () => { for (const subscription of subscriptions) void subscription.then((close) => close()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!approval) return;
    const timer = window.setTimeout(() => setApproval((current) => current?.id === approval.id ? null : current), 60_000);
    return () => window.clearTimeout(timer);
  }, [approval]);

  if (!approval) return null;
  const titles = { trash: "Move to Trash", permanent: "Delete permanently", terminate: "End processes" };
  async function decide(approved: boolean) {
    if (!approval) return;
    try { await api.mcpDecision(approval.id, approved); }
    finally { setApproval((current) => current?.id === approval.id ? null : current); }
  }
  const decline = () => { void decide(false).catch(() => {}); };
  return <Dialog title={t("Confirm MCP request")} tone="warning" onClose={decline}>
    <div className="dialog-body end-processes">
      <strong>{t(titles[approval.action])}</strong>
      <ul>{approval.targets.map((target) => <li key={target}>{target}</li>)}</ul>
      {approval.action === "permanent" && <p>{t("This action cannot be undone.")}</p>}
      {approval.action === "terminate" && <p>{t("Ending processes may cause unsaved work to be lost.")}</p>}
    </div>
    <footer className="dialog-footer">
      <Button type="button" data-initial-focus onClick={decline}>{t("Cancel")}</Button>
      <Button type="button" className="alert-confirm" onClick={() => { void decide(true).catch(() => {}); }}>{t(titles[approval.action])}</Button>
    </footer>
  </Dialog>;
}

export function McpDialog({ onClose }: { onClose: () => void }) {
  const [connection, setConnection] = useState<McpConnection | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void api.mcpConnection().then(
      (current) => { if (live) setConnection(current); },
      (failure: unknown) => { if (live) setError(describeError(failure)); },
    ).finally(() => { if (live) setWorking(false); });
    return () => { live = false; };
  }, []);

  async function toggle() {
    setWorking(true);
    setError("");
    setCopied(false);
    try {
      if (connection) {
        await api.stopMcp();
        setConnection(null);
      } else setConnection(await api.startMcp());
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  }
  const configuration = connection ? JSON.stringify({
    url: connection.endpoint,
    headers: { Authorization: "Bearer " + connection.token },
  }, null, 2) : "";
  return <Dialog title={t("MCP server")} onClose={onClose}>
    <div className="dialog-body">
      {connection ? <>
        <label className="field">{t("MCP connection configuration")}
          <textarea aria-label={t("MCP connection configuration")} readOnly rows={6} value={configuration}
            onFocus={(event) => event.currentTarget.select()} />
        </label>
        <p>{t("Use this configuration in a trusted MCP client on this computer.")}</p>
        <Button type="button" onClick={() => {
          void navigator.clipboard.writeText(configuration).then(() => setCopied(true),
            (failure: unknown) => setError(describeError(failure)));
        }}>{t(copied ? "Copied" : "Copy connection configuration")}</Button>
      </> : <p>{t("Start the local MCP server to connect an AI client.")}</p>}
      {error && <p role="alert" className="dialog-error">{errorText(error)}</p>}
    </div>
    <footer className="dialog-footer">
      <Button type="button" onClick={onClose}>{t("Close")}</Button>
      <Button type="button" className="primary" onClick={() => { void toggle(); }} disabled={working}>
        {t(connection ? "Stop server" : "Start server")}
      </Button>
    </footer>
  </Dialog>;
}
