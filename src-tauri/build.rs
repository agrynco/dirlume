fn main() {
    println!("cargo:rerun-if-env-changed=DIRLUME_BUILD_NUMBER");
    let mut version =
        std::env::var("CARGO_PKG_VERSION").expect("Cargo must provide the product version");
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
