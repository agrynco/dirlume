import assert from "node:assert/strict";

export async function testShortcutFields(page) {
  await page.getByRole("button", { name: "Options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Options", exact: true });
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
  const verify = async () => {
    await check("Extend selection down", "Shift+ArrowDown");
    await check("Forward", "Alt+ArrowRight");
  };
  await verify();
  const grip = options.getByRole("button", { name: "Resize Options", exact: true });
  for (let index = 0; index < 24; index++) await grip.press("ArrowLeft");
  await verify();
  await options.getByRole("button", { name: "Clear shortcut for Forward", exact: true }).click();
  assert.equal(await lookup("Forward").innerText(), "Unassigned");
  await options.getByRole("button", { name: "Close dialog", exact: true }).click();
  console.log("Verified long shortcut labels fit at normal and minimum Options width and Clear stays usable.");
}
