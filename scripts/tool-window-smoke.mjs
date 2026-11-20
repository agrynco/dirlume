export async function openToolWindow(main, trigger, title) {
  const [tool] = await Promise.all([main.context().waitForEvent("page", { timeout: 8000 }), trigger()]);
  tool.setDefaultTimeout(8000);
  await tool.getByRole("dialog", { name: title, exact: true }).waitFor();
  await tool.waitForFunction(() => {
    const tauri = window.__TAURI_INTERNALS__;
    return tauri.invoke("plugin:window|is_visible", { label: tauri.metadata.currentWindow.label });
  });
  return tool;
}

export function openOptionsWindow(main, trigger = () => main.getByRole("button", { name: "Options", exact: true }).click(), title = "Options") {
  return openToolWindow(main, trigger, title);
}

export async function closeToolWindow(tool, trigger = () => tool.keyboard.press("Escape")) {
  await Promise.all([tool.waitForEvent("close", { timeout: 8000 }), trigger()]);
}
