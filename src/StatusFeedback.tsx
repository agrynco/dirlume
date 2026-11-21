import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "./Button";
import { errorText, t } from "./i18n";

export type WorkspaceStatus = { text: string; error?: boolean };

export function StatusFeedback({ status }: { status: WorkspaceStatus }) {
  const initialStatus = useRef(status);
  const [confirmation, setConfirmation] = useState<WorkspaceStatus | null>(null);
  const [errors, setErrors] = useState<string[]>(() => status.error ? [status.text] : []);

  useEffect(() => {
    if (status === initialStatus.current) return;
    if (status.error) {
      setErrors((current) => current.includes(status.text) ? current : [...current, status.text]);
    } else if (status.text !== "Ready") setConfirmation(status);
  }, [status]);

  useEffect(() => {
    if (!confirmation) return;
    const timer = window.setTimeout(() => setConfirmation(null), 2600);
    return () => window.clearTimeout(timer);
  }, [confirmation]);

  return <div className="workspace-feedback">
    <div className="workspace-errors" role="alert" aria-atomic="false" aria-relevant="additions text">
      {errors.map((message) => <div className="workspace-error" key={message}>
        <span>{errorText(message)}</span>
        <Button type="button" className="icon-button" aria-label={t("Dismiss error")}
          onClick={() => setErrors((current) => current.filter((item) => item !== message))}><X aria-hidden="true" /></Button>
      </div>)}
    </div>
    <div className="workspace-confirmation" role="status">{confirmation && errorText(confirmation.text)}</div>
  </div>;
}
