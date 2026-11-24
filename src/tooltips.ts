const selector = "[data-tooltip]";
const tooltipId = "dirlume-tooltip";
const viewportMargin = 8;
const hoverDelay = 450;
type PointerTooltip = { text: string; y: number };
let showPointerTooltip: ((anchor: HTMLElement, text: string, x: number, y: number) => () => void) | undefined;

export function showTooltipAtPointer(anchor: HTMLElement, text: string, event: MouseEvent) {
  return showPointerTooltip?.(anchor, text, event.clientX, event.clientY);
}

function tooltipTarget(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function clipsContent(element: HTMLElement) {
  const wider = element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
  const taller = element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1;
  if (!wider && !taller) return false;
  const style = getComputedStyle(element);
  return (wider && style.overflowX !== "visible") || (taller && style.overflowY !== "visible");
}

function fits(element: HTMLElement, anchor: HTMLElement) {
  if (!element.getClientRects().length || getComputedStyle(element).visibility !== "visible") return false;
  for (let current: HTMLElement | null = element; current && current !== anchor.parentElement; current = current.parentElement) {
    if (clipsContent(current)) return false;
  }
  return !Array.from(element.querySelectorAll("*")).some((child) => child instanceof HTMLElement && clipsContent(child));
}

function tooltipText(anchor: HTMLElement) {
  const { tooltip, tooltipAction, tooltipShortcut } = anchor.dataset;
  if (!tooltip) return;
  const action = normalize(tooltipAction ?? tooltip);
  const hasVisibleLabel = [anchor, ...anchor.querySelectorAll("*")].some((element) => {
    if (!(element instanceof HTMLElement) || element.closest("kbd")) return false;
    const text = normalize(element.innerText);
    return ` ${text} `.includes(` ${action} `) && fits(element, anchor);
  });
  const hasVisibleShortcut = !tooltipShortcut || Array.from(anchor.querySelectorAll("kbd")).some((key) =>
    normalize(key.dataset.shortcut ?? key.innerText) === normalize(tooltipShortcut) && fits(key, anchor));
  if (!hasVisibleLabel || !hasVisibleShortcut) return tooltip;
}

export function installTooltips() {
  const tooltip = document.createElement("div");
  tooltip.id = tooltipId;
  tooltip.className = "app-tooltip";
  tooltip.setAttribute("role", "tooltip");
  if (typeof tooltip.showPopover === "function") tooltip.popover = "manual";

  let trigger: HTMLElement | null = null;
  let pointerTooltip: PointerTooltip | undefined;
  let pointerX = 0;
  let timer: number | undefined;

  function position(anchor: HTMLElement) {
    const bounds = anchor.getBoundingClientRect();
    const preferAbove = anchor.dataset.tooltipPlacement === "above";
    tooltip.style.maxHeight = preferAbove ? `${Math.max(16, bounds.top - 2 * viewportMargin)}px` : "";
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const below = (pointerTooltip?.y ?? bounds.bottom) + viewportMargin;
    const above = (pointerTooltip?.y ?? bounds.top) - height - viewportMargin;
    const maxTop = window.innerHeight - height - viewportMargin;
    const top = preferAbove || (below > maxTop && above >= viewportMargin) ? above : below;
    tooltip.style.left = `${Math.max(viewportMargin, Math.min(pointerX - width / 2, window.innerWidth - width - viewportMargin))}px`;
    tooltip.style.top = `${Math.max(viewportMargin, Math.min(top, maxTop))}px`;
  }

  const observer = new MutationObserver(() => {
    const text = trigger && (pointerTooltip?.text ?? tooltipText(trigger));
    if (!trigger?.isConnected || trigger.closest("[hidden], dialog:not([open])") || !text) {
      hide();
    } else if (tooltip.textContent !== text) {
      tooltip.textContent = text;
      position(trigger);
    }
  });

  function hide() {
    window.clearTimeout(timer);
    observer.disconnect();
    if (trigger && tooltip.parentNode) {
      const descriptions = trigger.getAttribute("aria-describedby")?.split(/\s+/).filter((id) => id && id !== tooltipId);
      if (descriptions?.length) trigger.setAttribute("aria-describedby", descriptions.join(" "));
      else trigger.removeAttribute("aria-describedby");
      tooltip.remove();
    }
    trigger = null;
    pointerTooltip = undefined;
  }

  function show(anchor: HTMLElement, x: number, atPointer?: PointerTooltip) {
    if (trigger === anchor && pointerTooltip === atPointer) return;
    hide();
    trigger = anchor;
    pointerTooltip = atPointer;
    pointerX = x;
    timer = window.setTimeout(() => {
      const text = pointerTooltip?.text ?? tooltipText(anchor);
      if (!anchor.isConnected || !text || !anchor.getClientRects().length) { hide(); return; }
      tooltip.textContent = text;
      (anchor.closest("dialog[open]") ?? document.body).append(tooltip);
      tooltip.showPopover?.();
      position(anchor);
      anchor.setAttribute("aria-describedby", [anchor.getAttribute("aria-describedby"), tooltipId].filter(Boolean).join(" "));
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ["data-tooltip", "data-tooltip-action", "data-tooltip-shortcut", "data-shortcut", "hidden", "open"] });
    }, hoverDelay);
  }

  showPointerTooltip = (anchor, text, x, y) => {
    const hover = { text, y };
    show(anchor, x, hover);
    return () => { if (pointerTooltip === hover) hide(); };
  };

  document.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch" || event.buttons) return;
    const anchor = tooltipTarget(event.target);
    if (anchor && anchor !== tooltipTarget(event.relatedTarget)) show(anchor, event.clientX);
  }, true);
  document.addEventListener("pointerout", (event) => {
    if (trigger && tooltipTarget(event.target) === trigger &&
        tooltipTarget(event.relatedTarget) !== trigger) hide();
  }, true);
  document.addEventListener("focusin", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const anchor = event.target;
    if (anchor.dataset.tooltipOnFocus) {
      const bounds = anchor.getBoundingClientRect();
      show(anchor, bounds.left + bounds.width / 2);
    } else if (trigger && anchor.closest("dialog") !== trigger.closest("dialog")) hide();
  });
  document.addEventListener("focusout", (event) => {
    if (trigger?.dataset.tooltipOnFocus && event.target === trigger) hide();
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); }, true);
  window.addEventListener("blur", hide);
  window.addEventListener("resize", hide);
}
