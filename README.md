# Dirlume

Dirlume is a two-pane file manager for Windows, Ubuntu, and macOS. It uses Tauri 2, Rust, React, TypeScript, and Vite. The window layout takes its cues from Revqora. The [migration checklist](docs/migration.md) tracks feature parity with KSwitcher Files.

The two panes have independent folder navigation, sorting, filtering, and file selection. Copy, move, rename, create folders, and send items to Trash. Local panes refresh automatically when files change. Built-in tools view, edit, and compare local text files and render Markdown. The terminal starts an interactive shell in the active local folder. Use **Options** to select a color scheme for the entire application or change, disable, and reset keyboard shortcuts.

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

On Windows, run `node scripts/desktop-smoke.mjs` after both builds. It opens Dirlume with an isolated WebView2 profile and test files.

## Remote sources

**Dirlume server** runs as a separate process on Windows, Ubuntu, and macOS and shares one folder with read access over TLS. [Server setup and autostart](docs/server.md).

**KSwitcher** provides Windows access to drives and files on paired computers. To browse inside a Dirlume pane, use a build of `KSwitcher.Files.exe` that includes Dirlume Bridge. In **Options → Remote connection**, choose **KSwitcher (Windows)** and enter the installation directory. KSwitcher must be running on both computers, and the remote file service must be reachable. With an older installation, the connection dialog can launch KSwitcher Files.

## CI and releases

[GitHub Actions](https://github.com/agrynco/dirlume/actions) checks and builds the desktop app and server for Windows x64, Ubuntu x64, macOS Apple Silicon, and macOS Intel. Each run provides downloadable build artifacts. Push a `vX.Y.Z` tag matching `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` to publish a [GitHub Release](https://github.com/agrynco/dirlume/releases) after all builds pass. The release contains the desktop packages, server archives, and SHA-256 checksums. The distributed builds use no Windows or Apple developer signing certificates.
