const selector = "[data-tooltip]";
const tooltipId = "dirlume-tooltip";
const viewportMargin = 8;
const hoverDelay = 450;

function tooltipTarget(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>(selector) : null;
}

export function installTooltips() {
  const tooltip = document.createElement("div");
  tooltip.id = tooltipId;
  tooltip.className = "app-tooltip";
  tooltip.setAttribute("role", "tooltip");
  if (typeof tooltip.showPopover === "function") tooltip.popover = "manual";

  let trigger: HTMLElement | null = null;
  let pointerX: number | undefined;
  let timer: number | undefined;

  function position(anchor: HTMLElement) {
    const bounds = anchor.getBoundingClientRect();
    const preferAbove = anchor.dataset.tooltipPlacement === "above";
    tooltip.style.maxHeight = preferAbove ? `${Math.max(16, bounds.top - 2 * viewportMargin)}px` : "";
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const center = pointerX ?? bounds.left + bounds.width / 2;
    const below = bounds.bottom + viewportMargin;
    const above = bounds.top - height - viewportMargin;
    const maxTop = window.innerHeight - height - viewportMargin;
    const top = preferAbove || (below > maxTop && above >= viewportMargin) ? above : below;
    tooltip.style.left = `${Math.max(viewportMargin, Math.min(center - width / 2, window.innerWidth - width - viewportMargin))}px`;
    tooltip.style.top = `${Math.max(viewportMargin, Math.min(top, maxTop))}px`;
  }

  const observer = new MutationObserver(() => {
    if (!trigger?.isConnected || trigger.closest("[hidden], dialog:not([open])") || !trigger.dataset.tooltip) {
      hide();
    } else if (tooltip.textContent !== trigger.dataset.tooltip) {
      tooltip.textContent = trigger.dataset.tooltip;
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
  }

  function show(anchor: HTMLElement, x?: number) {
    if (trigger === anchor && (x !== undefined || pointerX === undefined)) return;
    hide();
    trigger = anchor;
    pointerX = x;
    timer = window.setTimeout(() => {
      const text = anchor.dataset.tooltip;
      if (!anchor.isConnected || !text || !anchor.getClientRects().length) { hide(); return; }
      tooltip.textContent = text;
      (anchor.closest("dialog[open]") ?? document.body).append(tooltip);
      tooltip.showPopover?.();
      position(anchor);
      anchor.setAttribute("aria-describedby", [anchor.getAttribute("aria-describedby"), tooltipId].filter(Boolean).join(" "));
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-tooltip", "hidden", "open"] });
    }, x === undefined ? 0 : hoverDelay);
  }

  document.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch" || event.buttons) return;
    const anchor = tooltipTarget(event.target);
    if (anchor && anchor !== tooltipTarget(event.relatedTarget)) show(anchor, event.clientX);
  }, true);
  document.addEventListener("pointerout", (event) => {
    if (trigger && pointerX !== undefined && tooltipTarget(event.target) === trigger &&
        tooltipTarget(event.relatedTarget) !== trigger) hide();
  }, true);
  document.addEventListener("focusin", (event) => {
    if (trigger && event.target instanceof Element &&
        event.target.closest("dialog") !== trigger.closest("dialog")) hide();
    const anchor = tooltipTarget(event.target);
    if (anchor === event.target && anchor?.matches(":focus-visible")) show(anchor);
  });
  document.addEventListener("focusout", (event) => {
    if (trigger && pointerX === undefined && event.target === trigger) hide();
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); }, true);
  window.addEventListener("blur", hide);
  window.addEventListener("resize", hide);
}
