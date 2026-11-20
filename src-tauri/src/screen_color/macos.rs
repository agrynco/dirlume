use std::cell::RefCell;

use block2::RcBlock;
use objc2_app_kit::{NSColor, NSColorSampler, NSColorSpace};
use tauri::AppHandle;
use tokio::sync::oneshot;

use super::{srgb, Rgb};
use crate::desktop::{message, Result};

pub(super) async fn pick(app: AppHandle) -> Result<Option<Rgb>> {
    let (send, receive) = oneshot::channel();
    app.run_on_main_thread(move || {
        let send = RefCell::new(Some(send));
        let handler = RcBlock::new(move |color: *mut NSColor| {
            let Some(send) = send.borrow_mut().take() else {
                return;
            };
            // AppKit keeps the selected color alive for the duration of the callback.
            let selected = unsafe { color.as_ref() }.map(|color| {
                color
                    .colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())
                    .map(|color| {
                        srgb([
                            color.redComponent(),
                            color.greenComponent(),
                            color.blueComponent(),
                        ])
                    })
                    .ok_or_else(|| "Could not convert the screen color to sRGB.".to_owned())
            });
            let _ = send.send(selected.transpose());
        });
        // AppKit invokes the handler on this thread and retains both the sampler and block.
        unsafe { NSColorSampler::new().showSamplerWithSelectionHandler(&handler) };
    })
    .map_err(message)?;
    receive.await.map_err(message)?
}
