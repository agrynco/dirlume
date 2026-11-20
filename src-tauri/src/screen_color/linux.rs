use std::{
    collections::HashMap,
    thread,
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use tauri::AppHandle;
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::{ConnectionExt, EventMask, GrabMode, GrabStatus, ImageFormat, ImageOrder},
        Event,
    },
    CURRENT_TIME, NONE,
};
use zbus::{
    zvariant::{OwnedObjectPath, OwnedValue, Value},
    Proxy,
};

use super::{srgb, Rgb};
use crate::desktop::{blocking, message, Result};

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const SELECTOR: &str = "/org/freedesktop/portal/desktop";

pub(super) async fn pick(_app: AppHandle) -> Result<Option<Rgb>> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
        || std::env::var_os("DISPLAY").is_none()
    {
        return pick_portal().await;
    }
    blocking(pick_x11).await
}

async fn pick_portal() -> Result<Option<Rgb>> {
    let connection = zbus::Connection::session().await.map_err(message)?;
    let sender = connection
        .unique_name()
        .ok_or("The desktop color portal is unavailable.")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let token = format!("dirlume_{}", uuid::Uuid::new_v4().simple());
    let path = format!("{SELECTOR}/request/{sender}/{token}");
    let request = Proxy::new(
        &connection,
        PORTAL,
        path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .await
    .map_err(message)?;
    // Subscribe before requesting the color so a fast cancellation is not lost.
    let mut responses = request.receive_signal("Response").await.map_err(message)?;
    let screenshot = Proxy::new(
        &connection,
        PORTAL,
        SELECTOR,
        "org.freedesktop.portal.Screenshot",
    )
    .await
    .map_err(message)?;
    let options = HashMap::from([("handle_token", Value::from(token.as_str()))]);
    let handle: OwnedObjectPath = screenshot
        .call("PickColor", &("", options))
        .await
        .map_err(message)?;
    if handle.as_str() != path {
        return Err("The desktop color portal returned an unexpected request.".to_owned());
    }
    let response = match tokio::time::timeout(Duration::from_secs(120), responses.next()).await {
        Ok(response) => response.ok_or("The desktop color portal disconnected.")?,
        Err(_) => {
            let _: std::result::Result<(), _> = request.call("Close", &()).await;
            return Ok(None);
        }
    };
    let (response, mut values): (u32, HashMap<String, OwnedValue>) =
        response.body().deserialize().map_err(message)?;
    if response == 1 {
        return Ok(None);
    }
    if response != 0 {
        return Err("The desktop color portal could not select a color.".to_owned());
    }
    let (red, green, blue): (f64, f64, f64) = values
        .remove("color")
        .ok_or("The desktop color portal did not return a color.")?
        .try_into()
        .map_err(message)?;
    Ok(Some(srgb([red, green, blue])))
}

fn pick_x11() -> Result<Option<Rgb>> {
    let (display, screen) = x11rb::connect(None).map_err(message)?;
    let setup = display.setup();
    let root = setup.roots[screen].root;
    let keymap = display
        .get_keyboard_mapping(setup.min_keycode, setup.max_keycode - setup.min_keycode + 1)
        .map_err(message)?
        .reply()
        .map_err(message)?;
    let per_key = usize::from(keymap.keysyms_per_keycode).max(1);
    let is_escape = |key: u8| {
        key.checked_sub(setup.min_keycode)
            .and_then(|key| keymap.keysyms.chunks(per_key).nth(usize::from(key)))
            .is_some_and(|symbols| symbols.contains(&0xff1b))
    };

    // Dropping this dedicated connection releases both grabs, including on errors.
    let fonts = display.generate_id().map_err(message)?;
    let cursor = display.generate_id().map_err(message)?;
    display
        .open_font(fonts, b"cursor")
        .map_err(message)?
        .check()
        .map_err(message)?;
    display
        .create_glyph_cursor(
            cursor,
            fonts,
            fonts,
            34,
            35,
            0,
            0,
            0,
            u16::MAX,
            u16::MAX,
            u16::MAX,
        )
        .map_err(message)?
        .check()
        .map_err(message)?;
    let pointer = display
        .grab_pointer(
            false,
            root,
            EventMask::BUTTON_PRESS | EventMask::BUTTON_RELEASE,
            GrabMode::ASYNC,
            GrabMode::ASYNC,
            NONE,
            cursor,
            CURRENT_TIME,
        )
        .map_err(message)?
        .reply()
        .map_err(message)?;
    let keyboard = display
        .grab_keyboard(false, root, CURRENT_TIME, GrabMode::ASYNC, GrabMode::ASYNC)
        .map_err(message)?
        .reply()
        .map_err(message)?;
    if pointer.status != GrabStatus::SUCCESS || keyboard.status != GrabStatus::SUCCESS {
        return Err("The desktop is already handling a pointer or keyboard selection.".to_owned());
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut point = None;
    while Instant::now() < deadline {
        match display.poll_for_event().map_err(message)? {
            Some(Event::KeyPress(event)) if is_escape(event.detail) => return Ok(None),
            Some(Event::ButtonPress(event)) if event.detail == 1 => {
                point = Some((event.root, event.root_x, event.root_y));
            }
            Some(Event::ButtonRelease(event)) if event.detail == 1 && point.is_some() => {
                let (root, x, y) = point.take().expect("the selection started with a press");
                return sample_x11(&display, root, x, y).map(Some);
            }
            None => thread::sleep(Duration::from_millis(8)),
            _ => {}
        }
    }
    Ok(None)
}

fn sample_x11(display: &impl Connection, root: u32, x: i16, y: i16) -> Result<Rgb> {
    let setup = display.setup();
    let screen = setup
        .roots
        .iter()
        .find(|screen| screen.root == root)
        .ok_or("The selected screen is unavailable.")?;
    let visual = screen
        .allowed_depths
        .iter()
        .flat_map(|depth| &depth.visuals)
        .find(|visual| visual.visual_id == screen.root_visual)
        .ok_or("The screen color format is unavailable.")?;
    let pixel = display
        .get_image(ImageFormat::Z_PIXMAP, root, x, y, 1, 1, u32::MAX)
        .map_err(message)?
        .reply()
        .map_err(message)?;
    let count = setup
        .pixmap_formats
        .iter()
        .find(|format| format.depth == pixel.depth)
        .map(|format| usize::from(format.bits_per_pixel) / 8)
        .filter(|count| (1..=4).contains(count))
        .ok_or("The screen pixel format is unsupported.")?;
    let bytes = pixel
        .data
        .get(..count)
        .ok_or("Could not read a pixel from the screen.")?;
    let mut channels = [0; 4];
    if setup.image_byte_order == ImageOrder::LSB_FIRST {
        channels[..count].copy_from_slice(bytes);
    } else {
        for (position, value) in bytes.iter().rev().enumerate() {
            channels[position] = *value;
        }
    }
    let pixel = u32::from_le_bytes(channels);
    let masks = [visual.red_mask, visual.green_mask, visual.blue_mask];
    if masks.contains(&0) {
        return Err("The screen color format is unsupported.".to_owned());
    }
    Ok(srgb(
        masks.map(|mask| f64::from(pixel & mask) / f64::from(mask)),
    ))
}
