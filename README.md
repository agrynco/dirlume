# Dirlume

Dirlume is a two-pane file manager for Windows, Ubuntu, and macOS. It uses Tauri 2, Rust, React, TypeScript, and Vite. The window layout takes its cues from Revqora. The [migration checklist](docs/migration.md) tracks feature parity with KSwitcher Files.

Choose English, Ukrainian, or Russian in **Options → General → Language**. Apply changes to switch the interface immediately. Dirlume remembers your choice after restart and uses it for dates and numbers. Native system menus and terminal output use their own language settings.

Choose **Classic blue** under **Options → Appearance → Color scheme** for deep blue file panes with cyan focus indicators. You can use it as the base for a custom scheme.

The two panes have independent folder navigation, sorting, filtering, and file selection. Local panes refresh automatically when files change. Copy or move selected files and folders from a destination dialog with live progress and cancellation. Moves across volumes copy each file before removing its source. With the default **Ask** option, Dirlume prompts when it reaches an existing file or folder. Choose **Overwrite** for a file, **Merge** for a folder, or **Skip** or **Cancel**. A remembered decision applies to subsequent conflicts of the same type in that transfer.

Pane addresses, transfer destinations, and the KSwitcher installation folder suggest matching paths as you type. Use the arrow keys and **Enter** or click a suggestion to choose it. Press **Tab** to complete a folder and continue the path. The browse button opens the system folder picker for local folder paths or a Save As dialog for a single-file destination. FTP suggestions come from the connected server.

Use **Ctrl+Shift+F8** to bookmark the active local or paired KSwitcher folder in group 8. Use **Ctrl+Shift+0–9** to choose another group and **Ctrl+0–9** to open its bookmarks. **Commands → Folder shortcuts** opens the picker for any saved group. In the picker, use **Insert** to add, **F4** to edit, **Delete** to remove, or **Ctrl+Up/Down** to reorder.

Drag the right edge of a file column heading to resize it. Double-click the edge to restore its default width. Right-click the heading row to show or hide **Size** and **Modified**. **Name** is always visible. Each pane saves its widths and visible columns independently and scrolls horizontally when the columns exceed the available space.

Choose **Standard**, **Twin panels**, or **Classic commander** in **Options → Main File Panels → Panel layout**. Every layout works with every color scheme. Twin panels keeps file icons and adds drive buttons with icons, a line with the drive's free space above each list, column separators, and a flat key bar with icons. Classic commander uses dense rows without icons, a bar of drives and places above each pane, details of the current item below the list, and a function-key strip. Marked items use the **Marked items** color from **Appearance → Panels**: Standard adds a check mark and a tinted row, and Classic commander highlights the name, size, and date. The pane footer shows the free space on the volume of a local folder.

Dirlume bundles **GoMono Nerd Font Mono** from [Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1). By default, file panels use it at **15 px**, and the viewer, editor, and terminal use it at **18 px**. Menus, toolbars, and dialogs use the system interface font at **14 px**. Choose it by name in the font picker or clear an override to use the default. The bundled faces work offline. The [font notices](src/assets/fonts/GoMono-NOTICE.txt) and upstream licenses are included in the desktop packages.

Use **Options → Appearance → New scheme** to save your own colors for the window, file panels, dialogs, and text tools. The **File types** section controls the filename colors for categories such as source code, images, and archives. In **Fonts**, type a name to filter installed fonts in the dropdown, or open the full list with the arrow button. Use the arrow keys and Enter to choose a font, or click a result. Use **Options → Keyboard shortcuts** to change, disable, or reset a binding. **Apply** saves changes and keeps Options open. **Done** saves and closes Options.

**File types** also has separate colors for hidden and system files and folders. Hidden items include dot-prefixed names and items with the Windows Hidden attribute. Items with the Windows System attribute use the system color, including when they are also hidden. **Show hidden files** controls whether hidden items are listed.

Use **Search settings** above the Options tree to find a setting or shortcut. **Main File Panels** contains hidden-file visibility, pane fonts and sizes, and panel colors. **Viewer**, **Editor**, and **Terminal** each have their own font settings. They inherit the scheme's shared text font and size until you set their own values. **General** contains the interface language and remote connection settings, and **Appearance** contains shared themes and styles.

Drag any edge or corner of Options to resize it. When Options reopens, it restores the last window size, section, search, and scroll position. The preview below the settings shows draft colors and fonts before you apply them. Click a color swatch to choose a hue and shade or enter a HEX value. Editing a built-in color creates a custom scheme. Hover over a button to see what it does and its current shortcut when one is assigned. On Windows, file panels and the process table share a cache of Shell icons for executables and registered file types.

| Default keys | Action |
| --- | --- |
| F1 | Open the offline Help guide in the current interface language. |
| F9 | Open the main menu. Use the arrow keys to browse, Enter to run a command, and Esc to return to the previous control. |
| Tab, arrows, Insert | Switch panes, navigate, and mark files. Ctrl-click or Shift-click also selects multiple items. |
| Shift+↑ / Shift+↓ | Mark a range from the current row, or unmark it when the first row you move onto is already marked. Reverse direction to shrink the range. |
| Alt+F1 / Alt+F2 | Open sources for the left or right pane. |
| F2 / Ctrl+R | Refresh the active pane. F2 saves when editing a text file. |
| F3 / F4 / Shift+F4 | View text or Markdown, edit text, or create and edit a new file. F3 measures folders. |
| Ctrl+Wheel | Change the font size of the file pane, viewer, or editor under the pointer. |
| Ctrl+Click | Open a linked Markdown document in a separate viewer tab. Command+Click also works on macOS. |
| F4 inside the viewer | Toggle the read-only hexadecimal view of the original bytes. |
| Esc inside the viewer or editor | Close the current document. A changed editor asks before discarding changes. |
| Ctrl+Tab / Ctrl+Shift+Tab | Cycle forward or backward through the file panels and open documents. |
| F5 / F6 | Open the Copy or Rename or move dialog. |
| Ctrl+Alt+S | Open Options. |
| Alt+letter | Jump to a matching name in the current pane. Refine the prefix in the Quick search field. |
| Alt+F7 | Find files by name or mask in the active folder and its subfolders. |
| F7 / F8 / Shift+Delete | Create a folder, send selected items to Trash, or permanently delete after confirmation. |
| Ctrl+C / Ctrl+V in a file list | Copy local files to the system clipboard or paste files into the active local folder. |
| Ctrl+O / Ctrl+Left / Ctrl+Right | Hide or show the panes, or move the divider. Drag the divider to resize with the mouse. |
| Ctrl+F / Ctrl+Enter | Insert the selected path or name in the command line. |
| Ctrl+E / Alt+F8 | Recall earlier commands or open command history. Alt+F8 also works from the terminal. |
| Shift+F11 | Compare files. Use F7 and F8 to navigate between differences. |

Click **Terminal** beside the command line to open an interactive PowerShell or system shell in the active local folder. The open terminal follows the active local panel in PowerShell, Bash, Zsh, and compatible Bourne shells. If a command is running or being edited, the directory changes when the shell returns to its prompt. The command line also sends commands to the shell from the active local folder. **Alt+F8** opens the command line history from either control. Terminal colors adapt to the background of the active color scheme.

On Windows, **Options → Terminal → Automatically refresh environment variables** is enabled by default. New PowerShell sessions read the current user and system variables, including PATH. If Windows reports a change while a terminal is open, Dirlume shows a notice. Reopen the terminal when you are ready to use the new values.

**Find files** searches local folders and connected sources. Masks are case-insensitive. **Show in panel** displays all collected matches in the searching pane. Relative paths identify files from different folders. You can view, edit, mark, compare, or copy files from there. Use **Go to selected file** to open the containing folder for move, rename, or deletion.

Viewers and editors use the same syntax highlighting and let you change the detected language or choose plain text. Customize syntax colors in **Options → Appearance → Text tools**. Markdown preview renders fenced Mermaid diagrams. The **Open documents** bar switches between the files view and open documents. Dirlume restores local browsing history, selection, layout, and viewer/editor windows at startup. Unsaved changes require confirmation before closing the editor or exiting.

In **New file** (**Shift+F4**), choose UTF-8, UTF-8 with BOM, UTF-16 LE, or UTF-16 BE. UTF-8 is the default. The editor preserves the chosen encoding when saving or reopening the file.

In Markdown preview, a link to another Markdown document navigates in the current viewer tab. Ctrl+Click opens the target in a separate viewer tab. Heading links scroll to the heading, and HTTP and HTTPS links open in your browser. Clicking a task checkbox saves the changed marker in a local or writable FTP file. If the editor already contains unsaved changes, the checkbox becomes part of that draft and is written when you save. Task checkboxes on read-only sources are disabled.

Mouse-wheel font changes appear on the Options page for the affected feature and in **Appearance → View font sizes**. Each file pane, the text and hex viewer, the editor, and the Markdown preview remember their own size. The Markdown preview keeps its size when you follow links or restart Dirlume. Changing a scheme’s font size clears wheel adjustments for views that use that size. A custom Viewer family also applies to Markdown.

Drag marked files and folders into the other local pane to open the transfer dialog. Select **Move instead of copying** to move local items. Both local panes watch their folders, and connected sources are refreshed periodically.

Choose **Processes** under **Alt+F1** or **Alt+F2** to view running processes, CPU usage, and memory. Click a column heading to sort the table, or search by name or PID. Windows shows executable icons when they are available. **F8** asks before ending selected processes. On Windows, right-clicking a local item opens the classic Shell context menu. A sharing violation can open a list of processes Windows reports as using the files. An access-denied error can offer **Open as administrator**, which requests UAC for a separate Dirlume window. macOS and Linux use Dirlume's file actions menu.

Press **Ctrl+A** while focused on a file list to inspect the current item’s attributes, owner, and timestamps. **Apply** saves supported flags and refreshes the file panes. Windows supports Archive, Hidden, System, Not indexed, and Read-only on files. On Linux and macOS you can change the owner’s write bit. Remote item details are read-only and depend on what the source reports.

In the main menu, **Help → Help** opens the offline guide and **Help → About** shows the running version. **Commands → Check for updates** checks for a desktop update.

## Build

Install Node.js 24, Rust via rustup, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Windows uses MSVC and WebView2, macOS uses Xcode Command Line Tools, and Ubuntu uses WebKitGTK 4.1.

```sh
npm ci
npm run tauri -- dev
```

Run the checks and build the desktop app and standalone server.

```sh
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --features server -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked --features server
npm run tauri -- build -- --locked
cargo build --manifest-path src-tauri/Cargo.toml --locked --release --no-default-features --features server --bin dirlume-server
node scripts/server-smoke.mjs
```

On Windows, run `node scripts/desktop-smoke.mjs` after both builds. It opens Dirlume with an isolated WebView2 profile and test files. The CI smoke job uses a separate build with the `ui-automation` feature. To include the FTP smoke test locally, install `pyftpdlib==2.2.0` in Python and set `DIRLUME_FTP_PYTHON` to that Python executable. Use a UI automation build so the fixture keeps its FTP profiles separate.

## Remote sources

**FTP.** Open the left or right pane's sources with **Alt+F1** or **Alt+F2**, then choose **FTP** or press **1**. Use **Shift+F4** to add a profile, **F4** to edit it, and **Enter** to connect. The port defaults to 21. Leave the username empty for anonymous login. Dirlume stores passwords in the system credential store and filenames use UTF-8 by default. Set a filename code page for legacy servers. Plain FTP sends passwords and files without encryption.

The pane opens at the server's initial directory. Use **F5** to copy files or folders between a local pane and an FTP pane in either direction. The transfer dialog shows progress and asks about conflicts. An upload completes under a temporary name before Dirlume renames it to the destination. Replacing an existing file requires a server that allows rename over the destination.

At startup, Dirlume reconnects to the saved FTP profile and reopens the last FTP folder in the same pane. If reconnection fails, the pane shows a local folder and reports the error. Dirlume keeps the FTP location for the next startup until you navigate to another location in that pane.

Inside an FTP pane, **F3** or **Enter** opens a file in the viewer. **F3** also measures folders. **F4** opens a text file for editing and **F2** saves it back to the server if the original revision still matches. **F6** renames an item and **F8** prompts before permanently deleting selected items, with an additional confirmation for nonempty folders. FTP files can be included in a text comparison.

**Dirlume server** runs as a separate process on Windows, Ubuntu, and macOS and shares one folder with read access over TLS. Browse and download files and directories, or open and compare text in Dirlume. [Server setup and autostart](docs/server.md).

**KSwitcher** provides Windows access to drives and files on paired computers. To browse inside a Dirlume pane, use a build of `KSwitcher.Files.exe` that includes Dirlume Bridge. In **Options → Remote connection**, choose **KSwitcher (Windows)** and enter the installation directory. KSwitcher must be running on both computers, and the remote file service must be reachable. With an older installation, the connection dialog can launch KSwitcher Files.

## Desktop diagnostics

Dirlume appends one JSON object per error to `diagnostics.jsonl` in the application data directory:

- Windows: `%LOCALAPPDATA%\io.github.agrynco.dirlume\logs\diagnostics.jsonl`
- Linux: `$XDG_DATA_HOME/io.github.agrynco.dirlume/logs/diagnostics.jsonl` (defaults to `~/.local/share`)
- macOS: `~/Library/Application Support/io.github.agrynco.dirlume/logs/diagnostics.jsonl`

Each entry records the failed operation, an error code, a timestamp in Unix milliseconds, and up to 32 recent actions in chronological order. Successful actions remain in memory. The log persists between sessions and records only allowlisted operation names and error codes, along with numeric OS error codes when available. It omits paths, command input, credentials, URLs, raw error text, and file contents.

## CI and releases

Dirlume checks for stable updates in the background at startup. Use **Commands → Check for updates** to check again. Windows NSIS, Linux AppImage, and both Mac packages verify an update signature before installing and restarting. Dirlume asks before discarding changes in open editors. Debian installations show the matching `.deb` and an upgrade command.

Install the first signed release manually to enable in-app updates for later releases.

[GitHub Actions](https://github.com/agrynco/dirlume/actions) checks and builds the desktop app and server for Windows x64, Ubuntu x64, macOS Apple Silicon, and macOS Intel. A version job resolves one product version and CI build number for all platforms. Ordinary builds use the higher of the source version and the highest published version. The build number is the workflow run number multiplied by 1,000 plus the run attempt. A full rerun gets a new build number. Retrying failed platform jobs reuses the resolved build identity if the version job already succeeded.

The installer and server filenames include both numbers, for example `Dirlume-0.1.1-build.42001-windows-x64.setup.exe`. In the installed app, open **Options → General → Version** to see `0.1.1+42001`. The server reports the same value with `dirlume-server --version`.

To publish the next stable [GitHub Release](https://github.com/agrynco/dirlume/releases), open **Actions → CI and releases → Run workflow**, leave the branch set to `main`, and click **Run workflow**. The workflow increments the published patch version, promotes a newer prerelease to its stable version, or uses a higher source version. After all platforms pass, it verifies the packages and creates the matching `vX.Y.Z` tag and release. Pull requests and branch pushes to `main` run CI checks only.

For an explicitly versioned release, update `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the lockfiles, then push the matching tag. CI rejects stale versions, a mismatched tag or package, and a tag pointing to a different commit. The release contains desktop packages, server archives, and SHA-256 checksums. The distributed builds use no Windows or Apple developer signing certificates.

The release workflow also publishes `latest.json`, version-bound updater signatures, and `.app.tar.gz` update packages for both Mac architectures. Configure `DIRLUME_UPDATER_PUBLIC_KEY` as a GitHub Actions repository variable. Store the matching encrypted key and its password in the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions secrets. Generate the key outside the repository with `npm run tauri -- signer generate -w <key-file>` and keep the private key available to the release maintainers. Installed apps trust the key embedded at build time. See the [Tauri updater signing guide](https://v2.tauri.app/plugin/updater/#signing-updates).

The **Install signed desktop updates** workflow tests both versions of an isolated fixture app on all four platforms with an ephemeral key. It checks that a modified package is rejected and that the original signed package installs, restarts, and restores a saved pane font setting.
