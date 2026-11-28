use super::*;

#[expect(
    clippy::too_many_arguments,
    reason = "A folder move uses the same progress channel as a file move"
)]
pub(super) async fn transfer_drive_folder(
    drive: &crate::google_drive::TransferDrive,
    source: &Path,
    parent: &str,
    plan: &DriveTargetPlan,
    session: &TransferSession,
    output: &Channel<TransferEvent>,
    moving: bool,
    destination: &str,
) -> Result<TransferOutcome> {
    let root = drive.create_folder(parent, &plan.name).await?;
    let mut files = Vec::new();
    let mut folders = Vec::new();
    let result: Result<()> = async {
        let mut pending = vec![(source.to_owned(), root.clone())];
        while let Some((folder, target)) = pending.pop() {
            session.ensure_running().map_err(message)?;
            let identity = same_file::Handle::from_path(&folder).map_err(message)?;
            local_transfer::verify_folder(&folder, &identity).map_err(message)?;
            for entry in fs::read_dir(&folder).map_err(message)? {
                session.ensure_running().map_err(message)?;
                let entry = entry.map_err(message)?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "Enter a valid name.")?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(message)?;
                if local::is_link(&metadata) || !metadata.is_file() && !metadata.is_dir() {
                    return Err("Choose files or folders without symbolic links.".into());
                }
                if metadata.is_dir() {
                    let child = drive.create_folder(&target, &name).await?;
                    pending.push((path, child));
                } else {
                    let revision =
                        local_transfer::FileRevision::capture(&path, &metadata).map_err(message)?;
                    session
                        .interrupt(drive.upload(&path, &target, &name, |bytes, total| {
                            report_transfer_progress(output, &path, bytes, Some(total));
                            session.ensure_running()
                        }))
                        .await?;
                    revision.verify(&path).map_err(message)?;
                    files.push((path, revision));
                }
            }
            folders.push((folder, identity));
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let _ = drive.trash(&root).await;
        return Err(error);
    }
    if let Some(existing) = &plan.replace {
        drive.trash(existing).await?;
    }
    if moving {
        let remove = || -> io::Result<()> {
            for (path, revision) in &files {
                revision.verify(path)?;
            }
            for (path, identity) in &folders {
                local_transfer::verify_folder(path, identity)?;
            }
            for (path, revision) in files {
                session.ensure_running()?;
                local_transfer::remove_original(&path, &revision)?;
            }
            for (path, identity) in folders.into_iter().rev() {
                session.ensure_running()?;
                local_transfer::verify_folder(&path, &identity)?;
                fs::remove_dir(path)?;
            }
            Ok(())
        };
        if let Err(error) = remove() {
            return Ok(TransferOutcome::SourceRetained {
                destination: destination.to_owned(),
                source: source.display().to_string(),
                error: message(error),
            });
        }
    }
    Ok(TransferOutcome::Completed)
}

pub(super) struct DriveTargetPlan {
    pub(super) name: String,
    pub(super) replace: Option<String>,
}

#[expect(
    clippy::too_many_arguments,
    reason = "Drive conflicts share the file transfer session and event channel"
)]
pub(super) async fn drive_transfer_plan(
    drive: &crate::google_drive::TransferDrive,
    destination: &GoogleDriveDestination,
    name: &str,
    incoming: local_transfer::EntryDetails,
    source_id: Option<&str>,
    request: &TransferRequest,
    session: &Arc<TransferSession>,
    output: &Channel<TransferEvent>,
) -> Result<Option<DriveTargetPlan>> {
    use local_transfer::{Decision, Policy};
    let mut plan = DriveTargetPlan {
        name: name.to_owned(),
        replace: None,
    };
    let entries = session.interrupt(drive.list(&destination.parent)).await?;
    let mut matches = entries.iter().filter(|item| {
        item.name == name && (!request.moving || Some(item.id.as_str()) != source_id)
    });
    let Some(existing) = matches.next() else {
        return Ok(Some(plan));
    };
    if request.policy == Policy::Rename {
        plan.name = (1..)
            .map(|n| format!("{name} ({n})"))
            .find(|candidate| entries.iter().all(|item| item.name != *candidate))
            .ok_or("No available name was found.")?;
        return Ok(Some(plan));
    }
    if matches!(request.policy, Policy::Skip | Policy::Newer) {
        return Ok(None);
    }
    let replaceable = matches.next().is_none() && !existing.directory;
    if request.policy == Policy::Ask {
        let modified = existing
            .modified
            .and_then(|seconds| u64::try_from(seconds).ok())
            .and_then(|seconds| UNIX_EPOCH.checked_add(Duration::from_secs(seconds)));
        let conflict = local_transfer::Conflict::paired(
            format!("{}/{name}", request.destination.trim_end_matches('/')),
            incoming,
            local_transfer::EntryDetails::network(existing.size, modified, existing.directory),
            replaceable,
            false,
        );
        let session = Arc::clone(session);
        let output = output.clone();
        if matches!(
            blocking(move || session.ask(conflict, &output).map_err(message)).await?,
            Decision::Skip
        ) {
            return Ok(None);
        }
    }
    if !replaceable {
        return Err("Choose a different name for this Google Drive item.".into());
    }
    plan.replace = Some(existing.id.clone());
    Ok(Some(plan))
}

pub(super) async fn copy_drive_tree(
    drive: &crate::google_drive::TransferDrive,
    item: &str,
    destination: &str,
    name: &str,
    session: &TransferSession,
) -> Result<()> {
    let mut folders = vec![item.to_owned()];
    let mut listings = HashMap::new();
    while let Some(parent) = folders.pop() {
        if parent == destination {
            return Err("Choose a destination outside the source folder.".into());
        }
        let items = session.interrupt(drive.list(&parent)).await?;
        folders.extend(
            items
                .iter()
                .filter(|item| item.directory)
                .map(|item| item.id.clone()),
        );
        listings.insert(parent, items);
    }
    let root = drive.create_folder(destination, name).await?;
    let result = async {
        let mut pending = vec![(item.to_owned(), root.clone())];
        while let Some((source, destination)) = pending.pop() {
            session.ensure_running().map_err(message)?;
            for child in listings.remove(&source).unwrap_or_default() {
                if child.directory {
                    let folder = drive.create_folder(&destination, &child.name).await?;
                    pending.push((child.id, folder));
                } else {
                    session
                        .interrupt(drive.copy_item(&child.id, &destination, &child.name))
                        .await?;
                }
            }
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = drive.trash(&root).await;
    }
    result
}

pub(super) fn drive_local_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
            {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let name = name.trim_end_matches([' ', '.']);
    if local::name_component(name).is_ok() {
        name.to_owned()
    } else {
        format!("_{name}")
    }
}

pub(super) async fn download_drive_tree(
    drive: &crate::google_drive::TransferDrive,
    item: &str,
    target: &Path,
    session: &TransferSession,
    local: bool,
    mut progress: impl FnMut(&Path, u64, Option<u64>) -> io::Result<()>,
) -> Result<bool> {
    let mut references = false;
    let mut pending = vec![(item.to_owned(), target.to_owned())];
    fs::create_dir(target).map_err(message)?;
    while let Some((item, folder)) = pending.pop() {
        session.ensure_running().map_err(message)?;
        let children = session.interrupt(drive.list(&item)).await?;
        for child in children {
            let prepared = if local && !child.directory {
                Some(
                    session
                        .interrupt(drive.prepare_local_file(&child.id))
                        .await?,
                )
            } else {
                None
            };
            let name = if local {
                drive_local_name(&child.name)
            } else {
                child.name
            };
            let name = prepared
                .as_ref()
                .map_or(name.clone(), |file| file.local_name(&name));
            let mut destination = folder.join(local::name_component(&name).map_err(message)?);
            if local && destination.try_exists().map_err(message)? {
                let original = destination.clone();
                let stem = original.file_stem().unwrap_or_default().to_string_lossy();
                let extension = original
                    .extension()
                    .map_or(String::new(), |ext| format!(".{}", ext.to_string_lossy()));
                for index in 2.. {
                    destination = folder.join(format!("{stem} ({index}){extension}"));
                    if !destination.try_exists().map_err(message)? {
                        break;
                    }
                }
            }
            if child.directory {
                fs::create_dir(&destination).map_err(message)?;
                pending.push((child.id, destination));
            } else if let Some(file) = prepared {
                references |= file.is_reference();
                session
                    .interrupt(file.write(&destination, |bytes, total| {
                        progress(&destination, bytes, total)
                    }))
                    .await?;
            } else {
                session
                    .interrupt(drive.download(&child.id, &destination, |bytes, total| {
                        progress(&destination, bytes, total)
                    }))
                    .await?;
            }
        }
    }
    Ok(references)
}

#[tokio::test]
async fn copies_google_drive_files_and_nested_folders_in_both_directions() {
    use axum::{
        body::Bytes,
        extract::{Path as RoutePath, Query, State as RouteState},
        http::{header, StatusCode},
        routing::{get, post},
        Json, Router,
    };
    use serde_json::{json, Value};

    #[derive(Default)]
    struct Uploaded {
        folders: Vec<(String, String)>,
        uploads: Vec<(String, String, Vec<u8>)>,
        trashed: Vec<String>,
    }
    #[derive(Clone)]
    struct Fixture {
        origin: String,
        uploaded: Arc<Mutex<Uploaded>>,
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = Fixture {
        origin: format!("http://{}", listener.local_addr().unwrap()),
        uploaded: Arc::new(Mutex::new(Uploaded::default())),
    };
    let metadata = |id: &str, name: &str, folder: bool| {
        json!({
            "id": id, "name": name, "mimeType": if folder { "application/vnd.google-apps.folder" } else { "text/plain" },
            "size": if folder { None } else { Some("5") },
            "version": "1",
            "capabilities": { "canDownload": !folder }
        })
    };
    let workspace_file = move |id: &str| {
        let mut data = metadata(
            id,
            if id == "google-doc" {
                "Document"
            } else {
                "Reference"
            },
            false,
        );
        data["size"] = Value::Null;
        data["mimeType"] = json!(if id == "google-doc" {
            "application/vnd.google-apps.document"
        } else {
            "application/vnd.google-apps.shortcut"
        });
        data
    };
    let routes = Router::new()
        .route(
            "/drive/v3/files",
            get(
                move |Query(params): Query<HashMap<String, String>>| async move {
                    let parent = params["q"].split('\'').nth(1).unwrap();
                    let files = match parent {
                        "relay-target" => vec![],
                        "drive-folder" => vec![metadata("drive-subfolder", "nested", true)],
                        "drive-subfolder" => vec![metadata("drive-file", "test.txt", false)],
                        "partial-folder" => {
                            let mut unknown = metadata("google-doc", "Document", false);
                            unknown["size"] = Value::Null;
                            vec![metadata("drive-file", "test.txt", false), unknown]
                        }
                        "mixed-folder" => vec![
                            metadata("drive-file", "test.txt", false),
                            workspace_file("google-doc"),
                            workspace_file("drive-reference"),
                        ],
                        _ => panic!("Unexpected parent {parent}"),
                    };
                    Json(json!({ "files": files }))
                },
            )
            .post(
                |RouteState(state): RouteState<Fixture>, Json(data): Json<Value>| async move {
                    let mut uploaded = state.uploaded.lock().unwrap();
                    let id = format!("new-{}", uploaded.folders.len());
                    uploaded.folders.push((
                        data["parents"][0].as_str().unwrap().to_owned(),
                        data["name"].as_str().unwrap().to_owned(),
                    ));
                    Json(json!({ "id": id }))
                },
            ),
        )
        .route(
            "/drive/v3/files/{id}",
            get(
                move |RoutePath(id): RoutePath<String>,
                      Query(params): Query<HashMap<String, String>>| async move {
                    use axum::response::IntoResponse;
                    if params.contains_key("alt") {
                        assert_eq!(id, "drive-file");
                        return "abcde".into_response();
                    }
                    let data = if id == "drive-file" {
                        metadata(&id, "test.txt", false)
                    } else {
                        workspace_file(&id)
                    };
                    Json(data).into_response()
                },
            ).patch(|RouteState(state): RouteState<Fixture>, RoutePath(id): RoutePath<String>| async move {
                state.uploaded.lock().unwrap().trashed.push(id);
                StatusCode::NO_CONTENT
            }),
        )
        .route(
            "/drive/v3/files/google-doc/export",
            get(|Query(params): Query<HashMap<String, String>>| async move {
                assert_eq!(
                    params["mimeType"],
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                );
                "docx fixture"
            }),
        )
        .route(
            "/upload/drive/v3/files",
            post(
                |RouteState(state): RouteState<Fixture>, Json(data): Json<Value>| async move {
                    let mut uploaded = state.uploaded.lock().unwrap();
                    let id = uploaded.uploads.len();
                    uploaded.uploads.push((
                        data["parents"][0].as_str().unwrap().to_owned(),
                        data["name"].as_str().unwrap().to_owned(),
                        Vec::new(),
                    ));
                    (
                        StatusCode::OK,
                        [(
                            header::LOCATION,
                            format!("{}/upload/drive/v3/files?upload_id={id}", state.origin),
                        )],
                    )
                },
            )
            .put(
                |RouteState(state): RouteState<Fixture>,
                 Query(params): Query<HashMap<String, usize>>,
                 bytes: Bytes| async move {
                    state.uploaded.lock().unwrap().uploads[params["upload_id"]].2 = bytes.to_vec();
                    StatusCode::CREATED
                },
            ),
        )
        .with_state(fixture.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, routes).await.unwrap();
    });
    let drive = crate::google_drive::TransferDrive::fixture(&fixture.origin);
    assert_eq!(drive.folder_size("drive-folder").await.unwrap(), (5, false));
    assert_eq!(
        drive.folder_size("partial-folder").await.unwrap(),
        (5, true)
    );
    let workspace = tempfile::tempdir().unwrap();
    let dir = workspace.path();
    let session = TransferSession::default();
    let channel = Channel::new(|_| Ok(()));

    drive
        .download("drive-file", &dir.join("download.txt"), |_, _| Ok(()))
        .await
        .unwrap();
    assert_eq!(fs::read(dir.join("download.txt")).unwrap(), b"abcde");
    download_drive_tree(
        &drive,
        "drive-folder",
        &dir.join("downloaded-folder"),
        &session,
        false,
        |_, _, _| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read(dir.join("downloaded-folder/nested/test.txt")).unwrap(),
        b"abcde"
    );
    let mixed = dir.join("mixed");
    assert!(download_drive_tree(
        &drive,
        "mixed-folder",
        &mixed,
        &session,
        true,
        |_, _, _| Ok(())
    )
    .await
    .unwrap());
    assert_eq!(fs::read(mixed.join("test.txt")).unwrap(), b"abcde");
    assert_eq!(
        fs::read(mixed.join("Document.docx")).unwrap(),
        b"docx fixture"
    );
    assert_eq!(
        fs::read_to_string(mixed.join("Reference.url")).unwrap(),
        "[InternetShortcut]\r\nURL=https://drive.google.com/open?id=drive-reference\r\n"
    );

    drive
        .upload(&dir.join("download.txt"), "root", "uploaded.txt", |_, _| {
            Ok(())
        })
        .await
        .unwrap();
    let plan = DriveTargetPlan {
        name: "uploaded-folder".into(),
        replace: None,
    };
    let result = transfer_drive_folder(
        &drive,
        &dir.join("downloaded-folder"),
        "root",
        &plan,
        &session,
        &channel,
        false,
        "My Drive",
    )
    .await
    .unwrap();
    assert!(matches!(result, TransferOutcome::Completed));
    {
        let uploaded = fixture.uploaded.lock().unwrap();
        assert_eq!(
            uploaded.folders,
            [
                ("root".into(), "uploaded-folder".into()),
                ("new-0".into(), "nested".into())
            ]
        );
        assert_eq!(
            uploaded.uploads,
            [
                ("root".into(), "uploaded.txt".into(), b"abcde".to_vec()),
                ("new-1".into(), "test.txt".into(), b"abcde".to_vec())
            ]
        );
    }
    assert!(dir.join("downloaded-folder/nested/test.txt").is_file());
    if let Ok(engine) = crate::archive_engine::Engine::find() {
        use super::remote_provider_transfer::{Endpoint, Relay};
        use crate::{archive_engine, archives::Archive};
        let directory = dir.to_owned();
        tokio::task::spawn_blocking(move || {
            fs::create_dir(directory.join("inbox")).unwrap();
            let path = directory.join("relay.zip");
            let list = archive_engine::list_file(&directory, ["inbox"]).unwrap();
            let mut command = engine.command("a");
            command
                .current_dir(&directory)
                .arg("-tzip")
                .arg(archive_engine::at("-i@", &list));
            archive_engine::archive_args(&mut command, &path);
            archive_engine::run(&mut command, None, io::sink(), |_| Ok(()))
                .unwrap()
                .checked(false)
                .unwrap();
            let archive = Mutex::new(Archive::open(engine, path, None).unwrap());
            let transfer = Arc::new(TransferSession::default());
            let output = Channel::new(|_| Ok(()));
            let inbox = vec!["inbox".to_owned()];
            let name = "test.txt".to_owned();
            let mut request = TransferRequest {
                source: TransferSource::GoogleDrive {
                    profile: uuid::Uuid::nil(),
                    item: "drive-file".into(),
                    name: name.clone(),
                    parent: "root".into(),
                    folder: false,
                },
                destination: "relay.zip!/inbox".into(),
                ftp_destination: None,
                ssh_destination: None,
                server_destination: None,
                archive_destination: Some(ArchiveDestination {
                    id: 0,
                    segments: inbox.clone(),
                }),
                kswitcher_destination: None,
                google_drive_destination: None,
                kswitcher_broker: false,
                multiple: true,
                moving: false,
                policy: local_transfer::Policy::Skip,
                ask_read_only: true,
                retry: false,
                copy_options: Default::default(),
            };
            fn run(
                request: &TransferRequest,
                transfer: &Arc<TransferSession>,
                output: &Channel<TransferEvent>,
                source: Endpoint<'_>,
                segments: &[String],
                destination: Endpoint<'_>,
            ) -> TransferOutcome {
                Relay {
                    request,
                    transfer,
                    output,
                }
                .run(
                    source,
                    segments,
                    destination,
                    &mut |_, _, _| Ok(()),
                    &mut |_| Ok(local_transfer::Decision::Skip),
                )
                .unwrap()
            }
            assert!(matches!(
                run(
                    &request,
                    &transfer,
                    &output,
                    Endpoint::Drive(&drive),
                    std::slice::from_ref(&name),
                    Endpoint::Archive(&archive)
                ),
                TransferOutcome::Completed
            ));
            request.moving = true;
            assert!(matches!(
                run(
                    &request,
                    &transfer,
                    &output,
                    Endpoint::Drive(&drive),
                    std::slice::from_ref(&name),
                    Endpoint::Archive(&archive)
                ),
                TransferOutcome::Skipped
            ));
            assert!(fixture.uploaded.lock().unwrap().trashed.is_empty());

            let archive_item = vec!["inbox".to_owned(), name];
            request.source = TransferSource::Archive {
                archive: 0,
                segments: archive_item.clone(),
            };
            request.destination = "Google Drive/Relay".into();
            request.archive_destination = None;
            request.google_drive_destination = Some(GoogleDriveDestination {
                profile: uuid::Uuid::nil(),
                parent: "relay-target".into(),
            });
            assert!(matches!(
                run(
                    &request,
                    &transfer,
                    &output,
                    Endpoint::Archive(&archive),
                    &archive_item,
                    Endpoint::Drive(&drive)
                ),
                TransferOutcome::Completed
            ));
            assert!(archive
                .lock()
                .unwrap()
                .list(&inbox)
                .unwrap()
                .entries
                .is_empty());
            assert_eq!(
                fixture.uploaded.lock().unwrap().uploads.last(),
                Some(&("relay-target".into(), "test.txt".into(), b"abcde".to_vec()))
            );
        })
        .await
        .unwrap();
    }
    server.abort();
}
