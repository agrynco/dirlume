import { Children, isValidElement, type ComponentPropsWithRef, type ReactNode } from "react";

function caption(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (isValidElement<{ children?: ReactNode }>(child) && child.type !== "kbd") return caption(child.props.children);
    return "";
  }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export function Button({ tooltip, title, shortcut, children, "data-tooltip": override, ...props }: ComponentPropsWithRef<"button"> & { tooltip?: string; shortcut?: string; "data-tooltip"?: string }) {
  const action = tooltip?.trim() || title?.trim() || override || props["aria-label"] || caption(children);
  const hint = shortcut ? `${action} (${shortcut})` : action;
  return <button {...props} data-tooltip={hint || undefined}>{children}</button>;
}
