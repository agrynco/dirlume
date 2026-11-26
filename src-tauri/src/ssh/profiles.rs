use std::{
    collections::HashSet,
    fs, io,
    net::IpAddr,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    desktop::{blocking, message, Result},
    netbox_connection::ConnectionPreferences,
    netbox_directories::DirectoryPreferences,
    netbox_environment::EnvironmentPreferences,
    netbox_proxy as proxy,
};

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Authentication {
    Password,
    PrivateKey { path: PathBuf },
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub(super) struct ConnectionSettings {
    #[serde(flatten)]
    pub endpoint: Endpoint,
    pub username: String,
    pub auth: Authentication,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub(super) struct SavedHost {
    #[serde(flatten)]
    pub settings: ConnectionSettings,
    credential: Option<Uuid>,
}

impl SavedHost {
    pub fn secret(&self) -> Result<Option<Zeroizing<String>>> {
        read_secret(self.credential)
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
struct SavedJumpHost {
    id: Uuid,
    #[serde(flatten)]
    host: SavedHost,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SavedProfile {
    id: Uuid,
    pub label: String,
    #[serde(flatten)]
    pub destination: SavedHost,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    jump_hosts: Vec<SavedJumpHost>,
    #[serde(default, skip_serializing_if = "DirectoryPreferences::is_default")]
    pub(super) directories: DirectoryPreferences,
    #[serde(default, skip_serializing_if = "EnvironmentPreferences::is_default")]
    pub(super) environment: EnvironmentPreferences,
    #[serde(default, skip_serializing_if = "ConnectionPreferences::is_default")]
    pub(super) connection_options: ConnectionPreferences,
    #[serde(default, skip_serializing_if = "proxy::Stored::is_default")]
    pub(super) proxy: proxy::Stored,
}

impl SavedProfile {
    pub(super) fn proxy_route(&self) -> Result<Option<proxy::Route>> {
        let first = self
            .jump_hosts
            .first()
            .map_or(&self.destination, |jump| &jump.host);
        self.proxy.route(&first.settings.endpoint.host)
    }

    pub fn route(&self) -> impl Iterator<Item = &SavedHost> {
        let destination = std::slice::from_ref(&self.destination);
        self.jump_hosts
            .iter()
            .map(|jump| &jump.host)
            .chain(destination)
    }

    fn credentials(&self) -> impl Iterator<Item = Uuid> + '_ {
        self.route().filter_map(|host| host.credential)
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    #[serde(flatten)]
    pub(super) endpoint: Endpoint,
    pub(super) fingerprint: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Config {
    profiles: Vec<SavedProfile>,
    trusted_hosts: Vec<HostKey>,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        match fs::File::open(path) {
            Ok(file) => serde_json::from_reader(file).map_err(message),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(message(error)),
        }
    }

    pub fn profile(&self, id: Uuid) -> Result<&SavedProfile> {
        self.profiles
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(|| "This SSH profile was removed.".to_owned())
    }

    pub fn fingerprint(&self, endpoint: &Endpoint) -> Option<&str> {
        self.trusted_hosts
            .iter()
            .find(|item| &item.endpoint == endpoint)
            .map(|item| item.fingerprint.as_str())
    }

    pub fn trust(&mut self, path: &Path, keys: Vec<HostKey>) -> Result<()> {
        let before = self.trusted_hosts.len();
        for key in keys {
            match self.fingerprint(&key.endpoint) {
                Some(pin) if pin == key.fingerprint => {}
                Some(_) => {
                    return Err(format!(
                        "The trusted SSH host key for {}:{} changed. Try the connection again.",
                        key.endpoint.host, key.endpoint.port
                    ))
                }
                None => self.trusted_hosts.push(key),
            }
        }
        if self.trusted_hosts.len() != before {
            self.persist(path)?;
        }
        Ok(())
    }

    fn persist(&self, path: &Path) -> Result<()> {
        let parent = path
            .parent()
            .ok_or("The SSH profile folder is unavailable.")?;
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(message)?;
        serde_json::to_writer_pretty(staged.as_file_mut(), self).map_err(message)?;
        staged.as_file().sync_all().map_err(message)?;
        staged.persist(path).map_err(message)?;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSummary {
    #[serde(flatten)]
    settings: ConnectionSettings,
    has_secret: bool,
}

impl From<SavedHost> for HostSummary {
    fn from(host: SavedHost) -> Self {
        Self {
            settings: host.settings,
            has_secret: host.credential.is_some(),
        }
    }
}

#[derive(Serialize)]
struct JumpHostSummary {
    id: Uuid,
    #[serde(flatten)]
    host: HostSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    id: Uuid,
    label: String,
    #[serde(flatten)]
    destination: HostSummary,
    jump_hosts: Vec<JumpHostSummary>,
    directories: DirectoryPreferences,
    environment: EnvironmentPreferences,
    connection_options: ConnectionPreferences,
    proxy: proxy::Summary,
}

impl From<SavedProfile> for ProfileSummary {
    fn from(item: SavedProfile) -> Self {
        Self {
            id: item.id,
            label: item.label,
            directories: item.directories,
            environment: item.environment,
            connection_options: item.connection_options,
            proxy: item.proxy.summary(),
            destination: item.destination.into(),
            jump_hosts: item
                .jump_hosts
                .into_iter()
                .map(|jump| JumpHostSummary {
                    id: jump.id,
                    host: jump.host.into(),
                })
                .collect(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    id: Option<Uuid>,
    label: String,
    #[serde(flatten)]
    destination: HostInput,
    #[serde(default)]
    jump_hosts: Vec<JumpHostInput>,
    directories: Option<DirectoryPreferences>,
    environment: Option<EnvironmentPreferences>,
    connection_options: Option<ConnectionPreferences>,
    proxy: Option<proxy::Input>,
}

#[derive(Deserialize)]
struct JumpHostInput {
    id: Option<Uuid>,
    #[serde(flatten)]
    host: HostInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostInput {
    host: String,
    port: u16,
    username: String,
    auth: Authentication,
    secret: Option<String>,
    #[serde(default)]
    clear_secret: bool,
}

impl HostInput {
    fn settings(&self) -> Result<ConnectionSettings> {
        let username = self.username.trim();
        let host = self.host.trim();
        let host = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host);
        if username.is_empty()
            || host.is_empty()
            || self.port == 0
            || host.contains(['/', '\\', '@', '?', '#', '[', ']'])
            || host
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
            || username.chars().any(char::is_control)
        {
            return Err("Enter a server host, port, and username.".to_owned());
        }
        let host = host
            .parse::<IpAddr>()
            .map_or_else(|_| host.to_ascii_lowercase(), |ip| ip.to_string());
        let auth = match &self.auth {
            Authentication::Password => Authentication::Password,
            Authentication::PrivateKey { path } => {
                let path = PathBuf::from(path.to_string_lossy().trim());
                if !path.is_absolute() {
                    return Err("Choose an absolute path to the SSH private key file.".to_owned());
                }
                Authentication::PrivateKey { path }
            }
        };
        Ok(ConnectionSettings {
            endpoint: Endpoint {
                host,
                port: self.port,
            },
            username: username.to_owned(),
            auth,
        })
    }

    fn prepare(mut self, previous: Option<&SavedHost>) -> Result<DraftHost> {
        let secret = self
            .secret
            .take()
            .map(Zeroizing::new)
            .filter(|secret| !self.clear_secret && !secret.is_empty());
        let settings = self.settings()?;
        let credential = previous
            .filter(|old| !self.clear_secret && old.settings == settings)
            .and_then(|old| old.credential);
        if matches!(settings.auth, Authentication::Password)
            && secret.is_none()
            && credential.is_none()
        {
            return Err("Enter the SSH password.".to_owned());
        }
        Ok(DraftHost {
            settings,
            secret,
            credential,
        })
    }
}

pub(super) struct DraftHost {
    pub settings: ConnectionSettings,
    secret: Option<Zeroizing<String>>,
    credential: Option<Uuid>,
}

impl DraftHost {
    pub fn take_secret(&mut self) -> Result<Option<Zeroizing<String>>> {
        match self.secret.take() {
            Some(secret) => Ok(Some(secret)),
            None => read_secret(self.credential),
        }
    }
}

struct DraftProfile {
    destination: DraftHost,
    jump_hosts: Vec<(Uuid, DraftHost)>,
}

impl ProfileInput {
    pub(super) fn proxy_route(&self, config: &Config) -> Result<Option<proxy::Route>> {
        let empty = proxy::Stored::default();
        let previous = self
            .id
            .map(|id| config.profile(id))
            .transpose()?
            .map_or(&empty, |item| &item.proxy);
        let first = self
            .jump_hosts
            .first()
            .map_or(&self.destination, |jump| &jump.host);
        match &self.proxy {
            Some(input) => input.test_route(previous, first.host.trim()),
            None => previous.route(first.host.trim()),
        }
    }
    pub(super) fn connection_preferences(&self, config: &Config) -> Result<ConnectionPreferences> {
        let previous = self.id.map(|id| config.profile(id)).transpose()?;
        self.connection_options
            .or_else(|| previous.map(|profile| profile.connection_options))
            .unwrap_or_default()
            .validated()
    }

    fn prepare(self, previous: Option<&SavedProfile>) -> Result<DraftProfile> {
        let destination = self
            .destination
            .prepare(previous.map(|profile| &profile.destination))?;
        let mut seen = HashSet::new();
        let jump_hosts = self
            .jump_hosts
            .into_iter()
            .enumerate()
            .map(|(index, jump)| {
                let id = jump.id.unwrap_or_else(Uuid::new_v4);
                if !seen.insert(id) {
                    return Err("Every SSH jump host must have a distinct entry.".to_owned());
                }
                let old = previous
                    .and_then(|profile| profile.jump_hosts.iter().find(|host| host.id == id));
                let host = jump
                    .host
                    .prepare(old.map(|old| &old.host))
                    .map_err(|error| format!("Jump host {}. {error}", index + 1))?;
                Ok((id, host))
            })
            .collect::<Result<_>>()?;
        Ok(DraftProfile {
            destination,
            jump_hosts,
        })
    }

    pub(super) fn test_route(self, config: &Config) -> Result<Vec<DraftHost>> {
        let previous = self.id.map(|id| config.profile(id)).transpose()?;
        let route = self.prepare(previous)?;
        let mut hosts = route
            .jump_hosts
            .into_iter()
            .map(|(_, host)| host)
            .collect::<Vec<_>>();
        hosts.push(route.destination);
        Ok(hosts)
    }
}

pub(super) fn config_path(app: &AppHandle) -> Result<PathBuf> {
    #[cfg(feature = "ui-automation")]
    if let Some(path) = std::env::var_os("DIRLUME_SSH_TEST_CONFIG")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        return Ok(path.join("ssh-profiles.json"));
    }
    Ok(app
        .path()
        .app_config_dir()
        .map_err(message)?
        .join("ssh-profiles.json"))
}

pub(super) fn lock(path: &Path) -> Result<fs::File> {
    let parent = path
        .parent()
        .ok_or("The SSH profile folder is unavailable.")?;
    fs::create_dir_all(parent).map_err(message)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(message)?;
    lock.lock().map_err(message)?;
    Ok(lock)
}

fn credential(key: Uuid) -> Result<keyring::Entry> {
    keyring::Entry::new("Dirlume SSH", &key.to_string()).map_err(message)
}

fn read_secret(key: Option<Uuid>) -> Result<Option<Zeroizing<String>>> {
    key.map(|key| {
        credential(key)?
            .get_password()
            .map(Zeroizing::new)
            .map_err(|error| {
                format!("Could not read the SSH secret from the system credential store. {error}")
            })
    })
    .transpose()
}

fn delete_credential(key: Uuid) {
    let _ = credential(key).and_then(|entry| entry.delete_credential().map_err(message));
}

#[derive(Default)]
struct NewCredentials(Vec<Uuid>);

impl NewCredentials {
    fn save(&mut self, host: DraftHost) -> Result<SavedHost> {
        let mut key = host.credential;
        if let Some(secret) = host.secret {
            let id = Uuid::new_v4();
            self.0.push(id);
            credential(id)?.set_password(&secret).map_err(|error| {
                format!("Could not save the SSH secret in the system credential store. {error}")
            })?;
            key = Some(id);
        }
        Ok(SavedHost {
            settings: host.settings,
            credential: key,
        })
    }
}

impl Drop for NewCredentials {
    fn drop(&mut self) {
        for key in self.0.drain(..) {
            delete_credential(key);
        }
    }
}

#[tauri::command]
pub async fn ssh_profiles(app: AppHandle) -> Result<Vec<ProfileSummary>> {
    let path = config_path(&app)?;
    blocking(move || {
        let _lock = lock(&path)?;
        Ok(Config::load(&path)?
            .profiles
            .into_iter()
            .map(ProfileSummary::from)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn save_ssh_profile(mut input: ProfileInput, app: AppHandle) -> Result<ProfileSummary> {
    let path = config_path(&app)?;
    blocking(move || {
        let label = input.label.trim().to_owned();
        if label.is_empty() {
            return Err("Enter a connection name.".to_owned());
        }
        let _lock = lock(&path)?;
        let mut config = Config::load(&path)?;
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        let previous = input.id.map(|id| config.profile(id)).transpose()?;
        let old_keys = previous
            .into_iter()
            .flat_map(SavedProfile::credentials)
            .collect::<Vec<_>>();
        let directories = input
            .directories
            .clone()
            .or_else(|| previous.map(|profile| profile.directories.clone()))
            .unwrap_or_default()
            .normalized()?;
        let environment = input
            .environment
            .clone()
            .or_else(|| previous.map(|profile| profile.environment.clone()))
            .unwrap_or_default()
            .validated()?;
        let connection_options = input
            .connection_options
            .or_else(|| previous.map(|profile| profile.connection_options))
            .unwrap_or_default()
            .validated()?;
        let previous_proxy = previous.map(|old| old.proxy.clone()).unwrap_or_default();
        let proxy_save = input
            .proxy
            .take()
            .map(|proxy| proxy.save(&previous_proxy))
            .transpose()?;
        let proxy = proxy_save
            .as_ref()
            .map(|save| save.stored.clone())
            .unwrap_or(previous_proxy);
        let draft = input.prepare(previous)?;
        let mut new_credentials = NewCredentials::default();
        let item = SavedProfile {
            id,
            label,
            directories,
            environment,
            connection_options,
            proxy,
            destination: new_credentials.save(draft.destination)?,
            jump_hosts: draft
                .jump_hosts
                .into_iter()
                .enumerate()
                .map(|(index, (id, host))| {
                    let host = new_credentials
                        .save(host)
                        .map_err(|error| format!("Jump host {}. {error}", index + 1))?;
                    Ok(SavedJumpHost { id, host })
                })
                .collect::<Result<_>>()?,
        };
        if let Some(existing) = config.profiles.iter_mut().find(|old| old.id == id) {
            *existing = item.clone();
        } else {
            config.profiles.push(item.clone());
        }
        config.persist(&path)?;
        if let Some(save) = proxy_save {
            save.finish();
        }
        new_credentials.0.clear();
        let retained = item.credentials().collect::<HashSet<_>>();
        for key in old_keys {
            if !retained.contains(&key) {
                delete_credential(key);
            }
        }
        Ok(item.into())
    })
    .await
}

#[tauri::command]
pub async fn remove_ssh_profile(id: Uuid, app: AppHandle) -> Result<()> {
    let path = config_path(&app)?;
    blocking(move || {
        let _lock = lock(&path)?;
        let mut config = Config::load(&path)?;
        let profile = config.profile(id)?;
        let keys = profile.credentials().collect::<Vec<_>>();
        let proxy = profile.proxy.clone();
        config.profiles.retain(|item| item.id != id);
        config.persist(&path)?;
        proxy.clear();
        for key in keys {
            delete_credential(key);
        }
        Ok(())
    })
    .await
}
