use std::{
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::atomic::{AtomicU8, Ordering},
    thread,
    time::{Duration, Instant},
};

use crate::desktop::{message, Result};
use tauri::{path::BaseDirectory, AppHandle, Manager};

pub const PASSWORD_ERROR: &str = "The archive needs a correct password.";
pub const LIST_LIMIT: u64 = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct Engine {
    executable: PathBuf,
    #[cfg(windows)]
    _portable_files: Option<std::sync::Arc<tempfile::TempDir>>,
}

impl Engine {
    pub fn for_app(app: &AppHandle) -> Result<Self> {
        #[cfg(windows)]
        if crate::portable::root().is_some() {
            return Self::embedded()?.map_or_else(Self::find, Ok);
        }
        let name = if cfg!(windows) { "7z.exe" } else { "7zz" };
        if let Ok(executable) = app.path().resolve(
            Path::new("archive-tools").join(name),
            BaseDirectory::Resource,
        ) {
            if executable.is_absolute() && executable.is_file() {
                return Ok(Self::external(executable));
            }
        }
        Self::find()
    }

    fn external(executable: PathBuf) -> Self {
        Self {
            executable,
            #[cfg(windows)]
            _portable_files: None,
        }
    }

    #[cfg(windows)]
    pub(crate) fn embedded() -> Result<Option<Self>> {
        let executable = include_bytes!(concat!(env!("OUT_DIR"), "/7z.exe"));
        let library = include_bytes!(concat!(env!("OUT_DIR"), "/7z.dll"));
        let sfx = include_bytes!(concat!(env!("OUT_DIR"), "/7z.sfx"));
        if executable.is_empty() || library.is_empty() || sfx.is_empty() {
            return Ok(None);
        }
        // Existing Portable versions only accept the app and a few known
        // resources in an update. Keep the signed engine inside the app.
        let workspace = tempfile::tempdir().map_err(message)?;
        for (name, contents) in [
            ("7z.exe", executable.as_slice()),
            ("7z.dll", library.as_slice()),
            ("7z.sfx", sfx.as_slice()),
        ] {
            fs::write(workspace.path().join(name), contents).map_err(message)?;
        }
        Ok(Some(Self {
            executable: workspace.path().join("7z.exe"),
            _portable_files: Some(std::sync::Arc::new(workspace)),
        }))
    }

    pub fn find() -> Result<Self> {
        let file_names = if cfg!(windows) {
            &["7zz.exe", "7z.exe", "7za.exe"][..]
        } else {
            &["7zz", "7z", "7za"][..]
        };
        let mut dirs: Vec<_> = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .filter(|path| path.is_absolute())
            .collect();
        #[cfg(windows)]
        dirs.extend(
            ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
                .iter()
                .filter_map(std::env::var_os)
                .map(|parent| PathBuf::from(parent).join("7-Zip")),
        );
        #[cfg(windows)]
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(base).join("Programs").join("7-Zip"));
        }
        #[cfg(not(windows))]
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
        let executable = dirs
            .iter()
            .find_map(|dir| {
                file_names
                    .iter()
                    .map(|name| dir.join(name))
                    .find(|path| path.is_file())
            })
            .ok_or("7-Zip is unavailable. Reinstall Dirlume or install the 7-Zip command line tools for this development build.")?;
        Ok(Self::external(executable))
    }

    pub fn command(&self, action: &str) -> Command {
        let mut command = Command::new(&self.executable);
        command.args([action, "-sccUTF-8", "-scsUTF-8", "-y"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }

    pub fn formats(&self) -> Result<Vec<String>> {
        let mut command = self.command("i");
        let output = capture(&mut command, None, 128 * 1024, |_| Ok(()))?;
        let formats = output
            .lines()
            .skip_while(|line| line.trim() != "Formats:")
            .skip(1)
            .take_while(|line| !line.trim().ends_with(':'))
            .filter_map(|line| {
                let mut words = line.split_whitespace();
                words.find(|word| word.starts_with('C') && word.contains('.'))?;
                let kind = words.next()?;
                if kind.starts_with('w') && kind.contains('.') {
                    words.next()
                } else {
                    Some(kind)
                }
            })
            .map(str::to_ascii_lowercase)
            .filter(|kind| ["7z", "zip", "tar", "wim"].contains(&kind.as_str()))
            .collect::<Vec<_>>();
        if formats.is_empty() {
            return Err("7-Zip did not report any supported archive formats.".to_owned());
        }
        Ok(formats)
    }

    pub fn sfx_module(&self) -> Option<PathBuf> {
        cfg!(windows)
            .then(|| self.executable.with_file_name("7z.sfx"))
            .filter(|file| file.is_file())
    }
}

pub struct Output<W> {
    pub data: W,
    status: ExitStatus,
    error: String,
}

impl<W> Output<W> {
    pub fn checked(self, allow_warnings: bool) -> Result<W> {
        if self.status.success() || allow_warnings && self.status.code() == Some(1) {
            return Ok(self.data);
        }
        let detail = self.error.trim();
        if detail.to_ascii_lowercase().contains("password") {
            return Err(PASSWORD_ERROR.to_owned());
        }
        Err(if detail.is_empty() {
            format!("7-Zip returned {}.", self.status)
        } else {
            detail.chars().take(700).collect()
        })
    }

    pub fn warned(&self) -> bool {
        self.status.code() == Some(1)
    }
}

pub fn validate_password(password: Option<&str>) -> Result<()> {
    if password.is_some_and(|value| value.len() > 4096 || value.contains(['\0', '\n', '\r'])) {
        return Err("Use a password without line breaks.".to_owned());
    }
    Ok(())
}

pub fn capture(
    command: &mut Command,
    password: Option<&str>,
    limit: u64,
    tick: impl FnMut(u8) -> io::Result<()>,
) -> Result<String> {
    let result = run(command, password, Limited(Vec::new(), limit), tick)?;
    if result.status.code() == Some(255)
        && result.data.0.split(|byte| *byte == b'\n').any(|line| {
            line.strip_suffix(b"\r").unwrap_or(line) == b"Enter password (will not be echoed):"
        })
    {
        return Err(PASSWORD_ERROR.to_owned());
    }
    let bytes = result.checked(false)?.0;
    String::from_utf8(bytes).map_err(message)
}

pub fn run<W: Write + Send>(
    command: &mut Command,
    password: Option<&str>,
    mut sink: W,
    mut tick: impl FnMut(u8) -> io::Result<()>,
) -> Result<Output<W>> {
    validate_password(password)?;
    tick(0).map_err(message)?;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(message)?;
    let mut stdin = child.stdin.take().expect("configured pipe");
    let stdout = child.stdout.take().expect("configured pipe");
    let stderr = child.stderr.take().expect("configured pipe");
    let percent = AtomicU8::new(0);
    thread::scope(|scope| {
        scope.spawn(move || {
            if let Some(password) = password.filter(|password| !password.is_empty()) {
                let line = format!("{password}\n");
                // Creation may ask for confirmation. Keep the password off the command line.
                let _ = stdin.write_all(line.as_bytes());
                let _ = stdin.write_all(line.as_bytes());
            }
        });
        let reader = scope.spawn(move || {
            let copied = io::copy(&mut io::BufReader::new(stdout), &mut sink);
            copied.map(|_| sink)
        });
        let status_reader = scope.spawn(|| {
            let mut bytes = Vec::new();
            let mut count = 0u16;
            let mut stderr = stderr;
            let mut buffer = [0; 8192];
            loop {
                let length = stderr.read(&mut buffer)?;
                if length == 0 {
                    break;
                }
                for byte in &buffer[..length] {
                    match byte {
                        b'0'..=b'9' => {
                            count = count
                                .saturating_mul(10)
                                .saturating_add(u16::from(byte - b'0'))
                        }
                        b'%' if count <= 100 => {
                            percent.store(count as u8, Ordering::Relaxed);
                            count = 0;
                        }
                        _ => count = 0,
                    }
                }
                let capacity = 64 * 1024 - bytes.len();
                bytes.extend_from_slice(&buffer[..length.min(capacity)]);
            }
            Ok::<_, io::Error>(String::from_utf8_lossy(&bytes).into_owned())
        });
        let mut reported = 0;
        let started = Instant::now();
        let status = loop {
            let next = percent.load(Ordering::Relaxed);
            if next != reported || started.elapsed() > Duration::from_millis(20) {
                if let Err(error) = tick(next) {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(error);
                }
                reported = next;
            }
            match child.try_wait() {
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Ok(Some(status)) => break Ok(status),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(error);
                }
            }
        };
        let error = status_reader
            .join()
            .map_err(|_| "7-Zip output could not be read.")?
            .map_err(message)?;
        let data = reader
            .join()
            .map_err(|_| "7-Zip output could not be read.")?
            .map_err(message)?;
        Ok(Output {
            data,
            status: status.map_err(message)?,
            error,
        })
    })
}

pub struct Limited<W>(pub W, pub u64);
impl<W: Write> Write for Limited<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Archive output exceeded the expected size.",
            ));
        }
        let length = self.0.write(bytes)?;
        self.1 -= length as u64;
        Ok(length)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

pub fn list_file(
    workspace: &Path,
    paths: impl IntoIterator<Item = impl AsRef<str>>,
) -> Result<PathBuf> {
    let path = workspace.join("members.txt");
    let mut file = fs::File::create(&path).map_err(message)?;
    for value in paths {
        let value = value.as_ref();
        if value.contains(['\n', '\r', '\0']) {
            return Err("An archive name contains a line break or invalid character.".to_owned());
        }
        writeln!(file, "{value}").map_err(message)?;
    }
    Ok(path)
}

pub fn at(marker: &str, path: &Path) -> OsString {
    let mut result = OsString::from(marker);
    result.push(path.as_os_str());
    result
}

pub fn archive_args<'a>(command: &'a mut Command, archive: &Path) -> &'a mut Command {
    command.arg(OsStr::new("--")).arg(archive)
}
