async (upgraded, reject, portable, replacementFailure, checkClipboard, checkScreenColor, fixtureDirectory) => {
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const report = (error) => invoke("updater_fixture_result", { error });
  const record = (phase) => invoke("updater_fixture_phase", { phase });
  async function waitFor(phase, read, { recordPhase = true } = {}) {
    if (recordPhase) await record(phase);
    for (let attempt = 0; attempt < 450; attempt++) {
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${phase}.`);
  }

  const preferenceKey = "dirlume.preferences.v1";
  async function verifyClipboard() {
    await record("the native text clipboard round trip");
    const sample = "Dirlume clipboard smoke test";
    let timeout;
    const roundTrip = async () => {
      await invoke("copy_path", { path: sample });
      return invoke("clipboard_text");
    };
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("The native text clipboard did not respond.")), 8000);
    });
    try {
      if (await Promise.race([roundTrip(), deadline]) !== sample) {
        throw new Error("The native clipboard did not return the copied text.");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  async function checkTooltip(control, expected) {
    const pointer = (type) => control.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));
    pointer("pointerover");
    if (expected) {
      await waitFor("the refresh tooltip", () => document.getElementById("dirlume-tooltip")?.textContent === expected);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 525));
      if (document.getElementById("dirlume-tooltip")) throw new Error("The visible SSH label and shortcut showed a redundant tooltip.");
    }
    pointer("pointerout");
  }
  async function checkHeaderMenus() {
    const bar = await waitFor("the main menu", () => document.querySelector(".topbar .main-menu"));
    for (const side of ["Right", "Left"]) {
      const control = [...bar.querySelectorAll("[data-menu-group]")].find((button) => button.textContent === side);
      control.click();
      await waitFor(`the ${side} menu to open`, () => control.getAttribute("aria-expanded") === "true");
      bar.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
      await waitFor(`the ${side} menu to close`, () => control.getAttribute("aria-expanded") === "false");
    }
  }
  async function checkPanelModes() {
    const pane = await waitFor("the left file pane", () => document.querySelector('#left-files[aria-busy="false"]'));
    const panel = pane.closest(".pane");
    const right = document.getElementById("right-pane");
    const originalRight = right.dataset.panelMode;
    const key = (type, key, code, ctrlKey) => pane.dispatchEvent(new KeyboardEvent(type, {
      key, code, ctrlKey, bubbles: true, cancelable: true,
    }));
    const chord = (side, digit) => {
      key("keydown", "Control", `Control${side}`, true);
      key("keydown", String(digit), `Digit${digit}`, true);
      key("keyup", "Control", `Control${side}`, false);
    };
    pane.focus();
    for (const [digit, id] of [[1, "brief"], [2, "medium"], [3, "full"], [4, "wide"], [8, "owners"], [9, "links"], [0, "alternativeFull"]]) {
      chord("Left", digit);
      await waitFor(`the ${id} panel mode`, () => panel.dataset.panelMode === id);
      if (right.dataset.panelMode !== originalRight) throw new Error("A panel mode changed both panes.");
      if (digit === 1 || digit === 2) {
        const columnHeaders = panel.querySelectorAll(".file-column-group");
        if (columnHeaders.length !== (digit === 1 ? 3 : 2)) throw new Error("The grouped mode showed the wrong number of headings.");
      }
    }
    for (let digit = 0; digit < 10; digit++) {
      chord("Right", digit);
      await waitFor(`bookmark group ${digit}`, () =>
        document.querySelector(".statusbar")?.textContent.includes(`No folder shortcuts in group ${digit}.`));
      if (panel.dataset.panelMode !== "alternativeFull") throw new Error("A bookmark shortcut changed the panel mode.");
    }
    chord("Left", 3);
    await waitFor("the restored Full panel mode", () => panel.dataset.panelMode === "full");
  }
  async function checkFileSort() {
    const pane = await waitFor("the file pane for sorting", () => document.querySelector('#left-files[aria-busy="false"]'));
    const send = (target, key, modifiers = {}) => target.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true, ...modifiers,
    }));
    pane.focus();
    send(pane, "F12", { ctrlKey: true });
    const popup = await waitFor("the Sort by menu", () => document.querySelector(".sort-menu"));
    const entries = popup.querySelectorAll("[data-sort-mode]");
    if (entries.length !== 15 || entries[0].dataset.sortMode !== "name" || entries[14].dataset.sortMode !== "streamSize") {
      throw new Error("The Sort by menu omitted a sort mode.");
    }
    const current = popup.querySelector('button[data-sort-mode="name"]');
    if (current.getAttribute("aria-checked") !== "true") throw new Error("Name was not the initial selection.");
    send(current, "-");
    await waitFor("descending file name order", () => current.getAttribute("aria-label").includes("Descending"));
    send(current, "+");
    await waitFor("ascending file name order", () => current.getAttribute("aria-label").includes("Ascending"));
    popup.closest("dialog").querySelector('button[aria-label="Close dialog"]').click();
    await waitFor("focus back in the file pane", () => !document.querySelector(".sort-menu") && document.activeElement === pane);
  }
  async function checkDocumentMode() {
    const fileName = "document-mode-fixture.txt";
    const key = (target, key, modifiers = {}) => target.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true, ...modifiers,
    }));
    const pane = await waitFor("the left file pane", () => document.querySelector('#left-files[aria-busy="false"]'));
    const breadcrumbs = await waitFor("the left path breadcrumbs", () => document.querySelector('#left-path .address-breadcrumbs[data-editable="true"]'));
    breadcrumbs.click();
    const address = await waitFor("the editable left path", () => document.querySelector("input#left-address"));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(address, fixtureDirectory);
    address.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(requestAnimationFrame);
    key(address, "Enter");
    const row = await waitFor("the document mode fixture", () => pane.querySelector(`[role="option"][data-tooltip="${fileName}"]`));
    row.click();
    await waitFor("the selected document mode fixture", () => row.dataset.current === "true" && document.activeElement === pane);
    key(pane, "F3");
    const mode = (editing, text = "Document mode fixture", recordPhase = true) => waitFor(editing ? "the same file in Editor" : "the same file in Viewer", () => {
      const view = document.querySelector(`.text-window[data-editing="${editing}"][aria-label="${fileName}"]:not([hidden])`);
      return view?.querySelector(".cm-content")?.textContent === text && view;
    }, { recordPhase });
    const viewer = await mode(false);
    key(viewer, "F6");
    const editor = await mode(true);
    key(editor, "F6");
    if (await mode(false) !== viewer) throw new Error("F6 duplicated the existing Viewer.");
    await record("an in-place document update");
    await mode(false, "Edited in place", false);
    key(viewer, "F6");
    await mode(true);
    const changeDialog = () => [...document.querySelectorAll("dialog[open]")]
      .find((dialog) => document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent === "File changed on disk");
    const inPlace = await waitFor("the clean Editor external-change prompt", changeDialog);
    const reload = (dialog) => [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Reload from disk");
    reload(inPlace).click();
    await mode(true, "Edited in place");
    await record("a replaced document");
    const replaced = await waitFor("the Editor prompt for a replaced file", changeDialog, { recordPhase: false });
    reload(replaced).click();
    key(await mode(true, "Replaced file"), "F10");
    key(await mode(false, "Replaced file"), "F10");
    await waitFor("return to the file pane", () => document.activeElement === pane);
    key(pane, "F6");
    const rename = await waitFor("the unchanged file pane F6 shortcut", () => [...document.querySelectorAll("dialog[open]")]
      .find((dialog) => document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent === "Rename or move"));
    rename.querySelector('button[aria-label="Close dialog"]').click();
    await waitFor("the rename dialog to close", () => !rename.open);
  }
  function checkAlertColors() {
    const root = document.documentElement;
    const theme = root.getAttribute("data-theme");
    const ordinary = document.createElement("dialog");
    ordinary.className = "dialog";
    ordinary.setAttribute("open", "");
    ordinary.innerHTML = '<header class="dialog-heading"></header><div class="dialog-body"></div><footer class="dialog-footer"><button>Cancel</button><button class="primary">Copy</button></footer>';
    const alert = ordinary.cloneNode(true);
    alert.dataset.tone = "warning";
    alert.querySelector(".primary").className = "alert-confirm";
    document.body.append(ordinary, alert);
    try {
      for (const mode of ["light", "dark", "classic-blue"]) {
        root.dataset.theme = mode;
        const surfaces = (dialog) => [dialog, ...dialog.querySelectorAll(".dialog-heading, .dialog-footer, button:first-child")]
          .map((element) => getComputedStyle(element).backgroundColor);
        const action = getComputedStyle(alert.querySelector(".alert-confirm"));
        if (JSON.stringify(surfaces(alert)) !== JSON.stringify(surfaces(ordinary)) ||
            action.backgroundColor !== "rgb(163, 35, 55)" || action.color !== "rgb(255, 255, 255)") {
          throw new Error(`The ${mode} alert did not use standard surfaces and a red confirmation button.`);
        }
      }
    } finally {
      ordinary.remove();
      alert.remove();
      if (theme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", theme);
    }
  }
  try {
    if (upgraded) {
      await waitFor("the saved pane font size", () => document.querySelector("#left-pane")?.style.getPropertyValue("--view-font-size") === "23px");
      await waitFor("the migrated menu position", () => document.querySelector('.topbar[data-menu-position="right"]') &&
        JSON.parse(localStorage.getItem(preferenceKey) ?? "{}").mainMenuAlignment === "right");
      await record("the main window in its normal size");
      await invoke("updater_fixture_normal_window");
      const resize = await waitFor("the main window resize marker", () => document.querySelector(".statusbar > .window-resize-marker"));
      const marker = resize.getBoundingClientRect();
      const status = resize.parentElement.getBoundingClientRect();
      if (resize.tabIndex >= 0 || resize.getAttribute("aria-hidden") !== "true" ||
        Math.abs(status.right - marker.right) > 2 || Math.abs(status.bottom - marker.bottom) > 2) {
        throw new Error("The main window resize marker was not decorative and flush with the status bar.");
      }
      const refresh = await waitFor("the pane refresh control", () => document.querySelector('#left-pane button[aria-label="Refresh folder"]:enabled'));
      await checkTooltip(refresh, "Refresh folder");
      const locations = document.querySelector("#left-pane .location-trigger");
      locations.click();
      const ssh = await waitFor("the SSH location shortcut", () => [...document.querySelectorAll("#left-pane .location-source-group button")]
        .find((button) => button.dataset.tooltipShortcut === "5" && button.dataset.tooltipAction === "SSH"));
      await checkTooltip(ssh);
      locations.click();
      await checkHeaderMenus();
      await checkPanelModes();
      await checkFileSort();
      if (fixtureDirectory) await checkDocumentMode();
      await record("the independent Options window");
      document.querySelector('.topbar button[aria-label="Options"]').click();
      await invoke("updater_fixture_options_window");
      const updates = await waitFor("the manual update command", () => {
        const commands = [...document.querySelectorAll(".main-menu [data-menu-group]")].find((button) => button.textContent === "Commands");
        if (commands?.getAttribute("aria-expanded") === "false") commands.click();
        return [...document.querySelectorAll(".main-menu [data-menu-item]")].find((button) => button.textContent === "Check for updates");
      });
      updates.click();
      await waitFor("the up-to-date message", () => [...document.querySelectorAll("dialog[open] p")].some((text) => text.textContent === "Dirlume is up to date."));
      await record("the shared alert colors");
      checkAlertColors();
      if (checkClipboard) await verifyClipboard();
      if (checkScreenColor) {
        await record("the native screen color cancellation");
        if (await invoke("pick_screen_color") !== null) throw new Error("Escape did not cancel screen sampling.");
        await record("the external screen color");
        const color = await invoke("pick_screen_color");
        const channels = color?.match(/[a-f\d]{2}/g)?.map((channel) => parseInt(channel, 16));
        if (channels?.length !== 3 || channels.some((channel, index) => Math.abs(channel - [36, 89, 120][index]) > 1)) {
          throw new Error(`The external screen color did not match the fixture. Received ${color}.`);
        }
      }
      await report(null);
      return;
    }
    const portableFailure = "The portable update failed. Your previous copy and settings are still available.";
    const install = await waitFor("the install or rollback screen", () => {
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
      await waitFor("the portable pane font size before installation", () => document.querySelector("#left-pane")?.style.getPropertyValue("--view-font-size") === "23px");
    }
    // The signed candidate restarts the app. A rejected candidate leaves the old version running.
    await record(reject ? "the signature rejection message" : "the update installation and restart");
    install.click();
    const error = await waitFor("the installation error",
      () => document.querySelector(".statusbar [role=alert]")?.textContent, { recordPhase: false });
    await report(reject && error === "Could not download, verify, or install the update. Try again." ? null : error);
  } catch (error) {
    await report(String(error));
  }
}
