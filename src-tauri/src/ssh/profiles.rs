use std::{
    fs, io,
    net::IpAddr,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::desktop::{blocking, message, Result};

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
pub(super) struct Profile {
    id: Uuid,
    pub label: String,
    #[serde(flatten)]
    pub settings: ConnectionSettings,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub(super) struct SavedProfile {
    #[serde(flatten)]
    pub profile: Profile,
    credential: Option<Uuid>,
}

impl SavedProfile {
    pub fn secret(&self) -> Result<Option<Zeroizing<String>>> {
        read_secret(self.credential)
    }
}

#[derive(Deserialize, Serialize)]
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
            .find(|item| item.profile.id == id)
            .ok_or_else(|| "This SSH profile was removed.".to_owned())
    }

    pub fn fingerprint(&self, endpoint: &Endpoint) -> Option<&str> {
        self.trusted_hosts
            .iter()
            .find(|item| &item.endpoint == endpoint)
            .map(|item| item.fingerprint.as_str())
    }

    pub fn trust(&mut self, path: &Path, endpoint: Endpoint, fingerprint: String) -> Result<()> {
        self.trusted_hosts.push(HostKey {
            endpoint,
            fingerprint,
        });
        self.persist(path)
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
pub struct ProfileSummary {
    #[serde(flatten)]
    profile: Profile,
    has_secret: bool,
}

impl From<SavedProfile> for ProfileSummary {
    fn from(item: SavedProfile) -> Self {
        Self {
            profile: item.profile,
            has_secret: item.credential.is_some(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    id: Option<Uuid>,
    label: String,
    host: String,
    port: u16,
    username: String,
    auth: Authentication,
    secret: Option<String>,
    #[serde(default)]
    clear_secret: bool,
}

impl ProfileInput {
    pub(super) fn settings(&self) -> Result<ConnectionSettings> {
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

    pub(super) fn take_secret(&mut self) -> Option<Zeroizing<String>> {
        self.secret
            .take()
            .map(Zeroizing::new)
            .filter(|secret| !self.clear_secret && !secret.is_empty())
    }

    fn previous<'a>(&self, config: &'a Config) -> Result<Option<&'a SavedProfile>> {
        self.id.map(|id| config.profile(id)).transpose()
    }

    fn reusable_credential(
        &self,
        settings: &ConnectionSettings,
        previous: Option<&SavedProfile>,
    ) -> Option<Uuid> {
        previous
            .filter(|old| !self.clear_secret && &old.profile.settings == settings)
            .and_then(|old| old.credential)
    }

    pub(super) fn secret_for_test(
        &self,
        config: &Config,
        settings: &ConnectionSettings,
        draft: Option<Zeroizing<String>>,
    ) -> Result<Option<Zeroizing<String>>> {
        let previous = self.previous(config)?;
        match draft {
            Some(secret) => Ok(Some(secret)),
            None => read_secret(self.reusable_credential(settings, previous)),
        }
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
    let secret = input.take_secret();
    blocking(move || {
        let label = input.label.trim().to_owned();
        if label.is_empty() {
            return Err("Enter a connection name.".to_owned());
        }
        let settings = input.settings()?;
        let _lock = lock(&path)?;
        let mut config = Config::load(&path)?;
        let previous = input.previous(&config)?;
        let reusable = input.reusable_credential(&settings, previous);
        if matches!(settings.auth, Authentication::Password)
            && secret.is_none()
            && reusable.is_none()
        {
            return Err("Enter the SSH password.".to_owned());
        }
        let updated_key = if let Some(secret) = secret {
            let key = Uuid::new_v4();
            credential(key)?.set_password(&secret).map_err(|error| {
                format!("Could not save the SSH secret in the system credential store. {error}")
            })?;
            Some(key)
        } else {
            None
        };
        let key = updated_key.or(reusable);
        let old_key = previous
            .and_then(|old| old.credential)
            .filter(|old| Some(*old) != key);
        let id = input.id.unwrap_or_else(Uuid::new_v4);
        let item = SavedProfile {
            profile: Profile {
                id,
                label,
                settings,
            },
            credential: key,
        };
        if let Some(existing) = config.profiles.iter_mut().find(|old| old.profile.id == id) {
            *existing = item.clone();
        } else {
            config.profiles.push(item.clone());
        }
        if let Err(error) = config.persist(&path) {
            if let Some(key) = updated_key {
                delete_credential(key);
            }
            return Err(error);
        }
        if let Some(key) = old_key {
            delete_credential(key);
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
        let key = config.profile(id)?.credential;
        config.profiles.retain(|item| item.profile.id != id);
        config.persist(&path)?;
        if let Some(key) = key {
            delete_credential(key);
        }
        Ok(())
    })
    .await
}
