use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    ops::Range,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use super::{Definition, Edit, Information, Scope, ValueKind, HELPER};

pub(super) fn same_name(left: &str, right: &str) -> bool {
    left == right
}

pub(super) fn valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte == b'_' || byte.is_ascii_alphabetic())
        && bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
        && name.len() <= 1024
}

pub(super) fn valid_value(value: &str, kind: ValueKind) -> bool {
    kind == ValueKind::Literal && !value.contains('\0') && value.len() <= 32767
}

struct Assignment {
    span: Range<usize>,
    name: String,
    value: String,
}

#[cfg(target_os = "linux")]
fn assignments(contents: &str, managed: bool) -> Vec<Assignment> {
    let mut values = Vec::new();
    let mut lines = contents.split_inclusive('\n');
    let mut offset = 0;
    while let Some(line) = lines.next() {
        let start = offset;
        offset += line.len();
        let line = line.trim_start_matches([' ', '\t']);
        if line.starts_with(['#', ';']) {
            continue;
        }
        let Some((name, raw)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if !valid_name(name) {
            continue;
        }
        let mut raw = raw.trim_start_matches([' ', '\t']).to_owned();
        let quote = raw
            .chars()
            .next()
            .filter(|character| matches!(character, '\'' | '"'));
        let value = if let Some(quote) = quote {
            let mut value = String::new();
            let mut ended = false;
            let mut escape = false;
            let mut first = true;
            while !ended {
                for character in raw.chars().skip(usize::from(first)) {
                    if escape {
                        if character != '\n' {
                            if !matches!(character, '"' | '\\' | '$' | '`') {
                                value.push('\\');
                            }
                            value.push(character);
                        }
                        escape = false;
                    } else if character == quote {
                        ended = true;
                        break;
                    } else if character == '\\' && quote == '"' {
                        escape = true;
                    } else {
                        value.push(character);
                    }
                }
                if ended {
                    break;
                }
                let Some(next) = lines.next() else { break };
                offset += next.len();
                first = false;
                raw = next.to_owned();
            }
            if !ended {
                continue;
            }
            value
        } else {
            while raw.ends_with("\\\n") {
                let Some(next) = lines.next() else { break };
                raw.truncate(raw.len() - 2);
                raw.push_str(next);
                offset += next.len();
            }
            raw.trim_end().to_owned()
        };
        let value = if managed {
            value.replace("$$", "$")
        } else {
            value
        };
        values.push(Assignment {
            span: start..offset,
            name: name.to_owned(),
            value,
        });
    }
    values
}

#[cfg(target_os = "macos")]
fn assignments(contents: &str, _: bool) -> Vec<Assignment> {
    let mut offset = 0;
    let mut values = Vec::new();
    for row in contents.split_inclusive('\n') {
        let start = offset;
        offset += row.len();
        let Some((name, value)) = row
            .trim()
            .strip_prefix("export ")
            .and_then(|row| row.split_once("=$'"))
        else {
            continue;
        };
        let Some(value) = value.strip_suffix('\'').filter(|_| valid_name(name)) else {
            continue;
        };
        let mut decoded = String::new();
        let mut chars = value.chars();
        while let Some(character) = chars.next() {
            if character != '\\' {
                decoded.push(character);
                continue;
            }
            match chars.next() {
                Some('n') => decoded.push('\n'),
                Some('r') => decoded.push('\r'),
                Some('t') => decoded.push('\t'),
                Some(character) => decoded.push(character),
                None => decoded.push('\\'),
            }
        }
        values.push(Assignment {
            span: start..offset,
            name: name.to_owned(),
            value: decoded,
        });
    }
    values
}

#[cfg(target_os = "linux")]
fn line(name: &str, value: &str) -> String {
    let literal = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "$$");
    format!("{name}=\"{literal}\"\n")
}

#[cfg(target_os = "macos")]
fn line(name: &str, value: &str) -> String {
    let literal = value
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("export {name}=$'{literal}'\n")
}

fn config_dir() -> io::Result<PathBuf> {
    dirs::config_dir().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "User configuration is unavailable.",
        )
    })
}

#[cfg(target_os = "linux")]
fn managed(scope: Scope) -> io::Result<PathBuf> {
    if scope == Scope::User {
        Ok(config_dir()?.join("environment.d/90-dirlume-user.conf"))
    } else {
        Ok("/etc/environment.d/90-dirlume-system.conf".into())
    }
}

#[cfg(target_os = "macos")]
fn managed(scope: Scope) -> io::Result<PathBuf> {
    if scope == Scope::User {
        Ok(config_dir()?.join("Dirlume/environment.zsh"))
    } else {
        Ok("/Library/Application Support/Dirlume/environment.zsh".into())
    }
}

fn read(path: &Path) -> io::Result<String> {
    match fs::read_to_string(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        result => result,
    }
}

fn definitions_in(path: &Path, managed: bool) -> io::Result<Vec<Definition>> {
    Ok(assignments(&read(path)?, managed)
        .into_iter()
        .map(|item| Definition {
            name: item.name,
            value: item.value,
            kind: ValueKind::Literal,
            source: path.to_string_lossy().into_owned(),
            overridden_by: None,
        })
        .collect())
}

#[cfg(target_os = "linux")]
pub(super) fn definitions(scope: Scope) -> io::Result<Vec<Definition>> {
    let user_dir = config_dir()?.join("environment.d");
    let user_managed = managed(Scope::User)?;
    let system_managed = managed(Scope::System)?;
    let mut files = BTreeMap::new();
    let mut scoped_files = BTreeMap::new();
    for path in [
        PathBuf::from("/usr/lib/environment.d"),
        "/usr/local/lib/environment.d".into(),
        "/run/environment.d".into(),
        "/etc/environment.d".into(),
        user_dir.clone(),
    ] {
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let file = entry.path();
            if file.extension().is_some_and(|ext| ext == "conf") && file.is_file() {
                files.insert(entry.file_name(), file.clone());
                if (path == user_dir) == (scope == Scope::User) {
                    scoped_files.insert(entry.file_name(), file);
                }
            }
        }
    }
    let mut effective = BTreeMap::new();
    for path in files.values() {
        for row in definitions_in(path, path == &user_managed || path == &system_managed)? {
            effective.insert(row.name.clone(), row.source);
        }
    }
    let target = managed(scope)?;
    let mut scoped = BTreeMap::new();
    for path in scoped_files.values() {
        for row in definitions_in(path, path == &target)? {
            scoped.insert(row.name.clone(), row);
        }
    }
    // Keep the editable managed definition visible even when another file wins precedence.
    for row in definitions_in(&target, true)? {
        scoped.insert(row.name.clone(), row);
    }
    Ok(scoped
        .into_values()
        .map(|mut row| {
            row.overridden_by = effective
                .get(&row.name)
                .filter(|source| **source != row.source)
                .cloned();
            row
        })
        .collect())
}

#[cfg(target_os = "macos")]
pub(super) fn definitions(scope: Scope) -> io::Result<Vec<Definition>> {
    Ok(definitions_in(&managed(scope)?, true)?
        .into_iter()
        .map(|row| (row.name.clone(), row))
        .collect::<BTreeMap<_, _>>()
        .into_values()
        .collect())
}

fn replace(path: &Path, old: &str, updated: &str, mode: u32) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    fs::create_dir_all(parent)?;
    let mode = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata.permissions().mode() & 0o777,
        Ok(_) => return Err(io::Error::from(io::ErrorKind::InvalidInput)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => mode,
        Err(error) => return Err(error),
    };
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.as_file()
        .set_permissions(fs::Permissions::from_mode(mode))?;
    temp.write_all(updated.as_bytes())?;
    temp.as_file().sync_all()?;
    if read(path)? != old {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists));
    }
    temp.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub(super) fn write(scope: Scope, edit: &Edit) -> io::Result<()> {
    let path = managed(scope)?;
    let old = read(&path)?;
    let updated_line = line(&edit.name, &edit.value);
    let mut updated = old.clone();
    let matches = assignments(&old, true)
        .into_iter()
        .filter(|item| item.name == edit.name)
        .collect::<Vec<_>>();
    if let Some((last, earlier)) = matches.split_last() {
        updated.replace_range(last.span.clone(), &updated_line);
        for item in earlier.iter().rev() {
            updated.replace_range(item.span.clone(), "");
        }
    } else {
        if !updated.is_empty() && !updated.ends_with('\n') {
            updated.push('\n');
        }
        updated.push_str(&updated_line);
    }
    replace(
        &path,
        &old,
        &updated,
        if scope == Scope::User { 0o600 } else { 0o644 },
    )
}

#[cfg(target_os = "macos")]
fn startup(scope: Scope) -> io::Result<PathBuf> {
    if scope == Scope::System {
        return Ok("/etc/zprofile".into());
    }
    let home = std::env::var_os("ZDOTDIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(dirs::home_dir);
    home.map(|path| path.join(".zprofile"))
        .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
}

#[cfg(target_os = "macos")]
const HOOK_MARKER: &str = "# Dirlume managed environment";

#[cfg(target_os = "macos")]
fn add_startup_hook(old: &str, managed: &Path) -> Option<String> {
    if old.lines().any(|row| row == HOOK_MARKER) {
        return None;
    }
    let quoted = format!("'{}'", managed.to_string_lossy().replace('\'', "'\\''"));
    Some(format!("{old}\n{HOOK_MARKER}\nif [[ -r {quoted} ]]; then\n  source {quoted}\nfi\n# End Dirlume managed environment\n"))
}

#[cfg(target_os = "macos")]
pub(super) fn integrate(scope: Scope) -> io::Result<()> {
    let startup = startup(scope)?;
    let path = if scope == Scope::User
        && fs::symlink_metadata(&startup).is_ok_and(|info| info.is_symlink())
    {
        startup.canonicalize()?
    } else {
        startup
    };
    let old = read(&path)?;
    let Some(updated) = add_startup_hook(&old, &managed(scope)?) else {
        return Ok(());
    };
    replace(
        &path,
        &old,
        &updated,
        if scope == Scope::User { 0o600 } else { 0o644 },
    )
}

#[cfg(target_os = "linux")]
pub(super) fn integrate(_: Scope) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

pub(super) fn info(scope: Scope) -> io::Result<Information> {
    #[cfg(target_os = "macos")]
    let (startup_file, integration_enabled, activation) = {
        let startup = startup(scope)?;
        (Some(startup.to_string_lossy().into_owned()), read(&startup)?.lines().any(|line| line == HOOK_MARKER),
            "Enable login shell integration and start a new zsh login shell to load the saved definitions.")
    };
    #[cfg(target_os = "linux")]
    let (startup_file, integration_enabled, activation) = (None, false,
        "Reload the systemd user manager or start a new login session. These definitions apply to services it launches.");
    Ok(Information {
        target: managed(scope)?.to_string_lossy().into_owned(),
        activation,
        startup_file,
        integration_enabled,
        expandable: false,
    })
}

pub(super) fn needs_admin() -> bool {
    unsafe { libc::geteuid() != 0 }
}

pub(super) fn elevate(request: &Path) -> io::Result<bool> {
    let executable = std::env::current_exe()?;
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("/usr/bin/pkexec");
        command.arg(executable).arg(HELPER).arg(request);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/osascript");
        command.args(["-e", "on run argv", "-e",
            "do shell script (quoted form of item 1 of argv & \" \" & quoted form of item 2 of argv & \" \" & quoted form of item 3 of argv) with administrator privileges",
            "-e", "end run"]).arg(executable).arg(HELPER).arg(request);
        command
    };
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .output()?;
    #[cfg(target_os = "linux")]
    return Ok(!matches!(output.status.code(), Some(126 | 127)));
    #[cfg(target_os = "macos")]
    return Ok(!String::from_utf8_lossy(&output.stderr).contains("(-128)"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_values_round_trip_with_whitespace_and_unicode() {
        let value = " Pérez \"quoted\" 'single' \\ $HOME\t\n next line ";
        let formatted = line("FIXTURE", value);
        let rows = assignments(&formatted, true);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value, value);
        assert_eq!(rows[0].span, 0..formatted.len());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_new_zsh_login_shell_reads_managed_variables() {
        let fixture = tempfile::tempdir().unwrap();
        let target = fixture.path().join("managed ' definition.zsh");
        let value = " Préservable $PATH \"quoted\" ";
        fs::write(&target, line("DIRLUME_TEST_VALUE", value)).unwrap();
        let profile = add_startup_hook("# existing profile", &target).unwrap();
        assert!(add_startup_hook(&profile, &target).is_none());
        fs::write(fixture.path().join(".zprofile"), profile).unwrap();
        let result = Command::new("/bin/zsh")
            .env("ZDOTDIR", fixture.path())
            .args(["-l", "-c", "printf %s \"$DIRLUME_TEST_VALUE\""])
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(String::from_utf8(result.stdout).unwrap(), value);
    }
}
