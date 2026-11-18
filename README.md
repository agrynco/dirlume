# Dirlume

Dirlume is a two-pane file manager for Windows, Ubuntu, and macOS. It uses Tauri 2, Rust, React, TypeScript, and Vite. The window layout takes its cues from Revqora. The [migration checklist](docs/migration.md) tracks feature parity with KSwitcher Files.

The two panes have independent folder navigation, sorting, filtering, and file selection. Local panes refresh automatically when files change. Copy or move selected files and folders from a destination dialog with live progress and cancellation. Moves across volumes copy each file before removing its source. With the default **Ask** option, Dirlume prompts when it reaches an existing file or folder. Choose **Overwrite** for a file, **Merge** for a folder, or **Skip** or **Cancel**. A remembered decision applies to subsequent conflicts of the same type in that transfer.

Use **Options → Appearance → New scheme** to save your own colors for the window, file panels, dialogs, and text tools. In **Fonts**, browse the installed font families or enter a name and set the size for each area. Use **Options → Keyboard shortcuts** to change, disable, or reset a binding. **Apply** saves changes and keeps Options open. **Done** saves and closes Options.

| Default keys | Action |
| --- | --- |
| Tab, arrows, Insert | Switch panes, navigate, and mark files. Ctrl-click or Shift-click also selects multiple items. |
| Alt+F1 / Alt+F2 | Open sources for the left or right pane. |
| F2 / Ctrl+R | Refresh the active pane. F2 saves when editing a text file. |
| F3 / F4 / Shift+F4 | View text or Markdown, edit text, or create and edit a new file. F3 measures folders. |
| F5 / F6 | Open the Copy or Rename or move dialog. |
| F7 / F8 / Shift+Delete | Create a folder, send selected items to Trash, or permanently delete after confirmation. |
| Ctrl+O / Ctrl+Left / Ctrl+Right | Hide or show the panes, or move the divider. Drag the divider to resize with the mouse. |
| Ctrl+F / Ctrl+Enter | Insert the selected path or name in the command line. |
| Ctrl+E / Alt+F8 | Recall earlier commands or open command history. |
| Shift+F11 | Compare files. Use F7 and F8 to navigate between differences. |

Click **Terminal** beside the command line to open an interactive PowerShell or system shell in the active local folder. The command line also sends commands to the shell from the active local folder. Terminal colors adapt to the background of the active color scheme.

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

On Windows, run `node scripts/desktop-smoke.mjs` after both builds. It opens Dirlume with an isolated WebView2 profile and test files. The CI smoke job uses a separate build with the `ui-automation` feature.

## Remote sources

**Dirlume server** runs as a separate process on Windows, Ubuntu, and macOS and shares one folder with read access over TLS. Browse and download files and directories, or open and compare text in Dirlume. [Server setup and autostart](docs/server.md).

**KSwitcher** provides Windows access to drives and files on paired computers. To browse inside a Dirlume pane, use a build of `KSwitcher.Files.exe` that includes Dirlume Bridge. In **Options → Remote connection**, choose **KSwitcher (Windows)** and enter the installation directory. KSwitcher must be running on both computers, and the remote file service must be reachable. With an older installation, the connection dialog can launch KSwitcher Files.

## CI and releases

[GitHub Actions](https://github.com/agrynco/dirlume/actions) checks and builds the desktop app and server for Windows x64, Ubuntu x64, macOS Apple Silicon, and macOS Intel. Each run provides downloadable build artifacts. Push a `vX.Y.Z` tag matching `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` to publish a [GitHub Release](https://github.com/agrynco/dirlume/releases) after all builds pass. The release contains the desktop packages, server archives, and SHA-256 checksums. The distributed builds use no Windows or Apple developer signing certificates.
