import type { ReactNode, Ref } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./Button";
import { t } from "./i18n";

type DropdownTrigger = {
  popupId: string;
  expanded: boolean;
  onClick: () => void;
  label?: string;
  tooltip?: string;
  shortcut?: string;
  disabled?: boolean;
  keepFieldFocus?: boolean;
};

export function EditableDropdown({ children, className, ref, trigger }: {
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLSpanElement>;
  trigger?: DropdownTrigger;
}) {
  const keepFieldFocus = trigger?.keepFieldFocus ?? true;
  return <span ref={ref} className={className ? `editable-dropdown ${className}` : "editable-dropdown"}>
    {children}
    {trigger && <Button type="button" className="icon-button" aria-label={trigger.label ?? t("Show entry history")}
      tooltip={trigger.tooltip} shortcut={trigger.shortcut} disabled={trigger.disabled}
      aria-haspopup="listbox" aria-expanded={trigger.expanded} aria-controls={trigger.expanded ? trigger.popupId : undefined}
      tabIndex={keepFieldFocus ? -1 : undefined} onMouseDown={keepFieldFocus ? (event) => event.preventDefault() : undefined}
      onClick={trigger.onClick}><ChevronDown aria-hidden="true" /></Button>}
  </span>;
}
