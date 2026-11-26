import { closeToolWindow, openOptionsWindow } from "./tool-window-smoke.mjs";
import assert from "node:assert/strict";

export async function verifyShortcutCapture(options, label = "Distinguish left and right Ctrl") {
  const search = options.locator(".settings-sidebar input[type=search]");
  await search.fill("ins");
  await options.locator('[data-add-shortcut="pickerAddFolder"]').click();
  const capture = options.locator("[data-shortcut-capture]");
  const checkbox = options.getByRole("checkbox", { name: label, exact: true });
  await capture.waitFor();
  assert.ok(await checkbox.evaluate((box) => {
    const label = box.nextElementSibling.firstChild;
    const inputBounds = box.getBoundingClientRect();
    const captureBounds = box.closest(".shortcut-capture").getBoundingClientRect();
    const range = document.createRange();
    const wholeWords = [...label.textContent.matchAll(/\S+/g)].every((word) => {
      range.setStart(label, word.index);
      range.setEnd(label, word.index + word[0].length);
      return range.getClientRects().length === 1;
    });
    return inputBounds.width > 0 && inputBounds.width <= 24 && captureBounds.width > 80 && wholeWords;
  }), "The Ctrl checkbox keeps its intrinsic width and its label wraps at word boundaries.");
  await capture.press("Tab");
  assert.ok(await checkbox.evaluate((element) => element === document.activeElement));
  await checkbox.press("Space");
  assert.ok(await checkbox.isChecked());
  await capture.press("Escape");
  await capture.waitFor({ state: "hidden" });
  await search.clear();
}

export async function testShortcutFields(page) {
  const window = await openOptionsWindow(page);
  const options = window.getByRole("dialog", { name: "Options", exact: true });
  await options.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const lookup = (command, shortcut) => options.getByRole("button", { name: `Change ${shortcut} for ${command}`, exact: true });
  const remove = (command, shortcut) => options.getByRole("button", { name: `Remove ${shortcut} from ${command}`, exact: true });
  const check = async (command, shortcut) => {
    const button = lookup(command, shortcut);
    assert.equal(await button.innerText(), shortcut);
    assert.equal(await button.evaluate((field) => {
      const range = document.createRange();
      range.selectNodeContents(field.querySelector("span"));
      const { left, right } = field.getBoundingClientRect();
      return [...range.getClientRects()].every((text) => text.left >= left && text.right <= right);
    }), true, command + " overflows its shortcut field");
    assert.equal(await remove(command, shortcut).isEnabled(), true);
  };
  const extend = "Extend selection down";
  await check(extend, "Shift+↓");
  await check("Forward", "Alt+→");
  await lookup(extend, "Shift+↓").click();
  await options.getByRole("textbox", { name: "New shortcut to replace Shift+↓ for " + extend, exact: true }).press("Control+Alt+Shift+Backspace");
  const verify = async () => {
    await check(extend, "Ctrl+Alt+Shift+Backspace");
    await check("Forward", "Alt+→");
  };
  await verify();
  await verifyShortcutCapture(options);
  await window.setViewportSize({ width: 600, height: 400 });
  await verify();
  await verifyShortcutCapture(options);
  await remove("Forward", "Alt+→").click();
  assert.equal(await lookup("Forward", "Alt+→").count(), 0);
  assert.equal(await options.getByRole("button", { name: "Add shortcut for Forward", exact: true }).isEnabled(), true);
  await closeToolWindow(window);
  console.log("Verified long shortcut labels fit at normal and minimum Options width and the remove button stays usable.");
}
