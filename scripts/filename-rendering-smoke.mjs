import { editPaneAddress } from "./pane-address-smoke.mjs";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function testFilenameRendering(page, root) {
  const folder = join(root, "filename-rendering-fixture");
  await mkdir(folder);
  const sample = "Invoice №123 (Example Holding OÜ,Sample Name) (1).pdf";
  const forms = [sample, sample.normalize("NFD")];
  for (const name of forms) await writeFile(join(folder, name), "");
  assert.deepEqual(new Set(await readdir(folder)), new Set(forms));
  const address = await editPaneAddress(page);
  await address.fill(folder);
  await address.press("Enter");
  const pane = page.getByRole("region", { name: "left pane", exact: true });
  await pane.getByRole("heading", { name: "filename-rendering-fixture", exact: true }).waitFor({ state: "attached" });
  const rows = pane.getByRole("option");
  const nameField = (name) => rows.and(pane.locator("[data-tooltip=" + JSON.stringify(name) + "]")).locator(".file-name > span");
  const dimensions = (name, selected) => nameField(name).evaluate((field, selected) => {
    const range = document.createRange();
    range.selectNodeContents(field);
    const { fontFamily, fontSize, textOverflow, direction } = getComputedStyle(field);
    return {
      content: field.textContent,
      width: range.getBoundingClientRect().width,
      visibleWidth: field.clientWidth,
      overflowing: field.scrollWidth > field.clientWidth,
      fontFamily, fontSize, textOverflow, direction,
      selected: field.closest('[role="option"]').getAttribute("data-current") === "true",
      expected: selected,
    };
  }, selected);
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  const resize = pane.getByRole("separator", { name: "Resize Name column", exact: true });
  for (let attempt = 0; attempt < 128; attempt++) {
    const names = await Promise.all(forms.map((form) => dimensions(form, false)));
    if (names.every(({ overflowing }) => !overflowing)) break;
    await resize.press("ArrowRight");
  }
  for (let index = 0; index < forms.length; index++) {
    await rows.and(pane.locator("[data-tooltip=" + JSON.stringify(forms[index]) + "]")).click();
    const values = await Promise.all(forms.map((form, other) => dimensions(form, other === index)));
    for (const value of values) {
      assert.equal(value.fontSize, "15px");
      assert.match(value.fontFamily, /GoMono Nerd Font Mono/);
      assert.equal(value.selected, value.expected);
      assert.equal(value.content, sample);
      assert.equal(value.textOverflow, "ellipsis");
      assert.equal(value.direction, "ltr");
      assert.equal(value.overflowing, false, `The ${value.width}px filename should fit in ${value.visibleWidth}px.`);
    }
    assert.ok(Math.abs(values[0].width - values[1].width) < 0.5);
    if (process.env.DIRLUME_FILENAME_SCREENSHOTS) {
      const areas = await Promise.all(forms.map((form) => nameField(form).screenshot({ scale: "css" })));
      for (let other = 0; other < forms.length; other++) {
        await writeFile(join(process.env.DIRLUME_FILENAME_SCREENSHOTS, `filename-${index}-${other}.png`), areas[other]);
      }
    }
  }
  for (let attempt = 0; attempt < 128 && !(await dimensions(forms[1], true)).overflowing; attempt++) {
    await resize.press("ArrowLeft");
  }
  assert.equal((await dimensions(forms[1], true)).overflowing, true);
  if (process.env.DIRLUME_FILENAME_SCREENSHOTS) {
    await nameField(forms[1]).screenshot({ path: join(process.env.DIRLUME_FILENAME_SCREENSHOTS, "filename-ellipsis.png"), scale: "css" });
  }
  await resize.dblclick();
  console.log("Verified precomposed and decomposed names, selection, and end ellipsis using the bundled 15px file-panel font.");
}
