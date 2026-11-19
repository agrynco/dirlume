import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function testNewFileEncoding(page, root) {
  const fileList = page.getByRole("listbox", { name: "left files", exact: true });
  const dialog = page.getByRole("dialog", { name: "New file", exact: true });
  const nameField = dialog.getByLabel("Name", { exact: true });
  const encodingField = dialog.getByLabel("Encoding", { exact: true });
  const create = () => dialog.getByRole("button", { name: "Create", exact: true }).click();
  const cases = [
    ["utf8", [], (text) => Buffer.from(text)],
    ["utf8_bom", [0xef, 0xbb, 0xbf], (text) => Buffer.from(text)],
    ["utf16_le", [0xff, 0xfe], (text) => Buffer.from(text, "utf16le")],
    ["utf16_be", [0xfe, 0xff], (text) => Buffer.from(text, "utf16le").swap16()],
  ];

  async function openNewFile(fromMenu = false) {
    await fileList.focus();
    if (fromMenu) {
      const bar = page.getByRole("menubar", { name: "Main menu", exact: true });
      await bar.getByRole("menuitem", { name: "Files", exact: true }).click();
      await bar.getByRole("menu", { name: "Files", exact: true }).getByRole("menuitem", { name: "New file", exact: true }).click();
    } else await fileList.press("Shift+F4");
    await dialog.waitFor();
  }

  for (const [encoding, bom, encode] of cases) {
    const name = `${encoding}.txt`;
    const target = join(root, name);
    const status = encoding.replaceAll("_", " ").toUpperCase();
    await openNewFile(encoding === "utf8_bom");
    assert.equal(await encodingField.inputValue(), "utf8");
    await nameField.fill(name);
    if (encoding !== "utf8") await encodingField.selectOption(encoding);
    await create();
    const document = page.getByRole("region", { name, exact: true });
    const editor = document.getByRole("textbox", { name: `Edit ${name}`, exact: true });
    await document.getByText(status, { exact: true }).waitFor();
    assert.deepEqual(await readFile(target), Buffer.from(bom));
    let last;
    for (const text of ["Привіт, 世界 🦊", "Другий запис ✓"]) {
      await editor.fill(text);
      await document.getByText(`${status} · Modified`, { exact: true }).waitFor();
      await editor.press("F2");
      await document.getByText(status, { exact: true }).waitFor();
      last = Buffer.concat([Buffer.from(bom), encode(text)]);
      assert.deepEqual(await readFile(target), last);
    }
    await page.keyboard.press("Escape");
    await document.waitFor({ state: "hidden" });
    await fileList.locator(`[title="${name}"]`).click();
    await page.keyboard.press("F4");
    await document.getByText(status, { exact: true }).waitFor();
    assert.match(await editor.innerText(), /Другий запис ✓/);
    await page.keyboard.press("Escape");
    await document.waitFor({ state: "hidden" });
    if (encoding === "utf16_be") {
      await openNewFile();
      await nameField.fill(name);
      await encodingField.selectOption("utf8_bom");
      await create();
      await dialog.getByRole("alert").waitFor();
      assert.deepEqual(await readFile(target), last);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  }

  await openNewFile();
  await nameField.fill("cancelled.txt");
  await encodingField.selectOption("utf16_le");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await assert.rejects(readFile(join(root, "cancelled.txt")), { code: "ENOENT" });
  console.log("Verified all new-file encodings, the bytes on disk, preservation on save, reopening, and cancellation.");
}
