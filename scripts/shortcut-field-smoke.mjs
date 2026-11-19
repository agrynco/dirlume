import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";

export async function testShortcutFields(page) {
  const window = await openOptionsWindow(page);
  const options = window.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const lookup = (command) => options.getByLabel("Change shortcut for " + command, { exact: true });
  const check = async (command, shortcut) => {
    const button = lookup(command);
    assert.equal(await button.innerText(), shortcut);
    assert.equal(await button.evaluate((field) => {
      const range = document.createRange();
      range.selectNodeContents(field.querySelector("span"));
      const { left, right } = field.getBoundingClientRect();
      return [...range.getClientRects()].every((text) => text.left >= left && text.right <= right);
    }), true, command + " overflows its shortcut field");
    assert.equal(await options.getByRole("button", { name: "Clear shortcut for " + command, exact: true }).isEnabled(), true);
  };
  const extend = "Extend selection down";
  await check(extend, "Shift+↓");
  await check("Forward", "Alt+→");
  await lookup(extend).click();
  await options.getByLabel("New shortcut for " + extend, { exact: true }).press("Control+Alt+Shift+Backspace");
  const verify = async () => {
    await check(extend, "Ctrl+Alt+Shift+Backspace");
    await check("Forward", "Alt+→");
  };
  await verify();
  await window.setViewportSize({ width: 600, height: 400 });
  await verify();
  await options.getByRole("button", { name: "Clear shortcut for Forward", exact: true }).click();
  assert.equal(await lookup("Forward").innerText(), "Unassigned");
  await closeToolWindow(window);
  console.log("Verified long shortcut labels fit at normal and minimum Options width and Clear stays usable.");
}
