use std::{
    env, fs, io,
    io::ErrorKind,
    path::{Path, PathBuf},
};

fn main() {
    println!("cargo:rerun-if-env-changed=DIRLUME_BUILD_NUMBER");
    let mut version =
        env::var("CARGO_PKG_VERSION").expect("Cargo must provide the product version");
    if env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        bundle_release_highlights(&version);
        bundle_google_drive_oauth_client()
            .expect("Could not prepare the Google Drive OAuth client");
        panic_source_manifest().expect("Could not prepare the panic source manifest");
        if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
            bundle_portable_archive_engine()
                .expect("Could not bundle the Windows Portable archive engine");
        }
    }
    if let Ok(number) = std::env::var("DIRLUME_BUILD_NUMBER") {
        assert!(
            !number.starts_with('0')
                && !number.is_empty()
                && number.bytes().all(|byte| byte.is_ascii_digit()),
            "DIRLUME_BUILD_NUMBER must be a positive integer"
        );
        version.push('+');
        version.push_str(&number);
    }
    println!("cargo:rustc-env=DIRLUME_BUILD_VERSION={version}");
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::build();
    }
}

fn bundle_google_drive_oauth_client() -> io::Result<()> {
    println!("cargo:rerun-if-env-changed=DIRLUME_BUNDLE_GOOGLE_OAUTH_CLIENT");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must provide OUT_DIR"))
        .join("google-drive-oauth.json");
    if let Some(source) = env::var_os("DIRLUME_BUNDLE_GOOGLE_OAUTH_CLIENT") {
        let source = PathBuf::from(source);
        println!("cargo:rerun-if-changed={}", source.display());
        fs::copy(source, output)?;
    } else {
        fs::write(output, [])?;
    }
    Ok(())
}

fn bundle_portable_archive_engine() -> io::Result<()> {
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must provide OUT_DIR"));
    let source = Path::new("archive-tools");
    println!("cargo:rerun-if-changed={}", source.display());
    let names = ["7z.exe", "7z.dll", "7z.sfx"];
    let prepared = names.iter().all(|name| source.join(name).is_file());
    for name in names {
        if prepared {
            fs::copy(source.join(name), output.join(name))?;
        } else {
            fs::write(output.join(name), [])?;
        }
    }
    Ok(())
}

fn panic_source_manifest() -> io::Result<()> {
    fn collect(directory: &Path, output: &mut Vec<String>) -> io::Result<()> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                collect(&path, output)?;
            } else if file_type.is_file()
                && path.extension().is_some_and(|extension| extension == "rs")
            {
                output.push(path.to_string_lossy().replace('\\', "/"));
            }
        }
        Ok(())
    }
    println!("cargo:rerun-if-changed=src");
    let mut paths = Vec::new();
    collect(Path::new("src"), &mut paths)?;
    paths.sort_unstable();
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must provide OUT_DIR"));
    fs::write(output.join("panic-sources.txt"), paths.join("\n"))
}

fn bundle_release_highlights(version: &str) {
    let directory = PathBuf::from("../release-highlights");
    println!("cargo:rerun-if-changed={}", directory.display());
    println!("cargo:rerun-if-env-changed=DIRLUME_UPDATER_HIGHLIGHTS_FIXTURE");
    let source = if env::var_os("CARGO_FEATURE_UI_AUTOMATION").is_some() {
        env::var_os("DIRLUME_UPDATER_HIGHLIGHTS_FIXTURE").map(PathBuf::from)
    } else {
        None
    };
    let contents = if let Some(source) = source {
        println!("cargo:rerun-if-changed={}", source.display());
        fs::read(source).expect("Could not read the updater fixture highlights")
    } else {
        match fs::read(directory.join(format!("{version}.json"))) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => b"null".to_vec(),
            Err(error) => panic!("Could not read release highlights: {error}"),
        }
    };
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must provide OUT_DIR"));
    fs::write(output.join("release-highlights.json"), contents)
        .expect("Could not bundle release highlights");
}
