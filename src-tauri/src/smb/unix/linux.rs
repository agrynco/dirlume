use std::{cell::Cell, io, path::PathBuf, rc::Rc, time::Duration};

use gio::prelude::*;
use url::Url;

use super::Credentials;

fn smb_error(error: gio::glib::Error, challenged: bool) -> io::Error {
    let kind = if error.matches(gio::IOErrorEnum::PermissionDenied)
        || challenged
            && (error.matches(gio::IOErrorEnum::FailedHandled)
                || error.matches(gio::IOErrorEnum::Cancelled))
    {
        io::ErrorKind::PermissionDenied
    } else {
        io::ErrorKind::Other
    };
    io::Error::new(kind, error.to_string())
}

fn with_mount<T>(
    url: &Url,
    credentials: Option<&Credentials>,
    read: impl FnOnce(gio::File) -> io::Result<T>,
) -> io::Result<T> {
    let context = gio::glib::MainContext::new();
    context
        .with_thread_default(|| {
            let file = gio::File::for_uri(url.as_str());
            let operation = gio::MountOperation::new();
            let challenged = Rc::new(Cell::new(false));
            let tried = Rc::clone(&challenged);
            let credentials = credentials.map(|value| Credentials {
                username: value.username.trim().to_owned(),
                password: value.password.clone(),
            });
            operation.connect_ask_password(move |operation, _, _, _, flags| {
                if tried.replace(true) {
                    operation.reply(gio::MountOperationResult::Aborted);
                    return;
                }
                if let Some(value) = &credentials {
                    let (domain, user) = value
                        .username
                        .split_once('\\')
                        .unwrap_or(("", &value.username));
                    operation.set_username(Some(user));
                    if !domain.is_empty() {
                        operation.set_domain(Some(domain));
                    }
                    operation.set_password(Some(&value.password));
                    operation.set_password_save(gio::PasswordSave::Never);
                } else if flags.contains(gio::AskPasswordFlags::ANONYMOUS_SUPPORTED) {
                    operation.set_anonymous(true);
                } else {
                    operation.reply(gio::MountOperationResult::Aborted);
                    return;
                }
                operation.reply(gio::MountOperationResult::Handled);
            });
            if let Err(error) = context.block_on(
                file.mount_enclosing_volume_future(gio::MountMountFlags::NONE, Some(&operation)),
            ) {
                if !error.matches(gio::IOErrorEnum::AlreadyMounted) {
                    return Err(smb_error(error, challenged.get()));
                }
            }
            read(file)
        })
        .map_err(io::Error::other)?
}

pub(super) fn list_shares(url: &Url, credentials: Option<&Credentials>) -> io::Result<Vec<String>> {
    with_mount(url, credentials, |file| {
        let cancel = gio::Cancellable::NONE;
        let entries = file
            .enumerate_children(
                "standard::name,standard::type",
                gio::FileQueryInfoFlags::NOFOLLOW_SYMLINKS,
                cancel,
            )
            .map_err(|error| smb_error(error, false))?;
        let mut names = Vec::new();
        while let Some(info) = entries
            .next_file(cancel)
            .map_err(|error| smb_error(error, false))?
        {
            if matches!(
                info.file_type(),
                gio::FileType::Mountable | gio::FileType::Directory
            ) {
                if let Some(name) = info.name().to_str() {
                    names.push(name.to_owned());
                }
            }
        }
        Ok(names)
    })
}

pub(super) fn mount_share(url: &Url, credentials: Option<&Credentials>) -> io::Result<PathBuf> {
    with_mount(url, credentials, |file| {
        for _ in 0..5 {
            if let Some(path) = file.path().filter(|path| path.is_dir()) {
                return Ok(path);
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Could not access the SMB mount. Ubuntu requires the GVfs SMB and FUSE backends.",
        ))
    })
}
