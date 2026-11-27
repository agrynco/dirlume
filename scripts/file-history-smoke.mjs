import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 560 } });
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(() => {
    let undone = false;
    const item = { id: 7, moving: true, source: "/fixture/from", destination: "/fixture/to",
      time: Date.now(), rows: [{ source: "/fixture/from/note.txt", destination: "/fixture/to/note.txt", outcome: "completed" }] };
    const history = (changed = false) => ({ entries: [{ ...item, outcome: undone ? "undone" : "completed" }],
      undo: undone ? null : item.id, redo: undone ? item.id : null, pending: null, changed });
    window.historyCommands = [];
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command, args) => {
        switch (command) {
          case "locations": return [{ label: "Home", path: "/fixture" }];
          case "list_directory": return { path: args.path, parent: null, entries: [], omitted: 0 };
          case "file_operation_history": return history();
          case "reverse_file_operation":
            if (args.expected !== item.id) throw Error("Wrong operation");
            window.historyCommands.push(args.direction);
            undone = args.direction === "undo";
            return history(true);
          default: return null;
        }
      },
    };
  });
  await page.goto("http://dirlume.test/");
  async function openCommand(label) {
    const menu = page.getByRole("menubar", { name: "Main menu" });
    await menu.getByRole("menuitem", { name: "Commands", exact: true }).click();
    await menu.getByRole("menuitem", { name: label, exact: true }).click();
  }
  await openCommand("File operation history");
  const dialog = page.getByRole("dialog", { name: "File operation history" });
  await dialog.getByText("/fixture/to/note.txt", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Undo file operation", exact: true }).click();
  await dialog.getByRole("option").filter({ hasText: "Undone" }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Undo file operation", exact: true }).isDisabled(), true);
  assert.equal(await dialog.locator(".file-operation-history").evaluate((body) => body.scrollWidth <= body.clientWidth), true);
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await openCommand("Redo file operation");
  await dialog.getByRole("option").filter({ hasText: "Completed" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.historyCommands), ["undo", "redo"]);
  console.log("Verified file history details, Undo, Redo, and dialog width.");
} finally {
  await browser.close();
}
