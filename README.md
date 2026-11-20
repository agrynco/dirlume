# Dirlume

Dirlume is a two-pane file manager for Windows, Ubuntu, and macOS. It uses Tauri 2, Rust, React, TypeScript, and Vite. The window layout takes its cues from Revqora. The [migration checklist](docs/migration.md) tracks feature parity with KSwitcher Files.

Choose English, Ukrainian, or Russian in **Options → General → Language**. Apply changes to switch the interface immediately. Dirlume remembers your choice after restart and uses it for numbers. Dates and times follow the operating system's regional settings. Native system menus and terminal output use their own language settings.

Choose **Classic blue** in **Options → Appearance → Window → Color scheme** for vivid blue file panes, cyan borders, yellow column headings, and a teal selection. You can use it as the base for a custom scheme.

Set **Favorite light scheme** and **Favorite dark scheme** in **Options → Appearance → Window**. **System** follows the operating system's appearance, and the sun or moon button switches between your favorites. Enable the optional list with **Show color scheme switcher in the title bar**. On Windows, drag the unused area of the title bar to move the window or double-click it to maximize or restore it.

The two panes have independent folder navigation, sorting, filtering, and file selection. Local panes refresh automatically when files change. Copy or move selected files and folders from a destination dialog with live progress and cancellation. Moves across volumes copy each file before removing its source. With the default **Ask** option, Dirlume prompts when it reaches an existing file or folder. Choose **Overwrite** for a file, **Merge** for a folder, or **Skip** or **Cancel**. A remembered decision applies to subsequent conflicts of the same type in that transfer.

Local copies can preserve timestamps and access rights, follow symbolic links, and filter filenames using `*` and `?`. **Process multiple destinations** copies the selection to each listed folder.

Drop files or folders from your system file manager onto a local, FTP, or SSH pane to open the transfer dialog. Local drops also offer a move. Dragging between Dirlume's panes uses the same transfer flow.

Pane addresses, transfer destinations, and the KSwitcher installation folder suggest matching paths as you type. Use the arrow keys and **Enter** or click a suggestion to choose it. Press **Tab** to complete a folder and continue the path. The browse button opens the system folder picker for local folder paths or a Save As dialog for a single-file destination. FTP and SSH suggestions come from the connected server.

Use the arrow beside an editable text field or press **Alt+↓** to recall recent entries. Typing a prefix narrows the suggestions. Use **↑/↓** and **Enter** to insert a value, or **Esc** to dismiss the list. Dirlume saves the history separately for each type of field. Password and connection token fields have history disabled.

Use **Ctrl+Shift+F8** to bookmark the active folder in group 8. Use **Ctrl+Shift+0–9** to choose another group and **Ctrl+0–9** to open its bookmarks. Folder shortcuts support local folders, Windows SMB shares, paired KSwitcher folders, FTP, SSH, and Dirlume server shares. FTP and SSH shortcuts can reconnect using their saved profiles. Reconnect a Dirlume server using an invitation before opening its bookmarks in a new session. **Commands → Folder shortcuts** opens the picker for any saved group. In the picker, use **Insert** to add, **F4** to edit, **Delete** to remove, or **Ctrl+Up/Down** to reorder.

**Size**, **Date**, and **Time** size themselves to the display font and stay aligned to the right. **Name** fills the remaining space. Right-click the headings to show or hide metadata columns independently for each pane.

Click a breadcrumb to open an ancestor folder. The address shows all breadcrumbs that fit, and the ellipsis opens any hidden parents. Hover over the address to edit or copy it, or press **Ctrl+L** to type a path. When a folder opens slowly or sizes are being calculated, **Esc** cancels the pending operation. Moving to another folder also cancels its size calculation.

Choose **Standard**, **Twin panels**, or **Classic commander** in **Options → Main File Panels → Panel layout**. Every layout works with every color scheme. Twin panels keeps file icons and adds drive buttons with icons, a line with the drive's free space above each list, column separators, and a flat key bar with icons. Classic commander uses dense rows without icons, a bar of drives and places above each pane, details of the current item below the list, and a function-key strip. Marked items use the **Marked items** color from **Appearance → Panels** for their check marks. The active and inactive selection colors set the row backgrounds. The pane footer shows the free space on the volume of a local folder.

Set **Main menu position** under **Options → General**. Set **Action button width** under **Options → Main File Panels** to switch between the default compact buttons and full-width buttons.

Dirlume bundles **GoMono Nerd Font Mono** from [Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1). By default, file panels use it at **15 px**, and the viewer, editor, and terminal use it at **18 px**. Menus, toolbars, and dialogs use the system interface font at **14 px**. Choose it by name in the font picker or clear an override to use the default. The bundled faces work offline. The [font notices](src/assets/fonts/GoMono-NOTICE.txt) and upstream licenses are included in the desktop packages.

Use **Options → Appearance → Window → New scheme** to save your own colors for the window, file panels, dialogs, and text tools. The **File types** section controls the filename colors for categories such as source code, images, and archives. In **Fonts**, type a name to filter installed fonts in the dropdown, or open the full list with the arrow button. Use the arrow keys and Enter to choose a font, or click a result. Use **Options → Keyboard shortcuts** to change, disable, or reset a binding. **Apply** saves changes and keeps Options open. **Done** saves and closes Options.

**File types** has separate colors for hidden and system items. Their names are italic and slightly dimmed. Hidden items include dot-prefixed names and items with the Windows Hidden attribute. Items with the Windows System attribute use the system color, including when they are also hidden. **Show hidden files** controls whether hidden items are listed.

Use **Search settings** above the Options tree to find a setting or shortcut. **Main File Panels** contains hidden-file visibility, pane fonts and sizes, and panel colors. **Viewer**, **Editor**, and **Terminal** each have their own font settings. They inherit the scheme's shared text font and size until you set their own values. **General** contains the interface language and remote connection settings, and **Appearance** contains shared themes and styles.

Use **Pick an element** beside **Search settings** to find the appearance controls for something visible on screen. Options hides while you point at the element. Click the highlight to return to Options with its colors, fonts, and sizes together. Press **Esc** to return to the same page and keep your draft. **Picker history** lists successful picks by local date and reopens them with current values. The history stores appearance categories and states.

In a color dialog, choose **Pick a color from the screen** and click a visible pixel in any application. **Use color** accepts the sample. **Esc** cancels the sample and keeps the previous color. Wayland sessions use the desktop's color picker portal.

In **Options → Keyboard shortcuts**, use **Add shortcut** to give a command another binding. Click an existing binding to replace it or its **×** to remove it. If the shortcut is already assigned in the same context, choose **Reassign shortcut** to move just that binding, or **Choose another shortcut** to keep entering a different combination. Commands in separate contexts can share a shortcut.

Choose a **Shortcut scheme** to switch the full set of bindings. **New scheme** copies the selected scheme. Editing **Default** creates a personal scheme, and existing custom shortcuts move to **My shortcuts** on upgrade. **Restore defaults** resets the selected personal scheme. Choose **Apply** or **Done** to use the selected scheme and save your changes.

Use **Settings** in the viewer or editor toolbar to open its section directly. The controls show the inherited font family and pixel size when no override is set. New installations use **GoMono Nerd Font Mono** at **18 px**.

**Viewer → Reading area** controls the background and maximum width of text, hex, and Markdown. **Viewer → Mermaid diagrams** controls the default block background, text, and border colors. The document header displays the encoding and, in source view, the syntax selector.

Drag the Options title bar to position it independently of the main window. Drag any edge or corner to resize it. When Options reopens, it restores the last window size, section, search, and scroll position. The preview below the settings shows draft colors and fonts before you apply them. Click a color swatch to choose a hue and shade or enter a HEX value. Editing a built-in color creates a custom scheme. Hover over a control to see details such as an icon's action, a shortcut that is missing from the control, or the full text of a clipped value. On Windows, file panels and the process table share a cache of Shell icons for executables and registered file types.

| Default keys | Action |
| --- | --- |
| F1 | Open the offline Help guide in the current interface language. |
| Alt or F9 | Open the main menu. Use the arrow keys to browse, Enter to run a command, and Esc to return to the previous control. |
| Tab, arrows, Insert | Switch panes, navigate, and mark files. Ctrl-click or Shift-click also selects multiple items. |
| Shift+↑ / Shift+↓ | Toggle the mark on the file or folder under the cursor, then move one row in that direction when possible. At either end of the list, the cursor stays in place and the mark still toggles. |
| Alt+F1 / Alt+F2 | Open sources for the left or right pane. On Windows, select a drive by letter to open the other pane's local folder on that drive, or open the drive root. |
| F2 / Ctrl+R | Refresh the active pane. F2 saves when editing a text file. |
| F3 / F4 / Shift+F4 | View text or Markdown, edit text, or create and edit a new file. F3 measures folders. |
| Ctrl+Wheel | Change the font size of the file pane, viewer, or editor under the pointer. |
| Ctrl+Click | Open a linked Markdown document in a separate viewer tab. Command+Click also works on macOS. |
| F4 inside the viewer | Toggle the read-only hexadecimal view of the original bytes. |
| Esc / F10 inside the viewer or editor | Close the current document. A changed editor asks before discarding changes. |
| F6 inside the viewer or editor | Switch to the other mode for the current file. Unsaved edits stay in the Editor. |
| Ctrl+Tab / Ctrl+Shift+Tab | Cycle forward or backward through the file panels and open documents. |
| F5 / F6 | Open the Copy or Rename or move dialog. |
| Ctrl+Alt+S | Open Options. |
| Alt+letter | Jump to a matching name in the current pane. Refine the prefix in the Quick search field. |
| Alt+F7 | Find files by name or mask in the active folder and its subfolders. |
| F2 | Rename the selected file or folder in its row. |
| Shift+F1 | Create an archive from local files and folders. |
| F7 / F8 or Delete / Shift+Delete | Create folders or directory links, send selected items to Trash, or permanently delete after confirmation. |
| Ctrl+C / Ctrl+V in a file list | Copy local files to the system clipboard or paste files into the active local folder. |
| Ctrl+Insert in a file list | Copy the marked item names, one per line in pane order. With no marks, copy the name under the cursor. |
| Ctrl+V in the terminal | Paste text into the active local or SSH session. **Options → Terminal** also enables right-click paste by default. |
| Ctrl+Shift+C (⌘⇧C on macOS) in a file list | Copy the current file or folder's full path as text. Also available under Commands → Copy full path. |
| Ctrl+O / Ctrl+Left / Ctrl+Right | Hide or show the panes, or move the divider. Drag the divider to resize with the mouse. |
| Ctrl+↑ / Ctrl+↓ | Expand the terminal or give height back to the file panes. The last step restores the command line. |
| Ctrl+F / Ctrl+Enter | Insert the selected path or name in the command line. |
| Ctrl+E / Alt+F8 | Recall earlier commands or open the shared command history. The terminal receives keystrokes while its input has focus. |
| Shift+F11 | Compare the selected files, or choose **Commands → Compare files**. Use F7 and F8 to navigate between differences. |

In **New folder**, enable **Process multiple names** to separate names with commas or semicolons. Put names containing a separator in double quotes. For a link, choose **Symbolic link** or **Directory junction** on Windows, then select an existing target folder. Press **Alt+Down** in the dialog to recall successful names from history.

Click **Terminal** or press **F12** to show or hide the interactive shell. Dirlume keeps a local shell and a separate shell for each SSH connection. The active local or SSH panel sets the working directory when a supported shell returns to its prompt. Hiding the terminal preserves the session and its split height. Use **Ctrl+↑/↓** to resize it in steps or **Ctrl+O** to hide or restore the file panes. Click **Close terminal** to end the active session.

The shell receives keystrokes while its input has focus. The status bar reminds you to click a file pane to use its shortcuts, or click **Terminal** to restore the panes when they are hidden. The terminal layout shortcuts remain available while editing a shell command. From the command line, **Alt+F8** opens dated history to search, edit, or rerun earlier commands. Dirlume keeps the last 1,000 submissions from the command line and from supported embedded shells.

Type in the command line to see matching history and completions for the active local folder. On Windows, PowerShell supplies completions, including options for Windows tools and installed Git and .NET commands. On macOS and Linux, Dirlume uses available Bash or Zsh completions and can also complete executable names and paths. Use **↑/↓** to choose a suggestion, **Tab** or **Enter** to insert it, and **Esc** to dismiss the list. **Enter** runs the draft when no suggestion is selected. **Shift+Enter** runs it with the list open.

On Windows, **Options → Terminal → Automatically refresh environment variables** is enabled by default. New PowerShell sessions read the current user and system variables, including PATH. If Windows reports a change while a terminal is open, Dirlume shows a notice. Reopen the terminal when you are ready to use the new values.

**Find files** searches local folders and connected sources. Masks are case-insensitive. **Show in panel** displays all collected matches in the searching pane. Relative paths identify files from different folders. You can view, edit, mark, compare, or copy files from there. Use **Go to selected file** to open the containing folder for move, rename, or deletion.

**Compare files** opens a separate window. Use **Previous** and **Next** to select a change, then **Apply to left** or **Apply to right** to transfer it. Turn on **Edit files** to work directly in both panes. When closing with unsaved edits, choose **Overwrite original** or **Save as** for each changed file.

Viewers and editors use the same syntax highlighting and let you change the detected language or choose plain text. Customize syntax colors in **Options → Appearance → Text tools**. Markdown preview renders fenced Mermaid diagrams. Use **HTML formatting** in the viewer toolbar to toggle support for inline spans that specify `white-space: nowrap` in table cells. The setting applies to the open viewer tab. The **Open documents** bar switches between the files view and open documents. Dirlume restores local browsing history, selection, layout, and viewer/editor windows at startup. Unsaved changes require confirmation before closing the editor or exiting.

In **New file** (**Shift+F4**), choose UTF-8, UTF-8 with BOM, UTF-16 LE, or UTF-16 BE. UTF-8 is the default. The editor preserves the chosen encoding when saving or reopening the file.

In Markdown preview, a link to another Markdown document navigates in the current viewer tab. Ctrl+Click opens the target in a separate viewer tab. Heading links scroll to the heading, and HTTP and HTTPS links open in your browser. Use **Back** and **Forward** to revisit documents and restore reading positions in the current tab. **Search** finds text in the rendered document. Clicking a task checkbox saves the changed marker in a local or writable FTP file. If the editor already contains unsaved changes, the checkbox becomes part of that draft and is written when you save. Task checkboxes on read-only sources are disabled.

The Viewer and Editor have document-specific menus and a shortcut strip. The header shows the active file's full path and document status. Choose **Options** beside the document menu to open the settings for that mode.

Use **F6** or the document's **File** menu to switch modes for the current file. The Viewer shows the saved file, and the Editor keeps its unsaved changes when you return. Change or disable the shortcut in **Options → Keyboard shortcuts**. In the file panes, **F6** still opens **Rename or move**.

The Viewer refreshes an open local file when it changes on disk. The Editor offers **Reload from disk** to open the updated file or **Keep editing** to retain the current buffer. Reloading discards any unsaved edits. Saving still checks that the disk contents match the version originally opened or last saved by the Editor.

Mouse-wheel font changes appear on the Options page for the affected feature and in **Appearance → View font sizes**. Each file pane, the text and hex viewer, the editor, and the Markdown preview remember their own size. The Markdown preview keeps its size when you follow links or restart Dirlume. Changing a scheme’s font size clears wheel adjustments for views that use that size. A custom Viewer family also applies to Markdown.

Drag marked files and folders into the other local pane to open the transfer dialog. Select **Move instead of copying** to move local items. Both local panes watch their folders, and connected sources are refreshed periodically.

Choose **Processes** under **Alt+F1** or **Alt+F2** to view running processes, CPU usage, and memory. Click a heading to sort or use **Alt+Letter** to start Quick search by process name. Windows shows executable icons when they are available. **F8** asks before ending selected processes. On Windows, right-clicking a local item opens the classic Shell context menu. A sharing violation can open a list of processes Windows reports as using the files. An access-denied error can offer **Open as administrator**, which requests UAC for a separate Dirlume window. macOS and Linux use Dirlume's file actions menu.

On Windows, select a local file or folder and choose **Find locking processes** from the main menu. The opposite pane shows what Windows found and keeps the source selection. Choose **Properties** for executable details or **Back to files** to return to the previous location. Both **F8** and **End process** in Properties ask for confirmation.
Choose **Processes** under **Alt+F1** or **Alt+F2** to view running processes, CPU usage, and memory. Click a column heading to sort the table, or search by name or PID. Windows shows executable icons when they are available. **F8** asks before ending selected processes. On Windows, right-click an item or the empty space in a filesystem pane for the classic Shell context menu. Dirlume provides its own context menu for FTP panes. A sharing violation can open a list of processes Windows reports as using the files. An access-denied error can offer **Open as administrator**, which requests UAC for a separate Dirlume window.

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

## Archives

Install the [7-Zip command-line tools](https://www.7-zip.org/download.html) to create and browse local archives. Dirlume looks for `7zz`, `7z`, or `7za` on the executable search path and in common installation directories. Select local items and press **Shift+F1** to create a ZIP, 7z, TAR, or WIM archive when the installed tool supports the format. The dialog supports compression profiles, AES encryption, split volumes, and a self-extracting option when the Windows SFX module is installed. Profiles store compression options without passwords.

Press **Enter** on an archive to open it in a pane. Use **F5** to extract selected members to a local folder with the normal copy conflict prompts, **F3** to view files, or the **Parent folder** button to go up. A writable archive supports editing text files with **F4** and removing selected members with **F8**. Encrypted, split, and other formats without update support open read-only. Dirlume skips unsafe member paths and refuses to extract links.

## Remote sources

Choose **FTP**, **SSH**, **SMB** (Windows), or **Remote machine** from either pane's sources menu to open its saved connections. Use **Shift+F4** to add a connection, **F4** to edit the selected connection, and **Enter** to connect. Open **..** to return to the previous location in that pane. Configure the connection shortcuts in **Options → Keyboard shortcuts**.

**SSH.** Open the left or right pane's sources with **Alt+F1** or **Alt+F2**, then choose **SSH** or press **5**. Use **Shift+F4** to add a named connection, **F4** to edit it, or select a saved connection and press **Enter**. SSH uses SFTP, with port 22 by default. Authenticate with a password or a private key file, optionally protected by a passphrase. Dirlume keeps passwords and passphrases in the system credential store and reads the private key from its existing location.

Use **Test connection** in the SSH profile form to check the entered credentials and browse the server's initial directory before saving. Approval of a new host key applies only to that test.

On first connection, verify the displayed SHA-256 host key fingerprint with your server administrator before choosing **Trust and connect**. Dirlume checks that fingerprint before authenticating and blocks the connection if the host key changes. The pin is shared by all SSH profiles for the same host and port. For a planned key rotation, independently verify the new fingerprint, close Dirlume, and remove the matching entry from the `trustedHosts` list in `ssh-profiles.json` in Dirlume's app configuration directory. Reopen Dirlume and verify the displayed fingerprint again.

The SSH pane opens in the server's initial directory. Browse with the file list, breadcrumbs, or an absolute path starting with / in the pane address. Press **F5** to copy files or folders between a local pane and the SSH pane with progress, cancellation, and conflict prompts. Replacing an existing server file requires the SFTP server to support the OpenSSH POSIX rename extension.

Press **F3** to view a remote file or **F4** to edit text. Saving preserves the file encoding and checks whether the file changed on the server. SSH editing uses the same safe replacement extension as copying over an existing file. If SFTP denies directory access, text reading, or saving, use **Open with sudo** or **Save with sudo** to retry. The server must allow the SSH account to run the external OpenSSH SFTP server through sudo. Dirlume uses the password only to open the authorized session. Subsequent protected operations on that connection can reuse the session until it has been idle for five minutes or the connection closes. Browsing and reading open a read-only session, and the first protected save requires write authorization.

Press **F8** or **Shift+Delete** to permanently delete selected items on FTP, SSH, and Windows SMB shares opened by UNC path. On FTP and SSH, Dirlume asks separately before deleting the contents of a nonempty folder. Deletion uses the connected account's standard permissions.

**FTP and SFTP.** Open the left or right pane's sources with **Alt+F1** or **Alt+F2**, then choose **FTP** or press **2**. Use **Shift+F4** to add a profile, select **FTP** or **SFTP (SSH)** in **Protocol**, and save. Use **F4** to edit a saved profile and **Enter** to connect. SFTP profiles also appear under **SSH**. FTP defaults to port 21 and supports anonymous login with an empty username. Dirlume stores passwords in the system credential store and filenames use UTF-8 by default. Set a filename code page for legacy FTP servers. Plain FTP sends passwords and files without encryption.

The pane opens at the server's initial directory. Use **F5** to copy files or folders between a local pane and an FTP pane in either direction. The transfer dialog shows progress and asks about conflicts. An upload completes under a temporary name before Dirlume renames it to the destination. Replacing an existing file requires a server that allows rename over the destination.

At startup, Dirlume reconnects to the saved FTP profile and reopens the last FTP folder in the same pane. If reconnection fails, the pane shows a local folder and reports the error. Dirlume keeps the FTP location for the next startup until you navigate to another location in that pane.

Inside an FTP pane, **F3** or **Enter** opens a file in the viewer. **F3** also measures folders. **F4** opens a text file for editing and **F2** saves it back to the server if the original revision still matches. **F6** renames an item and **F8** prompts before permanently deleting selected items, with an additional confirmation for nonempty folders. FTP files can be included in a text comparison. The viewer and editor show the full address of a remote file, including the protocol, host, any non-default port, and filename.

**Dirlume server** runs as a separate process on Windows, Ubuntu, and macOS and shares one folder with read access over TLS. Browse and download files and directories, or open and compare text in Dirlume. [Server setup and autostart](docs/server.md).

**KSwitcher** provides Windows access to drives and files on paired computers. To browse inside a Dirlume pane, use a build of `KSwitcher.Files.exe` that includes Dirlume Bridge. In **Options → Remote connection**, choose **KSwitcher (Windows)** and enter the installation directory. KSwitcher must be running on both computers, and the remote file service must be reachable. With an older installation, the connection dialog can launch KSwitcher Files.

## MCP server

Open **Commands → MCP server** and choose **Start server**. Copy the displayed Streamable HTTP configuration into a trusted MCP client on the same computer. The server listens on a loopback address and requires the displayed session bearer token. **Stop server** closes that endpoint and revokes the token. Starting the app again requires starting the server again.

Use the client's tool list for argument schemas. The server works with the locations and credentials already available to the desktop app.

| Area | Available tools |
| --- | --- |
| Panes | Inspect the workspace, open a path in the current source, mark items, and list directories. |
| Files | Search, read properties and text, save text using a revision, create local items, and rename local or FTP items. |
| Transfers | Copy from supported sources into a local pane, copy from local to FTP, or move between local panes. Existing targets are skipped. |
| Connections | Connect a saved FTP profile or a Dirlume Server invitation. An open paired KSwitcher pane supports browsing and downloads. |
| Settings | List and add folder shortcuts, and list or create named color schemes with validated overrides. |
| Processes | List processes and inspect Windows locking processes. |
| Confirmed actions | Trash or permanently delete local regular files and folders, and forcibly end specific processes. |

For a confirmed action, Dirlume presents the exact paths or process IDs in its window. A dismissed, expired, or unavailable dialog leaves the targets untouched. Remote deletions, link deletions, and terminal execution are unavailable through the MCP tool set. Custom schemes appear in **Options → Appearance → Color scheme** and persist across restarts.
On Windows, add an **SMB** connection using a server name, IP address, or UNC share path such as `\\server\documents`. Opening a saved server shows its shares as folders. At a share's root, use **Parent folder** to return to the share list. **Remember credentials** stores a successful sign-in separately in Windows Credential Manager.

## Desktop diagnostics

Use **Help → Open error log** to open the log in Dirlume's viewer.

Dirlume appends one JSON object per error to `diagnostics.jsonl` in the application data directory:

- Windows: `%LOCALAPPDATA%\io.github.agrynco.dirlume\logs\diagnostics.jsonl`
- Linux: `$XDG_DATA_HOME/io.github.agrynco.dirlume/logs/diagnostics.jsonl` (defaults to `~/.local/share`)
- macOS: `~/Library/Application Support/io.github.agrynco.dirlume/logs/diagnostics.jsonl`

Each entry records the failed operation, an error code, a timestamp in Unix milliseconds, and up to 32 recent actions in chronological order. Successful actions remain in memory. The log persists between sessions and records only allowlisted operation names and error codes, along with numeric OS error codes when available. It omits paths, command input, credentials, URLs, raw error text, and file contents.

## CI and releases

Dirlume checks for stable updates in the background at startup. Use **Commands → Check for updates** to check again. Windows installers and portable copies, Linux AppImage, and both Mac packages verify an update signature before installing and restarting. Dirlume asks before discarding changes in open editors. Debian installations show the matching `.deb` and an upgrade command.

Install a recent release with the bundled verification key to enable in-app updates. When a newer release is available, choose **Install and restart** to download and verify the update and let Dirlume install it.

[GitHub Actions](https://github.com/agrynco/dirlume/actions) checks and builds the desktop app and server for Windows x64, Ubuntu x64, macOS Apple Silicon, and macOS Intel. A version job resolves one product version and CI build number for all platforms. Ordinary builds use the higher of the source version and the highest published version. The build number is the workflow run number multiplied by 1,000 plus the run attempt. A full rerun gets a new build number. Retrying failed platform jobs reuses the resolved build identity if the version job already succeeded.

The installer and server filenames include both numbers, for example `Dirlume-0.1.1-build.42001-windows-x64.setup.exe`. In the installed app, open **Options → General → Version** to see `0.1.1+42001`. The server reports the same value with `dirlume-server --version`.

Start work branches from `prerelease`. For implementation tasks, Codex runs the relevant local checks, opens a pull request into `prerelease`, and squash-merges it when ready. Pull requests and pushes to that branch do not start CI.

When the batch is ready, open one pull request from `prerelease` to `main`. Both CI workflows run on pull requests targeting `main` and recheck the batch if `prerelease` receives new commits while the pull request is open.

Invoke [$dirlume-backlog-runner](.agents/skills/dirlume-backlog-runner/SKILL.md) in Codex to process the GitHub issue backlog in the current checkout. It works through the issues in order, merges each completed task into `prerelease`, then opens and merges the promotion pull request after its required checks pass.

After the required checks pass, merge the release pull request with **Create a merge commit** to preserve the shared history for the next batch. GitHub Actions automatically builds the signed update bundles and server packages from the merged commit, verifies the packages, and publishes the matching `vX.Y.Z` tag and [GitHub Release](https://github.com/agrynco/dirlume/releases). The full test suite runs during pull request CI. The release build picks the next patch version, promotes a newer published prerelease to stable, or uses a higher source version.

To publish manually, open **Actions → CI and releases → Run workflow** and select `main`. A manual release runs the full build and test suite before publishing.

For an explicitly versioned release, update `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the lockfiles, then push the matching tag. CI rejects stale versions, a mismatched tag or package, and a tag pointing to a different commit. The release contains desktop installers, portable ZIPs, standalone server archives, and SHA-256 checksums. The distributed builds use no Windows or Apple developer signing certificates.

The **Downloads** table on the release page links to the installer and ZIP for each platform. Extract the ZIP and open `Dirlume.exe` on Windows, `Dirlume.AppImage` on Linux, or `Dirlume.app` on macOS. The optional standalone server is in the `server/` folder. Windows requires the WebView2 runtime.

Windows Portable uses **Install and restart** to update its current folder. Extract it into a folder you can write to. Move the whole folder to carry the portable marker and `dirlume-settings.json` with the app. Copies in separate folders keep separate Options preferences. For earlier ZIPs that lack the portable marker, extract a current ZIP to start using in-place updates.

The release workflow also publishes `latest.json`, version-bound updater signatures, and `.app.tar.gz` update packages for both Mac architectures. All desktop builds use the updater public key in `src-tauri/tauri.conf.json`. Store the matching encrypted signing key and its password in the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions secrets. See the [Tauri updater signing guide](https://v2.tauri.app/plugin/updater/#signing-updates).

The **Install signed desktop updates** workflow tests both versions of an isolated fixture app on all four platforms with an ephemeral key. It checks that a modified package is rejected and that the original signed package installs, restarts, and restores a saved pane font setting.
