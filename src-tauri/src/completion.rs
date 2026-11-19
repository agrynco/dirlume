use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    desktop::{blocking, message, Result},
    local, terminal,
};

#[cfg(not(windows))]
#[path = "completion/unix.rs"]
mod platform;
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
}

#[derive(Default, Deserialize, Serialize)]
pub struct CompletionBatch {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    length: usize,
    #[serde(default)]
    matches: Vec<Suggestion>,
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
    blocking(move || {
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
    #[cfg(not(windows))]
    byte_caret: usize,
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
    let mut chars = word.chars();
    while let Some(letter) = chars.next() {
        if letter == escape && quote != Some('\'') {
            if let Some(escaped) = chars.next() {
                result.push(escaped);
            }
        } else if quote == Some(letter) {
            quote = None;
        } else if quote.is_none() && matches!(letter, '\'' | '"') {
            quote = Some(letter);
        } else {
            result.push(letter);
        }
    }
    result
}

fn context(line: &str, caret: usize) -> Option<Context> {
    let byte_caret = byte_at_utf16(line, caret)?;
    let escape = if cfg!(windows) { '`' } else { '\\' };
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
        #[cfg(not(windows))]
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
    if !(cfg!(windows) && value.starts_with('@'))
        && value.chars().all(|letter| {
            letter.is_alphanumeric()
                || "_./-:+,=@%~".contains(letter)
                || (cfg!(windows) && letter == '\\')
        })
    {
        return value.to_owned();
    }
    if cfg!(windows) {
        return format!("'{}'", value.replace('\'', "''"));
    }
    if let Some(tail) = value.strip_prefix("~/") {
        return format!("~/'{}'", tail.replace('\'', "'\\''"));
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn paths(cwd: &Path, prefix: &str, directories_only: bool) -> Vec<Suggestion> {
    let separator = if cfg!(windows) { '\\' } else { '/' };
    let position = prefix.rfind(|c| c == '/' || (cfg!(windows) && c == '\\'));
    let (base, name) = prefix.split_at(position.map_or(0, |at| at + 1));
    let directory = if let Some(relative) = base.strip_prefix("~/") {
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

fn executables(prefix: &str) -> Vec<String> {
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
    if let Some(path) = std::env::var_os("PATH") {
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
    let shell = terminal::shell_program();
    // Shell completion hooks may expand expressions in a draft.
    let native = (!request.line.contains(['$', '`']))
        .then(|| platform::native(request, &context, cwd, &shell))
        .flatten();
    if let Some(mut result) = native {
        if result.index <= request.caret
            && result.index.saturating_add(result.length) <= request.line.encode_utf16().count()
        {
            result.matches.truncate(MAX_MATCHES);
            if !result.matches.is_empty() {
                return result;
            }
        }
    }
    let directory = context.words.first().is_some_and(|first| {
        matches!(
            first.to_ascii_lowercase().as_str(),
            "cd" | "pushd" | "set-location" | "sl"
        )
    });
    let mut matches = if context.words.is_empty() && !context.prefix.contains(['/', '\\']) {
        executables(&context.prefix)
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
    matches.extend(paths(cwd, &context.prefix, directory));
    matches.truncate(MAX_MATCHES);
    CompletionBatch {
        index: context.index,
        length: context.length,
        matches,
    }
}

fn read_process(mut command: Command, input: Vec<u8>) -> Option<Vec<u8>> {
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
    let timeout = if cfg!(windows) { 8 } else { 4 };
    let bytes = results
        .recv_timeout(Duration::from_secs(timeout))
        .ok()
        .flatten();
    if bytes.is_none() || child.try_wait().ok().flatten().is_none() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
    }
    let _ = child.wait();
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
