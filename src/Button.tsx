import { Children, isValidElement, type ComponentPropsWithRef, type ReactNode } from "react";

function caption(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (isValidElement<{ children?: ReactNode }>(child) && child.type !== "kbd") return caption(child.props.children);
    return "";
  }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export function Button({ title, shortcut, children, ...props }: ComponentPropsWithRef<"button"> & { shortcut?: string }) {
  const action = title?.trim() || props["aria-label"] || caption(children);
  const hint = shortcut ? `${action} (${shortcut})` : action;
  return <button {...props} title={hint}>{children}</button>;
}
