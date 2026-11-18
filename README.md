# Dirlume

Dirlume — двопанельний файловий менеджер для Windows, Ubuntu і macOS. Застосунок використовує Tauri 2, Rust, React, TypeScript і Vite. Компонування орієнтується на Revqora. Хід перенесення функцій з KSwitcher Files описано в [переліку міграції](docs/migration.md).

У двох панелях можна незалежно відкривати папки, сортувати й фільтрувати список, позначати елементи, копіювати та переміщати їх, створювати й перейменовувати папки та відправляти елементи в кошик. Вбудовані інструменти відкривають, редагують і порівнюють локальний текст та показують Markdown. У **Options** можна вибрати схему оформлення для всього застосунку та змінити, вимкнути або скинути гарячі клавіші.

## Збірка

Потрібні Node.js 24, Rust через rustup і [системні залежності Tauri](https://v2.tauri.app/start/prerequisites/). Windows використовує MSVC і WebView2, macOS — Xcode Command Line Tools, Ubuntu — WebKitGTK 4.1.

```sh
npm ci
npm run tauri -- dev
```

Перевірки й локальна збірка

```sh
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --features server -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked --features server
npm run tauri -- build -- --locked
cargo build --manifest-path src-tauri/Cargo.toml --locked --release --no-default-features --features server --bin dirlume-server
node scripts/server-smoke.mjs
```

На Windows також можна виконати `node scripts/desktop-smoke.mjs` після обох збірок. Перевірка відкриває окремий екземпляр Dirlume з тимчасовим профілем WebView2 і тестовими файлами.

## Віддалені джерела

**Dirlume server** — окремий процес для Windows, Ubuntu та macOS. Він працює без відкритого файлового менеджера й надає доступ для читання до однієї вибраної папки. [Запуск, підключення й автозапуск](docs/server.md).

**KSwitcher** — Windows-джерело для перегляду дисків і завантаження файлів із уже спарених машин. Для роботи всередині панелі Dirlume потрібна збірка `KSwitcher.Files.exe` з Dirlume Bridge. У **Options → Remote connection** виберіть **KSwitcher (Windows)** і вкажіть каталог цієї збірки. На машині клієнта й на віддаленій машині має працювати KSwitcher, а файлова служба віддаленого ПК має бути доступна. Якщо встановлено звичайну збірку, кнопка з’єднання відкриває її файловий менеджер.

## CI/CD

[GitHub Actions](https://github.com/agrynco/dirlume/actions) запускає перевірки та збирає застосунок і сервер для Windows x64, Ubuntu x64, macOS Apple Silicon та Intel. Пакунки для звичайних збірок доступні в артефактах запуску. Тег `vX.Y.Z`, що відповідає версії в `package.json`, `src-tauri/Cargo.toml` і `src-tauri/tauri.conf.json`, публікує [GitHub Release](https://github.com/agrynco/dirlume/releases) після проходження всіх збірок. У реліз додаються інсталятори, архіви сервера та SHA-256 кожного пакунка. Пакунки збираються без сертифікатів розробника Windows та Apple.
