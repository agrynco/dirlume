import assert from "node:assert/strict";

export async function checkResizeMarker(marker) {
  await marker.waitFor();
  assert.equal(await marker.evaluate((element) => {
    const corner = element.getBoundingClientRect();
    const surface = element.parentElement.getBoundingClientRect();
    return element.tabIndex < 0 && element.getAttribute("aria-hidden") === "true" &&
      Math.abs(surface.right - corner.right) <= 2 && Math.abs(surface.bottom - corner.bottom) <= 2;
  }), true, "The decorative resize marker must be flush with its surface and outside the tab sequence.");
}

export async function openToolWindow(main, trigger, title) {
  const [tool] = await Promise.all([main.context().waitForEvent("page", { timeout: 8000 }), trigger()]);
  tool.setDefaultTimeout(8000);
  await tool.getByRole("dialog", { name: title, exact: true }).waitFor();
  await tool.waitForFunction(() => {
    const tauri = window.__TAURI_INTERNALS__;
    return tauri.invoke("plugin:window|is_visible", { label: tauri.metadata.currentWindow.label });
  });
  await checkResizeMarker(tool.locator(".dialog-window > .window-resize-marker"));
  return tool;
}

export function openOptionsWindow(main, trigger = () => main.getByRole("button", { name: "Options", exact: true }).click(), title = "Options") {
  return openToolWindow(main, trigger, title);
}

export async function closeToolWindow(tool, trigger = () => tool.keyboard.press("Escape")) {
  await Promise.all([tool.waitForEvent("close", { timeout: 8000 }), trigger()]);
}
