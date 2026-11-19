use std::{
    collections::HashMap,
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime},
};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State as HttpState},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use subtle::ConstantTimeEq;
use tauri::{Emitter, Manager, State, WebviewWindow};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Semaphore},
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    desktop::{blocking, message, Result},
    local, processes,
};

const TOOLS: &str = include_str!("mcp_tools.json");
const PROTOCOL: &str = "2025-11-25";

fn tool_definitions() -> &'static [Value] {
    static DEFINITIONS: OnceLock<Vec<Value>> = OnceLock::new();
    DEFINITIONS.get_or_init(|| serde_json::from_str(TOOLS).expect("valid MCP tool definitions"))
}

#[derive(Clone)]
struct Session {
    app: tauri::AppHandle,
    port: u16,
    token: String,
    stopped: CancellationToken,
    calls: Arc<Semaphore>,
}

#[derive(Default)]
pub struct McpService {
    session: Mutex<Option<Session>>,
    calls: Mutex<HashMap<String, Pending>>,
}

enum Pending {
    Approval(oneshot::Sender<bool>),
    Action(oneshot::Sender<FrontendResult>),
}

#[derive(Deserialize)]
pub struct FrontendResult {
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct McpConnection {
    endpoint: String,
    token: String,
}

impl Session {
    fn connection(&self) -> McpConnection {
        McpConnection {
            endpoint: format!("http://127.0.0.1:{}/mcp", self.port),
            token: self.token.clone(),
        }
    }
}

#[tauri::command]
pub async fn start_mcp(
    app: tauri::AppHandle,
    service: State<'_, McpService>,
) -> Result<McpConnection> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .map_err(message)?;
    let port = listener.local_addr().map_err(message)?.port();
    let mut secret = [0u8; 32];
    SystemRandom::new()
        .fill(&mut secret)
        .map_err(|_| "Unable to create an MCP access token.")?;
    let mut current = service.session.lock().map_err(message)?;
    if let Some(session) = current.as_ref() {
        return Ok(session.connection());
    }
    let session = Session {
        app,
        port,
        token: URL_SAFE_NO_PAD.encode(secret),
        stopped: CancellationToken::new(),
        calls: Arc::new(Semaphore::new(1)),
    };
    let connection = session.connection();
    let stop = session.stopped.clone();
    let router = Router::new()
        .route("/mcp", post(rpc))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(session.clone());
    *current = Some(session);
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await;
    });
    Ok(connection)
}

#[tauri::command]
pub fn stop_mcp(service: State<'_, McpService>) -> Result<()> {
    if let Some(session) = service.session.lock().map_err(message)?.take() {
        session.stopped.cancel();
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_connection(service: State<'_, McpService>) -> Result<Option<McpConnection>> {
    Ok(service
        .session
        .lock()
        .map_err(message)?
        .as_ref()
        .map(Session::connection))
}

fn check_window(window: &WebviewWindow) -> Result<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Use the Dirlume window.".to_owned())
    }
}

#[tauri::command]
pub fn mcp_decision(
    window: WebviewWindow,
    id: String,
    approved: bool,
    service: State<'_, McpService>,
) -> Result<()> {
    check_window(&window)?;
    let mut pending = service.calls.lock().map_err(message)?;
    let Some(Pending::Approval(_)) = pending.get(&id) else {
        return Err("The confirmation has expired.".to_owned());
    };
    if let Some(Pending::Approval(reply)) = pending.remove(&id) {
        reply
            .send(approved)
            .map_err(|_| "The confirmation has expired.".to_owned())?;
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_result(
    window: WebviewWindow,
    id: String,
    output: FrontendResult,
    service: State<'_, McpService>,
) -> Result<()> {
    check_window(&window)?;
    let mut pending = service.calls.lock().map_err(message)?;
    let Some(Pending::Action(_)) = pending.get(&id) else {
        return Err("The MCP request has expired.".to_owned());
    };
    if let Some(Pending::Action(reply)) = pending.remove(&id) {
        reply
            .send(output)
            .map_err(|_| "The MCP request has expired.".to_owned())?;
    }
    Ok(())
}

fn error(id: Value, code: i32, message: &str) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
        .into_response()
}

fn result(id: Value, value: Value) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": value })).into_response()
}

async fn rpc(HttpState(session): HttpState<Session>, headers: HeaderMap, bytes: Bytes) -> Response {
    let host = format!("127.0.0.1:{}", session.port);
    if headers.contains_key(header::ORIGIN)
        || headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            != Some(host.as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !bool::from(bearer.as_bytes().ct_eq(session.token.as_bytes()))
        || session.stopped.is_cancelled()
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(request) = serde_json::from_slice::<Value>(&bytes) else {
        return error(Value::Null, -32700, "Invalid JSON.");
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    if request["jsonrpc"] != "2.0"
        || !matches!(id, Value::Null | Value::Number(_) | Value::String(_))
    {
        return error(Value::Null, -32600, "Invalid JSON-RPC request.");
    }
    let Some(method) = request["method"].as_str() else {
        return error(id, -32600, "A method is required.");
    };
    if id.is_null() {
        return StatusCode::ACCEPTED.into_response();
    }
    match method {
        "initialize" => {
            let requested = request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or(PROTOCOL);
            let version = if matches!(requested, "2025-03-26" | "2025-06-18" | "2025-11-25") {
                requested
            } else {
                PROTOCOL
            };
            result(
                id,
                json!({ "protocolVersion": version, "capabilities": { "tools": {} },
              "serverInfo": { "name": "dirlume", "version": env!("CARGO_PKG_VERSION") } }),
            )
        }
        "ping" => result(id, json!({})),
        "tools/list" => result(id, json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let params = &request["params"];
            let Some(name) = params["name"].as_str() else {
                return error(id, -32602, "A tool name is required.");
            };
            let arguments = match params.get("arguments") {
                None => Map::new(),
                Some(Value::Object(arguments)) => arguments.clone(),
                Some(_) => return error(id, -32602, "Tool arguments must be an object."),
            };
            match validate(name, &arguments) {
                Ok(()) => {}
                Err(problem) => return error(id, -32602, &problem),
            }
            let contents = match session.call(name, arguments).await {
                Ok(value) => json!({ "content": [{ "type": "text", "text": value.to_string() }] }),
                Err(problem) => {
                    json!({ "isError": true, "content": [{ "type": "text", "text": problem }] })
                }
            };
            result(id, contents)
        }
        _ => error(id, -32601, "Method not found."),
    }
}

fn validate(name: &str, arguments: &Map<String, Value>) -> Result<()> {
    let tool = tool_definitions()
        .iter()
        .find(|tool| tool["name"] == name)
        .ok_or("Unknown Dirlume tool.")?;
    let schema = &tool["inputSchema"];
    if schema["required"].as_array().is_some_and(|fields| {
        fields.iter().any(|field| {
            field
                .as_str()
                .is_some_and(|key| !arguments.contains_key(key))
        })
    }) {
        return Err("Required tool arguments are missing.".to_owned());
    }
    for (key, value) in arguments {
        let property = &schema["properties"][key];
        let valid = match property["type"].as_str() {
            Some("string") => value.is_string(),
            Some("boolean") => value.is_boolean(),
            Some("integer") => value.as_u64().is_some(),
            Some("object") => value.is_object(),
            Some("array") => value.as_array().is_some_and(|entries| {
                entries.len() <= 100
                    && match property["items"]["type"].as_str() {
                        Some("string") => entries.iter().all(Value::is_string),
                        Some("integer") => entries.iter().all(|item| item.as_u64().is_some()),
                        _ => false,
                    }
            }),
            _ => false,
        } && !property["enum"]
            .as_array()
            .is_some_and(|options| !options.contains(value));
        if !valid {
            return Err(format!("Invalid tool argument: {key}."));
        }
    }
    Ok(())
}

struct Request<'a> {
    service: State<'a, McpService>,
    id: String,
}

impl Drop for Request<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.service.calls.lock() {
            pending.remove(&self.id);
        }
    }
}

impl Session {
    fn show_request(
        &self,
        pending: Pending,
        event: &str,
        mut payload: Value,
    ) -> Result<Request<'_>> {
        let window = self
            .app
            .get_webview_window("main")
            .ok_or("Open Dirlume to use its MCP server.")?;
        if matches!(pending, Pending::Approval(_))
            && (!window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false))
        {
            return Err("Open the Dirlume window to handle the MCP request.".to_owned());
        }
        let service = self.app.state::<McpService>();
        let id = Uuid::new_v4().to_string();
        service
            .calls
            .lock()
            .map_err(message)?
            .insert(id.clone(), pending);
        payload["id"] = json!(id);
        let request = Request { id, service };
        window.emit(event, payload).map_err(message)?;
        Ok(request)
    }

    async fn await_reply<T>(&self, reply: oneshot::Receiver<T>) -> Result<T> {
        tokio::select! {
            () = self.stopped.cancelled() => Err("The MCP server has stopped.".to_owned()),
            response = timeout(Duration::from_secs(60), reply) => response.ok().and_then(std::result::Result::ok)
                .ok_or_else(|| "The Dirlume window did not respond in time.".to_owned()),
        }
    }

    async fn approve(&self, action: &str, targets: Vec<String>) -> Result<()> {
        let (accept, reply) = oneshot::channel();
        let _request = self.show_request(
            Pending::Approval(accept),
            "mcp-approval",
            json!({ "action": action, "targets": targets }),
        )?;
        if !self.await_reply(reply).await? || self.stopped.is_cancelled() {
            return Err("The request was declined.".to_owned());
        }
        Ok(())
    }

    async fn call(&self, name: &str, arguments: Map<String, Value>) -> Result<Value> {
        let _permit = self
            .calls
            .try_acquire()
            .map_err(|_| "Another MCP request is pending in Dirlume.")?;
        let args = Value::Object(arguments);
        match name {
            "delete_items" => {
                let mode = if args["permanent"] == true {
                    "permanent"
                } else {
                    "trash"
                };
                let plans = blocking(move || delete_targets(&args["paths"])).await?;
                let targets = plans
                    .iter()
                    .map(|target| local::display_path(&target.path).map_err(message))
                    .collect::<Result<Vec<_>>>()?;
                self.approve(mode, targets).await?;
                blocking(move || {
                    for target in &plans {
                        target.verify()?;
                    }
                    for target in &plans {
                        target.verify()?;
                        if mode == "permanent" {
                            local::permanently_delete(&target.path).map_err(message)?;
                        } else {
                            trash::delete(&target.path).map_err(message)?;
                        }
                    }
                    Ok(json!({ "deleted": plans.len() }))
                })
                .await
            }
            "terminate_processes" => {
                let pids = args["pids"].as_array().ok_or("Choose process IDs.")?;
                if pids.is_empty() {
                    return Err("Choose process IDs.".to_owned());
                }
                let mut running = processes::list_processes(self.app.clone()).await?;
                let mut ids = Vec::new();
                let mut targets = Vec::new();
                for pid in pids {
                    let pid = pid.as_u64().ok_or("Invalid PID.")?;
                    let index = running
                        .iter()
                        .position(|process| {
                            u64::from(process.id.pid) == pid && process.can_terminate
                        })
                        .ok_or("The process cannot be terminated.")?;
                    let process = running.swap_remove(index);
                    targets.push(format!("{} (PID {})", process.name, process.id.pid));
                    ids.push(process.id);
                }
                self.approve("terminate", targets).await?;
                let errors = processes::terminate_processes(ids).await?;
                if errors.is_empty() {
                    Ok(json!({ "ended": pids.len() }))
                } else {
                    Err(errors.join("\n"))
                }
            }
            _ => {
                let (complete, reply) = oneshot::channel();
                let _request = self.show_request(
                    Pending::Action(complete),
                    "mcp-action",
                    json!({ "tool": name, "arguments": args }),
                )?;
                let output = self.await_reply(reply).await?;
                match output.error {
                    Some(problem) => Err(problem),
                    None => Ok(output.result.unwrap_or(Value::Null)),
                }
            }
        }
    }
}

struct DeleteTarget {
    path: PathBuf,
    identity: same_file::Handle,
    directory: bool,
    modified: SystemTime,
    size: u64,
}

impl DeleteTarget {
    fn capture(path: PathBuf) -> Result<Self> {
        let meta = fs::symlink_metadata(&path).map_err(message)?;
        if local::is_link(&meta) || !(meta.is_file() || meta.is_dir()) {
            return Err("MCP deletion requires a regular file or folder.".to_owned());
        }
        Ok(Self {
            identity: same_file::Handle::from_path(&path).map_err(message)?,
            path,
            directory: meta.is_dir(),
            modified: meta.modified().map_err(message)?,
            size: meta.len(),
        })
    }

    fn verify(&self) -> Result<()> {
        let current = Self::capture(self.path.clone())?;
        if current.identity != self.identity
            || current.directory != self.directory
            || current.modified != self.modified
            || current.size != self.size
        {
            return Err("A deletion target changed. Submit a new request in Dirlume.".to_owned());
        }
        Ok(())
    }
}

fn delete_targets(paths: &Value) -> Result<Vec<DeleteTarget>> {
    let paths = paths.as_array().ok_or("Choose file or folder paths.")?;
    if paths.is_empty() {
        return Err("Choose file or folder paths.".to_owned());
    }
    let mut targets: Vec<DeleteTarget> = Vec::new();
    for path in paths {
        let input =
            local::absolute(path.as_str().ok_or("Choose an absolute path.")?).map_err(message)?;
        let parent = input
            .parent()
            .ok_or("A filesystem root cannot be deleted.")?
            .canonicalize()
            .map_err(message)?;
        let target = parent.join(
            input
                .file_name()
                .ok_or("A filesystem root cannot be deleted.")?,
        );
        if targets
            .iter()
            .any(|earlier| earlier.path.starts_with(&target) || target.starts_with(&earlier.path))
        {
            return Err("Choose distinct deletion targets without overlap.".to_owned());
        }
        targets.push(DeleteTarget::capture(target)?);
    }
    Ok(targets)
}
