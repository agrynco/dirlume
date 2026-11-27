# Dirlume

Dirlume is a two-pane file manager for Windows and Ubuntu. It uses Tauri 2, Rust, React, TypeScript, and Vite. The window layout takes its cues from Revqora. The [migration checklist](docs/migration.md) tracks feature parity with KSwitcher Files.

Choose English, Ukrainian, or Russian in **Options → General → Language**. Apply changes to switch the interface immediately. Dirlume remembers your choice after restart and uses it for numbers. Dates and times follow the operating system's regional settings. Native system menus and terminal output use their own language settings.

Choose **Classic blue** in **Options → Appearance → Window → Color scheme** for vivid blue file panes, cyan borders, yellow column headings, and a teal selection. You can use it as the base for a custom scheme.

**Lavender**, **Emerald**, **Aurora**, **Midnight blue**, **Sunrise**, and **Graphite** give the window a modern look: rounded file panes on a soft gradient or glowing background, chip-style drive and key buttons, and the main window font in the file lists. Lavender and Sunrise are light schemes, the other four are dark. Sunrise (warm ivory with a coral accent) and Graphite (neutral charcoal with an amber accent) are a matching pair with plainer backgrounds. They look closest to their design in the **Twin panels** layout and work with every layout. A font set in **Appearance → Fonts** still takes precedence.

Set **Favorite light scheme** and **Favorite dark scheme** in **Options → Appearance → Window**. **System** follows the operating system's appearance, and the sun or moon button switches between your favorites. Enable the optional list with **Show color scheme switcher in the title bar**. On Windows, drag the unused area of the title bar to move the window or double-click it to maximize or restore it.

Set **Window background** on that page to choose a solid color for the backdrop behind the file panes and modern toolbars. **Reset window background** restores the base scheme's backdrop.

Clear **Show status bar** in **Options → Appearance → Window** to give the workspace more room. The resize grip stays at the bottom-right, confirmations appear briefly above the lower toolbar, and errors stay visible until dismissed.

Use **Manage custom color schemes** on the same page to rename a saved scheme or delete an inactive one without changing the current appearance. A custom scheme currently applied by **System** is protected from deletion. Deleting an inactive favorite restores the matching built-in Light or Dark favorite. Use **Apply** or **Done** to save the changes.

Check **Keep current fonts** to capture the font families and base sizes in use. The retained fonts apply when switching schemes in Options, in the title bar, or through System appearance. Clear the checkbox to use the selected scheme's fonts again. Per-view zoom settings stay in place.

Use **Export settings** in **Options** to save selected settings groups and custom color schemes to a JSON file. To share only a palette, select its scheme. On another installation, use **Import settings** to choose what to apply from the file. Dirlume asks for confirmation before replacing a local color scheme. Imported schemes are available under **Options → Appearance → Window → Color scheme**.

The JSON archive includes portable preferences such as panel modes and keyboard shortcuts. Dirlume migrates supported older files and skips settings it no longer recognizes. The KSwitcher installation folder is configured locally in **Options → General**.

The two panes have independent folder navigation, sorting, filtering, and file selection. Local panes refresh automatically when files change. Copy or move selected files and folders from a destination dialog with live progress and cancellation. Moves across volumes copy each file before removing its source. With the default **Ask** option, Dirlume prompts when it reaches an existing file or folder. Choose **Overwrite** for a file, **Merge** for a folder, or **Skip** or **Cancel**. A remembered decision applies to subsequent conflicts of the same type in that transfer.

Press **Ctrl+U** (**Command+U** on macOS) or choose **Commands → Swap panes** to exchange the workspace panes while keeping the active view and its selection. This works with files, processes, Quick View, Space Analyzer, and environment variables. In Git View it exchanges **Branches** and **Commit history** for the current session. In **Side-by-side** comparison it exchanges the files, including unsaved edits, and the merge actions follow the displayed sides. Change or disable **Swap panes** in **Options → Keyboard shortcuts**.

Local copies can preserve timestamps and access rights, follow symbolic links, and filter filenames using `*` and `?`. **Process multiple destinations** copies the selection to each listed folder.

Drop files or folders from your system file manager onto a local, FTP, or SSH pane to open the transfer dialog. Local drops also offer a move. Dragging between Dirlume's panes uses the same transfer flow.

Pane addresses, transfer destinations, and the KSwitcher installation folder suggest matching paths as you type. Use the arrow keys and **Enter** or click a suggestion to choose it. Press **Tab** to complete a folder and continue the path. The browse button opens the system folder picker for local folder paths or a Save As dialog for a single-file destination. FTP and SSH suggestions come from the connected server.

Use the arrow beside an editable text field or press **Alt+↓** to recall recent entries. Typing a prefix narrows the suggestions. Use **↑/↓** and **Enter** to insert a value, or **Esc** to dismiss the list. Dirlume saves the history separately for each type of field. Password and connection token fields have history disabled.

Use **Ctrl+Shift+F8** to bookmark the active folder in group 8. Use **Ctrl+Shift+0–9** to choose another group and **Right Ctrl+0–9** to open its bookmarks. Folder shortcuts support local folders, Windows SMB shares, paired KSwitcher folders, FTP, SSH, and Dirlume server shares. FTP and SSH shortcuts can reconnect using their saved profiles. Reconnect a Dirlume server using an invitation before opening its bookmarks in a new session. **Commands → Folder shortcuts** opens the picker for any saved group. In the picker, use **Insert** to add, **F4** to edit, **Delete** to remove, or **Ctrl+Up/Down** to reorder.

Choose a file panel mode from the **Left** or **Right** menu. The active pane also responds to **Left Ctrl** with the top-row digits **1** for Brief, **2** for Medium, **3** for Full, **4** for Wide, **8** for File owners, **9** for File links, and **0** for Alternative full. Brief and Medium fill three or two groups of names down the pane. Full uses Name, Size, Date, and Time. Wide uses Name and Size. Alternative full adds mark indicators and shows sizes in bytes. File owners and File links show the metadata available from the current source.

In Brief and Medium, **Up** and **Down** follow the sort order from the bottom of one column to the top of the next. **Left**, **Right**, **Page Up**, and **Page Down** move by a whole screen of files. **Home** and **End** go to the first and last entries.

In **Options → Panel modes**, edit the name, columns, current-item status line, and filename display for each mode. **Align file extensions** displays the final extension without its separating dot, such as `archive.tar` with aligned `gz`. Built-in modes set widths to **0** for automatic sizing. The list fits headings and values when space allows, including file size units. Name takes the space left by the metadata columns. To set your own widths, enter a character count or a percentage of the remaining space. Right-click the headings to show or hide columns for the current pane and mode. Each pane sizes its columns independently.

The built-in **Full** mode uses automatic Size and Date widths. These widths follow the displayed values in the current pane font. The Size column widens as needed to show full folder measurements, even with a saved width. Set a column width to **0** to fit its displayed values automatically.

After confirming a local deletion or Move to Trash, you can cancel preparation or follow progress for the current item and the full selection. If an item is locked, retry it, skip it, or skip all remaining locks in that batch. On Windows, **Find locking processes** opens the process inspector. Ending a process requires its own confirmation. Permanent deletion keeps a skipped item and its parent folders while continuing with removable siblings. The final free-space reading comes from the source volume.

Open **Sort by** with **Ctrl+F12** or **Sort modes** in the **Left** or **Right** menu. Use the menu to sort by name, extension, size, timestamps, or other metadata supplied by the source. Choose **Unsorted** to keep listing order within each priority group. Press **+** for ascending, **−** for descending, or **\*** to reverse the direction. Press **F4** in the menu to edit tie-breakers.

Use **Show selected first** to sort marked items ahead of unmarked items. **Show directories first** keeps folders together. **Options → Sort groups** lets you order filename masks before or after unmatched items. Enable **Use sort groups** for Name, Name only, and Extension. The pane remembers its sort and priorities when you switch folders, change its panel mode, or restart.

Press **Enter** on a local folder row to open it with the cursor on **..**. Press **Enter** again to return to the parent folder. The **Parent folder** arrow and configured shortcut open the same immediate parent. At a root, the arrow is disabled and the **..** row is hidden. Click a breadcrumb to open any ancestor folder. **Shift+Enter** opens a focused local folder in the system file manager. On **..**, it opens the current folder. For a file, **Shift+Enter** behaves like **Enter**. The address shows the current location and all breadcrumbs that fit. Dimmed segments return to a folder on the previous branch. Use the leading ellipsis to open hidden parent folders and the trailing ellipsis to open hidden folders on the previous branch. Hover over the address to edit or copy it, or press **Ctrl+L** to type a path. When a folder opens slowly or sizes are being calculated, **Esc** cancels the pending operation. Moving to another folder also cancels its size calculation.

Choose **Standard**, **Twin panels**, or **Classic commander** in **Options → Main File Panels → Panel layout**. Every layout works with every color scheme. Twin panels keeps file icons and adds drive buttons with icons, a line with the drive's free space above each list, column separators, and a flat key bar with icons. Classic commander uses dense rows without icons, a bar of drives and places above each pane, details of the current item below the list, and a function-key strip. Marked items use the **Marked items** color from **Appearance → Panels** for their check marks. The active and inactive selection colors set the row backgrounds. The pane footer shows the free space on the volume of a local folder.

The current marked row in the active pane has its own fill and outline. Adjust or reset **Current marked row background** and **Current marked row outline** independently in **Options → Appearance → Panels**.

Enable **Right-click selection** under **Options → Main File Panels** to mark an item with a short right-click. Drag with the right button held to mark the rows you cross, or start on a marked row to unmark them. Hold the button over a row or empty pane space for half a second and release when the spinner appears to open the usual context menu.

Choose **List** or **Tree** independently in either local file pane. Use a folder's disclosure button or Left and Right to traverse the tree. You can mark and operate on items across branches. Switching to List from a nested row opens that item's parent and keeps it selected if available. Turn on **Folder sizes** to scan the current subtree in the background in either view. Use **Refresh** to recalculate after changes. Completed values stay visible until their replacements are ready. An ellipsis indicates a pending size, a dash indicates an unavailable size, and ≥ marks a partial total. Choose **Size on disk** when allocation is available. The toggle starts off each time the app opens.

Click the free-space indicator or **Analyze space** to scan the folder shown in that pane. The adjacent arrow offers the containing volume, share, or connection root when available. The tree and treemap show file sizes or allocated storage, with percentages relative to each item's parent. **Show in other pane** opens a folder or selects a file there. **Stop** keeps partial results, **Rescan** repeats the same scope, and **Close** restores the file list. On Windows, full local NTFS volume scans use the Master File Table when accessible. Without volume access, Dirlume reads the sizes and file IDs of local NTFS directory entries in batches and scans folders concurrently. On solid-state storage, it uses up to 16 workers when the processor supports them. Local scans stream results to the pane as they arrive. Configure the **Analyze space** binding in **Options → Keyboard shortcuts**.

In the local **Space Analyzer → Tree**, right-click a file or folder for its actions. Windows opens the Shell menu when available. Use **F5** to copy, **F6** to rename or move, **F8** to follow the location's Trash policy, or **Shift+Delete** to review permanent deletion. The same shortcut settings apply in the file pane and the analyzer. Copy and move suggest the other pane's directory when supported. Results refresh after file operations while keeping expanded branches.

**F3** measures selected local folders in List view with the Space Analyzer scanner. It shows each folder's logical file size as its scan completes. **Esc** cancels pending measurements and keeps completed totals. In Tree view, **F3** measures the selected folder and its descendants without changing the **Folder sizes** toggle.

Open **Space Analyzer** in either pane from the Left or Right menu, the free-space control, or **left Ctrl+5** on the number row. Each pane keeps its own scan and selection. The breadcrumbs show the selected folder or file's parent. Choose a breadcrumb within the scan to reveal its folder, or choose a folder above the root to scan it. In a local or matching SSH terminal, successful directory changes follow the same rules. In Tree, **Tab** switches panes and marked items take precedence for file actions. Choose a file panel mode such as **Full** to browse the current folder and keep the selected file. **Close** or **Esc** restores the previous file view.

Choose **Disk information** from the Left or Right menu, or press **Ctrl+Shift+L**, to inspect the current folder's volume or filesystem-backed share in the opposite pane. Invoke it again to restore the previous view. **Scan volume** or **Scan share** opens Space Analyzer at that root. **Sunburst** shows two levels of storage use. Its item list supports keyboard selection and **Shift+F10** for context actions. Right-click a Sunburst sector or Treemap tile to reveal that exact item in the other pane or use the available local file actions. Selecting a view saves it as the default for future scans.

The status row below each file list puts the configured current-item details on the left and counts and marked size on the right. Hover over shortened text to see the full details.

Set **Main menu position** under **Options → General**. Set **Action button width** under **Options → Main File Panels** to switch between compact and full-width buttons. Turn on **Hide action button icons** for a text-only File actions bar in any panel layout.

Dirlume bundles **GoMono Nerd Font Mono** from [Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1). By default, file panels use it at **15 px**, and the viewer, editor, and terminal use it at **18 px**. Menus, toolbars, and dialogs use the system interface font at **14 px**. Choose it by name in the font picker or clear an override to use the default. The bundled faces work offline. The [font notices](src/assets/fonts/GoMono-NOTICE.txt) and upstream licenses are included in the desktop packages.

Use **Options → Appearance → Window → New scheme** to save your own colors for the window, file panels, dialogs, and text tools. In **File types**, edit the built-in extension groups or add your own. Set a filename color or font for each group. Matching uses the last extension and ignores letter case. Adding an extension already assigned elsewhere asks you to confirm the move. An inherited or unavailable group font uses the file pane font. In **Fonts**, type a name to filter installed fonts in the dropdown, or open the full list with the arrow button. Use the arrow keys and Enter to choose a font, or click a result. Use **Options → Keyboard shortcuts** to change, disable, or reset a binding. **Apply** saves changes and keeps Options open. **Done** saves and closes Options.

**File types** has separate colors for hidden and system items. Their names are italic and slightly dimmed. Hidden items include dot-prefixed names and items with the Windows Hidden attribute. Items with the Windows System attribute use the system color, including when they are also hidden. **Show hidden files** controls whether hidden items are listed.

Use **Search settings** above the Options tree to find a setting or shortcut. **Main File Panels** contains hidden-file visibility, pane fonts and sizes, and panel colors. Set individual fonts and colors in **Viewer** (including Hex Viewer and Markdown preview), **Editor**, **Terminal** (including Command line), and **Appearance → Text tools → Compare files**. Each field shows its effective value and whether the scheme inherits or customizes it. Reset a field to restore its inherited value. **General** contains the interface language and remote connection settings.

Use **Pick an element** beside **Search settings** to find the appearance controls for something visible on screen. Options hides while you point at the element. Click the highlight to return to Options with its colors, fonts, and sizes together. Press **Esc** to return to the same page and keep your draft. **Picker history** lists successful picks by local date and reopens them with current values. The history stores appearance categories and states.

In a color dialog, choose **Pick a color from the screen** and click a visible pixel in any application. **Use color** accepts the sample. **Esc** cancels the sample and keeps the previous color. Wayland sessions use the desktop's color picker portal.

In **Options → Keyboard shortcuts**, use **Add shortcut** to give a command another binding. Click an existing binding to replace it or its **×** to remove it. If the shortcut is already assigned in the same context, choose **Reassign shortcut** to move just that binding, or **Choose another shortcut** to keep entering a different combination. Commands in separate contexts can share a shortcut.

Choose a **Shortcut scheme** to switch the full set of bindings. **New scheme** copies the selected scheme. Editing **Default** creates a personal scheme, and existing custom shortcuts move to **My shortcuts** on upgrade. **Restore defaults** resets the selected personal scheme. Choose **Apply** or **Done** to use the selected scheme and save your changes.

Use **Settings** in the viewer or editor toolbar to open its section directly. The controls show the inherited font family and pixel size when no override is set. New installations use **GoMono Nerd Font Mono** at **18 px**.

**Viewer → Reading area** controls the shared maximum width and the background beside a narrower reading column. The document scrolls at the right edge of the Viewer. Under **Viewer → Markdown**, rendered Markdown can use the shared width, a custom width, or full width. Markdown in **Source** uses the shared width. **Viewer → Mermaid diagrams** controls the default block background, text, and border colors. The document header displays the encoding and, in source view, the syntax selector.

Drag the Options title bar to position it independently of the main window. Drag any edge or corner to resize it. When Options reopens, it restores the last window size, section, search, and scroll position. The preview below the settings shows draft colors and fonts before you apply them. Click a color swatch to choose a hue and shade or enter a HEX value. Editing a built-in color creates a custom scheme. Hover over a control to see details such as an icon's action, a shortcut that is missing from the control, or the full text of a clipped value. On Windows, file panels and the process table share a cache of Shell icons for executables and registered file types.

| Default keys | Action |
| --- | --- |
| F1 | Open offline Help for the control under the pointer or the most recent keyboard focus. In an open dialog, Help stays within that dialog. Use Search Help to find topics and passages across the current language, then press Esc to return to the previous control. Configure Help and Search Help under Options → Keyboard shortcuts. |
| Alt or F9 | Focus the main menu and reveal it if its title-bar display is disabled. Use the arrow keys to browse, Enter to run a command, and Esc to return to the previous control. |
| Tab, arrows, Insert | Switch panes, navigate, and mark files. Ctrl-click or Shift-click also selects multiple items. |
| Shift+↑ / Shift+↓ | Toggle the mark on the file or folder under the cursor, then move one row in that direction when possible. At either end of the list, the cursor stays in place and the mark still toggles. |
| Alt+F1 / Alt+F2 | Open sources for the left or right pane. On Windows, select a drive by letter to open the other pane's local folder on that drive, or open the drive root. |
| F2 / Ctrl+R | Refresh the active pane. F2 saves when editing a text file. |
| F3 / F4 / Shift+F4 | View text or Markdown, edit text, or create and edit a new file. F3 measures folders. |
| Ctrl+Wheel | Change the font size of the Dirlume area under the pointer. |
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
| Configurable | Open **User Menu** from a local file pane. Set **Open User Menu** in **Options → Keyboard shortcuts**. |
| Shift+F1 | Create an archive from local files and folders. |
| F7 / F8 or Delete / Shift+Delete | Create folders or directory links, send selected items to Trash, or permanently delete after confirmation. |
| Ctrl+C / Ctrl+V in a file list | Copy local files to the system clipboard or paste files into the active local folder. |
| Ctrl+Insert in a file list | Copy the marked item names, one per line in pane order. With no marks, copy the name under the cursor. |
| Ctrl+V in the terminal | Paste text into the active local or SSH session. |
| Ctrl+Shift+C (⌘⇧C on macOS) in a file list | Copy the current file or folder's full path as text. Also available under Commands → Copy full path. |
| Ctrl+O / Ctrl+Left / Ctrl+Right | Hide or show the panes, or move the divider. Drag the divider to resize with the mouse. |
| Ctrl+↑ / Ctrl+↓ | Expand the terminal or give height back to the file panes. The last step restores the command line. |
| Ctrl+F / Ctrl+Enter | Insert the selected path or name in the command line. Ctrl+F on **..** inserts the current folder path in a local or SSH pane. |
| Ctrl+E / Alt+F8 | Recall earlier commands or open the shared command history. The terminal receives keystrokes while its input has focus. |
| Shift+F11 | Compare the selected files, or choose **Commands → Compare files**. Use F7 and F8 to navigate between differences. |

In **New folder**, enable **Process multiple names** to separate names with commas or semicolons. Put names containing a separator in double quotes. For a link, choose **Symbolic link** or **Directory junction** on Windows, then select an existing target folder. Press **Alt+Down** in the dialog to recall successful names from history.

Click **Terminal** or press **F12** to show or hide the interactive shell. Dirlume keeps a local shell and a separate shell for each SSH connection. The active local or SSH pane and its terminal synchronize their working directories when a supported shell returns to its prompt. Hiding the terminal preserves the session and its split height. Use **Ctrl+↑/↓** to resize it in steps or **Ctrl+O** to hide or restore the file panes. Click **Close terminal** to end the active session.

Open **Commands → User Menu** to run saved commands from the captured local pane. The current folder's `.dirlume-menu.json` takes precedence over the personal menu. Use **Menu source** to switch to a parent or personal menu, and **Manage menus** to edit commands, submenus, and separators. Assign a letter, digit, or function key within each menu level. Choose a visibility rule and use **Show hidden entries** to find filtered commands.

Use **Insert token** to add the active folder, opposite folder, focused name, path, stem or extension, marked paths, or a named prompt. Enter shell steps one per line. Put tokens where arguments go, without adding extra quotes. Folder definitions require a review and approval of their current contents for the session. The preview shows substituted values before prompted commands run. Commands run in order in their own PowerShell, sh, dash, Bash, or Zsh session. The Terminal reports failures and exit status. **Stop** cancels remaining steps. Completed steps can leave changes.

The shell receives keystrokes while its input has focus. A hint in the status bar, or beside the close button in the terminal header when the status bar is hidden, reminds you to click a file pane to use its shortcuts. Use the question-mark button to open offline Help and return to your command when you close it. Click **Terminal** to restore the panes when they are hidden. The terminal layout shortcuts remain available while editing a shell command. From the command line, **Alt+F8** opens dated history to search, edit, or rerun earlier commands. Dirlume keeps the last 1,000 submissions from the command line and from supported embedded shells.

Right-click local or SSH terminal output to open **Copy**, **Paste**, and **Select All**. On macOS, Control-click also opens the menu. **Select All** includes retained scrollback. Copy selected text to the system clipboard with **Ctrl+Shift+C** on Windows and Ubuntu or **Command+C** on macOS. Change or disable the binding under **Options → Keyboard shortcuts**. **Ctrl+C** interrupts the shell. Over an HTTP(S) link, the menu also offers **Open Link** and **Copy Link Address**. Enable **Paste on right-click** in **Options → Terminal** to paste directly.

Left-click an HTTP or HTTPS link in local or SSH terminal output to open it in the default browser on the computer running Dirlume. Hover over a labeled terminal hyperlink to see its destination before opening it.

In the Windows PowerShell terminal, `cd` suggests directories as you type. Select a folder to continue into its children. For a Linux SSH connection, the Command line retrieves suggestions from the selected remote folder even before you open the Terminal. Supported prompts use their current shell environment. On Windows and Linux, both inputs can complete Docker subcommands and options, including commands outside `docker container` and `docker compose`. Container suggestions use the active Docker context or an explicit `--context`. Compose suggests services from the current project, including projects selected through `-f` or `COMPOSE_FILE`.

At a supported PowerShell, Bash, or Zsh prompt, the terminal shows suggestions next to the caret as you edit a single-line command. Use **↑/↓** to select, **Tab** to insert the selected or first suggestion, or **Esc** to dismiss. Click a suggestion or press **Enter** with one selected to insert it. **Enter** submits the command when the list has no selection. Dirlume SSH terminals use the remote working directory and search path. If you run `ssh` yourself, the parent terminal suspends suggestions until it recognizes its prompt again.

Type in the command line to see matching history and completions for the active local folder. It stays available while the terminal is open below the file panes. **Enter** submits the draft to the matching terminal in the directory displayed when you submit it. If the terminal is busy, the command waits for its prompt. If the shell cannot enter the directory, the terminal shows the error and skips the command. On Windows, PowerShell supplies completions, including options for Windows tools and installed Git and .NET commands. On macOS and Linux, Dirlume uses available Bash or Zsh completions and can also complete executable names and paths. On Windows and Linux, path suggestions follow the command’s completion rules. Start an explicit path such as `./` to request paths where the command allows them. Use **↑/↓** to choose a suggestion, **Tab** or **Enter** to insert it, and **Esc** to dismiss the list. **Shift+Enter** runs the draft with a suggestion selected.

On Windows, **Options → Terminal → Automatically refresh environment variables** is enabled by default. New PowerShell sessions read the current user and system variables, including PATH. If Windows reports a change while a terminal is open, Dirlume shows a notice. Reopen the terminal when you are ready to use the new values.

**Find files** searches local folders and connected sources. Masks are case-insensitive. **Show in panel** displays all collected matches in the searching pane. Relative paths identify files from different folders. You can view, edit, mark, compare, or copy files from there. With local results, you can also move files to a local destination, send them to Trash, or permanently delete them using the file-pane commands and confirmations. Successfully moved or removed files disappear from the results. **Ctrl+R** or **Refresh** reruns a local search in place with its original folder, mask, and visibility settings. Use **Go to selected file** to open the containing folder for renaming.

**Compare files** opens a separate window. Use **Previous** and **Next** to select a change, then **Apply to left** or **Apply to right** to transfer it. Turn on **Edit files** to work directly in both panes. When closing with unsaved edits, choose **Overwrite original** or **Save as** for each changed file.

Open the syntax control in the Viewer or Editor header or choose **Syntax → Choose syntax…** to search by language, alias, or extension. Use the arrow keys and **Enter** to apply a choice. **Automatic** uses filename detection and **Plain text** turns off highlighting. Customize syntax colors for the individual tool in **Options → Viewer** or **Options → Editor**. The shared syntax colors remain in **Appearance → Text tools**.

Nginx highlighting turns on automatically for `nginx.conf`, for `*.conf` beneath an `nginx` folder, and for files directly in `nginx/sites-available` or `nginx/sites-enabled`. This works for local and SFTP files, including site files named after a domain. For a configuration stored elsewhere, choose **Nginx** in the syntax control.

Markdown preview renders fenced Mermaid diagrams. Use **HTML formatting** in the viewer toolbar to toggle support for inline spans that specify `white-space: nowrap` in table cells. The setting applies to the open viewer tab. The **Open documents** bar switches between the files view and open documents. Dirlume restores local browsing history, selection, layout, and viewer/editor windows at startup. Unsaved changes require confirmation before closing the editor or exiting.

Press **Ctrl+Q** or select **Quick View** in the main toolbar to preview the current file in the opposite pane while browsing. Toggle it again to restore that pane. **Ctrl+Left** and **Ctrl+Right** move the divider. Use **Rendered** and **Source** in the toolbar for Markdown and HTML. Rendered HTML runs no scripts and loads no external resources. For PNG, JPEG, GIF, WebP, and BMP images up to 16 MiB, use the buttons to zoom, fit, or rotate the preview.

Quick View shows binary files as scrollable single-cell characters in file order. Each byte uses the DOS CP437 glyph mapping, and zero bytes appear as blank cells. Rows wrap to fit the pane.

Press **F3** to open a PNG, JPEG, GIF, WebP, or BMP up to 16 MiB in the image Viewer. **Fit** shows the whole image and **100%** shows the original pixels. Drag a zoomed image to pan, or hold the configured wheel-zoom modifier and scroll to zoom around the pointer. **Previous image** and **Next image** follow the originating pane's sort order and filter in the same tab. Use **F4** to switch between the image and Hex, and **Esc** or **F10** to return to the last viewed file.

Use **F4** on a local single-frame PNG or JPEG to edit it, or **F6** to switch between its saved view and your editing draft. Rotate 90° with **[** or **]**. Use **Crop** to draw a rectangle or set its position and size in image pixels, and choose free, original, preset, or custom proportions. **Apply crop** adds the selection to the draft. **Save a copy** saves in the source format without overwriting a file. **Replace original** asks for confirmation and checks whether the original changed. Camera and color profile metadata may be lost on export. The editor supports images up to 16 MiB and 32 megapixels.

With Git installed, choose **Git View** beside **Quick View** from a local repository folder. The active pane lists local and remote-tracking branches. The opposite pane shows the selected branch or detached HEAD history. Open a commit to see its message and changed paths, or select **Load more** to continue through older commits. For a merge, the changed paths are relative to the first parent. **Refresh** rereads local Git data. Toggle **Git View** again to resume file browsing. Configure the shortcut in **Options → Keyboard shortcuts**.

In **Changes**, use **Stage** or **Unstage** in the preview pane to update the selected path in the index. Replacing a staged version with the full working file requires confirmation. **Commit…** opens a review of every staged path, including paths hidden by the filter. Choose a path to inspect the staged diff, enter a message, and confirm to create a local commit on the checked-out branch. If the branch or index changed since the review, refresh and confirm again. Git executes configured hooks and signing without an interactive terminal. A hook that changes the reviewed commit contents cancels the commit. Use a terminal for interactive Git operations.

Select **Changes** to review staged, unstaged, and untracked files across the repository. Filter by path and use the arrow keys to read each inline diff in the opposite pane. Staged changes compare HEAD with the index, and unstaged changes compare the index with the working file. **Open in Viewer** or **Open in Editor** opens the current working file. Saving refreshes Changes and leaves staged content intact. Use **Refresh** to pick up changes made in other applications.

### Environment variables

Choose **Commands → Environment variables** in either pane, then open **User variables**, **System variables**, or the read-only **Dirlume process environment**. The list shows variable names and definition sources in aligned columns. With the list focused, press **Alt+Letter** or **Alt+0–9** to start Quick search by name prefix. On macOS, use **Option** for Alt. Use **Up** or **Down** to cycle through matches, **Enter** to inspect the current match, and **Escape** to return to the list. Quick search works within the rows shown by **Filter variables** and uses the **Quick search by name** binding in Options.

Press **Enter** or **F3** to inspect a value, **F4** to edit, and **Shift+F4** to create a variable. Use **F5** to review and copy selected or marked variables to an opposite pane showing the other writable scope. **Ctrl+R** reloads the scope. **Back to files** restores the file pane.

On Windows, saved definitions are read from the user and machine Environment registry keys. Saved strings retain their expandable type and raw text. Start a new PowerShell session with **Refresh environment** enabled to pick up registry changes. On Ubuntu, Dirlume writes `90-dirlume-user.conf` in the user `environment.d` directory and `/etc/environment.d/90-dirlume-system.conf` for system defaults. Reload the systemd user manager or sign in again so newly launched user services inherit the definitions. On macOS, enable login shell integration to add a startup hook to `.zprofile` or `/etc/zprofile`. The dialog previews which file will change. Start a new `zsh` login shell to load the managed definitions. System writes can request administrator authorization.

In **New file** (**Shift+F4**), choose UTF-8, UTF-8 with BOM, UTF-16 LE, or UTF-16 BE. UTF-8 is the default. The editor preserves the chosen encoding when saving or reopening the file.

In Markdown preview, a link to another Markdown document navigates in the current viewer tab. Ctrl+Click opens the target in a separate viewer tab. Heading links scroll to the heading, and HTTP and HTTPS links open in your browser. Use **Back** and **Forward** to revisit documents and restore reading positions in the current tab. **Search** finds text in the rendered document. Clicking a task checkbox saves the changed marker in a local or writable FTP file. If the editor already contains unsaved changes, the checkbox becomes part of that draft and is written when you save. Task checkboxes on read-only sources are disabled.

The Viewer and Editor have document-specific menus that show configured shortcuts. The Editor also has a shortcut strip. In Text Viewer, use **File** to open an editable file in the Editor or close the document. **Navigate** offers **Search** in rendered Markdown and **Hex** in source and hexadecimal views. In text and source views, **Display → Show whitespace** reveals spaces and tabs. Set the shared **Tab width** in **Options → Viewer** or **Options → Editor**. It defaults to four columns and applies with markers on or off. Both settings are saved and leave copied and saved text intact. The header shows the active file's full path and document status.

In the local text Viewer, click beside a line number or use **Navigate → Bookmark line**. In local Markdown **Preview**, select text and choose **Navigate → Bookmark selection**. Both actions use the configurable bookmark shortcut, **Ctrl+Alt+B** by default. **File bookmarks** in the Viewer shows the current file's bookmarks. **Commands → File bookmarks** in the file panes shows every saved bookmark, including entries for closed files. Press **Enter** to open an entry at its saved source line or highlight the saved passage in Preview. Preview bookmarks match the saved text and its surroundings. If the passage cannot be distinguished or found, the entry stays available to retry or remove. You can rename or remove either kind of bookmark from both lists. Bookmarks persist across restarts.

Use **F6** or the document's **File** menu to switch modes for the current file. The Viewer shows the saved file, and the Editor keeps its unsaved changes when you return. Change or disable the shortcut in **Options → Keyboard shortcuts**. In the file panes, **F6** still opens **Rename or move**.

The Viewer refreshes an open local file when it changes on disk. The Editor offers **Reload from disk** to open the updated file or **Keep editing** to retain the current buffer. Reloading discards any unsaved edits. Saving still checks that the disk contents match the version originally opened or last saved by the Editor.

Use **Ctrl+Wheel** over the main interface, either file pane, a file pane dialog such as **Folder shortcuts**, **Options**, the Terminal, the command line, **Compare files**, or a document view to change its text size. Related dialogs share the same adjustment. The file panes, text Viewer, Hex Viewer, Editor, and Markdown preview each remember their own size. Adjustments persist and appear in **Appearance → View font sizes**, where clearing a value restores the inherited size. **Keyboard shortcuts** lets you reassign or disable **Font zoom with mouse wheel**. An imported font that is unavailable uses its current inherited fallback and keeps its saved name.

Drag marked files and folders into the other local pane to open the transfer dialog. Select **Move instead of copying** to move local items. Both local panes watch their folders, and connected sources are refreshed periodically.

Open either pane's sources with **Alt+F1** or **Alt+F2**, then choose **Processes** or press **0** to view running processes, CPU usage, and memory. Click a column heading to sort, or use **Alt+Letter** to search by process name. Windows shows executable icons when they are available. **F8** asks before ending marked processes.

Right-click a process row or press **Shift+F10** on the focused row to inspect its properties, show its executable in the other pane, copy the PID or executable path, or ask to end that process. The row menu keeps the existing marks. The footer and its shortcut continue to act on the marked processes. Windows lock results omit **Show in other pane** so the locked item stays selected.

On Windows, select a local file or folder and choose **Find locking processes** from the main menu. A sharing violation can also offer this action. The opposite pane shows what Windows found and keeps the source selection. Choose **Properties** for executable details or **Back to files** to return to the previous location. Both **F8** and **End process** in Properties ask for confirmation.

Right-click an item or the empty space in a Windows filesystem pane for the classic Shell context menu. Dirlume provides its own file actions menu for FTP panes and for Linux and macOS.

When Windows denies access, **Open as administrator** requests UAC for a separate Dirlume window with the **Administrator** title bar label. The new window uses the original window's applied preferences and opens the parent and selected item in the requesting pane. It also restores the opposite local folder or reopens Space Analyzer at its local root. Retry the action in the new window after it opens.

Press **Ctrl+A** while focused on a file list to inspect the current item’s attributes, owner, and timestamps. **Apply** saves supported flags and refreshes the file panes. Windows supports Archive, Hidden, System, Not indexed, and Read-only on files. On Linux and macOS you can change the owner’s write bit. Remote item details are read-only and depend on what the source reports.

In the main menu, **Help → Help** opens the offline guide and **Help → About** shows the running version. **Commands → Check for updates** checks for a desktop update.

## Build

Install Node.js 24, Rust via rustup, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Windows uses MSVC and WebView2. Ubuntu uses WebKitGTK 4.1.

```sh
npm ci
npm run tauri -- dev
```

Before starting the local desktop dev server, Dirlume measures the debug files in Cargo's target and build directories. If their combined file size exceeds 30 GiB, it runs `cargo clean --profile dev -p dirlume` to remove Dirlume's development artifacts. To apply the same check before a direct Cargo build or test, run `node scripts/clean-debug-artifacts.mjs` from the repository root.

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

For Windows memory investigations, [measure WebView2 by PID and process role](docs/webview2-memory.md).

## Archives

Packaged Dirlume includes the [7-Zip command-line tools](https://www.7-zip.org/download.html), including their license and source. Archive operations work offline. A development build can use a system copy of `7zz`, `7z`, or `7za`. Run `./scripts/prepare-7zip.ps1` before building a desktop package to prepare the pinned tools. Select local items and press **Shift+F1** to create a ZIP, 7z, TAR, or WIM archive when the tool supports the format. The dialog supports compression profiles, AES encryption, split volumes, and self-extracting archives on Windows. Profiles store compression options without passwords.

Press **Enter** on an archive to open it in a pane. Use **F5** to extract selected members to a local folder with the normal copy conflict prompts, **F3** to view files, or the **Parent folder** button to go up. A writable archive supports editing text files with **F4** and removing selected members with **F8**. Encrypted, split, and other formats without update support open read-only. Dirlume skips unsafe member paths and refuses to extract links.

With a writable, unencrypted ZIP or 7z archive open, select local files or folders in the other pane and press **F5** to copy into the displayed archive folder. The confirmation shows the archive filename and member path. Use **F7** to create an empty folder or **F2** to rename one entry in the archive. Canceling a write before replacement keeps the original archive and source files.

## Remote sources

Choose **NetBox**, **SMB**, or **Remote machine** from either pane's sources menu to open saved connections. NetBox shows FTP and SFTP profiles together with their name, protocol, and host. Press **2** in the sources menu to open NetBox, **Shift+F4** to add a profile, **F4** to edit it, and **Enter** to connect. Configure the shortcuts in **Options → Keyboard shortcuts**.

While browsing a remote folder, choose the source breadcrumb or its entry in the sources menu to open saved connections in the same pane. NetBox selects the current connection. Use the dimmed path to return directly to a folder on that connection. **Back** returns to the remote folder, and **Forward** opens the list again.

New NetBox profiles default to **SFTP (SSH)** on port 22. Choose the protocol on the **Session** page. SSH supports password or private-key authentication, with an optional key passphrase. Dirlume keeps passwords and passphrases in the system credential store and reads the private key from its existing location.

On **Directories**, enter an absolute starting folder or leave the field empty for the server default. Enable **Remember last used directory** to try the last successfully opened folder first. If that folder is unavailable, NetBox tries the configured folder and then the server default. A bookmark opens its saved path. Back and Forward can use cached listings for visited folders. Enable **Cache directory changes** to reuse listings during ordinary navigation and **Keep directory cache after closing Dirlume** to retain them across restarts. **Refresh folder** always reads the server. SFTP can follow symbolic links to directories and use the target path for navigation.

On **Environment**, choose LF or CRLF for text files with no existing line endings. Editing preserves detected line endings, and binary transfers keep the original bytes. FTP profiles can also use a legacy filename encoding. For legacy FTP LIST timestamps, choose a fixed server offset from UTC or use this computer’s time zone. The local option can use the offset on each file’s date or today’s offset for all dates. SFTP and FTP MLSD timestamps already specify UTC and are used as received. **Preserve modification times on downloads** controls whether copies to local files receive the remote modification time.

Use **Test connection** to check credentials and list the server's initial directory before saving. Approval of a new SSH host key applies only to that test.

On **SFTP**, leave **SFTP server command** blank to use the standard subsystem. Enter a command only when the server requires a different way to start SFTP. Use **Interpret SFTP modification times as signed** with servers that encode dates before 1970 as signed 32-bit seconds. The bundled client uses SFTP version 3 and applies the server's supported transfer limits. Choosing other versions or manual packet caps requires a client with those controls. Symlink argument order applies to link creation, which Dirlume does not offer in SFTP. On **Shell**, choose the server's default shell, Bash, Zsh, or sh for the SSH terminal.

On **Proxy**, choose **SOCKS5** or **HTTP CONNECT** and enter the proxy address and optional credentials. Dirlume stores the proxy password in the system credential store. Destination names resolve at the proxy by default. Select **On this computer** to resolve them before connecting, or enable the loopback option to connect directly to localhost and loopback addresses. A configured proxy failure is reported on the saved route. FTP and FTPS use the proxy for control and passive data connections. SFTP and the SSH terminal use the same route. With SSH jump hosts, the proxy connects to the first hop and SSH forwards the rest.

If the destination is reachable through bastion servers, add each server under **Jump hosts** in the SSH or SFTP profile. Put the host this computer can reach first, followed by the remaining hosts in connection order. Enter the credentials for each hop and check the **Route** preview. Each jump server must permit SSH TCP forwarding to the next server's SSH port. **Test connection** follows the route and lists the destination's initial SFTP directory. A saved route also applies to the SSH terminal, bookmark reconnects, and file transfers. An empty jump-host list connects directly.

On first connection, verify the displayed SHA-256 host key fingerprint with your server administrator before choosing **Trust and connect**. Dirlume checks that fingerprint before authenticating and blocks the connection if the host key changes. The pin is shared by all SSH profiles for the same host and port. For a planned key rotation, independently verify the new fingerprint, close Dirlume, and remove the matching entry from the `trustedHosts` list in `ssh-profiles.json` in Dirlume's app configuration directory. Reopen Dirlume and verify the displayed fingerprint again.

The SSH pane opens in the server's initial directory. Browse with the file list, breadcrumbs, or an absolute path starting with / in the pane address. If SFTP cannot recover after an unexpected SSH terminal closure, a folder open, or a refresh, the pane returns to NetBox. Choose the profile again to reconnect. A normal shell exit leaves the file pane open. Press **F5** to copy files or folders between a local pane and the SSH pane with progress, cancellation, and conflict prompts. Replacing an existing server file requires the SFTP server to support the OpenSSH POSIX rename extension.

Press **F6** on one or more regular local files with a connected SSH/SFTP folder in the other pane to move those files. Copy and Move show the connection beside the editable destination path. Move removes each local source after the server commits that upload. If removal fails, the dialog identifies the uploaded file and the source. Retry checks both files before trying removal again.

Press **F3** to view a remote file or **F4** to edit text. Saving preserves the file encoding and checks whether the file changed on the server. SSH editing uses the same safe replacement extension as copying over an existing file. If SFTP denies directory access, text reading, or saving, use **Open with sudo** or **Save with sudo** to retry. The server must allow the SSH account to run the external OpenSSH SFTP server through sudo. Dirlume uses the password only to open the authorized session. Subsequent protected operations on that connection can reuse the session until it has been idle for five minutes or the connection closes. Browsing and reading open a read-only session, and the first protected save requires write authorization.

Press **F8** or **Shift+Delete** to permanently delete selected items on FTP, SSH, and Windows SMB shares opened by UNC path. On FTP and SSH, Dirlume asks separately before deleting the contents of a nonempty folder. Deletion uses the connected account's standard permissions.

To add an FTP profile, choose **FTP** in the new NetBox profile’s **Protocol** field. FTP uses port 21 by default and supports anonymous login with an empty username. Dirlume stores passwords in the system credential store and filenames use UTF-8 by default. Set a filename code page for legacy FTP servers. Plain FTP sends passwords and files without encryption.

The pane opens at the server's initial directory. Use **F5** to copy files or folders between a local pane and an FTP pane in either direction. The transfer dialog shows progress and asks about conflicts. An upload completes under a temporary name before Dirlume renames it to the destination. Replacing an existing file requires a server that allows rename over the destination.

At startup, Dirlume reconnects to the saved FTP profile and reopens the last FTP folder in the same pane. If reconnection fails, the pane shows a local folder and reports the error. Dirlume keeps the FTP location for the next startup until you navigate to another location in that pane.

Inside an FTP pane, **F3** or **Enter** opens a file in the viewer. **F3** also measures folders. **F4** opens a text file for editing and **F2** saves it back to the server if the original revision still matches. **F6** renames an item and **F8** prompts before permanently deleting selected items, with an additional confirmation for nonempty folders. FTP files can be included in a text comparison. The viewer and editor show the full address of a remote file, including the protocol, host, any non-default port, and filename.

**Dirlume server** runs as a separate process on Windows, Ubuntu, and macOS and shares one folder with read access over TLS. Browse and download files and directories, or open and compare text in Dirlume. [Server setup and autostart](docs/server.md).

**Dirlume LAN** lists available remote drives under their computer name in either pane's sources. To pair with another Dirlume instance, open **Options → Computers** on the host, generate and copy its pairing code, then save the computer in **Options → Computers** on the guest. The guest can browse and download from the host's local locations while the host keeps access enabled. Reopen the pane sources to refresh attached drives. Stopping access or exiting the host invalidates the current code.

On Windows, authorize `Dirlume.exe` in **KSwitcher → Computers → Trusted clients** to use the resident KSwitcher LAN service. Each online paired computer appears under **Dirlume LAN** in either pane's sources. Choose a drive to open it directly. Dirlume can browse and download regular files using the existing LAN pair’s permissions. If the executable changes, add it again in KSwitcher.

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
Add an **SMB** connection on Windows, macOS, or Ubuntu using a server name, IP address, or share address such as `smb://server/documents`. Windows also supports UNC paths. Opening a saved server shows its shares as folders. At a share's root, use **Parent folder** to return to the share list. **Remember credentials** saves a successful sign-in in the system credential store. Ubuntu uses the `gvfs-backends` and `gvfs-fuse` packages to open shares from a desktop session.

## Desktop diagnostics

Choose **Help → Open error log** to inspect the journal. In the viewer, choose **File → Clear error log** to remove its entries after confirmation. Dirlume continues recording new errors after the log is cleared.

Use **Help → Open error log** to see the latest entries first, with local timestamps down to the millisecond. Expand an entry to inspect its fields and recent actions. A warning icon marks panics, and partial lines can be opened individually. Select **Source** to copy the original JSONL in file order. Opening a JSONL file from a file pane uses the regular text viewer.

Dirlume appends one JSON object per error to `diagnostics.jsonl` in the application data directory:

- Windows: `%LOCALAPPDATA%\io.github.agrynco.dirlume\logs\diagnostics.jsonl`
- Linux: `$XDG_DATA_HOME/io.github.agrynco.dirlume/logs/diagnostics.jsonl` (defaults to `~/.local/share`)
- macOS: `~/Library/Application Support/io.github.agrynco.dirlume/logs/diagnostics.jsonl`

Each entry records the failed operation, an error code, a timestamp in Unix milliseconds, and up to 32 recent actions in chronological order. Successful actions remain in memory. The log persists between sessions and uses allowlisted operation names and error codes, along with numeric OS error codes when available. It omits user and absolute build paths, command input, credentials, URLs, raw error text, and file contents.

For Rust panics, the `panic` object includes the desktop build, platform, architecture and, when known, the repository-relative Rust source path and line. Use the build number to locate the matching GitHub Actions build and source revision. The `subsystem` and `command` fields describe the failing worker when that context is available. An outcome of `recovered` means a desktop worker caught the panic. Other panics report `unknown`. A missing source, subsystem, or command is represented by `null`.

For JavaScript failures reported by the window, a rejected promise, or React, the `frontend` object includes the desktop build, platform, architecture, origin, and known window surface. Its `source` contains the bundled asset basename and one-based generated line and column when available, or `null` when the location is unknown. To resolve the coordinates, download the `frontend-maps-<version>-build.<build>-<platform>` artifact from the matching GitHub Actions run. Open `<asset>.map` with a source map reader and look up the generated coordinates. With Node 24, use `new SourceMap(map).findOrigin(line, column)` from `node:module`, where `map` is the parsed JSON. Local builds place the maps in `src-tauri/target/frontend-sourcemaps`. Desktop packages omit these maps.

Local text reads that encounter a problem include `fileRead` with the caller surface when known, the platform, the stage and reason, and any native `osCode`. A `preview_fallback` entry with outcome `recovered` means Quick View found a usable preview after its text read failed. An unsuccessful fallback reports `failed` and includes the fallback stage and cause. Read numeric codes in the context of the operating system that wrote the log.

A failed update check includes `updateCheck` with the initiating trigger, build, platform, architecture, package target, stage, and reason. `httpStatus` is the code of the response available at the failure. A rate limit can be identified from HTTP 429 or a 403 with rate-limit headers. The update check records none of the response headers or body. Download and installation errors still use `install_update`.

## CI and releases

The [DirLume project board](https://github.com/users/agrynco/projects/12/views/1) uses issue labels, issue branches, and task pull requests to keep its columns current. The `ready for dev` label moves a queued issue to **Ready**. A published `codex/issue-N` branch or draft task pull request marks it **In progress**. A task pull request ready for review marks it **In review**. Merging that pull request into `prerelease` moves the issue to **prerelease**, and closing it moves it to **Done**. Link task pull requests with `Refs #N`.

The sync workflow uses the `DIRLUME_PROJECT_TOKEN` Actions secret. Use a GitHub classic personal access token with the `project` scope for this user-owned project. Run **Sync Dirlume project status** in GitHub Actions to reconcile the board immediately after setting the secret.

Dirlume checks for stable updates in the background at startup. Use **Commands → Check for updates** to check again. Windows installers, Windows portable copies, Linux AppImage, and macOS apps verify an update signature before installing and restarting. Dirlume asks before discarding changes in open editors. Debian installations show the matching `.deb` and an upgrade command. GitHub releases publish downloads and updates for Windows, Linux, and macOS.

The update dialog shows the offered version’s highlights and links to its full release notes. After installation, **What’s new** shows the installed version’s highlights offline. Dismiss the dialog once for that product version. It also appears on a clean installation when highlights are available. Use **Help → What’s new** to reopen it. Each Windows Portable folder keeps its own acknowledgment.

Install a recent release with the bundled verification key to enable in-app updates. When a newer release is available, choose **Install and restart** to download and verify the update and let Dirlume install it.

[GitHub Actions](https://github.com/agrynco/dirlume/actions) checks and builds the desktop app and server for Windows x64, Ubuntu x64, and macOS on Apple Silicon and Intel. A version job resolves one product version and CI build number for all platforms. Ordinary builds use the higher of the source version and the highest published version. The build number is the workflow run number multiplied by 1,000 plus the run attempt. A full rerun gets a new build number. Retrying failed platform jobs reuses the resolved build identity if the version job already succeeded.

The installer and server filenames include both numbers, for example `Dirlume-0.1.1-build.42001-windows-x64.setup.exe`. In the installed app, open **Options → General → Version** to see `0.1.1+42001`. The server reports the same value with `dirlume-server --version`.

Start work branches from `prerelease`. For implementation tasks, Codex runs the relevant local checks, opens a pull request into `prerelease`, and squash-merges it when ready. Pull requests and pushes to that branch do not start CI.

When the batch is ready, open one pull request from `prerelease` to `main`. Both CI workflows run on pull requests targeting `main` and recheck the batch if `prerelease` receives new commits while the pull request is open.

Invoke [$dirlume-backlog-runner](.agents/skills/dirlume-backlog-runner/SKILL.md) in Codex to process the GitHub issue backlog in the current checkout. It works through the issues in order, merges each completed task into `prerelease`, then opens and merges the promotion pull request after its required checks pass.

After the required checks pass, merge the release pull request with **Create a merge commit** to preserve the shared history for the next batch. GitHub Actions automatically builds the signed update bundles and server packages for Windows, Linux, and macOS from the merged commit, verifies the packages, and publishes the matching `vX.Y.Z` tag and [GitHub Release](https://github.com/agrynco/dirlume/releases). The full test suite runs during pull request CI on all four targets. The release build picks the next patch version, promotes a newer published prerelease to stable, or uses a higher source version.

Prepare one to eight short English highlights in `release-highlights/X.Y.Z.json` for the next stable version before opening its promotion pull request. Set `version` to that product version and list the sentences in `highlights`. The same summary goes into the desktop packages, the updater manifest, and the GitHub Release.

To publish manually, open **Actions → CI and releases → Run workflow** and select `main`. A manual release runs the full build and test suite before publishing.

For an explicitly versioned release, update `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the lockfiles, then push the matching tag. CI rejects stale versions, a mismatched tag or package, and a tag pointing to a different commit. The release contains desktop installers, portable ZIPs, standalone server archives, and SHA-256 checksums. The distributed Windows builds use no Windows developer signing certificate.

The **Downloads** table on the release page links to the installer or disk image and portable ZIP for each platform. Extract the ZIP and open `Dirlume.exe` on Windows, `Dirlume.AppImage` on Linux, or `Dirlume.app` on macOS. The optional standalone server is in the `server/` folder. Windows requires the WebView2 runtime. macOS builds use ad hoc code signing and may require approval in **System Settings → Privacy & Security** on first launch.

On Windows, ordinary and administrator launches of the same executable read Options preferences from `dirlume-settings.json` beside `Dirlume.exe`. An existing settings file takes precedence. On upgrade, the first ordinary launch copies older preferences to that file if the folder allows writes. If saving is denied, Dirlume reports the error and keeps the previous settings. An administrator window opened from Dirlume can initialize a missing settings file from the preferences of the ordinary window.

Windows Portable uses **Install and restart** to update its current folder. Extract it into a folder you can write to. Move the whole folder to carry the portable marker and `dirlume-settings.json` with the app. Copies in separate folders keep separate Options preferences. For earlier ZIPs that lack the portable marker, extract a current ZIP to start using in-place updates.

The release workflow also publishes `latest.json` and version-bound updater signatures for Windows, Linux, and macOS. All desktop builds use the updater public key in `src-tauri/tauri.conf.json`. Store the matching encrypted signing key and its password in the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions secrets. See the [Tauri updater signing guide](https://v2.tauri.app/plugin/updater/#signing-updates).

The **Install signed desktop updates** workflow tests both versions of an isolated fixture app on Windows, Ubuntu, and both macOS architectures with an ephemeral key. It checks signature rejection, installation, restored pane settings, and release highlights before and after install. The Ubuntu job also checks the manual Debian upgrade path.
