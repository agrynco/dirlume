import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const sharing = (page) => page.getByRole("dialog", { name: "Share a folder", exact: true });

async function connectDialog(page) {
  await button(page.locator(".topbar"), "Connect").click();
  const provider = page.getByRole("dialog", { name: "Connect through KSwitcher", exact: true });
  const dialog = page.getByRole("dialog", { name: "Connect to Dirlume server", exact: true });
  await dialog.or(provider).waitFor();
  if (await provider.isVisible()) await button(provider, "Use a Dirlume invitation").click();
  await dialog.waitFor();
  return dialog;
}

export async function testDesktopShare(host, root, guest = host) {
  const folder = join(root, "shared folder ł");
  await mkdir(join(folder, "nested"), { recursive: true });
  await writeFile(join(folder, "nested", "shared.txt"), "Shared from the desktop");
  const hostConnect = await connectDialog(host);
  await button(hostConnect, "Share a folder").click();
  const dialog = sharing(host);
  await dialog.getByRole("combobox", { name: "Folder to share", exact: true }).fill(folder);
  const address = dialog.getByRole("textbox", { name: "Local network IP address", exact: true });
  await address.fill("203.0.113.1");
  await button(dialog, "Start sharing").click();
  await dialog.getByRole("alert").getByText("Enter a local network IP address.").waitFor();
  await address.fill("127.0.0.1");
  await button(dialog, "Start sharing").click();
  await button(dialog, "Copy invitation").waitFor();
  const invitation = await host.evaluate(async () => {
    const share = await window.__TAURI_INTERNALS__.invoke("active_desktop_share");
    return share?.invitation;
  });
  assert.ok(invitation?.startsWith("dirlume-v1:"));
  await button(dialog, "Close dialog").click();
  await hostConnect.waitFor();
  await button(hostConnect, "Close dialog").click();

  const right = guest.locator("#right-files");
  await right.focus();
  const guestConnect = await connectDialog(guest);
  const credential = guestConnect.getByLabel("Server invitation", { exact: true });
  await credential.fill("invalid invitation");
  await button(guestConnect, "Connect").click();
  await guestConnect.getByRole("alert").getByText("Enter a valid Dirlume server invitation.").waitFor();
  await credential.fill(invitation);
  await button(guestConnect, "Connect").click();
  await right.getByRole("option", { name: /^nested/ }).dblclick();
  await right.getByRole("option", { name: /^shared\.txt/ }).click();
  await right.press("F3");
  await guest.getByText("Shared from the desktop", { exact: true }).waitFor();
  await guest.keyboard.press("Escape");

  await button(await connectDialog(host), "Share a folder").click();
  await button(dialog, "Stop sharing").click();
  await button(dialog, "Start sharing").waitFor();
  assert.equal(await host.evaluate(() => window.__TAURI_INTERNALS__.invoke("active_desktop_share")), null);
  await button(dialog, "Close dialog").click();
  await hostConnect.waitFor();
  await button(hostConnect, "Close dialog").click();
  const revoked = await connectDialog(guest);
  await revoked.getByLabel("Server invitation", { exact: true }).fill(invitation);
  await button(revoked, "Connect").click();
  await revoked.getByRole("alert").waitFor();
  await button(revoked, "Close dialog").click();
  await right.waitFor();
  console.log("Verified desktop share setup, guest invitation and read-only browsing, and revocation.");
}
