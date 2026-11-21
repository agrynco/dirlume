use crate::{
    desktop::{load_preview_image, lock_local_save, publish_local_replacement, selected},
    local,
    local_transfer::FileRevision,
};
use image::{
    codecs::{jpeg::JpegDecoder, png::PngDecoder},
    metadata::Orientation,
    DynamicImage, ImageDecoder, ImageFormat, Limits,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{self, Cursor},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::State;

type Result<T> = std::result::Result<T, String>;
const MAX_DIMENSION: u32 = 16_384;
const MAX_PIXELS: u64 = 32 * 1024 * 1024;
const MAX_SOURCES: usize = 64 * 1024 * 1024;
const SOURCE_CHANGED: &str = "The original image changed on disk. You can still save a copy.";

#[derive(Default)]
pub(crate) struct ImageEdits(Mutex<HashMap<String, Arc<ImageEdit>>>);

struct ImageEdit {
    path: PathBuf,
    format: ImageFormat,
    revision: FileRevision,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenImageEdit {
    id: String,
    width: u32,
    height: u32,
    can_replace: bool,
}

#[derive(Deserialize)]
pub(crate) struct ImageTransform {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    turns: u8,
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn format(path: &Path) -> Result<ImageFormat> {
    match ImageFormat::from_path(path) {
        Ok(ImageFormat::Png) => Ok(ImageFormat::Png),
        Ok(ImageFormat::Jpeg) => Ok(ImageFormat::Jpeg),
        _ => Err("Only local single-frame PNG and JPEG images can be edited.".into()),
    }
}

fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_PIXELS * 8);
    limits
}

fn decoder(bytes: &[u8], format: ImageFormat) -> Result<(Box<dyn ImageDecoder + '_>, Orientation)> {
    let source = Cursor::new(bytes);
    let mut decoder: Box<dyn ImageDecoder> = match format {
        ImageFormat::Png => {
            let png = PngDecoder::with_limits(source, limits()).map_err(message)?;
            if png.is_apng().map_err(message)? {
                return Err("Animated PNG images can only be viewed.".into());
            }
            Box::new(png)
        }
        ImageFormat::Jpeg => Box::new(JpegDecoder::new(source).map_err(message)?),
        _ => return Err("Only local single-frame PNG and JPEG images can be edited.".into()),
    };
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("The image exceeds the editor's 32 megapixel limit.".into());
    }
    decoder.set_limits(limits()).map_err(message)?;
    let orientation = decoder.orientation().map_err(message)?;
    Ok((decoder, orientation))
}

impl ImageEdit {
    fn open(path: PathBuf) -> Result<(Self, u32, u32, bool)> {
        let format = format(&path)?;
        let metadata = fs::symlink_metadata(&path).map_err(message)?;
        let revision = FileRevision::capture(&path, &metadata).map_err(message)?;
        let bytes = load_preview_image(&path)?;
        revision.verify(&path).map_err(message)?;
        let (width, height) = {
            let (decoder, orientation) = decoder(&bytes, format)?;
            let (width, height) = decoder.dimensions();
            match orientation {
                Orientation::Rotate90
                | Orientation::Rotate270
                | Orientation::Rotate90FlipH
                | Orientation::Rotate270FlipH => (height, width),
                _ => (width, height),
            }
        };
        let can_replace = !metadata.permissions().readonly()
            && fs::OpenOptions::new().write(true).open(&path).is_ok();
        Ok((
            Self {
                path,
                format,
                revision,
                bytes,
            },
            width,
            height,
            can_replace,
        ))
    }

    fn verify_original(&self) -> Result<()> {
        let failed = |_| SOURCE_CHANGED.to_owned();
        self.revision.verify(&self.path).map_err(failed)?;
        if load_preview_image(&self.path).ok().as_deref() != Some(&self.bytes) {
            return Err(SOURCE_CHANGED.into());
        }
        self.revision.verify(&self.path).map_err(failed)
    }

    fn render(&self, edit: ImageTransform) -> Result<DynamicImage> {
        let (decoder, orientation) = decoder(&self.bytes, self.format)?;
        let mut image = DynamicImage::from_decoder(decoder).map_err(message)?;
        image.apply_orientation(orientation);
        if edit.width == 0
            || edit.height == 0
            || edit.x.saturating_add(edit.width) > image.width()
            || edit.y.saturating_add(edit.height) > image.height()
            || edit.turns > 3
        {
            return Err("The crop is outside the image.".into());
        }
        if (edit.x, edit.y, edit.width, edit.height) != (0, 0, image.width(), image.height()) {
            image = image.crop_imm(edit.x, edit.y, edit.width, edit.height);
        }
        image.apply_orientation(
            [
                Orientation::NoTransforms,
                Orientation::Rotate90,
                Orientation::Rotate180,
                Orientation::Rotate270,
            ][usize::from(edit.turns)],
        );
        Ok(image)
    }

    fn save(&self, target: Option<&str>, edit: ImageTransform) -> Result<()> {
        let path = match target {
            Some(target) => local::absolute(target).map_err(message)?,
            None => self.path.as_path(),
        };
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Enter a file name.")?;
        local::name_component(name).map_err(message)?;
        if format(path).ok() != Some(self.format) {
            return Err("Use the same file format as the original image.".into());
        }
        let parent = path.parent().ok_or("Choose a parent folder.")?;
        let _guard = if target.is_none() {
            Some(lock_local_save(path).map_err(|_| SOURCE_CHANGED.to_owned())?)
        } else {
            None
        };
        if target.is_none() {
            self.verify_original()?;
        }
        let workspace = local::staging_directory(parent).map_err(message)?;
        let mut staged = tempfile::NamedTempFile::new_in(workspace.path()).map_err(message)?;
        let metadata = if target.is_none() {
            let metadata = fs::symlink_metadata(path).map_err(message)?;
            fs::OpenOptions::new()
                .write(true)
                .open(path)
                .map_err(message)?;
            Some(metadata)
        } else {
            None
        };
        #[cfg(windows)]
        if let Some(metadata) = &metadata {
            local::preserve_access(path, staged.path(), metadata).map_err(message)?;
        }
        self.render(edit)?
            .write_to(&mut staged, self.format)
            .map_err(message)?;
        #[cfg(unix)]
        if let Some(metadata) = &metadata {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o6000 != 0 {
                return Err("Edit this file with a tool that supports special permissions.".into());
            }
            local::preserve_access(path, staged.path(), metadata).map_err(message)?;
        }
        staged.as_file().sync_all().map_err(message)?;
        if target.is_none() {
            self.verify_original()?;
            publish_local_replacement(path, staged)
        } else {
            staged.persist_noclobber(path).map_err(|error| {
                if error.error.kind() == io::ErrorKind::AlreadyExists {
                    "A file already exists at that path. Choose a new file name.".into()
                } else {
                    message(error.error)
                }
            })?;
            Ok(())
        }
    }
}

impl ImageEdits {
    fn get(&self, id: &str) -> Result<Arc<ImageEdit>> {
        self.0
            .lock()
            .map_err(message)?
            .get(id)
            .cloned()
            .ok_or_else(|| "Reopen the image before editing.".into())
    }
}

#[tauri::command]
pub(crate) async fn open_image_edit(
    directory: String,
    name: String,
    state: State<'_, ImageEdits>,
) -> Result<OpenImageEdit> {
    let path = selected(&directory, &name).map_err(message)?;
    let (image, width, height, can_replace) =
        tauri::async_runtime::spawn_blocking(move || ImageEdit::open(path))
            .await
            .map_err(message)??;
    let mut edits = state.0.lock().map_err(message)?;
    let bytes: usize = edits.values().map(|edit| edit.bytes.len()).sum();
    if bytes + image.bytes.len() > MAX_SOURCES {
        return Err("Close another image editor to free memory.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    edits.insert(id.clone(), Arc::new(image));
    Ok(OpenImageEdit {
        id,
        width,
        height,
        can_replace,
    })
}

#[tauri::command]
pub(crate) async fn read_image_edit(
    id: String,
    state: State<'_, ImageEdits>,
) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(state.get(&id)?.bytes.clone()))
}

#[tauri::command]
pub(crate) async fn save_image_edit(
    id: String,
    target: Option<String>,
    edit: ImageTransform,
    state: State<'_, ImageEdits>,
) -> Result<()> {
    let image = state.get(&id)?;
    tauri::async_runtime::spawn_blocking(move || image.save(target.as_deref(), edit))
        .await
        .map_err(message)?
}

#[tauri::command]
pub(crate) async fn close_image_edit(id: String, state: State<'_, ImageEdits>) -> Result<()> {
    state.0.lock().map_err(message)?.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage, Rgba, RgbaImage};

    fn transform(x: u32, y: u32, width: u32, height: u32, turns: u8) -> ImageTransform {
        ImageTransform {
            x,
            y,
            width,
            height,
            turns,
        }
    }

    #[test]
    fn rotate_and_crop_transparent_png_to_copy() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.png");
        let copy = folder.path().join("copy.png");
        let mut fixture = RgbaImage::from_pixel(1200, 800, Rgba([20, 30, 60, 80]));
        fixture.put_pixel(30, 749, Rgba([225, 100, 50, 0]));
        fixture.save(&source).unwrap();
        let original = fs::read(&source).unwrap();
        let (edit, width, height, _) = ImageEdit::open(source.clone()).unwrap();
        assert_eq!((width, height), (1200, 800));
        edit.save(copy.to_str(), transform(30, 30, 405, 720, 1))
            .unwrap();
        let output = image::open(&copy).unwrap();
        assert_eq!(output.dimensions(), (720, 405));
        assert_eq!(output.get_pixel(0, 0), Rgba([225, 100, 50, 0]));
        assert_eq!(output.get_pixel(1, 0), Rgba([20, 30, 60, 80]));
        assert_eq!(fs::read(source).unwrap(), original);
    }

    #[test]
    fn normalizes_jpeg_orientation_before_editing() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.jpg");
        let mut jpeg = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::from_pixel(24, 12, Rgb([220, 40, 30])))
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        let mut jpeg = jpeg.into_inner();
        // EXIF orientation 6 (90 degrees clockwise) in a little-endian TIFF directory.
        let exif = [
            0xff, 0xe1, 0, 34, b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0,
            0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ];
        jpeg.splice(2..2, exif);
        fs::write(&source, jpeg).unwrap();
        let (edit, width, height, _) = ImageEdit::open(source.clone()).unwrap();
        assert_eq!((width, height), (12, 24));
        edit.save(None, transform(0, 0, width, height, 0)).unwrap();
        let (saved, width, height, _) = ImageEdit::open(source).unwrap();
        assert_eq!((width, height), (12, 24));
        assert_eq!(
            decoder(&saved.bytes, ImageFormat::Jpeg).unwrap().1,
            Orientation::NoTransforms
        );
    }

    #[test]
    fn existing_files_survive_invalid_crops_and_conflicting_saves() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("source.png");
        let copy = folder.path().join("copy.png");
        RgbaImage::new(12, 10).save(&source).unwrap();
        let original = fs::read(&source).unwrap();
        let (edit, _, _, _) = ImageEdit::open(source.clone()).unwrap();
        fs::write(&copy, b"collision").unwrap();
        assert!(edit.save(None, transform(1, 1, 20, 20, 0)).is_err());
        assert_eq!(fs::read(&source).unwrap(), original);
        assert!(edit
            .save(copy.to_str(), transform(0, 0, 12, 10, 1))
            .is_err());
        assert_eq!(fs::read(&copy).unwrap(), b"collision");
        fs::write(&source, b"external change").unwrap();
        assert_eq!(
            edit.save(None, transform(0, 0, 12, 10, 1)),
            Err(SOURCE_CHANGED.into())
        );
        let recovered = folder.path().join("recovered.png");
        edit.save(recovered.to_str(), transform(0, 0, 12, 10, 1))
            .unwrap();
        assert_eq!(image::open(recovered).unwrap().dimensions(), (10, 12));
        assert_eq!(fs::read(source).unwrap(), b"external change");
    }
}
