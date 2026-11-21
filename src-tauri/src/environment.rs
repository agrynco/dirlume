use std::{
    fs,
    io::{self, Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::Path,
    sync::Mutex,
    time::Duration,
};

use serde::{Deserialize, Serialize};

#[cfg(unix)]
mod files;
#[cfg(windows)]
mod registry;
#[cfg(unix)]
use files as platform;
#[cfg(windows)]
use registry as platform;

const HELPER: &str = "--dirlume-environment-helper";
const MAX_REQUEST: u64 = 8 * 1024 * 1024;
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    User,
    System,
    Process,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    Literal,
    Expandable,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    name: String,
    value: String,
    kind: ValueKind,
    source: String,
    overridden_by: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    name: String,
    source: String,
    overridden_by: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Information {
    target: String,
    activation: &'static str,
    startup_file: Option<String>,
    integration_enabled: bool,
    expandable: bool,
}

#[derive(Serialize)]
pub struct Listing {
    rows: Vec<Variable>,
    info: Information,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    name: String,
    value: String,
    kind: ValueKind,
    expected: Option<Definition>,
    replace_path: bool,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResultKind {
    Saved,
    Conflict,
    Invalid,
    Denied,
    Failed,
}

#[derive(Serialize, Deserialize)]
pub struct Outcome {
    name: String,
    result: ResultKind,
}

#[derive(Serialize, Deserialize)]
struct Request {
    edits: Vec<Edit>,
    integrate: bool,
    port: u16,
    nonce: String,
}

#[derive(Serialize, Deserialize)]
pub struct SaveResult {
    outcomes: Vec<Outcome>,
    integration: Option<ResultKind>,
}

fn process_variables() -> Vec<Definition> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some(Definition {
            name: name.into_string().ok()?,
            value: value.into_string().ok()?,
            kind: ValueKind::Literal,
            source: "Dirlume process".to_owned(),
            overridden_by: None,
        }))
        .collect()
}

fn definitions(scope: Scope) -> io::Result<Vec<Definition>> {
    if scope == Scope::Process {
        return Ok(process_variables());
    }
    platform::definitions(scope)
}

fn info(scope: Scope) -> io::Result<Information> {
    if scope == Scope::Process {
        return Ok(Information {
            target: "Dirlume process".into(),
            activation: "These values were inherited when Dirlume started.",
            startup_file: None,
            integration_enabled: false,
            expandable: false,
        });
    }
    platform::info(scope)
}

fn sanitized(_: io::Error) -> String {
    "Could not read the selected environment scope.".to_owned()
}

#[tauri::command]
pub async fn environment_scope(scope: Scope) -> Result<Listing, String> {
    crate::desktop::blocking(move || {
        let mut rows: Vec<_> = definitions(scope).map_err(sanitized)?.into_iter().map(|row| Variable {
            name: row.name, source: row.source, overridden_by: row.overridden_by,
        }).collect();
        rows.sort_by_cached_key(|row| row.name.to_lowercase());
        Ok(Listing { rows, info: info(scope).map_err(sanitized)? })
    }).await
}

#[tauri::command]
pub async fn environment_value(scope: Scope, name: String) -> Result<Option<Definition>, String> {
    crate::desktop::blocking(move || Ok(definitions(scope).map_err(sanitized)?.into_iter()
        .find(|row| platform::same_name(&row.name, &name)))).await
}

fn error(error: io::Error) -> ResultKind {
    if error.kind() == io::ErrorKind::PermissionDenied { ResultKind::Denied } else { ResultKind::Failed }
}

fn valid(edit: &Edit) -> bool {
    platform::valid_name(&edit.name) && platform::valid_value(&edit.value, edit.kind)
        && (!platform::same_name(&edit.name, "PATH") || edit.expected.is_none() || edit.replace_path)
}

fn apply(scope: Scope, edits: &[Edit], integrate: bool) -> SaveResult {
    let _guard = WRITES.lock().ok();
    let outcomes = edits.iter().map(|edit| {
        let result = if !valid(edit) || scope == Scope::Process {
            ResultKind::Invalid
        } else {
            match definitions(scope) {
                Ok(rows) => {
                    let current = rows.iter().find(|row| platform::same_name(&edit.name, &row.name));
                    if current != edit.expected.as_ref() {
                        ResultKind::Conflict
                    } else {
                        platform::write(scope, edit).map_or_else(error, |()| ResultKind::Saved)
                    }
                }
                Err(failure) => error(failure),
            }
        };
        Outcome { name: edit.name.clone(), result }
    }).collect();
    let integration = integrate.then(|| platform::integrate(scope).map_or_else(error, |()| ResultKind::Saved));
    SaveResult { outcomes, integration }
}

fn unavailable(edits: &[Edit], integrate: bool, result: ResultKind) -> SaveResult {
    SaveResult {
        outcomes: edits.iter().map(|edit| Outcome { name: edit.name.clone(), result }).collect(),
        integration: integrate.then_some(result),
    }
}

fn elevated(edits: Vec<Edit>, integrate: bool) -> io::Result<SaveResult> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let mut file = tempfile::Builder::new().prefix("dirlume-env-").tempfile()?;
    let request = Request { edits, integrate, port: listener.local_addr()?.port(), nonce: uuid::Uuid::new_v4().to_string() };
    serde_json::to_writer(file.as_file_mut(), &request)?;
    file.as_file().sync_all()?;
    if file.as_file().metadata()?.len() > MAX_REQUEST {
        return Ok(unavailable(&request.edits, integrate, ResultKind::Invalid));
    }
    // The helper returns statuses using a local connection. It never writes to the request path.
    let launcher = platform::elevate(file.path())?;
    if !launcher {
        return Ok(unavailable(&request.edits, integrate, ResultKind::Denied));
    }
    listener.set_nonblocking(true)?;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                let mut answer = Vec::new();
                stream.take(MAX_REQUEST + 1).read_to_end(&mut answer)?;
                if let Ok((nonce, result)) = serde_json::from_slice::<(String, SaveResult)>(&answer) {
                    if nonce == request.nonce {
                        return Ok(result);
                    }
                }
            }
            Err(failure) if failure.kind() == io::ErrorKind::WouldBlock => {
                return Ok(unavailable(&request.edits, integrate, ResultKind::Failed));
            }
            Err(failure) => return Err(failure),
        }
    }
}

#[tauri::command]
pub async fn save_environment(scope: Scope, edits: Vec<Edit>, integrate: bool) -> Result<SaveResult, String> {
    crate::desktop::blocking(move || {
        if scope == Scope::System && platform::needs_admin() && (integrate || edits.iter().any(valid)) {
            elevated(edits, integrate).map_err(|_| "Could not authorize the environment change.".to_owned())
        } else {
            Ok(apply(scope, &edits, integrate))
        }
    }).await
}

pub fn helper() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(HELPER)) {
        return None;
    }
    Some(i32::from(!args.next().is_some_and(|path| helper_request(Path::new(&path)).is_ok())))
}

fn helper_request(path: &Path) -> io::Result<()> {
    let request_file = fs::File::open(path)?;
    let request: Request = serde_json::from_reader(request_file.take(MAX_REQUEST))?;
    let result = apply(Scope::System, &request.edits, request.integrate);
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, request.port).into();
    let mut response = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    response.set_write_timeout(Some(Duration::from_secs(2)))?;
    serde_json::to_writer(&mut response, &(request.nonce, result))?;
    response.flush()
}
