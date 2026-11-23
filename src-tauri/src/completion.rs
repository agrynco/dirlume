use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    desktop::{blocking_for, message, Result},
    local,
    remote_transfer::UploadSession as _,
    terminal,
};

mod docker;
#[cfg(not(windows))]
#[path = "completion/unix.rs"]
mod platform;
pub(crate) use docker::ENVIRONMENT as DOCKER_COMPLETION_ENVIRONMENT;
#[cfg(windows)]
#[path = "completion/windows.rs"]
mod platform;

const MAX_DRAFT: usize = 8192;
const MAX_MATCHES: usize = 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    line: String,
    caret: usize,
    directory: String,
    refresh_environment: bool,
    #[serde(default)]
    shell_environment: Option<HashMap<String, Option<String>>>,
}

#[derive(Default, Deserialize, Serialize)]
pub struct CompletionBatch {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    length: usize,
    #[serde(default)]
    matches: Vec<Suggestion>,
    #[serde(default)]
    exclusive: bool,
}

#[derive(Deserialize, Serialize)]
struct Suggestion {
    label: String,
    text: String,
    #[serde(default)]
    directory: bool,
}

#[derive(Default)]
pub struct CompletionQueue {
    serial: AtomicU64,
    worker: Mutex<()>,
}

#[tauri::command]
pub async fn complete_command(
    request: CompletionRequest,
    queue: State<'_, std::sync::Arc<CompletionQueue>>,
) -> Result<CompletionBatch> {
    if request.line.len() > MAX_DRAFT || request.line.contains(['\0', '\r', '\n']) {
        return Ok(CompletionBatch::default());
    }
    let serial = queue.serial.fetch_add(1, Ordering::Relaxed) + 1;
    let queue = queue.inner().clone();
    blocking_for("complete_command", move || {
        let _worker = queue.worker.lock().map_err(message)?;
        if queue.serial.load(Ordering::Relaxed) != serial {
            return Ok(CompletionBatch::default());
        }
        Ok(complete(&request))
    })
    .await
}

struct Context {
    words: Vec<String>,
    prefix: String,
    index: usize,
    length: usize,
    byte_caret: usize,
}

impl Context {
    fn explicit_path(&self, windows: bool) -> bool {
        let prefix = &self.prefix;
        if windows {
            prefix.contains('\\')
                || prefix.trim_start_matches('/').contains('/')
                || prefix.as_bytes().get(1) == Some(&b':')
                || (self.words.is_empty() && prefix.starts_with('/'))
        } else {
            prefix.contains('/')
        }
    }

    fn directory_argument(&self, windows: bool) -> bool {
        self.words.first().is_some_and(|command| {
            if windows {
                matches!(
                    command.to_ascii_lowercase().as_str(),
                    "cd" | "chdir" | "pushd" | "push-location" | "set-location" | "sl"
                )
            } else {
                matches!(command.as_str(), "cd" | "pushd")
            }
        }) && !self.prefix.starts_with('-')
    }

    fn allows_path_fallback(&self, windows: bool) -> bool {
        self.explicit_path(windows)
            || self.directory_argument(windows)
            || (!windows
                && !self.prefix.starts_with('-')
                && self.words.first().is_some_and(|command| {
                    // These commands take path operands even on systems without
                    // a Bash or Zsh completion package.
                    matches!(
                        command.rsplit('/').next().unwrap_or(command),
                        "cat"
                            | "cp"
                            | "ls"
                            | "mkdir"
                            | "mv"
                            | "readlink"
                            | "realpath"
                            | "rm"
                            | "rmdir"
                            | "stat"
                            | "touch"
                    )
                }))
    }
}

fn byte_at_utf16(line: &str, caret: usize) -> Option<usize> {
    let mut units = 0;
    for (index, letter) in line.char_indices() {
        if units == caret {
            return Some(index);
        }
        units += letter.len_utf16();
        if units > caret {
            return None;
        }
    }
    (units == caret).then_some(line.len())
}

fn unquote(word: &str, escape: char) -> String {
    let mut result = String::new();
    let mut quote = None;
    let mut chars = word.chars().peekable();
    while let Some(letter) = chars.next() {
        if letter == escape && quote != Some('\'') {
            if let Some(escaped) = chars.next() {
                result.push(escaped);
            }
        } else if quote == Some(letter) {
            if escape == '`' && chars.next_if_eq(&letter).is_some() {
                result.push(letter);
            } else {
                quote = None;
            }
        } else if quote.is_none() && matches!(letter, '\'' | '"') {
            quote = Some(letter);
        } else {
            result.push(letter);
        }
    }
    result
}

fn context(line: &str, caret: usize) -> Option<Context> {
    shell_context(line, caret, cfg!(windows))
}

fn shell_context(line: &str, caret: usize, windows: bool) -> Option<Context> {
    let byte_caret = byte_at_utf16(line, caret)?;
    let escape = if windows { '`' } else { '\\' };
    let mut words = Vec::new();
    let mut start = None;
    let mut quote = None;
    let mut escaped = false;
    let mut current = byte_caret..byte_caret;
    for (at, letter) in line
        .char_indices()
        .chain(std::iter::once((line.len(), ' ')))
    {
        let separator = matches!(letter, ';' | '|' | '&');
        if at == line.len()
            || (!escaped && quote.is_none() && (letter.is_whitespace() || separator))
        {
            if let Some(begin) = start.take() {
                if begin <= byte_caret && byte_caret <= at {
                    current = begin..at;
                    break;
                }
                if at < byte_caret {
                    words.push(unquote(&line[begin..at], escape));
                }
            }
            if at >= byte_caret {
                break;
            }
            if separator {
                words.clear();
            }
            continue;
        }
        start.get_or_insert(at);
        if escaped {
            escaped = false;
        } else if letter == escape && quote != Some('\'') {
            escaped = true;
        } else if quote == Some(letter) {
            quote = None;
        } else if quote.is_none() && matches!(letter, '\'' | '"') {
            quote = Some(letter);
        }
    }
    let index = line[..current.start].encode_utf16().count();
    let length = line[current.clone()].encode_utf16().count();
    Some(Context {
        words,
        prefix: unquote(&line[current.start..byte_caret], escape),
        index,
        length,
        byte_caret,
    })
}

fn starts_with(value: &str, prefix: &str) -> bool {
    if cfg!(windows) {
        value.to_lowercase().starts_with(&prefix.to_lowercase())
    } else {
        value.starts_with(prefix)
    }
}

fn shell_word(value: &str) -> String {
    quote_word(value, cfg!(windows))
}

fn quote_word(value: &str, windows: bool) -> String {
    if !(windows && value.starts_with('@'))
        && value.chars().all(|letter| {
            letter.is_alphanumeric()
                || "_./-:+,=@%~".contains(letter)
                || (windows && letter == '\\')
        })
    {
        return value.to_owned();
    }
    if windows {
        return format!("'{}'", value.replace('\'', "''"));
    }
    if let Some(tail) = value.strip_prefix("~/") {
        return format!("~/'{}'", tail.replace('\'', "'\\''"));
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCompletionRequest {
    line: String,
    caret: usize,
    directory: String,
    search_path: Option<String>,
    #[serde(default)]
    shell_environment: Option<HashMap<String, Option<String>>>,
}

#[tauri::command]
pub async fn complete_ssh_terminal(
    id: u32,
    request: RemoteCompletionRequest,
    terminals: State<'_, terminal::Terminals>,
) -> Result<CompletionBatch> {
    let terminal = terminals.remote(id)?;
    complete_remote(request, false, |script| {
        let terminal = std::sync::Arc::clone(&terminal);
        async move { terminal.complete(&script).await }
    })
    .await
}

#[tauri::command]
pub async fn complete_ssh_command(
    id: u32,
    segments: Vec<String>,
    line: String,
    caret: usize,
    ssh: State<'_, crate::ssh::SshState>,
) -> Result<CompletionBatch> {
    let connection = ssh.connection(id)?;
    let request = RemoteCompletionRequest {
        line,
        caret,
        directory: crate::ssh::Session::absolute(&segments)?,
        search_path: None,
        shell_environment: None,
    };
    complete_remote(request, true, |script| {
        let connection = std::sync::Arc::clone(&connection);
        async move { connection.complete(&script).await }
    })
    .await
}

const REMOTE_OUTPUT: &[u8] = b"\0DIRLUME-COMPLETION\0";

fn remote_command(request: &RemoteCompletionRequest, script: &str, linux_only: bool) -> String {
    let mut command = String::new();
    if linux_only {
        command.push_str("[ \"$(command uname -s)\" = Linux ] || exit\n");
    }
    command.push_str(&format!(
        "CDPATH= cd -- {} || exit\n",
        crate::ssh::quote(&request.directory)
    ));
    command.push_str("unset ENV BASH_ENV\n");
    let body = format!("printf '\\000DIRLUME-COMPLETION\\000'\n{script}");
    if let Some(path) = &request.search_path {
        command.push_str(&format!("export PATH={}\n{body}", crate::ssh::quote(path)));
    } else {
        command.push_str("shell=${SHELL:-/bin/bash}\ncase ${shell##*/} in bash|zsh) ;; *) shell=/bin/bash ;; esac\n");
        command.push_str(&format!(
            "exec \"$shell\" -ic {} </dev/null",
            crate::ssh::quote(&body)
        ));
    }
    command
}

fn remote_output(output: &[u8]) -> &[u8] {
    output
        .windows(REMOTE_OUTPUT.len())
        .position(|bytes| bytes == REMOTE_OUTPUT)
        .map_or(&[], |start| &output[start + REMOTE_OUTPUT.len()..])
}

async fn complete_remote<F>(
    request: RemoteCompletionRequest,
    linux_only: bool,
    run: impl Fn(String) -> F,
) -> Result<CompletionBatch>
where
    F: std::future::Future<Output = Result<Vec<u8>>>,
{
    if request.line.len() > MAX_DRAFT
        || request.line.contains(['\0', '\r', '\n'])
        || !request.directory.starts_with('/')
        || request.directory.len() > MAX_DRAFT
        || request.directory.contains('\0')
        || request
            .search_path
            .as_ref()
            .is_some_and(|path| path.len() > MAX_DRAFT || path.contains('\0'))
    {
        return Ok(CompletionBatch::default());
    }
    let Some(context) = shell_context(&request.line, request.caret, false) else {
        return Ok(CompletionBatch::default());
    };
    let docker_legacy = docker::query(&context, false);
    let docker_requires_linux = docker_legacy.is_none();
    if let Some(query) = docker_legacy.or_else(|| docker::extended_query(&context, false)) {
        let script = docker::remote_script(request.shell_environment.as_ref(), &query);
        let output = run(remote_command(
            &request,
            &script,
            linux_only || docker_requires_linux,
        ))
        .await
        .unwrap_or_default();
        let mut result = docker::batch(
            &query,
            &context,
            &request.line,
            remote_output(&output),
            false,
        );
        if let Some(flags) = docker::flag_query(&context) {
            let script = docker::remote_script(request.shell_environment.as_ref(), &flags);
            let output = run(remote_command(&request, &script, true))
                .await
                .unwrap_or_default();
            docker::add_flags(
                &mut result,
                docker::batch(
                    &flags,
                    &context,
                    &request.line,
                    remote_output(&output),
                    false,
                ),
            );
        }
        if result.exclusive || !result.matches.is_empty() {
            return Ok(result);
        }
    }
    let shell = include_str!("completion/bash.sh");
    let fallback = include_str!("completion/ssh-paths.sh");
    let path_fallback = if context.directory_argument(false) {
        "directory"
    } else if context.allows_path_fallback(false) {
        "any"
    } else {
        "none"
    };
    let script = format!(
        "exec /bin/bash --noprofile --norc -c {} dirlume-completion {} {} {} {} {}",
        crate::ssh::quote(fallback),
        context.byte_caret,
        crate::ssh::quote(&request.line),
        path_fallback,
        if request.line.contains(['$', '`']) {
            "''".to_owned()
        } else {
            crate::ssh::quote(shell)
        },
        context
            .words
            .iter()
            .chain(std::iter::once(&context.prefix))
            .map(|word| crate::ssh::quote(word))
            .collect::<Vec<_>>()
            .join(" "),
    );
    let output = run(remote_command(&request, &script, linux_only)).await?;
    let mut seen = BTreeSet::new();
    let matches = remote_output(&output)
        .split(|&byte| byte == 0)
        .filter_map(|value| {
            let (source, value) = value.split_first()?;
            let value = std::str::from_utf8(value).ok()?;
            let (label, trailing_space) = match source {
                b'N' => value
                    .strip_suffix(' ')
                    .map_or((value, false), |label| (label, true)),
                b'P' => (value, false),
                _ => return None,
            };
            if label.is_empty() || label.chars().any(char::is_control) || !seen.insert(label) {
                return None;
            }
            let mut text = quote_word(label, false);
            if trailing_space {
                text.push(' ');
            }
            Some(Suggestion {
                label: label.to_owned(),
                text,
                directory: label.ends_with('/'),
            })
        })
        .take(MAX_MATCHES)
        .collect();
    Ok(CompletionBatch {
        index: context.index,
        length: context.length,
        matches,
        exclusive: false,
    })
}

fn paths(cwd: &Path, prefix: &str, directories_only: bool) -> Vec<Suggestion> {
    let position = prefix.rfind(|c| c == '/' || (cfg!(windows) && c == '\\'));
    let separator = position.map_or(if cfg!(windows) { '\\' } else { '/' }, |at| {
        prefix.as_bytes()[at] as char
    });
    let (base, name) = prefix.split_at(position.map_or(0, |at| at + 1));
    let home_relative = base.strip_prefix("~/").or_else(|| {
        if cfg!(windows) {
            base.strip_prefix("~\\")
        } else {
            None
        }
    });
    let directory = if let Some(relative) = home_relative {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        home.join(relative)
    } else {
        cwd.join(base)
    };
    let Ok(list) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut result: Vec<_> = list
        .filter_map(|item| {
            let item = item.ok()?;
            let label = item.file_name().into_string().ok()?;
            if (label.starts_with('.') && !name.starts_with('.')) || !starts_with(&label, name) {
                return None;
            }
            let directory = item.path().is_dir();
            if directories_only && !directory {
                return None;
            }
            let suffix = if directory {
                separator.to_string()
            } else {
                String::new()
            };
            let text = shell_word(&format!("{base}{label}{suffix}"));
            Some(Suggestion {
                label,
                text,
                directory,
            })
        })
        .collect();
    result.sort_by(|a, b| b.directory.cmp(&a.directory).then(a.label.cmp(&b.label)));
    result
}

fn executables(prefix: &str, search_path: Option<&str>) -> Vec<String> {
    let builtins = if cfg!(windows) {
        &[
            "cd",
            "clear",
            "cls",
            "dir",
            "echo",
            "Get-ChildItem",
            "Set-Location",
        ][..]
    } else {
        &[
            "cd", "alias", "echo", "export", "exit", "pwd", "read", "set", "source", "test", "type",
        ][..]
    };
    let mut names: BTreeSet<_> = builtins
        .iter()
        .filter(|command| starts_with(command, prefix))
        .map(ToString::to_string)
        .collect();
    if let Some(path) = search_path
        .map(Into::into)
        .or_else(|| std::env::var_os("PATH"))
    {
        for directory in std::env::split_paths(&path).filter(|directory| directory.is_absolute()) {
            if let Ok(files) = fs::read_dir(directory) {
                for entry in files.flatten() {
                    let Ok(name) = entry.file_name().into_string() else {
                        continue;
                    };
                    if starts_with(&name, prefix) && executable(&entry.path()) {
                        names.insert(name);
                    }
                }
            }
        }
    }
    names.into_iter().collect()
}

fn executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(windows)]
    {
        path.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| {
                    matches!(
                        ext.to_ascii_lowercase().as_str(),
                        "exe" | "cmd" | "bat" | "com"
                    )
                })
    }
}

fn complete(request: &CompletionRequest) -> CompletionBatch {
    let Ok(cwd) = local::absolute(&request.directory) else {
        return CompletionBatch::default();
    };
    let Some(context) = context(&request.line, request.caret) else {
        return CompletionBatch::default();
    };
    let directory = context.directory_argument(cfg!(windows));
    if let Some(batch) = docker::local(request, &context, cwd) {
        return batch;
    }
    if cfg!(windows)
        && directory
        && context.words.len() == 1
        && !context.prefix.starts_with('-')
        && (!context.prefix.contains(':') || context.prefix.as_bytes().get(1) == Some(&b':'))
    {
        // Use filesystem metadata for local navigation. PowerShell providers can
        // classify a file as a container, depending on the active provider.
        let mut matches = paths(cwd, &context.prefix, true);
        matches.truncate(MAX_MATCHES);
        return CompletionBatch {
            index: context.index,
            length: context.length,
            matches,
            exclusive: true,
        };
    }
    let shell = terminal::shell_program();
    // Shell completion hooks may expand expressions in a draft.
    let native = (!request.line.contains(['$', '`']))
        .then(|| platform::native(request, &context, cwd, &shell))
        .flatten();
    if let Some(mut result) = native {
        if result.index <= request.caret
            && result.index.saturating_add(result.length) <= request.line.encode_utf16().count()
        {
            if directory && !context.prefix.starts_with('-') {
                // Providers can report ordinary files among directory completions.
                result.matches.retain(|entry| entry.directory);
            }
            result.matches.truncate(MAX_MATCHES);
            if !result.matches.is_empty() {
                return result;
            }
        }
    }
    let search_path = request
        .shell_environment
        .as_ref()
        .filter(|_| cfg!(target_os = "linux"))
        .and_then(|environment| environment.get("PATH"))
        .map(|value| value.as_deref().unwrap_or(""));
    let mut matches = if context.words.is_empty() && !context.prefix.contains(['/', '\\']) {
        executables(&context.prefix, search_path)
            .into_iter()
            .map(|label| Suggestion {
                text: shell_word(&label),
                label,
                directory: false,
            })
            .collect()
    } else {
        Vec::new()
    };
    if cfg!(target_os = "macos") || context.allows_path_fallback(cfg!(windows)) {
        matches.extend(paths(cwd, &context.prefix, directory));
    }
    matches.truncate(MAX_MATCHES);
    CompletionBatch {
        index: context.index,
        length: context.length,
        matches,
        exclusive: false,
    }
}

fn read_process(command: Command, input: Vec<u8>) -> Option<Vec<u8>> {
    let timeout = Duration::from_secs(if cfg!(windows) { 8 } else { 4 });
    read_process_with_timeout(command, input, timeout)
}

fn read_process_with_timeout(
    mut command: Command,
    input: Vec<u8>,
    timeout: Duration,
) -> Option<Vec<u8>> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    #[cfg(windows)]
    let _job = platform::ProcessJob::attach(&child);
    let mut writer = child.stdin.take()?;
    let reader = child.stdout.take()?;
    let (sender, results) = mpsc::channel();
    std::thread::spawn(move || {
        let result = writer.write_all(&input);
        drop(writer);
        let mut bytes = Vec::new();
        let read = result.and_then(|()| reader.take(1024 * 1024).read_to_end(&mut bytes));
        let _ = sender.send(read.ok().map(|_| bytes));
    });
    let deadline = Instant::now() + timeout;
    let bytes = results.recv_timeout(timeout).ok().flatten();
    let mut exited = child.try_wait().ok().flatten();
    while bytes.is_some() && exited.is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
        exited = child.try_wait().ok().flatten();
    }
    if bytes.is_none() || exited.is_none() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
    }
    let status = child.wait().ok()?;
    if status.success() {
        bytes
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn completes_linux_command_line_and_ssh_prompt_in_their_own_directories() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let local = temp.path().join("local project");
        let remote = temp.path().join("remote project");
        let bin = temp.path().join("remote bin");
        let local_bin = temp.path().join("local bin");
        for directory in [&home, &local, &remote, &bin, &local_bin] {
            fs::create_dir(directory).unwrap();
        }
        let remote_path = format!("{}:/usr/bin:/bin", bin.display());
        fs::write(
            home.join(".bashrc"),
            format!("export PATH={}\n", crate::ssh::quote(&remote_path)),
        )
        .unwrap();
        fs::write(
            home.join(".bash_completion"),
            r#"_fixture_tool() {
    case "$3" in
        remote-only-tool) COMPREPLY=(report);;
        report) COMPREPLY=(--summary);;
    esac
}
complete -F _fixture_tool remote-only-tool
"#,
        )
        .unwrap();
        fs::write(remote.join("remote-file.txt"), []).unwrap();
        fs::write(local.join("local-file.txt"), []).unwrap();
        let docker = r#"#!/bin/sh
case "$*" in
  "__complete co"|"__complete ") printf 'container\ncompose\n:4\n';;
  "__complete image ls --for"|"__complete image ls -") printf '%s\n' '--format' ':4';;
  "__complete ps ") printf ':4\n';;
  "__complete ps -") printf '%s\n' '--all' '--format' ':4';;
  "__complete ps --format ") printf ':4\n';;
  "__complete ps --format -") printf ':0\n';;
  "__complete compose up -") printf '%s\n' '--build' ':4';;
  "__complete container logs -") printf '%s\n' '--follow' ':4';;
  'compose config --services') /bin/cat compose.yaml;;
  *'container ls --all --no-trunc --format'*) /bin/cat containers.json;;
esac
"#;
        for (dir, name, source) in [
            (&bin, "remote-only-tool", "#!/bin/sh\n"),
            (&local_bin, "local-only-tool", "#!/bin/sh\n"),
            (&bin, "docker", docker),
            (&local_bin, "docker", docker),
        ] {
            let path = dir.join(name);
            fs::write(&path, source).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(remote.join("compose.yaml"), "remote-web\n").unwrap();
        fs::write(local.join("compose.yaml"), "local-web\n").unwrap();
        fs::write(
            remote.join("containers.json"),
            r#"{"ID":"aabb","Names":"remote-container"}"#,
        )
        .unwrap();
        fs::write(
            local.join("containers.json"),
            r#"{"ID":"ccdd","Names":"local-container"}"#,
        )
        .unwrap();
        let environment = HashMap::from([(
            "PATH".to_owned(),
            Some(format!("{}:/usr/bin:/bin", local_bin.display())),
        )]);
        for (line, expected) in [
            ("local-only", "local-only-tool"),
            ("ec", "echo"),
            ("cat local-", "local-file.txt"),
            ("local-only-tool ./local-", "local-file.txt"),
            ("docker co", "container"),
            ("docker ps ", "--all"),
            ("docker image ls ", "--format"),
            ("docker image ls --for", "--format"),
            ("docker compose up ", "--build"),
            ("docker compose up ", "local-web"),
            ("docker container logs ", "--follow"),
            ("docker container logs ", "local-container"),
            ("docker compose logs local-", "local-web"),
            ("docker container inspect cc", "ccdd"),
        ] {
            let batch = complete(&CompletionRequest {
                line: line.into(),
                caret: line.len(),
                directory: local.to_string_lossy().into_owned(),
                refresh_environment: false,
                shell_environment: Some(environment.clone()),
            });
            assert!(
                batch.matches.iter().any(|item| item.label == expected),
                "local {line}: missing {expected}"
            );
        }
        for line in ["local-only-tool local-", "docker ps --format "] {
            let batch = complete(&CompletionRequest {
                line: line.into(),
                caret: line.len(),
                directory: local.to_string_lossy().into_owned(),
                refresh_environment: false,
                shell_environment: Some(environment.clone()),
            });
            assert!(batch.matches.is_empty(), "local {line}");
        }
        for live in [false, true] {
            for (line, expected) in [
                ("remote-only", "remote-only-tool"),
                ("remote-only-tool rep", "report"),
                ("remote-only-tool report --sum", "--summary"),
                ("ec", "echo"),
                ("cat remote-", "remote-file.txt"),
                ("docker ", "compose"),
                ("docker co", "container"),
                ("docker ps ", "--all"),
                ("docker image ls ", "--format"),
                ("docker image ls --for", "--format"),
                ("docker compose up ", "--build"),
                ("docker compose up ", "remote-web"),
                ("docker container logs ", "--follow"),
                ("docker container logs ", "remote-container"),
                ("docker compose logs remote-", "remote-web"),
                ("docker container inspect aa", "aabb"),
            ] {
                let batch = complete_remote(
                    RemoteCompletionRequest {
                        line: line.into(),
                        caret: line.len(),
                        directory: remote.to_string_lossy().into_owned(),
                        search_path: live.then(|| remote_path.clone()),
                        shell_environment: None,
                    },
                    !live,
                    |script| {
                        let output = Command::new("/bin/sh")
                            .args(["-c", &script])
                            .env_clear()
                            .env("PATH", "/usr/bin:/bin")
                            .env("SHELL", "/bin/bash")
                            .env("HOME", &home)
                            .output()
                            .unwrap();
                        assert!(output.status.success(), "remote shell status for {line}");
                        std::future::ready(Ok(output.stdout))
                    },
                )
                .await
                .unwrap();
                assert!(
                    batch.matches.iter().any(|item| item.label == expected),
                    "remote {line}: missing {expected}"
                );
            }
        }
    }

    #[test]
    fn matches_only_the_current_token_and_preserves_the_rest_of_the_draft() {
        let line = "echo 🐈; git che --quiet";
        let caret = "echo 🐈; git ch".encode_utf16().count();
        let result = context(line, caret).unwrap();
        assert_eq!(result.words, ["git"]);
        assert_eq!(result.prefix, "ch");
        assert_eq!(result.index, caret - 2);
        assert_eq!(result.length, 3);
    }

    #[test]
    fn parses_power_shell_folder_quotes_and_drive_roots() {
        let root = "cd C:\\";
        let context = shell_context(root, root.len(), true).unwrap();
        assert_eq!(context.prefix, "C:\\");
        let quoted = "cd 'C:\\O''Brien\\'";
        let context = shell_context(quoted, quoted.len() - 1, true).unwrap();
        assert_eq!(context.prefix, "C:\\O'Brien\\");
        assert_eq!(context.index + context.length, quoted.len());
    }

    #[test]
    fn only_enables_generic_paths_in_path_positions() {
        for (draft, windows, expected) in [
            ("git checkout ", true, false),
            ("git checkout ", false, false),
            ("ipconfig /n", true, false),
            ("kubectl get pods ", false, false),
            ("unknown-tool --flag ", true, false),
            ("unknown-tool --flag ", false, false),
            ("unknown-tool .\\assets", true, true),
            ("unknown-tool ./assets", false, true),
            ("cd work", true, true),
            ("cd work", false, true),
            ("cat notes", false, true),
            ("cat --", false, false),
        ] {
            let context = shell_context(draft, draft.len(), windows).unwrap();
            assert_eq!(context.allows_path_fallback(windows), expected, "{draft}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn power_shell_suggests_files_for_path_arguments() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("completion-fixture")).unwrap();
        for (draft, expected) in [
            ("Get-ChildItem completion-", true),
            ("Get-ChildItem -Force completion-", true),
            ("Get-ChildItem -Filter completion-", false),
            ("where.exe completion-", false),
            ("where.exe .\\completion-", true),
        ] {
            let batch = complete(&CompletionRequest {
                line: draft.to_owned(),
                caret: draft.len(),
                directory: directory.path().to_string_lossy().into_owned(),
                refresh_environment: false,
                shell_environment: None,
            });
            assert_eq!(
                batch
                    .matches
                    .iter()
                    .any(|item| item.label == "completion-fixture"),
                expected,
                "{draft}"
            );
        }
    }
}
