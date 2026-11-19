async (upgraded, reject) => {
  async function waitFor(read) {
    for (let attempt = 0; attempt < 450; attempt++) {
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The updater screen did not reach its expected state.");
  }

  const report = (error) => window.__TAURI_INTERNALS__.invoke("updater_fixture_result", { error });
  const preferenceKey = "dirlume.preferences.v1";
  try {
    if (upgraded) {
      await waitFor(() => document.querySelector("#left-pane")?.style.getPropertyValue("--view-font-size") === "23px");
      const updates = await waitFor(() => {
        const commands = [...document.querySelectorAll(".main-menu [data-menu-group]")].find((button) => button.textContent === "Commands");
        if (commands?.getAttribute("aria-expanded") === "false") commands.click();
        return [...document.querySelectorAll(".main-menu [data-menu-item]")].find((button) => button.textContent === "Check for updates");
      });
      updates.click();
      await waitFor(() => [...document.querySelectorAll("dialog[open] p")].some((text) => text.textContent === "Dirlume is up to date."));
      await report(null);
      return;
    }
    const install = await waitFor(() => [...document.querySelectorAll("dialog[open] button")]
      .find((button) => button.textContent === "Install and restart"));
    const preferences = JSON.parse(localStorage.getItem(preferenceKey) ?? "{}");
    preferences.viewFontSizes = { ...preferences.viewFontSizes, left: 23 };
    localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    install.click();
    // The signed candidate restarts the app. A rejected candidate leaves the old version running.
    const error = await waitFor(() => document.querySelector(".statusbar [role=alert]")?.textContent);
    if (reject && error === "Could not download, verify, or install the update. Try again.") await report(null);
    else await report(error);
  } catch (error) {
    await report(String(error));
  }
}
