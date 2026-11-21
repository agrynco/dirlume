import { CircleHelp } from "lucide-react";
import { Button } from "./Button";
import { t } from "./i18n";

export function TerminalShortcutHint({ panelsHidden, onHelp }: { panelsHidden: boolean; onHelp: () => void }) {
  const title = t("File shortcuts paused.");
  const instruction = t(panelsHidden ? "Use the Terminal button to return to files." : "Click a file pane to use them.");
  return <div className="terminal-shortcut-hint">
    <span className="terminal-shortcut-text" role="status" aria-live="polite" data-tooltip={title + " " + instruction} data-tooltip-placement="above">
      <strong>{title}</strong>{" "}{instruction}
    </span>
    <Button type="button" className="icon-button terminal-shortcut-help" data-terminal-shortcut-help
      data-help-topic="terminalShortcuts" aria-label={t("Why are file shortcuts paused?")}
      onMouseDown={(event) => { if (event.button === 0) event.preventDefault(); }} onClick={onHelp}>
      <CircleHelp aria-hidden="true" />
    </Button>
  </div>;
}
