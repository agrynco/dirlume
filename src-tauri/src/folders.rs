use std::{
    collections::HashSet,
    fs, io,
    path::{Component, Path},
};

use serde::{Deserialize, Serialize};

use crate::{
    desktop::{blocking, message, Result},
    local,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    name: String,
    multiple: bool,
    link_type: LinkType,
    target: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LinkType {
    None,
    Junction,
    Symbolic,
}

#[derive(Default, Serialize)]
pub struct CreatedFolders {
    last: Option<String>,
    failure: Option<FailedFolder>,
}

#[derive(Serialize)]
struct FailedFolder {
    name: String,
    error: String,
}

#[tauri::command]
pub async fn create_folders(directory: String, request: Request) -> Result<CreatedFolders> {
    blocking(move || create_at(local::absolute(&directory).map_err(message)?, &request)).await
}

fn create_at(directory: &Path, request: &Request) -> Result<CreatedFolders> {
    let mut seen = HashSet::new();
    let names = parse_names(&request.name, request.multiple)?;
    let names = names
        .into_iter()
        .map(|name| {
            let component =
                local::name_component(name).map_err(|error| format!("{name}: {error}"))?;
            let key = if cfg!(windows) {
                name.to_lowercase()
            } else {
                name.to_owned()
            };
            if !seen.insert(key) {
                return Err("Folder names must be unique.".to_owned());
            }
            Ok((name, directory.join(component)))
        })
        .collect::<Result<Vec<_>>>()?;

    let target = match request.link_type {
        LinkType::None => None,
        LinkType::Junction if !cfg!(windows) => {
            return Err("Directory junctions are available on Windows.".to_owned())
        }
        LinkType::Junction | LinkType::Symbolic => {
            let path = Path::new(&request.target);
            if request.target.trim().is_empty()
                || (!path.is_absolute()
                    && (path.has_root()
                        || matches!(path.components().next(), Some(Component::Prefix(_)))))
            {
                return Err("Enter an absolute or relative folder path.".to_owned());
            }
            let target = directory.join(path).canonicalize().map_err(message)?;
            if !fs::metadata(&target).map_err(message)?.is_dir() {
                return Err("Choose a folder as the link target.".to_owned());
            }
            Some(target)
        }
    };

    let mut output = CreatedFolders::default();
    for (name, path) in names {
        let result = match &target {
            Some(target) => create_link(request.link_type, target, &path),
            None => fs::create_dir(path),
        };
        if let Err(error) = result {
            output.failure = Some(FailedFolder {
                name: name.to_owned(),
                error: message(error),
            });
            break;
        }
        output.last = Some(name.to_owned());
    }
    Ok(output)
}

fn parse_names(input: &str, multiple: bool) -> Result<Vec<&str>> {
    if !multiple {
        return Ok(vec![input]);
    }
    let malformed = || {
        "Separate folder names with commas or semicolons and put names with separators in double quotes.".to_owned()
    };
    let separators = [',', ';'];
    let mut remaining = input.trim();
    let mut names = Vec::new();
    loop {
        let (name, rest) = if let Some(quoted) = remaining.strip_prefix('"') {
            let (name, tail) = quoted.split_once('"').ok_or_else(malformed)?;
            (name, tail.trim_start())
        } else {
            let end = remaining.find(separators).unwrap_or(remaining.len());
            let name = remaining[..end].trim();
            if name.contains('"') {
                return Err(malformed());
            }
            (name, &remaining[end..])
        };
        if name.is_empty() {
            return Err(malformed());
        }
        names.push(name);
        if rest.is_empty() {
            return Ok(names);
        }
        remaining = rest
            .strip_prefix(separators)
            .ok_or_else(malformed)?
            .trim_start();
    }
}

fn create_link(link: LinkType, target: &Path, path: &Path) -> io::Result<()> {
    match link {
        #[cfg(windows)]
        LinkType::Junction => {
            let directory = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
            // The staging name is private. Publishing it cannot replace a destination.
            let staging = tempfile::tempdir_in(directory)?;
            let junction = staging.path().join("junction");
            junction::create(target, &junction)?;
            let result = renamest::rename_exclusive(&junction, path);
            if result.is_err() {
                let _ = fs::remove_dir(junction);
            }
            result
        }
        #[cfg(windows)]
        LinkType::Symbolic => std::os::windows::fs::symlink_dir(target, path),
        #[cfg(unix)]
        LinkType::Symbolic => std::os::unix::fs::symlink(target, path),
        _ => Err(io::ErrorKind::Unsupported.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_and_delimited_names_and_rejects_malformed_lists() {
        assert_eq!(parse_names("A,B", false).unwrap(), ["A,B"]);
        assert_eq!(
            parse_names(" A ; \"B,C\" ; \"D;E\", F ", true).unwrap(),
            ["A", "B,C", "D;E", "F"]
        );
        for bad in ["A;", "A,,B", "\"unfinished", "\"A\"B", "A,\"\""] {
            assert!(parse_names(bad, true).is_err(), "{bad}");
        }
    }

    #[test]
    fn validates_all_names_and_keeps_successes_on_a_filesystem_error() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("existing"), "original").unwrap();
        let mut request = Request {
            name: "duplicate; duplicate".to_owned(),
            multiple: true,
            link_type: LinkType::None,
            target: String::new(),
        };
        assert!(create_at(root, &request).is_err());
        assert!(!root.join("duplicate").exists());
        request.name = "first; existing; last".to_owned();
        let result = create_at(root, &request).unwrap();
        assert_eq!(result.last.as_deref(), Some("first"));
        assert_eq!(result.failure.unwrap().name, "existing");
        assert!(root.join("first").is_dir());
        assert!(!root.join("last").exists());
        assert_eq!(
            fs::read_to_string(root.join("existing")).unwrap(),
            "original"
        );
    }
}
