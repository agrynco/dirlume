use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jiff::{
    tz::{Offset, TimeZone},
    Timestamp,
};
use serde::{Deserialize, Serialize};

use crate::{desktop::Result, remote_recycle::RecyclePreferences};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LineEnding {
    #[default]
    Lf,
    Crlf,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ListingTime {
    #[default]
    AsReported,
    FixedOffset,
    LocalZone,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DaylightSaving {
    #[default]
    AtTimestamp,
    CurrentOffset,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct EnvironmentPreferences {
    line_ending: LineEnding,
    listing_time: ListingTime,
    server_offset_minutes: i16,
    daylight_saving: DaylightSaving,
    pub(crate) preserve_download_timestamps: bool,
    #[serde(skip_serializing_if = "RecyclePreferences::is_default")]
    pub(crate) recycle_bin: RecyclePreferences,
}

impl Default for EnvironmentPreferences {
    fn default() -> Self {
        Self {
            line_ending: LineEnding::Lf,
            listing_time: ListingTime::AsReported,
            server_offset_minutes: 0,
            daylight_saving: DaylightSaving::AtTimestamp,
            preserve_download_timestamps: true,
            recycle_bin: RecyclePreferences::default(),
        }
    }
}

impl EnvironmentPreferences {
    pub(crate) fn is_default(&self) -> bool {
        self == &Self::default()
    }

    pub(crate) fn validated(mut self) -> Result<Self> {
        if !(-1439..=1439).contains(&self.server_offset_minutes) {
            return Err("Enter a server time offset between −1439 and 1439 minutes.".to_owned());
        }
        self.recycle_bin = self.recycle_bin.normalized()?;
        Ok(self)
    }

    pub(crate) fn ftp_clock(&self, utc: bool) -> impl Fn(SystemTime) -> SystemTime + '_ {
        let zone = if !utc && self.listing_time == ListingTime::LocalZone {
            TimeZone::system()
        } else {
            TimeZone::UTC
        };
        let now = Timestamp::now();
        move |value| {
            if utc || self.listing_time == ListingTime::AsReported || value == UNIX_EPOCH {
                value
            } else {
                self.correct_listing_time(value, &zone, now)
                    .unwrap_or(value)
            }
        }
    }

    fn correct_listing_time(
        &self,
        value: SystemTime,
        zone: &TimeZone,
        now: Timestamp,
    ) -> Option<SystemTime> {
        // LIST wall times are represented as UTC by the listing parser until the profile supplies a zone.
        let seconds = i64::try_from(value.duration_since(UNIX_EPOCH).ok()?.as_secs()).ok()?;
        let wall_time = Offset::UTC.to_datetime(Timestamp::from_second(seconds).ok()?);
        let corrected = match self.listing_time {
            ListingTime::AsReported => return Some(value),
            ListingTime::FixedOffset => {
                Offset::from_seconds(i32::from(self.server_offset_minutes) * 60)
                    .ok()?
                    .to_timestamp(wall_time)
            }
            ListingTime::LocalZone if self.daylight_saving == DaylightSaving::CurrentOffset => {
                zone.to_offset(now).to_timestamp(wall_time)
            }
            ListingTime::LocalZone => zone.to_timestamp(wall_time),
        }
        .ok()?
        .as_second();
        let seconds = Duration::from_secs(corrected.unsigned_abs());
        if corrected < 0 {
            UNIX_EPOCH.checked_sub(seconds)
        } else {
            UNIX_EPOCH.checked_add(seconds)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wall(value: &str) -> SystemTime {
        let parsed = value.parse::<Timestamp>().unwrap();
        UNIX_EPOCH + Duration::from_secs(parsed.as_second().try_into().unwrap())
    }

    #[test]
    fn corrects_only_naive_list_timestamps() {
        let settings = EnvironmentPreferences {
            listing_time: ListingTime::FixedOffset,
            server_offset_minutes: 120,
            ..Default::default()
        };
        let received = wall("2025-07-15T12:00:00Z");
        assert_eq!(
            settings.ftp_clock(false)(received),
            wall("2025-07-15T10:00:00Z")
        );
        assert_eq!(settings.ftp_clock(true)(received), received);
        assert_eq!(
            EnvironmentPreferences::default().ftp_clock(false)(received),
            received
        );
    }

    #[test]
    fn distinguishes_historical_dst_from_current_offset() {
        let zone = TimeZone::get("America/New_York").unwrap();
        let now = "2025-07-15T12:00:00Z".parse().unwrap();
        let winter = wall("2025-01-15T12:00:00Z");
        let summer = wall("2025-07-15T12:00:00Z");
        let mut settings = EnvironmentPreferences {
            listing_time: ListingTime::LocalZone,
            ..Default::default()
        };
        assert_eq!(
            settings.correct_listing_time(winter, &zone, now),
            Some(wall("2025-01-15T17:00:00Z"))
        );
        assert_eq!(
            settings.correct_listing_time(summer, &zone, now),
            Some(wall("2025-07-15T16:00:00Z"))
        );
        settings.daylight_saving = DaylightSaving::CurrentOffset;
        assert_eq!(
            settings.correct_listing_time(winter, &zone, now),
            Some(wall("2025-01-15T16:00:00Z"))
        );
    }
}
