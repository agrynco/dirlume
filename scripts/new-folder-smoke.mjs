import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testNewFolder({ page, startDesktop, exitDesktop, root }) {
  const source = join(root, "new-folder-fixture");
  const target = join(source, "link-target");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "contents.txt"), "linked contents");
  await writeFile(join(source, "existing"), "keep me");

  const dialog = () => page.getByRole("dialog", { name: "New folder", exact: true });
  const name = () => dialog().getByLabel("Name", { exact: true });
  const create = () => dialog().getByRole("button", { name: "Create", exact: true }).click();
  const entry = (name) => page.locator("#left-files").getByRole("option").and(page.getByTitle(name, { exact: true }));
  const lastSelected = (name) => entry(name).and(page.locator("[data-current='true']")).waitFor();
  async function open() {
    await page.locator("#left-files").focus();
    await page.keyboard.press("F7");
    await name().waitFor();
    assert.equal(await name().evaluate((field) => document.activeElement === field), true);
  }
  async function batch(input) {
    await dialog().getByRole("checkbox", { name: "Process multiple names" }).check();
    await name().fill(input);
    await create();
  }

  const address = page.getByLabel("left path", { exact: true });
  await address.fill(source);
  await address.press("Enter");
  await entry("link-target").click();

  // The earlier shortcut test remaps New folder to F12.
  await page.getByRole("button", { name: "Options", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Options", exact: true });
  await settings.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await settings.getByLabel("Change shortcut for New folder", { exact: true }).click();
  await settings.getByLabel("New shortcut for New folder", { exact: true }).press("F7");
  await settings.getByRole("button", { name: "Done", exact: true }).click();

  await open();
  await name().fill("escape-cancelled");
  await name().press("Escape");
  await dialog().waitFor({ state: "hidden" });
  await assert.rejects(stat(join(source, "escape-cancelled")), { code: "ENOENT" });

  await page.getByRole("button", { name: "New folder", exact: false }).click();
  assert.equal(await dialog().getByLabel("Link type", { exact: true }).inputValue(), "none");
  await name().fill("single-folder");
  await create();
  await dialog().waitFor({ state: "hidden" });
  await lastSelected("single-folder");
  assert.ok((await stat(join(source, "single-folder"))).isDirectory());

  const names = 'first, "comma,name"; "semicolon;name"; last';
  await open();
  await batch(names);
  await dialog().waitFor({ state: "hidden" });
  for (const item of ["first", "comma,name", "semicolon;name", "last"]) {
    assert.ok((await stat(join(source, item))).isDirectory());
  }
  await lastSelected("last");

  await open();
  await batch("duplicate; duplicate");
  await dialog().getByRole("alert").filter({ hasText: "Folder names must be unique." }).waitFor();
  await assert.rejects(stat(join(source, "duplicate")), { code: "ENOENT" });
  await name().fill("partial; existing; never-created");
  await create();
  await dialog().getByRole("alert").filter({ hasText: "Could not create existing." }).waitFor();
  await lastSelected("partial");
  assert.equal(await readFile(join(source, "existing"), "utf8"), "keep me");
  await assert.rejects(stat(join(source, "never-created")), { code: "ENOENT" });
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();

  await open();
  await dialog().getByLabel("Link type", { exact: true }).selectOption("junction");
  const destination = () => dialog().getByRole("combobox", { name: "Target", exact: true });
  await destination().fill("link-ta");
  const suggestion = dialog().getByRole("listbox").getByRole("option", { name: "link-target", exact: true });
  await suggestion.click();
  assert.equal(await destination().inputValue(), "link-target");
  await batch("junction-a; junction-b");
  await dialog().waitFor({ state: "hidden" });
  await lastSelected("junction-b");
  for (const item of ["junction-a", "junction-b"]) {
    assert.equal(await readFile(join(source, item, "contents.txt"), "utf8"), "linked contents");
  }

  await open();
  await name().fill("symlink");
  await dialog().getByLabel("Link type", { exact: true }).selectOption("symbolic");
  await destination().fill(target);
  await create();
  const outcome = await Promise.race([
    dialog().waitFor({ state: "hidden" }).then(() => "created"),
    dialog().getByRole("alert").waitFor().then(() => "error"),
  ]);
  if (outcome === "created") {
    assert.equal(await readFile(join(source, "symlink", "contents.txt"), "utf8"), "linked contents");
  } else {
    assert.match(await dialog().getByRole("alert").innerText(), /1314|privilege|access is denied/i);
    await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  }

  await exitDesktop(page);
  page = await startDesktop();
  await entry("junction-b").waitFor();
  await open();
  await name().press("Alt+ArrowDown");
  const history = dialog().getByRole("listbox", { name: "Folder name history", exact: true });
  await history.getByRole("group").first().waitFor();
  await history.getByRole("option", { name: names, exact: true }).click();
  assert.equal(await name().inputValue(), names);
  await name().press("Alt+ArrowDown");
  await history.waitFor();
  await page.keyboard.press("Escape");
  await history.waitFor({ state: "hidden" });
  await dialog().waitFor();
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  console.log(`Verified F7 folder batches, target completion, junctions, history persistence, and symbolic-link outcome: ${outcome}.`);
  return page;
}
