use std::{ffi::OsStr, time::Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use super::*;

pub(super) fn native(
    request: &CompletionRequest,
    context: &Context,
    cwd: &Path,
    shell: &OsStr,
) -> Option<CompletionBatch> {
    let _ = request.refresh_environment;
    if context
        .words
        .first()
        .is_some_and(|word| matches!(word.as_str(), "cd" | "pushd"))
    {
        return None;
    }
    let shell_name = Path::new(shell).file_name()?.to_str()?;
    let output = match shell_name {
        "bash" => bash(request, context, cwd, shell),
        "zsh" => zsh(request, context, cwd, shell),
        _ => None,
    }?;
    let mut seen = BTreeSet::new();
    let matches = output
        .split(|&byte| byte == 0)
        .filter_map(|candidate| {
            let value = std::str::from_utf8(candidate).ok()?;
            let (label, trailing_space) = if shell_name == "bash" {
                value
                    .strip_suffix(' ')
                    .map_or((value, false), |label| (label, true))
            } else {
                (value, false)
            };
            if label.is_empty() || label.contains(['\n', '\r']) || !seen.insert(label) {
                return None;
            }
            let mut text = shell_word(label);
            if trailing_space {
                text.push(' ');
            }
            Some(Suggestion {
                label: label.to_owned(),
                text,
                directory: label.ends_with('/'),
            })
        })
        .collect();
    Some(CompletionBatch {
        index: context.index,
        length: context.length,
        matches,
        exclusive: false,
    })
}

fn bash(
    request: &CompletionRequest,
    context: &Context,
    cwd: &Path,
    shell: &OsStr,
) -> Option<Vec<u8>> {
    let mut command = Command::new(shell);
    command
        .current_dir(cwd)
        .env_remove("BASH_ENV")
        .args([
            "--noprofile",
            "--norc",
            "-c",
            include_str!("bash.sh"),
            "dirlume-completion",
        ])
        .arg(context.byte_caret.to_string())
        .arg(&request.line)
        .args(&context.words)
        .arg(&context.prefix);
    read_process(command, Vec::new())
}

fn zsh(
    request: &CompletionRequest,
    context: &Context,
    cwd: &Path,
    shell: &OsStr,
) -> Option<Vec<u8>> {
    let config = tempfile::tempdir().ok()?;
    fs::write(config.path().join(".zshrc"), include_str!("zshrc")).ok()?;
    let results = config.path().join("matches");
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .ok()?;
    let mut reader = pair.master.try_clone_reader().ok()?;
    let mut writer = pair.master.take_writer().ok()?;
    let mut command = CommandBuilder::new(shell);
    command.args(["-di"]);
    command.cwd(cwd);
    command.env("ZDOTDIR", config.path());
    command.env("TERM", "xterm-256color");
    command.env("DIRLUME_COMPLETION_DRAFT", &request.line);
    command.env(
        "DIRLUME_COMPLETION_CURSOR",
        request.line[..context.byte_caret]
            .chars()
            .count()
            .to_string(),
    );
    command.env("DIRLUME_COMPLETION_OUTPUT", &results);
    let mut child = pair.slave.spawn_command(command).ok()?;
    drop(pair.slave);
    let (sender, signal) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut chunk = [0; 512];
        let mut pending = Vec::new();
        let mut ready = false;
        while let Ok(count) = reader.read(&mut chunk) {
            if count == 0 {
                break;
            }
            if !ready {
                const MARKER: &[u8] = b"DIRLUME-ZSH-READY";
                pending.extend_from_slice(&chunk[..count]);
                if pending.windows(MARKER.len()).any(|window| window == MARKER) {
                    ready = true;
                    let _ = sender.send(());
                } else if pending.len() > MARKER.len() {
                    pending.drain(..pending.len() - MARKER.len());
                }
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(4);
    if signal.recv_timeout(Duration::from_secs(2)).is_ok() && writer.write_all(b"\t").is_ok() {
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return fs::File::open(results).ok().and_then(|file| {
                    let mut matches = Vec::new();
                    file.take(1024 * 1024).read_to_end(&mut matches).ok()?;
                    Some(matches)
                });
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}
