use serde::Deserialize;

use crate::desktop::{blocking, Result};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimestampStyle {
    Date,
    Time,
    DateTime,
}

#[tauri::command]
pub async fn format_timestamps(
    timestamps: Vec<i64>,
    style: TimestampStyle,
) -> Result<Vec<Option<String>>> {
    if timestamps.len() > 1024 {
        return Err("Too many timestamps to format.".to_owned());
    }
    blocking(move || Ok(platform::format(&timestamps, style))).await
}

#[cfg(windows)]
mod platform {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::{FILETIME, SYSTEMTIME},
        Globalization::{GetDateFormatEx, GetTimeFormatEx, DATE_SHORTDATE, TIME_NOSECONDS},
        System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTimeEx},
    };

    use super::TimestampStyle;

    fn system_time(seconds: i64) -> Option<SYSTEMTIME> {
        let ticks = u64::try_from(seconds.checked_add(11_644_473_600)?)
            .ok()?
            .checked_mul(10_000_000)?;
        let file = FILETIME {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        };
        let mut utc = SYSTEMTIME::default();
        let mut local = SYSTEMTIME::default();
        unsafe {
            if FileTimeToSystemTime(&file, &mut utc) == 0
                || SystemTimeToTzSpecificLocalTimeEx(ptr::null(), &utc, &mut local) == 0
            {
                return None;
            }
        }
        Some(local)
    }

    fn date_or_time(local: &SYSTEMTIME, date: bool, format: Option<&[u16]>) -> Option<String> {
        let mut output = [0u16; 1024];
        let custom = format.map_or(ptr::null(), <[u16]>::as_ptr);
        let size = unsafe {
            if date {
                GetDateFormatEx(
                    ptr::null(),
                    if format.is_some() { 0 } else { DATE_SHORTDATE },
                    local,
                    custom,
                    output.as_mut_ptr(),
                    output.len() as i32,
                    ptr::null(),
                )
            } else {
                GetTimeFormatEx(
                    ptr::null(),
                    if format.is_some() { 0 } else { TIME_NOSECONDS },
                    local,
                    custom,
                    output.as_mut_ptr(),
                    output.len() as i32,
                )
            }
        };
        (size > 1).then(|| String::from_utf16_lossy(&output[..size as usize - 1]))
    }

    pub fn format(timestamps: &[i64], style: TimestampStyle) -> Vec<Option<String>> {
        timestamps
            .iter()
            .map(|&time| {
                let local = system_time(time)?;
                match style {
                    TimestampStyle::Date => date_or_time(&local, true, None),
                    TimestampStyle::Time => date_or_time(&local, false, None),
                    TimestampStyle::DateTime => Some(format!(
                        "{}, {}",
                        date_or_time(&local, true, None)?,
                        date_or_time(&local, false, None)?
                    )),
                }
            })
            .collect()
    }

    #[cfg(test)]
    #[test]
    fn windows_date_and_time_formatters_honor_custom_patterns() {
        let time = SYSTEMTIME {
            wYear: 2026,
            wMonth: 11,
            wDay: 19,
            wHour: 16,
            wMinute: 19,
            ..SYSTEMTIME::default()
        };
        let pattern = |value: &str| value.encode_utf16().chain([0]).collect::<Vec<_>>();
        assert_eq!(
            date_or_time(&time, true, Some(&pattern("dd.MM.yyyy"))).as_deref(),
            Some("19.11.2026")
        );
        assert_eq!(
            date_or_time(&time, false, Some(&pattern("HH:mm"))).as_deref(),
            Some("16:19")
        );
        assert_eq!(
            date_or_time(&time, false, Some(&pattern("hh:mm"))).as_deref(),
            Some("04:19")
        );
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::TimestampStyle;
    use std::{
        ffi::{c_char, c_void, CStr},
        ptr,
    };

    type CfRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;
    const CF_EPOCH_OFFSET: f64 = 978_307_200.0;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFLocaleCopyCurrent() -> CfRef;
        fn CFDateFormatterCreate(
            allocator: CfRef,
            locale: CfRef,
            date: isize,
            time: isize,
        ) -> CfRef;
        fn CFDateFormatterCreateStringWithAbsoluteTime(
            allocator: CfRef,
            formatter: CfRef,
            time: f64,
        ) -> CfRef;
        fn CFStringGetCString(string: CfRef, output: *mut c_char, size: isize, encoding: u32)
            -> u8;
        fn CFRelease(object: CfRef);
    }

    struct Owned(CfRef);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    pub fn format(timestamps: &[i64], style: TimestampStyle) -> Vec<Option<String>> {
        let (date, time) = match style {
            TimestampStyle::Date => (1, 0),
            TimestampStyle::Time => (0, 1),
            TimestampStyle::DateTime => (1, 1),
        };
        let locale = Owned(unsafe { CFLocaleCopyCurrent() });
        let formatter = Owned(unsafe { CFDateFormatterCreate(ptr::null(), locale.0, date, time) });
        if formatter.0.is_null() {
            return vec![None; timestamps.len()];
        }
        timestamps
            .iter()
            .map(|&time| {
                let value = Owned(unsafe {
                    CFDateFormatterCreateStringWithAbsoluteTime(
                        ptr::null(),
                        formatter.0,
                        time as f64 - CF_EPOCH_OFFSET,
                    )
                });
                if value.0.is_null() {
                    return None;
                }
                let mut output = [0 as c_char; 2048];
                let filled = unsafe {
                    CFStringGetCString(value.0, output.as_mut_ptr(), output.len() as isize, UTF8)
                };
                (filled != 0).then(|| {
                    unsafe { CStr::from_ptr(output.as_ptr()) }
                        .to_string_lossy()
                        .into_owned()
                })
            })
            .collect()
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::TimestampStyle;
    use std::{ffi::CStr, ptr};

    #[cfg(target_os = "linux")]
    fn desktop_time_pattern() -> Option<&'static CStr> {
        use gio::prelude::SettingsExt;

        let desktop = std::env::var("XDG_CURRENT_DESKTOP").ok()?;
        if !desktop
            .split(':')
            .any(|name| name.eq_ignore_ascii_case("gnome"))
        {
            return None;
        }
        let schema =
            gio::SettingsSchemaSource::default()?.lookup("org.gnome.desktop.interface", true)?;
        if !schema.has_key("clock-format") {
            return None;
        }
        let settings = gio::Settings::new_full(&schema, None::<&gio::SettingsBackend>, None);
        match settings.string("clock-format").as_str() {
            "12h" => Some(c"%I:%M %p"),
            "24h" => Some(c"%H:%M"),
            _ => None,
        }
    }

    struct LocalTime(libc::locale_t);
    impl Drop for LocalTime {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { libc::freelocale(self.0) };
            }
        }
    }

    fn format_part(
        time: &libc::tm,
        format: *const libc::c_char,
        locale: &LocalTime,
    ) -> Option<String> {
        if format.is_null() {
            return None;
        }
        let mut result = [0 as libc::c_char; 1024];
        let length =
            unsafe { libc::strftime_l(result.as_mut_ptr(), result.len(), format, time, locale.0) };
        (length > 0).then(|| {
            unsafe { CStr::from_ptr(result.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        })
    }

    pub fn format(timestamps: &[i64], style: TimestampStyle) -> Vec<Option<String>> {
        let locale = LocalTime(unsafe {
            libc::newlocale(
                libc::LC_TIME_MASK | libc::LC_CTYPE_MASK,
                c"".as_ptr(),
                ptr::null_mut(),
            )
        });
        if locale.0.is_null() {
            return vec![None; timestamps.len()];
        }
        let date = unsafe { libc::nl_langinfo_l(libc::D_FMT, locale.0) };
        let time = unsafe { libc::nl_langinfo_l(libc::T_FMT, locale.0) };
        #[cfg(target_os = "linux")]
        let time = desktop_time_pattern().map_or(time.cast_const(), CStr::as_ptr);
        timestamps
            .iter()
            .map(|&timestamp| {
                let timestamp = libc::time_t::try_from(i128::from(timestamp)).ok()?;
                let mut local: libc::tm = unsafe { std::mem::zeroed() };
                if unsafe { libc::localtime_r(&timestamp, &mut local) }.is_null() {
                    return None;
                }
                match style {
                    TimestampStyle::Date => format_part(&local, date, &locale),
                    TimestampStyle::Time => format_part(&local, time, &locale),
                    TimestampStyle::DateTime => Some(format!(
                        "{}, {}",
                        format_part(&local, date, &locale)?,
                        format_part(&local, time, &locale)?
                    )),
                }
            })
            .collect()
    }
}
