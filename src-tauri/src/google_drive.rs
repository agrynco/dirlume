use std::{
    collections::HashMap,
    fs,
    future::IntoFuture,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{extract::Query, http::StatusCode, routing::get, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Client, Response};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

use crate::desktop::TextDocument;
use crate::text_format::{self, DecodeError, Encoding, TEXT_LIMIT};
use crate::{message, Result};

const SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly";
const WRITE_SCOPE: &str = "https://www.googleapis.com/auth/drive";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3";
const PREVIEW_IMAGE_LIMIT: u64 = 16 * 1024 * 1024;
const SIGN_IN: &str = "Sign in to this Google Drive account again.";
const OFFLINE: &str = "Could not reach Google Drive. Check your internet connection.";
const ACCESS_DENIED: &str = "Google Drive denied access to this item.";
const DOWNLOAD_DENIED: &str = "Google Drive does not allow downloading this file.";
const WRITE_SIGN_IN: &str = "Reconnect Google Drive and allow changes to files and folders.";
const TEXT_CHANGED: &str = "The file changed since it was opened.";
const FOLDER: &str = "application/vnd.google-apps.folder";

#[derive(Default)]
pub(crate) struct DriveState {
    profiles: Mutex<()>,
    sign_ins: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    id: Uuid,
    account: String,
    label: String,
    email: String,
    #[serde(default)]
    sign_in_needed: bool,
    #[serde(default)]
    can_write: bool,
}

#[derive(Deserialize)]
struct InstalledClient {
    client_id: String,
    client_secret: String,
}

#[derive(Deserialize)]
struct ClientFile {
    installed: InstalledClient,
}

fn client_config(app: &AppHandle) -> Result<InstalledClient> {
    if let Some(file) = std::env::var_os("DIRLUME_GOOGLE_OAUTH_CLIENT") {
        let bytes = fs::read(file)
            .map_err(|_| "Configure the Dirlume Google Drive OAuth desktop client first.")?;
        return parse_client_config(&bytes);
    }
    match fs::read(config_dir(app)?.join("google-drive-oauth.json")) {
        Ok(bytes) => parse_client_config(&bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let bundled = include_bytes!(concat!(env!("OUT_DIR"), "/google-drive-oauth.json"));
            if bundled.is_empty() {
                return Err(
                    "Configure the Dirlume Google Drive OAuth desktop client first.".into(),
                );
            }
            parse_client_config(bundled)
        }
        Err(_) => Err("Configure the Dirlume Google Drive OAuth desktop client first.".into()),
    }
}

fn parse_client_config(bytes: &[u8]) -> Result<InstalledClient> {
    let config: ClientFile = serde_json::from_slice(bytes)
        .map_err(|_| "Choose a Google OAuth Desktop app client configuration.")?;
    Ok(config.installed)
}

fn config_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path().app_config_dir().map_err(message)
}

fn profile_file(app: &AppHandle) -> Result<PathBuf> {
    Ok(config_dir(app)?.join("google-drive-profiles.json"))
}

fn profiles(app: &AppHandle) -> Result<Vec<Profile>> {
    match fs::read(profile_file(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(message),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(message(error)),
    }
}

fn save_profiles(app: &AppHandle, profiles: &[Profile]) -> Result<()> {
    let path = profile_file(app)?;
    let directory = config_dir(app)?;
    fs::create_dir_all(&directory).map_err(message)?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(message)?;
    serde_json::to_writer(&mut file, profiles).map_err(message)?;
    file.as_file().sync_all().map_err(message)?;
    file.persist(path).map_err(message)?;
    Ok(())
}

fn credential(id: Uuid) -> Result<keyring::Entry> {
    keyring::Entry::new("Dirlume Google Drive", &id.to_string()).map_err(message)
}

fn read_credential(entry: &keyring::Entry) -> Result<Option<String>> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(message(error)),
    }
}

#[tauri::command]
pub(crate) fn google_drive_profiles(
    app: AppHandle,
    state: State<'_, DriveState>,
) -> Result<Vec<Profile>> {
    let _guard = state.profiles.lock().map_err(message)?;
    let mut profiles = profiles(&app)?;
    for profile in &mut profiles {
        profile.sign_in_needed = read_credential(&credential(profile.id)?)?.is_none();
    }
    Ok(profiles)
}

#[tauri::command]
pub(crate) fn rename_google_drive(
    app: AppHandle,
    state: State<'_, DriveState>,
    id: Uuid,
    label: String,
) -> Result<()> {
    let label = label.trim();
    if label.is_empty() {
        return Err("Enter a connection name.".into());
    }
    let _guard = state.profiles.lock().map_err(message)?;
    let mut profiles = profiles(&app)?;
    let profile = profiles
        .iter_mut()
        .find(|profile| profile.id == id)
        .ok_or("The Google Drive connection no longer exists.")?;
    profile.label = label.to_owned();
    save_profiles(&app, &profiles)
}

#[tauri::command]
pub(crate) fn remove_google_drive(
    app: AppHandle,
    state: State<'_, DriveState>,
    id: Uuid,
) -> Result<()> {
    let _guard = state.profiles.lock().map_err(message)?;
    let profiles = profiles(&app)?;
    let remaining = profiles
        .iter()
        .filter(|profile| profile.id != id)
        .cloned()
        .collect::<Vec<_>>();
    let entry = credential(id)?;
    save_profiles(&app, &remaining)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => {
            save_profiles(&app, &profiles)?;
            Err(message(error))
        }
    }
}

struct SignIn {
    id: Uuid,
    jobs: Arc<Mutex<HashMap<Uuid, CancellationToken>>>,
    stop: CancellationToken,
}

impl SignIn {
    fn start(state: &DriveState, id: Uuid) -> Result<Self> {
        let mut jobs = state.sign_ins.lock().map_err(message)?;
        if jobs.contains_key(&id) {
            return Err("Google sign-in is already in progress.".into());
        }
        let stop = CancellationToken::new();
        jobs.insert(id, stop.clone());
        Ok(Self {
            id,
            jobs: state.sign_ins.clone(),
            stop,
        })
    }
}

impl Drop for SignIn {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(&self.id);
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_google_drive_sign_in(state: State<'_, DriveState>, id: Uuid) -> Result<()> {
    if let Some(stop) = state.sign_ins.lock().map_err(message)?.get(&id) {
        stop.cancel();
    }
    Ok(())
}

#[derive(Deserialize)]
struct Callback {
    state: Option<String>,
    code: Option<String>,
}

fn random_value() -> Result<String> {
    let mut bytes = [0; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Could not start Google sign-in.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

async fn authorization_code(config: &InstalledClient) -> Result<(String, String, String)> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(message)?;
    let redirect = format!("http://{}/", listener.local_addr().map_err(message)?);
    let state = random_value()?;
    let verifier = random_value()?;
    let challenge = URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()));
    let mut auth = Url::parse("https://accounts.google.com/o/oauth2/v2/auth").map_err(message)?;
    auth.query_pairs_mut().extend_pairs([
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", &redirect),
        ("response_type", "code"),
        ("scope", WRITE_SCOPE),
        ("state", &state),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]);

    open::that_detached(auth.as_str()).map_err(message)?;
    let code = receive_callback(listener, state).await?;
    Ok((code, verifier, redirect))
}

async fn receive_callback(listener: tokio::net::TcpListener, state: String) -> Result<String> {
    let (send, receive) = oneshot::channel();
    let send = Arc::new(Mutex::new(Some(send)));
    let router = Router::new().route(
        "/",
        get(move |Query(callback): Query<Callback>| async move {
            if callback.state.as_ref() != Some(&state) {
                return (
                    StatusCode::BAD_REQUEST,
                    "This Google sign-in request has expired.",
                );
            }
            if let Ok(mut send) = send.lock() {
                if let Some(send) = send.take() {
                    let _ = send.send(callback.code);
                }
            }
            (StatusCode::OK, "Return to Dirlume to continue.")
        }),
    );
    let server = axum::serve(listener, router).into_future();
    tokio::select! {
        result = receive => result.map_err(message)?.ok_or_else(|| "Google sign-in was canceled or denied.".into()),
        result = server => Err(result.err().map_or_else(|| "Google sign-in ended.".into(), message)),
    }
}

fn http() -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .read_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(message)
}

fn network(error: reqwest::Error) -> String {
    if error.is_connect() || error.is_timeout() {
        OFFLINE.into()
    } else {
        "Google Drive could not complete the request.".into()
    }
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    scope: Option<String>,
}

async fn tokens(
    client: &Client,
    config: &InstalledClient,
    grant: &[(&str, &str)],
) -> Result<Tokens> {
    let mut fields = vec![
        ("client_id", config.client_id.as_str()),
        ("client_secret", config.client_secret.as_str()),
    ];
    fields.extend_from_slice(grant);
    let response = client
        .post(TOKEN_URL)
        .form(&fields)
        .send()
        .await
        .map_err(network)?;
    if response.status().is_success() {
        return response.json().await.map_err(network);
    }
    #[derive(Deserialize)]
    struct OAuthError {
        error: String,
    }
    if response
        .json::<OAuthError>()
        .await
        .is_ok_and(|body| body.error == "invalid_grant")
    {
        return Err(SIGN_IN.into());
    }
    Err("Google could not authorize Dirlume. Check the OAuth desktop client configuration.".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveUser {
    permission_id: String,
    email_address: String,
}

#[tauri::command]
pub(crate) async fn sign_in_google_drive(
    app: AppHandle,
    state: State<'_, DriveState>,
    id: Uuid,
    profile_id: Option<Uuid>,
) -> Result<Uuid> {
    let job = SignIn::start(&state, id)?;
    let config = client_config(&app)?;
    let client = http()?;
    let process = async {
        let (code, verifier, redirect) = authorization_code(&config).await?;
        let tokens = tokens(
            &client,
            &config,
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect),
            ],
        )
        .await?;
        let can_write = tokens
            .scope
            .as_deref()
            .is_some_and(|scope| scope.split_whitespace().any(|item| item == WRITE_SCOPE));
        if !can_write
            && !tokens
                .scope
                .as_deref()
                .is_some_and(|scope| scope.split_whitespace().any(|item| item == SCOPE))
        {
            return Err("Grant Dirlume permission to read Google Drive files.".into());
        }
        #[derive(Deserialize)]
        struct About {
            user: DriveUser,
        }
        let about: About = json(
            client
                .get(format!("{API}/about"))
                .bearer_auth(&tokens.access_token)
                .query(&[("fields", "user(permissionId,emailAddress)")]),
        )
        .await?;
        Ok::<_, String>((about.user, tokens.refresh_token, can_write))
    };
    let (user, refresh, can_write) = tokio::select! {
        biased;
        _ = job.stop.cancelled() => return Err("Google sign-in was canceled.".into()),
        result = tokio::time::timeout(Duration::from_secs(240), process) =>
            result.map_err(|_| "Google sign-in timed out.")??,
    };
    let _guard = state.profiles.lock().map_err(message)?;
    if job.stop.is_cancelled() {
        return Err("Google sign-in was canceled.".into());
    }
    let mut profiles = profiles(&app)?;
    let existing = profiles
        .iter_mut()
        .find(|profile| profile.account == user.permission_id);
    if profile_id.is_some() && profile_id != existing.as_ref().map(|profile| profile.id) {
        return Err("Reconnect using the original Google account.".into());
    }
    let profile_id = if let Some(profile) = existing {
        if can_write && !profile.can_write && refresh.is_none() {
            return Err("Google did not provide a saved sign-in. Sign in again.".into());
        }
        profile.email = user.email_address;
        if refresh.is_some() {
            profile.can_write = can_write;
        }
        profile.id
    } else {
        let id = Uuid::new_v4();
        profiles.push(Profile {
            id,
            account: user.permission_id,
            label: user.email_address.clone(),
            email: user.email_address,
            sign_in_needed: false,
            can_write,
        });
        id
    };
    let entry = credential(profile_id)?;
    let previous = read_credential(&entry)?;
    if let Some(refresh) = &refresh {
        entry.set_password(refresh).map_err(message)?;
    } else if previous.is_none() {
        return Err("Google did not provide a saved sign-in. Sign in again.".into());
    }
    if let Err(error) = save_profiles(&app, &profiles) {
        if refresh.is_some() {
            if let Some(previous) = previous {
                let _ = entry.set_password(&previous);
            } else {
                let _ = entry.delete_credential();
            }
        }
        return Err(error);
    }
    Ok(profile_id)
}

async fn access(app: &AppHandle, client: &Client, id: Uuid) -> Result<String> {
    access_with_scope(app, client, id, None).await
}

async fn access_with_scope(
    app: &AppHandle,
    client: &Client,
    id: Uuid,
    required: Option<&str>,
) -> Result<String> {
    let state = app.state::<DriveState>();
    let entry = credential(id)?;
    let (refresh, can_write) = {
        let _guard = state.profiles.lock().map_err(message)?;
        let profile = profiles(app)?
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or("The Google Drive connection no longer exists.")?;
        (read_credential(&entry)?.ok_or(SIGN_IN)?, profile.can_write)
    };
    let config = client_config(app)?;
    match tokens(
        client,
        &config,
        &[("grant_type", "refresh_token"), ("refresh_token", &refresh)],
    )
    .await
    {
        Ok(tokens) => {
            if required.is_some_and(|required| {
                !tokens
                    .scope
                    .as_deref()
                    .map_or(required == WRITE_SCOPE && can_write, |scope| {
                        scope.split_whitespace().any(|granted| granted == required)
                    })
            }) {
                return Err(WRITE_SIGN_IN.into());
            }
            Ok(tokens.access_token)
        }
        Err(error) if error == SIGN_IN => {
            let _guard = state.profiles.lock().map_err(message)?;
            if read_credential(&entry)?.as_deref() == Some(&refresh) {
                let _ = entry.delete_credential();
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

async fn checked(request: reqwest::RequestBuilder, download: bool) -> Result<Response> {
    let response = request.send().await.map_err(network)?;
    match response.status().as_u16() {
        401 => Err(SIGN_IN.into()),
        403 => {
            #[derive(Deserialize)]
            struct ErrorResponse {
                error: ErrorBody,
            }
            #[derive(Deserialize)]
            struct ErrorBody {
                #[serde(default)]
                errors: Vec<Reason>,
            }
            #[derive(Deserialize)]
            struct Reason {
                reason: String,
            }
            let error = response
                .json::<ErrorResponse>()
                .await
                .ok()
                .map(|response| response.error.errors)
                .unwrap_or_default();
            let has = |reason: &str| error.iter().any(|item| item.reason == reason);
            if has("accessNotConfigured") {
                Err(
                    "Enable the Google Drive API in the OAuth client’s Google Cloud project."
                        .into(),
                )
            } else if has("rateLimitExceeded") || has("userRateLimitExceeded") {
                Err("Google Drive temporarily limited requests. Try again shortly.".into())
            } else if download {
                Err(DOWNLOAD_DENIED.into())
            } else {
                Err(ACCESS_DENIED.into())
            }
        }
        404 => Err(ACCESS_DENIED.into()),
        412 => Err(TEXT_CHANGED.into()),
        status if (200..300).contains(&status) => Ok(response),
        _ => Err("Google Drive could not complete the request.".into()),
    }
}

async fn json<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T> {
    checked(request, false).await?.json().await.map_err(network)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFile {
    id: String,
    name: String,
    mime_type: String,
    size: Option<String>,
    modified_time: Option<String>,
    web_view_link: Option<String>,
    capabilities: Option<Capabilities>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    can_download: bool,
}

impl DriveFile {
    fn size(&self) -> Option<u64> {
        self.size.as_deref()?.parse().ok()
    }

    fn modified(&self) -> Option<i64> {
        self.modified_time
            .as_deref()?
            .parse::<jiff::Timestamp>()
            .ok()
            .map(|time| time.as_second())
    }

    fn downloadable(&self) -> bool {
        !self.mime_type.starts_with("application/vnd.google-apps.")
            && self
                .capabilities
                .as_ref()
                .is_some_and(|capabilities| capabilities.can_download)
    }
}

const FILE_FIELDS: &str =
    "id,name,mimeType,size,modifiedTime,webViewLink,capabilities(canDownload)";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriveItem {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) directory: bool,
    pub(crate) size: Option<u64>,
    pub(crate) modified: Option<i64>,
    web_view_link: Option<String>,
    pub(crate) download: bool,
}

fn valid_id(id: &str) -> Result<()> {
    if !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        Ok(())
    } else {
        Err("Choose a valid Google Drive item.".into())
    }
}

#[tauri::command]
pub(crate) async fn list_google_drive(
    app: AppHandle,
    id: Uuid,
    folder: String,
) -> Result<Vec<DriveItem>> {
    valid_id(&folder)?;
    let client = http()?;
    let access = access(&app, &client, id).await?;
    if folder != "root" {
        checked(
            client
                .get(format!("{API}/files/{folder}"))
                .bearer_auth(&access)
                .query(&[("fields", "id")]),
            false,
        )
        .await?;
    }
    list_items(&client, API, &access, &folder, true).await
}

async fn list_items(
    client: &Client,
    api: &str,
    access: &str,
    folder: &str,
    include_shortcuts: bool,
) -> Result<Vec<DriveItem>> {
    valid_id(folder)?;
    let mut query = format!("'{folder}' in parents and trashed = false");
    if !include_shortcuts {
        query.push_str(" and mimeType != 'application/vnd.google-apps.shortcut'");
    }
    let fields = format!("nextPageToken,files({FILE_FIELDS})");
    let mut cursor = None;
    let mut items = Vec::new();
    loop {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Page {
            next_page_token: Option<String>,
            #[serde(default)]
            files: Vec<DriveFile>,
        }
        let mut request = client
            .get(format!("{api}/files"))
            .bearer_auth(access)
            .query(&[
                ("q", query.as_str()),
                ("fields", &fields),
                ("pageSize", "1000"),
            ]);
        if let Some(cursor) = &cursor {
            request = request.query(&[("pageToken", cursor)]);
        }
        let page: Page = json(request).await?;
        items.extend(page.files.into_iter().map(|item| DriveItem {
            directory: item.mime_type == FOLDER,
            size: item.size(),
            modified: item.modified(),
            download: item.downloadable(),
            id: item.id,
            name: item.name,
            web_view_link: item.web_view_link,
        }));
        cursor = page.next_page_token;
        if cursor.is_none() {
            return Ok(items);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
pub(crate) enum DriveChange {
    CreateFolder { parent: String, name: String },
    CreateFile { parent: String, name: String },
    Rename { item: String, name: String },
    Trash { item: String },
    Delete { item: String },
}

fn valid_child_id(id: &str) -> Result<()> {
    valid_id(id)?;
    if id == "root" {
        return Err("Choose a valid Google Drive item.".into());
    }
    Ok(())
}

fn valid_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name == "." || name == ".." || name.contains('\0') {
        return Err("Enter a valid name.".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn change_google_drive(
    app: AppHandle,
    id: Uuid,
    change: DriveChange,
) -> Result<Option<String>> {
    let client = http()?;
    let creates_item = matches!(
        change,
        DriveChange::CreateFolder { .. } | DriveChange::CreateFile { .. }
    );
    let request = match change {
        DriveChange::CreateFolder {
            ref parent,
            ref name,
        }
        | DriveChange::CreateFile {
            ref parent,
            ref name,
        } => {
            valid_id(parent)?;
            valid_name(name)?;
            client.post(format!("{API}/files")).query(&[("fields", "id")]).json(&serde_json::json!({
                "name": name,
                "mimeType": if creates_item && matches!(change, DriveChange::CreateFolder { .. }) { FOLDER } else { "text/plain" },
                "parents": [parent],
            }))
        }
        DriveChange::Rename { item, name } => {
            valid_child_id(&item)?;
            valid_name(&name)?;
            client
                .patch(format!("{API}/files/{item}"))
                .json(&serde_json::json!({ "name": name }))
        }
        DriveChange::Trash { item } => {
            valid_child_id(&item)?;
            client
                .patch(format!("{API}/files/{item}"))
                .json(&serde_json::json!({ "trashed": true }))
        }
        DriveChange::Delete { item } => {
            valid_child_id(&item)?;
            client.delete(format!("{API}/files/{item}"))
        }
    };
    let access = access_with_scope(&app, &client, id, Some(WRITE_SCOPE)).await?;
    let request = request.bearer_auth(access);
    if creates_item {
        #[derive(Deserialize)]
        struct Created {
            id: String,
        }
        return json::<Created>(request).await.map(|file| Some(file.id));
    }
    checked(request, false).await?;
    Ok(None)
}

async fn drive_media(
    client: &Client,
    api: &str,
    token: &str,
    item: &str,
    limit: u64,
) -> Result<(Vec<u8>, Option<String>)> {
    valid_child_id(item)?;
    let mut response = checked(
        client
            .get(format!("{api}/files/{item}"))
            .bearer_auth(token)
            .query(&[("alt", "media")]),
        true,
    )
    .await?;
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("The file is too large to open.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, etag))
}

fn media_revision(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, bytes))
}

#[tauri::command]
pub(crate) async fn read_google_drive_text(
    app: AppHandle,
    id: Uuid,
    item: String,
) -> Result<TextDocument> {
    TransferDrive::readable(&app, id)
        .await?
        .read_text(&item)
        .await
}

#[tauri::command]
pub(crate) async fn read_google_drive_image(
    app: AppHandle,
    id: Uuid,
    item: String,
) -> Result<tauri::ipc::Response> {
    let client = http()?;
    let token = access(&app, &client, id).await?;
    let (bytes, _) = drive_media(&client, API, &token, &item, PREVIEW_IMAGE_LIMIT).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub(crate) async fn read_google_drive_bytes(
    app: AppHandle,
    id: Uuid,
    item: String,
    offset: u64,
) -> Result<crate::protocol::BytePage> {
    use crate::protocol::{BytePage, BYTE_PAGE_SIZE};
    valid_child_id(&item)?;
    let client = http()?;
    let token = access(&app, &client, id).await?;
    let url = format!("{API}/files/{item}");
    let meta: DriveFile = json(
        client
            .get(&url)
            .bearer_auth(&token)
            .query(&[("fields", FILE_FIELDS)]),
    )
    .await?;
    if !meta.downloadable() {
        return Err(DOWNLOAD_DENIED.into());
    }
    let length = meta.size().ok_or(DOWNLOAD_DENIED)?;
    if offset >= length {
        return Ok(BytePage {
            length,
            data: Vec::new(),
        });
    }
    let end = length.min(offset.saturating_add(BYTE_PAGE_SIZE)) - 1;
    let mut response = checked(
        client
            .get(&url)
            .bearer_auth(&token)
            .query(&[("alt", "media")])
            .header(reqwest::header::RANGE, format!("bytes={offset}-{end}")),
        true,
    )
    .await?;
    if offset != 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(DOWNLOAD_DENIED.into());
    }
    let limit = (end - offset + 1) as usize;
    let mut data = Vec::with_capacity(limit);
    while data.len() < limit {
        let Some(chunk) = response.chunk().await.map_err(network)? else {
            break;
        };
        data.extend_from_slice(&chunk[..chunk.len().min(limit - data.len())]);
    }
    Ok(BytePage { length, data })
}

#[tauri::command]
pub(crate) async fn save_google_drive_text(
    app: AppHandle,
    id: Uuid,
    item: String,
    revision: String,
    encoding: Encoding,
    text: String,
) -> Result<TextDocument> {
    TransferDrive::writable(&app, id)
        .await?
        .save_text(&item, &revision, encoding, text)
        .await
}

pub(crate) struct TransferDrive {
    client: Client,
    token: String,
    api: String,
    upload_api: String,
}

pub(crate) struct DriveLocalFile {
    content: DriveLocalContent,
    extension: Option<&'static str>,
    modified: Option<i64>,
}

enum DriveLocalContent {
    Download(Response, Option<u64>),
    Reference(String),
}

impl DriveLocalFile {
    pub(crate) fn local_name(&self, name: &str) -> String {
        if let Some(extension) = self.extension {
            let suffix = format!(".{extension}");
            if !name.to_ascii_lowercase().ends_with(&suffix) {
                return format!("{name}{suffix}");
            }
        }
        name.to_owned()
    }

    pub(crate) fn is_reference(&self) -> bool {
        matches!(self.content, DriveLocalContent::Reference(_))
    }

    pub(crate) async fn write(
        self,
        target: &Path,
        mut progress: impl FnMut(u64, Option<u64>) -> io::Result<()>,
    ) -> Result<Option<i64>> {
        match self.content {
            DriveLocalContent::Download(response, total) => {
                write_drive_download(response, target, total, progress).await?
            }
            DriveLocalContent::Reference(text) => {
                let mut file = fs::File::create_new(target).map_err(message)?;
                file.write_all(text.as_bytes()).map_err(message)?;
                file.sync_all().map_err(message)?;
                progress(text.len() as u64, Some(text.len() as u64)).map_err(message)?;
            }
        }
        Ok(self.modified)
    }
}

fn drive_export_format(mime: &str) -> Option<(&'static str, &'static str)> {
    Some(match mime {
        "application/vnd.google-apps.document" => (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
        ),
        "application/vnd.google-apps.spreadsheet" => (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "xlsx",
        ),
        "application/vnd.google-apps.presentation" => (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "pptx",
        ),
        "application/vnd.google-apps.drawing" => ("application/pdf", "pdf"),
        "application/vnd.google-apps.script" => ("application/vnd.google-apps.script+json", "json"),
        _ => return None,
    })
}

async fn write_drive_download(
    mut response: Response,
    target: &Path,
    total: Option<u64>,
    mut progress: impl FnMut(u64, Option<u64>) -> io::Result<()>,
) -> Result<()> {
    let mut file = fs::File::create_new(target).map_err(message)?;
    let mut written = 0;
    while let Some(bytes) = response.chunk().await.map_err(network)? {
        file.write_all(&bytes).map_err(message)?;
        written += bytes.len() as u64;
        progress(written, total).map_err(message)?;
    }
    if total.is_some_and(|total| total != written) {
        return Err("The Google Drive download was incomplete.".into());
    }
    file.sync_all().map_err(message)
}

impl TransferDrive {
    pub(crate) async fn prepare_local_file(&self, item: &str) -> Result<DriveLocalFile> {
        valid_child_id(item)?;
        let url = format!("{}/files/{item}", self.api);
        let meta: DriveFile = json(
            self.client
                .get(&url)
                .bearer_auth(&self.token)
                .query(&[("fields", FILE_FIELDS)]),
        )
        .await?;
        let modified = meta.modified();
        let reference = || DriveLocalFile {
            content: DriveLocalContent::Reference(format!(
                "[InternetShortcut]\r\nURL=https://drive.google.com/open?id={item}\r\n"
            )),
            extension: Some("url"),
            modified,
        };
        let (request, extension) = if meta.downloadable() {
            (self.client.get(&url).query(&[("alt", "media")]), None)
        } else if let Some((mime, extension)) = drive_export_format(&meta.mime_type).filter(|_| {
            meta.capabilities
                .as_ref()
                .is_some_and(|permissions| permissions.can_download)
        }) {
            (
                self.client
                    .get(format!("{url}/export"))
                    .query(&[("mimeType", mime)]),
                Some(extension),
            )
        } else {
            return Ok(reference());
        };
        let response = match checked(request.bearer_auth(&self.token), true).await {
            Ok(response) => response,
            Err(error) if error == DOWNLOAD_DENIED => return Ok(reference()),
            Err(error) => return Err(error),
        };
        let total = response.content_length().or_else(|| {
            if extension.is_none() {
                meta.size()
            } else {
                None
            }
        });
        Ok(DriveLocalFile {
            content: DriveLocalContent::Download(response, total),
            extension,
            modified,
        })
    }

    async fn read_text(&self, item: &str) -> Result<TextDocument> {
        let (bytes, _) =
            drive_media(&self.client, &self.api, &self.token, item, TEXT_LIMIT).await?;
        let revision = Some(media_revision(&bytes));
        let (text, encoding) = text_format::decode(bytes).map_err(|error| match error {
            DecodeError::Unsupported(message) => message,
            DecodeError::Binary => "The file is not a supported text file.".into(),
        })?;
        Ok(TextDocument {
            text,
            encoding,
            revision,
        })
    }

    async fn save_text(
        &self,
        item: &str,
        revision: &str,
        encoding: Encoding,
        text: String,
    ) -> Result<TextDocument> {
        use std::hash::{DefaultHasher, Hash, Hasher};

        let body = text_format::encode(encoding, &text);
        if body.len() as u64 > TEXT_LIMIT {
            return Err("The file is too large to open.".into());
        }
        static SAVES: [tokio::sync::Mutex<()>; 64] =
            [const { tokio::sync::Mutex::const_new(()) }; 64];
        let mut hash = DefaultHasher::new();
        item.hash(&mut hash);
        let _save = SAVES[(hash.finish() % SAVES.len() as u64) as usize]
            .lock()
            .await;
        let (current, etag) =
            drive_media(&self.client, &self.api, &self.token, item, TEXT_LIMIT).await?;
        if revision != media_revision(&current) && etag.as_deref() != Some(revision) {
            return Err(TEXT_CHANGED.into());
        }
        let revision = Some(media_revision(&body));
        let mut request = self
            .client
            .patch(format!("{}/files/{item}", self.upload_api))
            .bearer_auth(&self.token)
            .query(&[("uploadType", "media")])
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body(body);
        if let Some(etag) = etag.filter(|value| value.starts_with('"')) {
            request = request.header(reqwest::header::IF_MATCH, etag);
        }
        checked(request, false).await?;
        Ok(TextDocument {
            text,
            encoding,
            revision,
        })
    }

    #[cfg(test)]
    pub(crate) fn fixture(origin: &str) -> Self {
        Self {
            client: http().unwrap(),
            token: "fixture-token".into(),
            api: format!("{origin}/drive/v3"),
            upload_api: format!("{origin}/upload/drive/v3"),
        }
    }

    pub(crate) async fn readable(app: &AppHandle, id: Uuid) -> Result<Self> {
        let client = http()?;
        let token = access(app, &client, id).await?;
        Ok(Self {
            client,
            token,
            api: API.into(),
            upload_api: UPLOAD_API.into(),
        })
    }

    pub(crate) async fn list(&self, folder: &str) -> Result<Vec<DriveItem>> {
        list_items(&self.client, &self.api, &self.token, folder, true).await
    }

    pub(crate) async fn folder_size(&self, root: &str) -> Result<(u64, bool)> {
        valid_id(root)?;
        let mut pending = vec![root.to_owned()];
        let mut seen = std::collections::HashSet::from([root.to_owned()]);
        let mut bytes = 0_u64;
        let mut incomplete = false;
        while let Some(folder) = pending.pop() {
            for item in match list_items(&self.client, &self.api, &self.token, &folder, false).await
            {
                Ok(items) => items,
                Err(error) if folder == root || error == SIGN_IN => return Err(error),
                Err(_) => {
                    incomplete = true;
                    continue;
                }
            } {
                if !seen.insert(item.id.clone()) {
                    continue;
                }
                if item.directory {
                    pending.push(item.id);
                } else if let Some(size) = item.size {
                    if let Some(total) = bytes.checked_add(size) {
                        bytes = total;
                    } else {
                        bytes = u64::MAX;
                        incomplete = true;
                    }
                } else {
                    incomplete = true;
                }
            }
        }
        Ok((bytes, incomplete))
    }

    pub(crate) async fn snapshot(&self, id: &str, folder: bool) -> Result<Vec<(String, String)>> {
        valid_child_id(id)?;
        let mut items = vec![(id.to_owned(), folder)];
        let mut revisions = Vec::new();
        while let Some((item, directory)) = items.pop() {
            #[derive(Deserialize)]
            struct Version {
                version: String,
            }
            let version: Version = json(
                self.client
                    .get(format!("{}/files/{item}", self.api))
                    .bearer_auth(&self.token)
                    .query(&[("fields", "version")]),
            )
            .await?;
            if directory {
                items.extend(
                    self.list(&item)
                        .await?
                        .into_iter()
                        .map(|child| (child.id, child.directory)),
                );
            }
            revisions.push((item, version.version));
        }
        revisions.sort_unstable();
        Ok(revisions)
    }

    pub(crate) async fn trash_unchanged(
        &self,
        item: &str,
        folder: bool,
        expected: &[(String, String)],
    ) -> Result<()> {
        if self.snapshot(item, folder).await? != expected {
            return Err("The source changed during the transfer.".into());
        }
        self.trash(item).await
    }
    pub(crate) async fn writable(app: &AppHandle, id: Uuid) -> Result<Self> {
        let client = http()?;
        let token = access_with_scope(app, &client, id, Some(WRITE_SCOPE)).await?;
        Ok(Self {
            client,
            token,
            api: API.into(),
            upload_api: UPLOAD_API.into(),
        })
    }

    pub(crate) async fn upload(
        &self,
        source: &Path,
        parent: &str,
        name: &str,
        mut progress: impl FnMut(u64, u64) -> io::Result<()>,
    ) -> Result<()> {
        valid_id(parent)?;
        valid_name(name)?;
        let mut file = tokio::fs::File::open(source).await.map_err(message)?;
        let total = file.metadata().await.map_err(message)?.len();
        if total == 0 {
            checked(self.client.post(format!("{}/files", self.api))
                .bearer_auth(&self.token)
                .json(&serde_json::json!({ "name": name, "parents": [parent], "mimeType": "application/octet-stream" })),
                false,
            ).await?;
            return Ok(());
        }
        let session = checked(
            self.client
                .post(format!("{}/files", self.upload_api))
                .bearer_auth(&self.token)
                .query(&[("uploadType", "resumable")])
                .header("X-Upload-Content-Type", "application/octet-stream")
                .header("X-Upload-Content-Length", total)
                .json(&serde_json::json!({ "name": name, "parents": [parent] })),
            false,
        )
        .await?;
        let url = session
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|location| location.to_str().ok())
            .and_then(|location| Url::parse(location).ok())
            .filter(|url| {
                Url::parse(&self.upload_api).is_ok_and(|base| {
                    url.origin() == base.origin() && url.path() == format!("{}/files", base.path())
                }) && url.username().is_empty()
                    && url.password().is_none()
            })
            .ok_or("Google Drive did not provide a valid upload session.")?;
        let mut offset = 0;
        while offset < total {
            let size = (total - offset).min(4 * 1024 * 1024);
            let mut body = vec![0; size as usize];
            file.read_exact(&mut body).await.map_err(message)?;
            let last = offset + size - 1;
            progress(offset, total).map_err(message)?;
            let response = self
                .client
                .put(url.clone())
                .bearer_auth(&self.token)
                .header(
                    reqwest::header::CONTENT_RANGE,
                    format!("bytes {offset}-{last}/{total}"),
                )
                .body(body)
                .send()
                .await
                .map_err(network)?;
            offset += size;
            if offset == total && response.status().is_success() {
                progress(offset, total).map_err(message)?;
                return Ok(());
            }
            if response.status().as_u16() != 308
                || response
                    .headers()
                    .get(reqwest::header::RANGE)
                    .and_then(|value| value.to_str().ok())
                    != Some(format!("bytes=0-{last}").as_str())
            {
                return Err("Google Drive could not complete the upload.".into());
            }
        }
        Err("Google Drive could not complete the upload.".into())
    }

    pub(crate) async fn create_folder(&self, parent: &str, name: &str) -> Result<String> {
        valid_id(parent)?;
        valid_name(name)?;
        #[derive(Deserialize)]
        struct CreatedFolder {
            id: String,
        }
        let folder: CreatedFolder = json(
            self.client
                .post(format!("{}/files", self.api))
                .bearer_auth(&self.token)
                .query(&[("fields", "id")])
                .json(
                    &serde_json::json!({ "name": name, "parents": [parent], "mimeType": FOLDER }),
                ),
        )
        .await?;
        Ok(folder.id)
    }

    pub(crate) async fn trash(&self, item: &str) -> Result<()> {
        valid_child_id(item)?;
        checked(
            self.client
                .patch(format!("{}/files/{item}", self.api))
                .bearer_auth(&self.token)
                .json(&serde_json::json!({ "trashed": true })),
            false,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn copy_item(&self, item: &str, parent: &str, name: &str) -> Result<()> {
        valid_child_id(item)?;
        valid_id(parent)?;
        valid_name(name)?;
        checked(
            self.client
                .post(format!("{}/files/{item}/copy", self.api))
                .bearer_auth(&self.token)
                .json(&serde_json::json!({ "name": name, "parents": [parent] })),
            false,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn move_item(
        &self,
        item: &str,
        from: &str,
        to: &str,
        name: &str,
    ) -> Result<()> {
        valid_child_id(item)?;
        valid_id(from)?;
        valid_id(to)?;
        valid_name(name)?;
        if from == to {
            return Ok(());
        }
        let url = format!("{}/files/{item}", self.api);
        #[derive(Deserialize)]
        struct Parents {
            parents: Vec<String>,
        }
        let actual: Parents = json(
            self.client
                .get(&url)
                .bearer_auth(&self.token)
                .query(&[("fields", "parents")]),
        )
        .await?;
        let old = if from == "root" {
            actual
                .parents
                .first()
                .map(String::as_str)
                .ok_or(ACCESS_DENIED)?
        } else {
            from
        };
        if !actual.parents.iter().any(|id| id == old) {
            return Err(TEXT_CHANGED.into());
        }
        checked(
            self.client
                .patch(url)
                .bearer_auth(&self.token)
                .query(&[("removeParents", old), ("addParents", to)])
                .json(&serde_json::json!({ "name": name })),
            false,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn download(
        &self,
        item: &str,
        target: &Path,
        progress: impl FnMut(u64, Option<u64>) -> io::Result<()>,
    ) -> Result<Option<i64>> {
        valid_child_id(item)?;
        let url = format!("{}/files/{item}", self.api);
        let meta: DriveFile = json(
            self.client
                .get(&url)
                .bearer_auth(&self.token)
                .query(&[("fields", FILE_FIELDS)]),
        )
        .await?;
        if !meta.downloadable() {
            return Err(DOWNLOAD_DENIED.into());
        }
        let response = checked(
            self.client
                .get(&url)
                .bearer_auth(&self.token)
                .query(&[("alt", "media")]),
            true,
        )
        .await?;
        let total = response.content_length().or_else(|| meta.size());
        write_drive_download(response, target, total, progress).await?;
        Ok(meta.modified())
    }
}

pub(crate) async fn download(
    app: &AppHandle,
    profile: Uuid,
    item: &str,
    target: &Path,
    progress: impl FnMut(u64, Option<u64>) -> io::Result<()>,
) -> Result<Option<i64>> {
    TransferDrive::readable(app, profile)
        .await?
        .download(item, target, progress)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drive_text_saves_twice_without_etag_and_rejects_external_edits() {
        use axum::{body::Bytes, extract::State, routing::patch};

        let content = Arc::new(Mutex::new(b"before".to_vec()));
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route(
                "/drive/v3/files/demo",
                get(|State(content): State<Arc<Mutex<Vec<u8>>>>| async move {
                    content.lock().unwrap().clone()
                }),
            )
            .route(
                "/upload/drive/v3/files/demo",
                patch(
                    |State(content): State<Arc<Mutex<Vec<u8>>>>, body: Bytes| async move {
                        *content.lock().unwrap() = body.to_vec();
                        StatusCode::OK
                    },
                ),
            )
            .with_state(content.clone());
        let service = tokio::spawn(axum::serve(listener, router).into_future());
        let drive = TransferDrive::fixture(&origin);
        let opened = drive.read_text("demo").await.unwrap();
        assert_eq!(opened.text, "before");
        let first = drive
            .save_text(
                "demo",
                opened.revision.as_deref().unwrap(),
                opened.encoding,
                "first".into(),
            )
            .await
            .unwrap();
        let second = drive
            .save_text(
                "demo",
                first.revision.as_deref().unwrap(),
                first.encoding,
                "second".into(),
            )
            .await
            .unwrap();
        assert_eq!(*content.lock().unwrap(), b"second");

        *content.lock().unwrap() = b"external edit".to_vec();
        let rejected = drive
            .save_text(
                "demo",
                second.revision.as_deref().unwrap(),
                second.encoding,
                "overwrite".into(),
            )
            .await;
        assert_eq!(rejected.err().as_deref(), Some(TEXT_CHANGED));
        assert_eq!(*content.lock().unwrap(), b"external edit");
        service.abort();
    }

    #[tokio::test]
    async fn accepts_only_the_state_of_the_pending_sign_in() {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let callback = tokio::spawn(receive_callback(listener, "matching-state".into()));
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let rejected = client
            .get(&url)
            .query(&[("state", "other-state"), ("code", "discard")])
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert!(!callback.is_finished());
        let accepted = client
            .get(&url)
            .query(&[("state", "matching-state"), ("code", "expected")])
            .send()
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(
            accepted.text().await.unwrap(),
            "Return to Dirlume to continue."
        );
        assert_eq!(callback.await.unwrap().unwrap(), "expected");
    }
}
