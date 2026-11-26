use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Result;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct RecyclePreferences {
    pub(crate) folder: String,
    pub(crate) keep_deleted: bool,
    pub(crate) keep_overwritten: bool,
}

impl RecyclePreferences {
    pub(crate) fn is_default(&self) -> bool {
        self == &Self::default()
    }

    pub(crate) fn normalized(mut self) -> Result<Self> {
        self.folder = self.folder.trim().to_owned();
        if self.keep_deleted || self.keep_overwritten || !self.folder.is_empty() {
            self.segments()?;
        }
        Ok(self)
    }

    pub(crate) fn segments(&self) -> Result<Vec<String>> {
        let parts: Vec<_> = self
            .folder
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        if !self.folder.starts_with('/')
            || parts.is_empty()
            || parts
                .iter()
                .any(|part| matches!(*part, "." | "..") || part.contains(['\\', '\0', '\r', '\n']))
        {
            return Err(
                "Enter an absolute recycle-bin folder other than the server root.".to_owned(),
            );
        }
        Ok(parts.into_iter().map(str::to_owned).collect())
    }
}

pub(crate) fn protect_path(bin: &[String], source: &[String]) -> Result<()> {
    if bin.is_empty() || source.is_empty() || bin.starts_with(source) || source.starts_with(bin) {
        return Err(
            "The recycle bin, its parents, and its contents cannot be moved into the recycle bin."
                .to_owned(),
        );
    }
    Ok(())
}

pub(crate) struct RecoveryPath {
    pub(crate) destination: Vec<String>,
    first_new_directory: usize,
}

impl RecoveryPath {
    pub(crate) fn new(bin: &[String], source: &[String]) -> Result<Self> {
        protect_path(bin, source)?;
        let mut destination = bin.to_vec();
        let attempt = Uuid::new_v4().to_string();
        destination.push(attempt);
        destination.extend_from_slice(source);
        Ok(Self {
            destination,
            first_new_directory: bin.len() + 1,
        })
    }

    pub(crate) fn directories(&self) -> impl Iterator<Item = &[String]> {
        (self.first_new_directory..self.destination.len()).map(|length| &self.destination[..length])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_the_original_path_under_a_distinct_recovery_directory() {
        let bin = vec!["recycle".to_owned()];
        let source = vec![
            "projects".to_owned(),
            "reports".to_owned(),
            "file.txt".to_owned(),
        ];
        let first = RecoveryPath::new(&bin, &source).unwrap();
        let second = RecoveryPath::new(&bin, &source).unwrap();
        assert_eq!(&first.destination[2..], source);
        assert_ne!(first.destination[1], second.destination[1]);
        assert_eq!(
            first.directories().map(<[String]>::len).collect::<Vec<_>>(),
            [2, 3, 4]
        );
        assert!(RecoveryPath::new(&bin, &bin).is_err());
        assert!(RecoveryPath::new(&source, &source[..1]).is_err());
        assert!(RecoveryPath::new(&source[..1], &source).is_err());
        assert!(RecoveryPath::new(&[], &source).is_err());
    }
}
