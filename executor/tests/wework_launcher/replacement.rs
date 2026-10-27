// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn normal_launch_never_implicitly_replaces_native_from_old_active_resources() {
    let installation = Installation::new();
    let source = install_launcher_resource(&installation);
    fs::copy(std::env::current_exe().unwrap(), &source).unwrap();
    let bytes = fs::read(&source).unwrap();
    let manifest_path = installation.root.join("versions/old/release.json");
    let mut manifest = read_json(&manifest_path);
    let record = manifest["files"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap();
    record["size"] = json!(bytes.len());
    record["sha256"] = json!(format!("{:x}", Sha256::digest(&bytes)));
    write_json(&manifest_path, &manifest);
    let previous = fs::read(installation.root.join("WeWork.exe")).unwrap();
    assert!(installation
        .command()
        .args(APP_ARGUMENTS)
        .status()
        .unwrap()
        .success());
    installation.await_start("active");
    assert!(!installation
        .root
        .join(".updates/launcher-replacement.json")
        .exists());
    assert_eq!(
        fs::read(installation.root.join("WeWork.exe")).unwrap(),
        previous
    );
}

#[test]
fn corrupt_first_install_seed_cannot_create_live_state() {
    let installation = Installation::new();
    installer_seed(&installation, "active");
    fs::remove_file(installation.root.join("update-state.json")).unwrap();
    fs::remove_file(
        installation
            .root
            .join("versions/installer/fixture-mode.txt"),
    )
    .unwrap();
    let output = installation.command().args(APP_ARGUMENTS).output().unwrap();
    assert!(!output.status.success());
    assert!(!installation.root.join("update-state.json").exists());
    assert!(installation.starts().is_empty());
}

#[test]
fn native_boundary_rejects_windows_device_and_alias_paths() {
    for name in [
        "resources/CON.txt",
        "resources/lpt9",
        "resources/a?.dll",
        "resources/pipe|name",
    ] {
        let installation = Installation::new();
        let candidate = installation.release(".updates/staging/new", "0.5.13", "healthy");
        let path = candidate.join("release.json");
        let mut manifest = read_json(&path);
        manifest["files"][0]["path"] = json!(name);
        write_json(&path, &manifest);
        let request = installation.apply_request(&candidate, dead_parent());
        let output = installation
            .command()
            .arg("--apply")
            .arg(request)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("Invalid release path"));
        assert_eq!(installation.state()["active"]["version"], "0.5.12");
    }
}

#[test]
fn native_boundary_requires_complete_electron_payload_and_limits_manifest_count() {
    for excessive_count in [false, true] {
        let installation = Installation::new();
        let candidate = installation.release(".updates/staging/new", "0.5.13", "healthy");
        let path = candidate.join("release.json");
        let mut manifest = read_json(&path);
        if excessive_count {
            manifest["files"] = json!(vec![manifest["files"][0].clone(); 100_001]);
        } else {
            manifest["files"]
                .as_array_mut()
                .unwrap()
                .retain(|file| file["path"] != "resources/app.asar");
            fs::remove_file(candidate.join("resources/app.asar")).unwrap();
        }
        write_json(&path, &manifest);
        let request = installation.apply_request(&candidate, dead_parent());
        let output = installation
            .command()
            .arg("--apply")
            .arg(request)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(installation.state()["active"]["version"], "0.5.12");
    }
}

#[cfg(windows)]
#[test]
fn ordinary_drive_paths_and_extended_paths_identify_the_same_staging_directory() {
    let installation = Installation::new();
    let candidate = installation.release(".updates/staging/new", "0.5.13", "healthy");
    let ordinary = candidate.to_str().unwrap().strip_prefix("\\\\?\\").unwrap();
    let request = installation.apply_request(Path::new(ordinary), dead_parent());
    let output = installation
        .command()
        .arg("--apply")
        .arg(request)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(installation.state()["active"]["version"], "0.5.13");
}
