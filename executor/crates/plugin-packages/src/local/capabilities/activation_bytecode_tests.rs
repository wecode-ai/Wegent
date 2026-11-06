//! Bytecode and file metadata activation contracts.
use super::*;

#[tokio::test]
async fn generated_python_bytecode_is_not_an_effective_plugin_change() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = python_packages(false);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        packages.clone(),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let paths = plugin_package_and_runtimes(&store);
    for path in &paths {
        let bytecode = path.join(BYTECODE_PATH);
        fs::create_dir_all(bytecode.parent().unwrap()).unwrap();
        fs::write(bytecode, "generated-bytecode").unwrap();
    }

    // Older shared links could also generate bytecode in the published source.
    // Verification removes it from the source; identical native runtimes retain
    // their generated caches without changing capability definitions.
    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, false).await;
    for (index, path) in paths.iter().enumerate() {
        assert_eq!(path.join(BYTECODE_PATH).exists(), index != 0);
        assert_eq!(
            fs::read_to_string(path.join("scripts/helper.py")).unwrap(),
            "VALUE = 1\n"
        );
    }
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn python_source_inside_bytecode_directories_remains_an_effective_change() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = python_packages(false);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        packages.clone(),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let paths = plugin_package_and_runtimes(&store);
    for path in &paths[1..] {
        let source = path.join("scripts/__pycache__/real.py");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(source, "VALUE = 'unexpected'\n").unwrap();
    }

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    for path in &paths[1..] {
        assert!(!path.join("scripts/__pycache__/real.py").exists());
    }
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_bytecode_symlink_remains_an_effective_plugin_change() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = python_packages(false);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        packages.clone(),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let paths = plugin_package_and_runtimes(&store);
    for path in &paths[1..] {
        let bytecode = path.join(BYTECODE_PATH);
        fs::create_dir_all(bytecode.parent().unwrap()).unwrap();
        symlink(path.join("scripts/helper.py"), bytecode).unwrap();
    }

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    for path in &paths[1..] {
        assert!(fs::symlink_metadata(path.join(BYTECODE_PATH)).is_err());
    }
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
}

#[tokio::test]
async fn published_python_bytecode_corruption_is_an_effective_plugin_change() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = python_packages(true);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        packages.clone(),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let paths = plugin_package_and_runtimes(&store);
    for path in &paths[1..] {
        fs::write(path.join(BYTECODE_PATH), "damaged-bytecode").unwrap();
    }

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    for path in &paths {
        assert_eq!(
            fs::read_to_string(path.join(BYTECODE_PATH)).unwrap(),
            "published-bytecode"
        );
    }
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn repairing_runtime_execute_bits_changes_capabilities() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = packages("v1");
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        packages.clone(),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let file = codex_runtime(&store).join("payload.txt");
    let original = fs::metadata(&file).unwrap().permissions().mode() & 0o111;
    let mut permissions = fs::metadata(&file).unwrap().permissions();
    permissions.set_mode(permissions.mode() ^ 0o100);
    fs::set_permissions(&file, permissions).unwrap();

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o111,
        original
    );
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn repairing_a_runtime_special_file_is_allowed_and_changes_capabilities() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = packages("v1");
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        packages.clone(),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let runtime = codex_runtime(&store);
    let fifo_path = runtime.join("unexpected.pipe");
    let c_path = CString::new(fifo_path.as_os_str().as_bytes()).unwrap();
    // The NUL-terminated path stays alive for this call and belongs to the fixture.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    assert!(!fifo_path.exists());
    assert_eq!(
        fs::read_to_string(runtime.join("payload.txt")).unwrap(),
        "v1"
    );
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
}
