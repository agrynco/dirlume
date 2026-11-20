import { editPaneAddress } from "./pane-address-smoke.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export async function testArchives(page, root) {
  const source = join(root, "archive-source");
  const destination = join(root, "archive-output");
  await mkdir(join(source, "folder"), { recursive: true });
  await mkdir(destination);
  await writeFile(join(source, "folder", "note.txt"), "archived text");
  await writeFile(join(source, "folder", "keep.txt"), "unrelated text");

  for (const [side, path] of [["left", source], ["right", destination]]) {
    const list = page.locator(`#${side}-files[aria-busy="false"]`);
    await list.waitFor();
    const address = await editPaneAddress(page, side);
    await address.fill(path);
    await address.press("Enter");
    await page.getByRole("region", { name: `${side} pane`, exact: true })
      .getByRole("heading", { name: basename(path), exact: true }).waitFor({ state: "attached" });
    await list.waitFor();
  }
  const left = page.locator("#left-files");
  async function returnToFiles() {
    // Closing a viewer can return to a document opened by an earlier smoke test.
    const filesTab = page.getByRole("navigation", { name: "Open documents", exact: true })
      .getByRole("button", { name: "Files", exact: true });
    if (await filesTab.isVisible()) await filesTab.click();
    await left.waitFor();
  }
  const row = (name) => left.getByRole("option").and(page.locator("[data-tooltip=" + JSON.stringify(name) + "]"));
  const badge = (name) => page.locator("[data-tooltip=" + JSON.stringify(name) + "]").filter({ hasText: name });
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const button = (parent, name) => parent.getByRole("button", { name, exact: true });
  const parentFolder = () => button(page.getByRole("region", { name: "left pane", exact: true }), "Parent folder").click();
  const options = dialog("Create archive");
  async function archive(format, filename) {
    await row("folder").click();
    await page.keyboard.press("Shift+F1");
    await options.getByLabel("Archive path", { exact: true }).fill(filename);
    await options.getByLabel("Format", { exact: true }).selectOption(format);
  }
  await archive("zip", "fixture");
  await button(options, "Create").click();
  await options.waitFor({ state: "hidden" });
  await row("fixture.zip").waitFor();
  const before = await readFile(join(source, "fixture.zip"));

  await archive("zip", "fixture");
  await button(options, "Create").click();
  await button(dialog("Replace archive?"), "Cancel").click();
  await button(options, "Cancel").click();
  assert.deepEqual(await readFile(join(source, "fixture.zip")), before);

  await row("fixture.zip").dblclick();
  await badge("Archive").waitFor();
  await row("folder").click();
  await page.keyboard.press("F5");
  await button(dialog("Copy"), "Copy").click();
  await page.locator("dialog[open]").first().waitFor({ state: "hidden" });
  await page.locator(".statusbar").getByText("Transfer complete", { exact: true }).waitFor();
  assert.equal(await readFile(join(destination, "folder", "note.txt"), "utf8"), "archived text");

  await row("folder").dblclick();
  await row("note.txt").click();
  await page.keyboard.press("F3");
  const document = page.getByRole("region", { name: "note.txt", exact: true });
  await document.getByText("archived text", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await document.waitFor({ state: "hidden" });
  await returnToFiles();
  await row("note.txt").click();
  await page.keyboard.press("F4");
  const editor = document.getByLabel("Edit note.txt");
  await editor.fill("updated in archive");
  await editor.press("F2");
  await document.locator(".document-encoding").filter({ hasText: /^UTF8$/ }).waitFor();
  await button(document, "Close document").click();
  await returnToFiles();
  await row("keep.txt").click();
  await page.keyboard.press("F8");
  await button(dialog("Delete permanently"), "Delete permanently").click();
  await row("keep.txt").waitFor({ state: "detached" });
  assert.notDeepEqual(await readFile(join(source, "fixture.zip")), before);

  await parentFolder();
  await row("folder").waitFor();
  await parentFolder();
  await badge("Archive").waitFor({ state: "hidden" });
  await row("fixture.zip").dblclick();
  await badge("Archive").waitFor();
  await row("folder").dblclick();
  await row("note.txt").click();
  await page.keyboard.press("F3");
  await document.getByText("updated in archive", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await document.waitFor({ state: "hidden" });
  await returnToFiles();
  assert.equal(await row("keep.txt").count(), 0);
  for (let index = 0; index < 2; index++) {
    await parentFolder();
    await row(index ? "fixture.zip" : "folder").waitFor();
  }

  const password = "archive-test-secret";
  await archive("7z", "encrypted");
  await options.getByRole("checkbox", { name: "Encrypt archive", exact: true }).check();
  await options.getByLabel("Password", { exact: true }).fill(password);
  await options.getByLabel("Confirm password", { exact: true }).fill(password);
  await options.getByRole("checkbox", { name: "Encrypt headers", exact: true }).check();
  await options.getByLabel("Profile name", { exact: true }).fill("Encrypted test");
  await button(options, "Save profile").click();
  await button(options, "Create").click();
  await options.waitFor({ state: "hidden" });
  assert.ok((await stat(join(source, "encrypted.7z"))).size > 0);
  assert.equal(await page.evaluate((secret) => JSON.stringify(localStorage).includes(secret), password), false);
  await row("encrypted.7z").dblclick();
  const unlock = dialog("Archive password");
  await unlock.getByLabel("Password", { exact: true }).fill("wrong");
  await button(unlock, "Open").click();
  await unlock.getByRole("alert").waitFor();
  await unlock.getByLabel("Password", { exact: true }).fill(password);
  await button(unlock, "Open").click();
  await unlock.waitFor({ state: "hidden" });
  await badge("Read-only archive").waitFor();
  await row("folder").dblclick();
  await row("note.txt").click();
  await page.keyboard.press("F3");
  await document.getByText("archived text", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await document.waitFor({ state: "hidden" });
  await returnToFiles();
  for (let depth = 0; depth < 2; depth++) {
    await parentFolder();
    await row(depth ? "encrypted.7z" : "folder").waitFor();
  }
  console.log("Verified ZIP creation, overwrite cancellation, copying, editing, removal, and encrypted 7z browsing with the Windows desktop app.");
}
