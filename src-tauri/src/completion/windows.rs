use std::{
    collections::HashMap, ffi::OsStr, mem, os::windows::io::AsRawHandle, process::Child, ptr,
    sync::OnceLock,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

use super::*;

const SCRIPT: &str = include_str!("powershell.ps1");
const CATALOG: &str = include_str!("windows-command-catalog.tsv");
pub(super) fn native(
    request: &CompletionRequest,
    context: &Context,
    cwd: &Path,
    shell: &OsStr,
) -> Option<CompletionBatch> {
    if let Some(batch) = windows_options(context) {
        return Some(batch);
    }
    if let Some(batch) = git_options(context, cwd, request.refresh_environment) {
        return Some(batch);
    }
    let script = STANDARD.encode(
        SCRIPT
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut command = Command::new(shell);
    command.current_dir(cwd).args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        &script,
    ]);
    if let Ok(environment) = crate::windows_environment::variables(request.refresh_environment) {
        command.env_clear().envs(environment);
    }
    let mut input = serde_json::to_vec(&serde_json::json!({ "catalog": CATALOG })).ok()?;
    input.push(b'\n');
    serde_json::to_writer(
        &mut input,
        &serde_json::json!({
            "line": request.line,
            "caret": request.caret,
            "directory": request.directory,
        }),
    )
    .ok()?;
    input.push(b'\n');
    let output = read_process(command, input)?;
    serde_json::from_slice(&output).ok()
}

fn git_options(
    context: &Context,
    cwd: &Path,
    refresh_environment: bool,
) -> Option<CompletionBatch> {
    let (program, arguments) = context.words.split_first()?;
    if !program.eq_ignore_ascii_case("git") && !program.eq_ignore_ascii_case("git.exe") {
        return None;
    }
    let args: &[&str] = match arguments {
        [] => &["--list-cmds=main,others,alias"],
        [verb]
            if [
                "checkout",
                "switch",
                "merge",
                "rebase",
                "log",
                "diff",
                "show",
                "reset",
                "cherry-pick",
                "revert",
            ]
            .contains(&verb.to_ascii_lowercase().as_str())
                && !context.prefix.starts_with('-') =>
        {
            &[
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
            ]
        }
        _ => return None,
    };
    let environment = crate::windows_environment::variables(refresh_environment).ok()?;
    let path = environment.iter().find_map(|(name, value)| {
        name.to_str()
            .is_some_and(|name| name.eq_ignore_ascii_case("PATH"))
            .then_some(value)
    })?;
    let git = std::env::split_paths(path)
        .filter(|path| path.is_absolute())
        .map(|path| path.join("git.exe"))
        .find(|path| path.is_file())?;
    let mut command = Command::new(git);
    command
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args);
    let output = String::from_utf8(read_process(command, Vec::new())?).ok()?;
    let matches: Vec<_> = output
        .lines()
        .filter(|value| starts_with(value, &context.prefix))
        .take(MAX_MATCHES)
        .map(|value| Suggestion {
            label: value.to_owned(),
            text: shell_word(value),
            directory: false,
        })
        .collect();
    (!matches.is_empty()).then_some(CompletionBatch {
        index: context.index,
        length: context.length,
        matches,
        exclusive: false,
    })
}

fn windows_options(context: &Context) -> Option<CompletionBatch> {
    static OPTIONS: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    let catalog = OPTIONS.get_or_init(|| {
        CATALOG
            .lines()
            .map(|row| row.split_once('\t').unwrap_or((row, "")))
            .collect()
    });
    let (command, arguments) = context.words.split_first()?;
    let lower = command.to_ascii_lowercase();
    let program = lower
        .strip_suffix(".exe")
        .or_else(|| lower.strip_suffix(".com"))
        .unwrap_or(&lower);
    let mut name = program.to_owned();
    let mut options = *catalog.get(program)?;
    let system = Path::new(&std::env::var_os("SystemRoot")?).join("System32");
    if !system.join(format!("{program}.exe")).is_file()
        && !system.join(format!("{program}.com")).is_file()
    {
        return None;
    }
    // Let PowerShell complete adapter names and commands passed to cmd.exe.
    if (program == "ipconfig"
        && arguments.first().is_some_and(|argument| {
            matches!(
                argument.to_ascii_lowercase().as_str(),
                "/renew" | "/release"
            )
        }))
        || (program == "cmd"
            && arguments
                .iter()
                .any(|argument| matches!(argument.to_ascii_lowercase().as_str(), "/c" | "/k")))
    {
        return None;
    }
    for argument in arguments {
        let child = format!("{name} {}", argument.to_ascii_lowercase());
        let Some(next) = catalog.get(child.as_str()) else {
            break;
        };
        name = child;
        options = next;
    }
    let prefix = if context.prefix == "?" {
        "/?"
    } else {
        &context.prefix
    };
    let matches: Vec<_> = options
        .split_whitespace()
        .filter(|value| starts_with(value, prefix))
        .take(MAX_MATCHES)
        .map(|value| Suggestion {
            label: value.to_owned(),
            text: value.to_owned(),
            directory: false,
        })
        .collect();
    (!matches.is_empty()).then_some(CompletionBatch {
        index: context.index,
        length: context.length,
        matches,
        exclusive: false,
    })
}

pub(super) struct ProcessJob(HANDLE);

impl ProcessJob {
    pub fn attach(child: &Child) -> Option<Self> {
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return None;
        }
        let job = Self(job);
        let mut limit = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limit as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                mem::size_of_val(&limit) as u32,
            ) != 0
                && AssignProcessToJobObject(job.0, child.as_raw_handle().cast()) != 0
        };
        configured.then_some(job)
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}
