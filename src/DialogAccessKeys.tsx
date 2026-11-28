import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { locale } from "./i18n";

const controls = "input, select, textarea, button, [role='button'], [role='checkbox'], [role='combobox'], [role='radio'], [role='slider'], [role='switch'], [role='tab'], [role='textbox']";
const unavailable = ":disabled, [aria-disabled='true'], [aria-hidden='true'], [hidden], [inert], details:not([open]) > :not(summary)";

function labelNodes(node: Node): Text[] {
  if (node instanceof Text) return [node];
  if (!(node instanceof HTMLElement)) return [];
  return Array.from(node.childNodes).flatMap((child) =>
    child instanceof Element && child.matches(`${controls}, kbd, [hidden], [aria-hidden='true']`) ? [] : labelNodes(child));
}

function controlLabel(control: HTMLElement) {
  const labels = (control as HTMLInputElement).labels;
  const label = Array.from(labels ?? []).find((node) => node.getClientRects().length > 0);
  const references = (control.getAttribute("aria-labelledby") ?? "").trim().split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id));
  const visibleReference = references.find((node) => node?.getClientRects().length);
  const nodes = label ? labelNodes(label) : references.flatMap((node) => node ? labelNodes(node) : []);
  return { anchor: label ?? visibleReference ?? control, nodes: nodes.length ? nodes : labelNodes(control) };
}

type Letter = { key: string; initial: boolean; node?: Text; index: number; length: number };

function letters(text: string, node?: Text): Letter[] {
  return [...text.matchAll(/\p{L}+/gu)].flatMap((word) => {
    let index = word.index;
    return [...word[0]].map((letter, offset) => {
      const entry = { key: letter.toLocaleLowerCase(locale()), initial: offset === 0, node, index, length: letter.length };
      index += letter.length;
      return entry;
    });
  });
}

function accessKeys(dialog: HTMLDialogElement) {
  const used = new Set<string>();
  return Array.from(dialog.querySelectorAll<HTMLElement>(controls)).filter((control) =>
    control.closest("dialog") === dialog && control.tabIndex >= 0 && !control.closest(unavailable) &&
    control.getClientRects().length > 0 && getComputedStyle(control).visibility === "visible")
    .map((control) => {
      const { anchor, nodes } = controlLabel(control);
      const visible = nodes.flatMap((node) => letters(node.data, node));
      const priority = visible.length ? control.matches(".dialog-footer button") ? 2 : 1 : 0;
      return { control, anchor, visible, priority };
    })
    .sort((a, b) => b.priority - a.priority)
    .flatMap(({ control, anchor, visible }) => {
      const candidates = visible.length ? visible : letters(control.getAttribute("aria-label") ?? "");
      const preferred = [...candidates.filter(({ initial }) => initial), ...candidates];
      const letter = preferred.find(({ key }) => !used.has(key)) ?? preferred[0];
      if (!letter) return [];
      used.add(letter.key);
      return [{ control, anchor, ...letter }];
    });
}

function visibleWithin(rect: DOMRect, anchor: HTMLElement, dialog: HTMLDialogElement) {
  const { left, top, right, bottom } = rect;
  for (let parent: HTMLElement | null = anchor; parent; parent = parent.parentElement) {
    if (parent === dialog || getComputedStyle(parent).overflowY !== "visible") {
      const clip = parent.getBoundingClientRect();
      if (right <= clip.left || left >= clip.right || bottom <= clip.top || top >= clip.bottom) return false;
    }
    if (parent === dialog) break;
  }
  return right > left && bottom > top;
}

export function useDialogAccessKeys(ref: RefObject<HTMLDialogElement | null>, suspended: boolean) {
  const layer = useRef<HTMLDivElement>(null);
  const [hints, setHints] = useState<{ key: string; left: number; top: number; width: number; color: string }[]>([]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || suspended) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const range = document.createRange();
      setHints(accessKeys(dialog).flatMap(({ anchor, key, node, index, length }) => {
        const caption = node?.parentElement;
        if (!node || !caption) return [];
        range.setStart(node, index);
        range.setEnd(node, index + length);
        const rect = range.getBoundingClientRect();
        return visibleWithin(rect, anchor, dialog) ? [{ key, left: rect.left, top: rect.bottom - 1,
          width: rect.width, color: getComputedStyle(caption).color }] : [];
      }));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const mutations = new MutationObserver((records) => {
      if (records.some(({ target }) => !layer.current?.contains(target))) schedule();
    });
    mutations.observe(dialog, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["class", "style", "open", "hidden", "disabled", "inert", "tabindex", "aria-hidden", "aria-disabled", "aria-label", "aria-labelledby"] });
    const resize = new ResizeObserver(schedule);
    resize.observe(dialog);
    update();
    dialog.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    document.fonts.addEventListener("loadingdone", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      dialog.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      document.fonts.removeEventListener("loadingdone", schedule);
    };
  }, [ref, suspended]);

  function handleAccessKey(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.getModifierState("AltGraph") ||
        !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Alt") { event.preventDefault(); return; }
    const key = event.key.toLocaleLowerCase(locale());
    const physical = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : "";
    const entries = accessKeys(event.currentTarget);
    const matches = entries.filter((entry) => entry.key === key);
    const choices = matches.length ? matches : entries.filter((entry) => entry.key === physical);
    if (!choices.length) return;
    const current = choices.findIndex(({ control }) => control === document.activeElement);
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) choices[(current + 1) % choices.length].control.focus();
  }

  const accessKeyHints = <div ref={layer} className="dialog-access-keys" aria-hidden="true">
    {!suspended && hints.map(({ key, ...style }, index) =>
      <span key={index} data-access-key={key} style={style} />)}
  </div>;
  return { handleAccessKey, accessKeyHints };
}
