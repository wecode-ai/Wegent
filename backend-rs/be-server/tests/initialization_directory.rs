//! Prebuilt binaries must resolve local resources from their runtime directory.

use std::{fs, path::PathBuf, process::Command};

#[test]
fn resource_directory_child() {
    let Some(expected) = std::env::var_os("WEGENT_TEST_INIT_DIRECTORY") else {
        return;
    };
    let directory = wegent_backend_rs::initialization::resource_directory();
    assert_eq!(directory.canonicalize().unwrap(), PathBuf::from(expected));
    assert_eq!(
        fs::read_to_string(directory.join("marker.yaml")).unwrap(),
        "runtime resources"
    );
}

#[test]
fn prebuilt_initialization_uses_runtime_resources_and_preserves_explicit_overrides() {
    let root = std::env::temp_dir().join(format!(
        "wegent-init-directory-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for name in ["init_data", "custom"] {
        fs::create_dir_all(root.join(name)).unwrap();
        fs::write(root.join(name).join("marker.yaml"), "runtime resources").unwrap();
    }
    for (configured, expected) in [("missing", "init_data"), ("custom", "custom")] {
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "resource_directory_child", "--nocapture"])
            .current_dir(&root)
            .env("INIT_DATA_DIR", root.join(configured))
            .env(
                "WEGENT_TEST_INIT_DIRECTORY",
                root.join(expected).canonicalize().unwrap(),
            )
            .status()
            .unwrap();
        if !status.success() {
            fs::remove_dir_all(&root).unwrap();
            panic!("resource directory lookup failed for {configured}");
        }
    }
    fs::remove_dir_all(root).unwrap();
}
