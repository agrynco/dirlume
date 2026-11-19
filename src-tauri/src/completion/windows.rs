use std::{ffi::OsStr, mem, os::windows::io::AsRawHandle, process::Child, ptr};

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
    _: &Context,
    cwd: &Path,
    shell: &OsStr,
) -> Option<CompletionBatch> {
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
