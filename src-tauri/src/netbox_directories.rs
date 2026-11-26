use serde::{Deserialize, Serialize};

use crate::desktop::Result;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct DirectoryPreferences {
    pub(crate) starting_folder: String,
    pub(crate) remember_last: bool,
    pub(crate) cache_listings: bool,
    pub(crate) cache_changes: bool,
    pub(crate) persistent_cache: bool,
    pub(crate) resolve_links: bool,
}

impl DirectoryPreferences {
    pub(crate) fn is_default(&self) -> bool {
        self == &Self::default()
    }

    pub(crate) fn normalized(mut self) -> Result<Self> {
        self.starting_folder = self.starting_folder.trim().to_owned();
        if !self.starting_folder.is_empty()
            && (!self.starting_folder.starts_with('/')
                || self
                    .starting_folder
                    .split('/')
                    .any(|name| matches!(name, "." | "..") || name.contains(['\0', '\r', '\n'])))
        {
            return Err(
                "Enter an absolute starting folder without relative path segments.".to_owned(),
            );
        }
        self.persistent_cache &= self.cache_listings || self.cache_changes;
        Ok(self)
    }

    fn starting_segments(&self) -> Option<Vec<String>> {
        if self.starting_folder.is_empty() {
            return None;
        }
        Some(
            self.starting_folder
                .split('/')
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .collect(),
        )
    }
}

pub(crate) enum InitialListingError {
    Unavailable(String),
    Other(String),
}

impl From<InitialListingError> for String {
    fn from(error: InitialListingError) -> Self {
        match error {
            InitialListingError::Unavailable(message) | InitialListingError::Other(message) => {
                message
            }
        }
    }
}

pub(crate) struct InitialListing<T> {
    pub(crate) segments: Vec<String>,
    pub(crate) listing: T,
    pub(crate) unavailable: Vec<String>,
}

pub(crate) fn list_initial<T>(
    settings: &DirectoryPreferences,
    explicit: Option<Vec<String>>,
    remembered: Option<Vec<String>>,
    mut read: impl FnMut(
        Option<&[String]>,
    ) -> std::result::Result<(Vec<String>, T), InitialListingError>,
) -> Result<InitialListing<T>> {
    if let Some(explicit) = explicit {
        let (segments, listing) = read(Some(&explicit))?;
        return Ok(InitialListing {
            segments,
            listing,
            unavailable: Vec::new(),
        });
    }
    let remembered = remembered.filter(|_| settings.remember_last);
    let configured = settings
        .starting_segments()
        .filter(|path| Some(path) != remembered.as_ref());
    let mut unavailable = Vec::new();
    for candidate in [remembered, configured].into_iter().flatten() {
        match read(Some(&candidate)) {
            Ok((segments, listing)) => {
                return Ok(InitialListing {
                    segments,
                    listing,
                    unavailable,
                })
            }
            Err(InitialListingError::Unavailable(_)) => {
                unavailable.push(format!("/{}", candidate.join("/")))
            }
            Err(error) => return Err(error.into()),
        }
    }
    let (segments, listing) = read(None)?;
    Ok(InitialListing {
        segments,
        listing,
        unavailable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_from_remembered_to_configured_to_server_default() {
        let settings = DirectoryPreferences {
            starting_folder: "/configured".into(),
            remember_last: true,
            ..Default::default()
        };
        let mut tried = Vec::new();
        let listing = list_initial(
            &settings,
            None,
            Some(vec!["remembered".into()]),
            |candidate| {
                if let Some(candidate) = candidate {
                    tried.push(candidate[0].clone());
                    return Err(InitialListingError::Unavailable("missing".into()));
                }
                Ok((vec!["server-default".into()], ()))
            },
        )
        .unwrap();
        assert_eq!(tried, ["remembered", "configured"]);
        assert_eq!(listing.segments, ["server-default"]);
        assert_eq!(listing.unavailable, ["/remembered", "/configured"]);
    }

    #[test]
    fn keeps_explicit_paths_and_transport_errors() {
        let settings = DirectoryPreferences {
            starting_folder: "/configured".into(),
            remember_last: true,
            ..Default::default()
        };
        let mut count = 0;
        let result = list_initial(
            &settings,
            Some(vec!["bookmark".into()]),
            Some(vec!["remembered".into()]),
            |candidate| {
                count += 1;
                assert_eq!(candidate.unwrap(), ["bookmark"]);
                Err::<(Vec<String>, ()), _>(InitialListingError::Unavailable(
                    "bookmark missing".into(),
                ))
            },
        );
        assert_eq!(result.err().as_deref(), Some("bookmark missing"));
        assert_eq!(count, 1);
        let result = list_initial(&settings, None, Some(vec!["remembered".into()]), |_| {
            count += 1;
            Err::<(Vec<String>, ()), _>(InitialListingError::Other("connection reset".into()))
        });
        assert_eq!(result.err().as_deref(), Some("connection reset"));
        assert_eq!(count, 2);
    }
}
