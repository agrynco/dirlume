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
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

use crate::{message, Result};

const SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const API: &str = "https://www.googleapis.com/drive/v3";
const SIGN_IN: &str = "Sign in to this Google Drive account again.";
const OFFLINE: &str = "Could not reach Google Drive. Check your internet connection.";
const ACCESS_DENIED: &str = "Google Drive denied access to this item.";
const DOWNLOAD_DENIED: &str = "Google Drive does not allow downloading this file.";
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
    let file = std::env::var_os("DIRLUME_GOOGLE_OAUTH_CLIENT")
        .map(PathBuf::from)
        .unwrap_or(config_dir(app)?.join("google-drive-oauth.json"));
    let bytes = fs::read(file)
        .map_err(|_| "Configure the Dirlume Google Drive OAuth desktop client first.")?;
    let config: ClientFile = serde_json::from_slice(&bytes)
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
        ("scope", SCOPE),
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
        if !tokens
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
        Ok::<_, String>((about.user, tokens.refresh_token))
    };
    let (user, refresh) = tokio::select! {
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
        profile.email = user.email_address;
        profile.id
    } else {
        let id = Uuid::new_v4();
        profiles.push(Profile {
            id,
            account: user.permission_id,
            label: user.email_address.clone(),
            email: user.email_address,
            sign_in_needed: false,
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
    let state = app.state::<DriveState>();
    let entry = credential(id)?;
    let refresh = {
        let _guard = state.profiles.lock().map_err(message)?;
        if !profiles(app)?.iter().any(|profile| profile.id == id) {
            return Err("The Google Drive connection no longer exists.".into());
        }
        read_credential(&entry)?.ok_or(SIGN_IN)?
    };
    let config = client_config(app)?;
    match tokens(
        client,
        &config,
        &[("grant_type", "refresh_token"), ("refresh_token", &refresh)],
    )
    .await
    {
        Ok(tokens) => Ok(tokens.access_token),
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
    id: String,
    name: String,
    directory: bool,
    size: Option<u64>,
    modified: Option<i64>,
    web_view_link: Option<String>,
    download: bool,
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
    let query = format!("'{folder}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.shortcut'");
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
            .get(format!("{API}/files"))
            .bearer_auth(&access)
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

pub(crate) async fn download(
    app: &AppHandle,
    profile: Uuid,
    item: &str,
    target: &Path,
    mut progress: impl FnMut(u64, Option<u64>) -> io::Result<()>,
) -> Result<Option<i64>> {
    valid_id(item)?;
    let client = http()?;
    let access = access(app, &client, profile).await?;
    let url = format!("{API}/files/{item}");
    let meta: DriveFile = json(
        client
            .get(&url)
            .bearer_auth(&access)
            .query(&[("fields", FILE_FIELDS)]),
    )
    .await?;
    if !meta.downloadable() {
        return Err(DOWNLOAD_DENIED.into());
    }
    let mut response = checked(
        client
            .get(&url)
            .bearer_auth(&access)
            .query(&[("alt", "media")]),
        true,
    )
    .await?;
    let total = response.content_length().or_else(|| meta.size());
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
    file.sync_all().map_err(message)?;
    Ok(meta.modified())
}

#[cfg(test)]
mod tests {
    use super::*;

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
