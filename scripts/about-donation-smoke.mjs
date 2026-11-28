import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const destination = "https://send.monobank.ua/jar/6ZninEa3R4";
const creatorUrl = "https://hrynco.com/";
const platforms = {
  windows: "Windows NT 10.0; Win64; x64",
  ubuntu: "X11; Linux x86_64",
  macos: "Macintosh; Intel Mac OS X 10_15_7",
};
const copy = {
  en: { menu: "Main menu", help: "Help", about: "About", donate: "Donate via monobank", close: "Close" },
  uk: { menu: "Головне меню", help: "Довідка", about: "Про програму", donate: "Підтримати через monobank", close: "Закрити" },
  ru: { menu: "Главное меню", help: "Справка", about: "О программе", donate: "Поддержать через monobank", close: "Закрыть" },
};

async function fixture(browser, platform, language = "en", enlarged = false) {
  const viewport = enlarged ? { width: 340, height: 760 } : { width: 760, height: 720 };
  const page = await browser.newPage({ viewport, userAgent: `Mozilla/5.0 (${platforms[platform]})`, locale: "en-US" });
  page.setDefaultTimeout(8000);
  await page.route("http://dirlume.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ path: resolve("dist", path === "/" ? "index.html" : "." + path) });
  });
  await page.addInitScript(({ windows, language, enlarged }) => {
    const path = windows ? "C:\\fixture" : "/fixture";
    const file = { name: "some-file.txt", directory: false, hidden: false, link: false, size: 7, modified: null };
    localStorage.setItem("dirlume.preferences.v1", JSON.stringify({ language, theme: "dark", showTitlebarScheme: !enlarged,
      activeScheme: enlarged ? "large-dialog" : null, schemes: enlarged
        ? [{ id: "large-dialog", name: "Large dialogs", base: "dark", fonts: { dialog: { size: 24 } } }] : [] }));
    window.isTauri = true;
    window.donationRequests = [];
    window.windowControls = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command === "locations") return [{ label: "Home", path }];
        if (command === "list_directory") return { path, parent: null, entries: [file], omitted: 0 };
        if (command === "file_icons") return args.items.map(() => null);
        if (command === "build_version") return "0.1.22-fixture";
        if (command === "open_web_link") window.donationRequests.push(args.href);
        if (command === "plugin:window|toggle_maximize") window.windowControls.push(command);
        if (command === "plugin:window|is_maximized") return false;
        return null;
      },
    };
  }, { windows: platform === "windows", language, enlarged });
  await page.goto("http://dirlume.test/");
  await page.locator("#left-files").getByText("some-file").waitFor();
  return page;
}

async function openAbout(page, { menu, help, about, close }) {
  const menubar = page.getByRole("menubar", { name: menu, exact: true });
  if (!await menubar.isVisible()) await page.keyboard.press("F9");
  await menubar.getByRole("menuitem", { name: help, exact: true }).click();
  await menubar.getByRole("menuitem", { name: about, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: about, exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("button", { name: close, exact: true }).evaluate((button) => button === document.activeElement), true);
  return dialog;
}

async function colors(button) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    const icon = getComputedStyle(element.querySelector("svg")).color;
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgb = (color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const luminance = (color) => rgb(color).map((value) => value / 255).map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const contrast = (color) => {
      const [foreground, background] = [luminance(color), luminance(style.backgroundColor)].sort((a, b) => b - a);
      return (foreground + 0.05) / (background + 0.05);
    };
    return { label: contrast(style.color), icon: contrast(icon), iconRgb: rgb(icon), background: style.backgroundColor, border: style.borderColor };
  });
}

async function checkFooter(dialog, labels, enlarged) {
  const donation = dialog.getByRole("button", { name: labels.donate, exact: true });
  const close = dialog.getByRole("button", { name: labels.close, exact: true });
  const footer = dialog.locator(".dialog-footer");
  assert.equal(await footer.getByRole("button").count(), 2);
  assert.equal(await dialog.locator(".about-actions button").count(), 4);
  assert.equal(await footer.getByRole("button").first().textContent(), labels.donate);
  const [bounds, leading, trailing] = await Promise.all([footer.boundingBox(), donation.boundingBox(), close.boundingBox()]);
  assert.ok(leading.x - bounds.x <= 17, "Donation should sit on the leading edge of the footer.");
  assert.ok(bounds.x + bounds.width - trailing.x - trailing.width <= 17, "Close should sit on the trailing edge of the footer.");
  assert.ok(leading.x + leading.width <= trailing.x || leading.y + leading.height <= trailing.y);
  assert.ok(leading.x + leading.width <= bounds.x + bounds.width && trailing.x >= bounds.x);
  assert.equal(await footer.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await donation.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  if (enlarged) assert.equal(await dialog.evaluate((node) => getComputedStyle(node).fontSize), "24px");
  return { donation, close };
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  const themes = ["dark", "light", "classic-blue", "lavender", "emerald", "midnight", "sunrise", "system"];
  const english = copy.en;
  for (const platform of Object.keys(platforms)) {
    const page = await fixture(browser, platform);
    const titlebar = page.locator(".topbar");
    const top = titlebar.getByRole("button", { name: english.donate, exact: true });
    const select = titlebar.getByRole("combobox", { name: "Color scheme", exact: true });
    assert.equal(await top.getAttribute("data-tooltip"), english.donate);
    assert.equal(await top.getAttribute("data-tauri-drag-region"), "false");
    assert.equal(await top.evaluate((node) => node.parentElement.firstElementChild === node), true);
    assert.equal(await titlebar.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    if (platform === "windows") {
      assert.equal(await titlebar.getAttribute("data-tauri-drag-region"), "deep");
      await titlebar.getByRole("button", { name: "Maximize window", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.windowControls), ["plugin:window|toggle_maximize"]);
    }
    await top.hover();
    await page.getByRole("tooltip").getByText(english.donate, { exact: true }).waitFor();
    await top.click();
    await page.waitForFunction(() => window.donationRequests.length === 1);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.ok(await top.evaluate((node) => node === document.activeElement && node.matches(":focus-visible")));
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.donationRequests.length === 2);
    for (const theme of platform === "windows" ? themes : ["dark", "light"]) {
      await select.selectOption(theme);
      const topColors = await colors(top);
      assert.ok(topColors.icon >= 3, `${platform} ${theme} title-bar icon contrast ${topColors.icon}`);
      const dialog = await openAbout(page, english);
      const { donation, close } = await checkFooter(dialog, english, false);
      const footerColors = await colors(donation);
      const closeColors = await colors(close);
      assert.ok(footerColors.label >= 4.5, `${platform} ${theme} donation label contrast ${footerColors.label}`);
      assert.ok(footerColors.icon >= 3, `${platform} ${theme} donation icon contrast ${footerColors.icon}`);
      assert.notEqual(footerColors.background, closeColors.background);
      assert.notEqual(footerColors.border, closeColors.border);
      if (theme === "dark") {
        const [red, green, blue] = footerColors.iconRgb;
        assert.ok(red > green && green > blue, "The default dark scheme uses a warm amber icon.");
        await page.keyboard.press("Shift+Tab");
        assert.ok(await donation.evaluate((node) => node === document.activeElement && node.matches(":focus-visible")));
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => window.donationRequests.length === 3);
        assert.deepEqual(await page.evaluate(() => window.donationRequests), [destination, destination, destination]);
        const creator = dialog.getByRole("link", { name: "Anatolii Hrynchuk", exact: true });
        assert.equal(await creator.getAttribute("href"), creatorUrl);
        await creator.click();
        await dialog.getByRole("link", { name: "MIT", exact: true }).focus();
        await page.keyboard.press("Shift+Tab");
        assert.equal(await creator.evaluate((element) => element === document.activeElement), true);
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => window.donationRequests.length === 5);
        assert.deepEqual(await page.evaluate(() => window.donationRequests.slice(3)), [creatorUrl, creatorUrl]);
      }
      await close.click();
      await dialog.waitFor({ state: "hidden" });
    }
    await page.close();
  }
  for (const [language, labels] of Object.entries(copy)) {
    const page = await fixture(browser, "ubuntu", language, true);
    const dialog = await openAbout(page, labels);
    assert.equal(await dialog.getByRole("link", { name: "Anatolii Hrynchuk", exact: true }).getAttribute("href"), creatorUrl);
    await checkFooter(dialog, labels, true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.close();
  }
  console.log("Verified donation styling, contrast, focus, both browser entry points, title-bar controls, and enlarged localized About footers.");
} finally {
  await browser.close();
}
