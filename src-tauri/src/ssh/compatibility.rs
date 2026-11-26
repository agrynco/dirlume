use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::Result;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Shell {
    #[default]
    Automatic,
    Bash,
    Zsh,
    Sh,
}

impl Shell {
    pub(super) fn assignment(self) -> &'static str {
        match self {
            Self::Automatic => "shell=${SHELL:-/bin/sh}",
            Self::Bash => "shell=bash",
            Self::Zsh => "shell=zsh",
            Self::Sh => "shell=/bin/sh",
        }
    }
}

#[derive(Clone, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Compatibility {
    pub(super) sftp_command: String,
    pub(super) signed_timestamps: bool,
    pub(super) shell: Shell,
}

impl Compatibility {
    pub(super) fn is_default(&self) -> bool {
        self == &Self::default()
    }

    pub(super) fn validated(mut self) -> Result<Self> {
        self.sftp_command = self.sftp_command.trim().to_owned();
        if self.sftp_command.len() > 4096 || self.sftp_command.contains(['\0', '\r', '\n']) {
            return Err("Enter the SFTP server command on one line.".to_owned());
        }
        Ok(self)
    }

    pub(super) fn timestamp(&self, time: SystemTime) -> SystemTime {
        if self.signed_timestamps {
            if let Ok(elapsed) = time.duration_since(UNIX_EPOCH) {
                if let Ok(seconds) = u32::try_from(elapsed.as_secs()) {
                    let signed = i32::from_ne_bytes(seconds.to_ne_bytes());
                    if signed < 0 {
                        return UNIX_EPOCH - Duration::from_secs(u64::from(signed.unsigned_abs()));
                    }
                }
            }
        }
        time
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_signed_timestamps_only_when_selected() {
        let time = UNIX_EPOCH + Duration::from_secs(u64::from(u32::MAX));
        assert_eq!(Compatibility::default().timestamp(time), time);
        let selected = Compatibility {
            signed_timestamps: true,
            ..Default::default()
        };
        assert_eq!(
            selected.timestamp(time),
            UNIX_EPOCH - Duration::from_secs(1)
        );
        assert_eq!(selected.timestamp(UNIX_EPOCH), UNIX_EPOCH);
    }
}
