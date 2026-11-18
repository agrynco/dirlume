# Dirlume

Dirlume is a two-pane file manager for Windows, Ubuntu, and macOS. It uses Tauri 2, Rust, React, TypeScript, and Vite. The window layout takes its cues from Revqora. The [migration checklist](docs/migration.md) tracks feature parity with KSwitcher Files.

Choose English, Ukrainian, or Russian in **Options → General → Language**. Apply changes to switch the interface immediately. Dirlume remembers your choice after restart and uses it for dates and numbers. Native system menus and terminal output use their own language settings.

The two panes have independent folder navigation, sorting, filtering, and file selection. Local panes refresh automatically when files change. Copy or move selected files and folders from a destination dialog with live progress and cancellation. Moves across volumes copy each file before removing its source. With the default **Ask** option, Dirlume prompts when it reaches an existing file or folder. Choose **Overwrite** for a file, **Merge** for a folder, or **Skip** or **Cancel**. A remembered decision applies to subsequent conflicts of the same type in that transfer.

Pane addresses, transfer destinations, and the KSwitcher installation folder suggest matching paths as you type. Use the arrow keys and **Enter** or click a suggestion to choose it. Press **Tab** to complete a folder and continue the path. The browse button opens the system folder picker for local folder paths or a Save As dialog for a single-file destination. FTP suggestions come from the connected server.

Drag the right edge of a file column heading to resize it. Double-click the edge to restore its default width. Right-click the heading row to show or hide **Size** and **Modified**. **Name** is always visible. Each pane saves its widths and visible columns independently and scrolls horizontally when the columns exceed the available space.

Use **Options → Appearance → New scheme** to save your own colors for the window, file panels, dialogs, and text tools. The **File types** section controls the filename colors for categories such as source code, images, and archives. In **Fonts**, type a name to filter installed fonts in the dropdown, or open the full list with the arrow button. Use the arrow keys and Enter to choose a font, or click a result. Use **Options → Keyboard shortcuts** to change, disable, or reset a binding. **Apply** saves changes and keeps Options open. **Done** saves and closes Options.

**File types** also has separate colors for hidden and system files and folders. Hidden items include dot-prefixed names and items with the Windows Hidden attribute. Items with the Windows System attribute use the system color, including when they are also hidden. **Show hidden files** controls whether hidden items are listed.

Use **Search settings** above the Options tree to find a section or shortcut. Drag any edge or corner of Options to resize it. When Options reopens, it restores the last window size, section, search, and scroll position. The preview below the settings shows draft colors and fonts before you apply them. Click a color swatch to choose a hue and shade or enter a HEX value. Editing a built-in color creates a custom scheme. Hover over a button to see what it does and its current shortcut when one is assigned. On Windows, file panels and the process table share a cache of Shell icons for executables and registered file types.

| Default keys | Action |
| --- | --- |
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

**Find files** searches local folders and connected sources. Masks are case-insensitive. **Show in panel** displays all collected matches in the searching pane. Relative paths identify files from different folders. You can view, edit, mark, compare, or copy files from there. Use **Go to selected file** to open the containing folder for move, rename, or deletion.

Viewers and editors use the same syntax highlighting and let you change the detected language or choose plain text. Customize syntax colors in **Options → Appearance → Text tools**. Markdown preview renders fenced Mermaid diagrams. The **Open documents** bar switches between the files view and open documents. Dirlume restores local browsing history, selection, layout, and viewer/editor windows at startup. Unsaved changes require confirmation before closing the editor or exiting.

In Markdown preview, a link to another Markdown document navigates in the current viewer tab. Ctrl+Click opens the target in a separate viewer tab. Heading links scroll to the heading, and HTTP and HTTPS links open in your browser. Clicking a task checkbox saves the changed marker in a local or writable FTP file. If the editor already contains unsaved changes, the checkbox becomes part of that draft and is written when you save. Task checkboxes on read-only sources are disabled.

Mouse-wheel font changes are saved in **Options → Appearance → View font sizes**. Each file pane, the text and hex viewer, the editor, and the Markdown preview remember their own size. The Markdown preview uses the saved size for all documents and keeps it when you follow links or restart Dirlume. In **Fonts**, changing a scheme’s size for file panels or text tools clears individual sizes for those views. Markdown uses the font family you choose for the editor, viewer, and terminal.

Drag marked files and folders into the other local pane to open the transfer dialog. Select **Move instead of copying** to move local items. Both local panes watch their folders, and connected sources are refreshed periodically.

Choose **Processes** under **Alt+F1** or **Alt+F2** to view running processes, CPU usage, and memory. Click a column heading to sort the table, or search by name or PID. Windows shows executable icons when they are available. **F8** asks before ending selected processes. On Windows, right-clicking a local item opens the classic Shell context menu. A sharing violation can open a list of processes Windows reports as using the files. An access-denied error can offer **Open as administrator**, which requests UAC for a separate Dirlume window. macOS and Linux use Dirlume's file actions menu.

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

## CI and releases

[GitHub Actions](https://github.com/agrynco/dirlume/actions) checks and builds the desktop app and server for Windows x64, Ubuntu x64, macOS Apple Silicon, and macOS Intel. Each run provides downloadable build artifacts. Push a `vX.Y.Z` tag matching `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` to publish a [GitHub Release](https://github.com/agrynco/dirlume/releases) after all builds pass. The release contains the desktop packages, server archives, and SHA-256 checksums. The distributed builds use no Windows or Apple developer signing certificates.
