async (upgraded, reject, portable, replacementFailure, terminalPaste) => {
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
  async function checkTerminalPaste() {
    document.querySelector(".command-bar > button").click();
    const terminal = await waitFor(() => document.querySelector(".terminal-card:not([hidden]) .terminal-surface"));
    const input = await waitFor(() => terminal.querySelector(".xterm-helper-textarea"));
    const screen = () => terminal.querySelector(".xterm-accessibility-tree")?.textContent ?? "";
    await waitFor(() => screen().trim());
    input.focus();
    await window.__TAURI_INTERNALS__.invoke("copy_path", { path: "DirlumeClipboardA" });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true }));
    await waitFor(() => screen().includes("DirlumeClipboardA"));
    await window.__TAURI_INTERNALS__.invoke("copy_path", { path: "DirlumeClipboardB" });
    terminal.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true }));
    await waitFor(() => screen().includes("DirlumeClipboardADirlumeClipboardB"));
    if (screen().split("DirlumeClipboardA").length !== 2 || screen().split("DirlumeClipboardB").length !== 2) {
      throw new Error("Terminal clipboard text was inserted more than once.");
    }
    terminal.closest(".terminal-card").querySelector('button[aria-label="Close terminal"]').click();
  }
  async function checkTooltip(control, expected) {
    const pointer = (type) => control.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));
    pointer("pointerover");
    if (expected) {
      await waitFor(() => document.getElementById("dirlume-tooltip")?.textContent === expected);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 525));
      if (document.getElementById("dirlume-tooltip")) throw new Error("The visible SSH label and shortcut showed a redundant tooltip.");
    }
    pointer("pointerout");
  }
  try {
    if (upgraded) {
      await waitFor(() => document.querySelector("#left-pane")?.style.getPropertyValue("--view-font-size") === "23px");
      await waitFor(() => document.querySelector('.topbar[data-menu-position="right"]') &&
        JSON.parse(localStorage.getItem(preferenceKey) ?? "{}").mainMenuAlignment === "right");
      const resize = await waitFor(() => document.querySelector(".statusbar > .window-resize-marker"));
      const marker = resize.getBoundingClientRect();
      const status = resize.parentElement.getBoundingClientRect();
      if (resize.tabIndex >= 0 || resize.getAttribute("aria-hidden") !== "true" ||
        Math.abs(status.right - marker.right) > 2 || Math.abs(status.bottom - marker.bottom) > 2) {
        throw new Error("The main window resize marker was not decorative and flush with the status bar.");
      }
      const refresh = await waitFor(() => document.querySelector('#left-pane button[aria-label="Refresh folder"]:enabled'));
      await checkTooltip(refresh, "Refresh folder");
      const locations = document.querySelector("#left-pane .location-trigger");
      locations.click();
      const ssh = await waitFor(() => [...document.querySelectorAll("#left-pane .location-source-group button")]
        .find((button) => button.dataset.tooltipShortcut === "5" && button.dataset.tooltipAction === "SSH"));
      await checkTooltip(ssh);
      locations.click();
      if (terminalPaste) await checkTerminalPaste();
      document.querySelector('.topbar button[aria-label="Options"]').click();
      await window.__TAURI_INTERNALS__.invoke("updater_fixture_options_window");
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
    const portableFailure = "The portable update failed. Your previous copy and settings are still available.";
    const install = await waitFor(() => {
      if (replacementFailure && document.querySelector(".statusbar [role=alert]")?.textContent === portableFailure) return portableFailure;
      return [...document.querySelectorAll("dialog[open] button")].find((button) => button.textContent === "Install and restart");
    });
    if (install === portableFailure) {
      if (JSON.parse(localStorage.getItem(preferenceKey) ?? "{}").viewFontSizes?.left !== 23) throw new Error("The portable rollback lost preferences.");
      await report(null);
      return;
    }
    const preferences = JSON.parse(localStorage.getItem(preferenceKey) ?? "{}");
    preferences.viewFontSizes = { ...preferences.viewFontSizes, left: 23 };
    delete preferences.mainMenuAlignment;
    preferences.menuPosition = "right";
    localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    if (portable) {
      window.dispatchEvent(new StorageEvent("storage", { key: preferenceKey }));
      await waitFor(() => document.querySelector("#left-pane")?.style.getPropertyValue("--view-font-size") === "23px");
    }
    install.click();
    // The signed candidate restarts the app. A rejected candidate leaves the old version running.
    const error = await waitFor(() => document.querySelector(".statusbar [role=alert]")?.textContent);
    if (reject && error === "Could not download, verify, or install the update. Try again.") await report(null);
    else await report(error);
  } catch (error) {
    await report(String(error));
  }
}
