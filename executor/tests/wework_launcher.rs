// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Output},
    thread,
    time::{Duration, Instant},
};

const APP_ARGUMENTS: [&str; 4] = ["--exact", "fixture_app", "--ignored", "--nocapture"];

#[path = "wework_launcher/replacement.rs"]
mod replacement;

#[path = "wework_launcher/adoption.rs"]
mod adoption;

#[path = "wework_launcher/handoff.rs"]
mod handoff;

struct Installation {
    directory: tempfile::TempDir,
    root: PathBuf,
}

impl Installation {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("Wework update 空格 ")
            .tempdir()
            .unwrap();
        let root = directory.path().canonicalize().unwrap();
        fs::create_dir_all(root.join(".updates/staging")).unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_wework-launcher"),
            root.join("WeWork.exe"),
        )
        .unwrap();
        let installation = Self { directory, root };
        installation.release("versions/old", "0.5.12", "active");
        installation.write_state(json!({
            "schemaVersion":2,"active":{"version":"0.5.12","path":"versions/old"},
            "dataSchemaVersion":1
        }));
        fs::write(
            installation.root.join("user-data.db"),
            b"user data must survive",
        )
        .unwrap();
        installation
    }

    fn release(&self, relative: &str, version: &str, mode: &str) -> PathBuf {
        let path = self.root.join(relative);
        fs::create_dir_all(&path).unwrap();
        fs::copy(std::env::current_exe().unwrap(), path.join("WeWork.exe")).unwrap();
        fs::write(path.join("fixture-mode.txt"), mode).unwrap();
        fs::create_dir_all(path.join("resources")).unwrap();
        fs::write(
            path.join("resources/app.asar"),
            b"Native subprocess fixture; real Electron has separate E2E coverage",
        )
        .unwrap();
        let files: Vec<Value> = ["WeWork.exe", "fixture-mode.txt", "resources/app.asar"].iter().map(|name| {
            let bytes = fs::read(path.join(name)).unwrap();
            json!({"path":name,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes))})
        }).collect();
        write_json(
            &path.join("release.json"),
            &json!({
                "schemaVersion":2,"version":version,"platform":platform(),"arch":arch(),
                "dataSchemaVersion":1,"entryPoint":"WeWork.exe","files":files
            }),
        );
        path
    }

    fn command(&self) -> Command {
        let mut command = Command::new(self.root.join("WeWork.exe"));
        command.env_remove("WEWORK_LAUNCHER_FIXTURE_ROOT");
        command
    }

    fn apply_request(&self, candidate: &Path, parent_pid: u32) -> PathBuf {
        let path = self.root.join(".updates/request.json");
        write_json(
            &path,
            &json!({
                "schemaVersion":2,"installRoot":self.root,"candidatePath":candidate,
                "parentPid":parent_pid,"launchArgs":APP_ARGUMENTS,"healthTimeoutMs":10000
            }),
        );
        path
    }

    fn apply(&self, mode: &str) -> Output {
        let candidate = self.release(".updates/staging/new", "0.5.13", mode);
        let request = self.apply_request(&candidate, dead_parent());
        if mode == "hang" {
            let mut value = read_json(&request);
            value["healthTimeoutMs"] = json!(200);
            write_json(&request, &value);
        }
        self.command().arg("--apply").arg(request).output().unwrap()
    }

    fn state(&self) -> Value {
        read_json(&self.root.join("update-state.json"))
    }

    fn write_state(&self, state: Value) {
        write_json(&self.root.join("update-state.json"), &state);
    }

    fn starts(&self) -> Vec<Value> {
        let path = self.root.join(".updates/fixture-starts");
        fs::read_dir(path)
            .map(|entries| {
                entries
                    .map(|entry| read_json(&entry.unwrap().path()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn await_start(&self, mode: &str) -> Value {
        wait_until(|| {
            self.starts()
                .into_iter()
                .find(|start| start["mode"] == mode)
        })
    }

    fn await_event(&self, event: &str) {
        wait_until(|| {
            fs::read_to_string(self.root.join(".updates/launcher.log"))
                .ok()
                .filter(|log| log.lines().any(|line| read_line(line)["event"] == event))
        });
    }
}

impl Drop for Installation {
    fn drop(&mut self) {
        for start in self.starts() {
            if let Some(pid) = start["pid"].as_u64() {
                stop_fixture(pid as u32);
            }
        }
        let _ = self.directory.path();
    }
}

fn read_line(line: &str) -> Value {
    serde_json::from_str(line).unwrap()
}
fn read_json(path: &Path) -> Value {
    read_line(&fs::read_to_string(path).unwrap())
}
fn write_json(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn wait_until<T>(mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for launcher fixture"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn dead_parent() -> u32 {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "fixture_noop", "--ignored"])
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    assert!(child.wait().unwrap().success());
    pid
}

fn platform() -> &'static str {
    std::env::consts::OS
}
fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    }
}

#[test]
fn complete_release_is_committed_only_after_real_child_health_confirmation() {
    let installation = Installation::new();
    let output = installation.apply("healthy");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = installation.state();
    assert_eq!(state["active"]["version"], "0.5.13");
    assert_eq!(state["previous"]["version"], "0.5.12");
    assert!(state.get("candidate").is_none());
    let start = installation.await_start("healthy");
    assert_eq!(start["transactionId"].as_str().unwrap().len(), 36);
    assert_eq!(
        read_json(&installation.root.join(format!(
            ".updates/health/{}.json",
            start["transactionId"].as_str().unwrap()
        )))["schemaVersion"],
        2
    );
    assert_eq!(
        fs::read(installation.root.join("user-data.db")).unwrap(),
        b"user data must survive"
    );
    assert!(installation.root.join("versions/old/WeWork.exe").exists());
}

#[test]
fn crashed_candidate_is_stopped_and_last_good_version_reopens() {
    let installation = Installation::new();
    let output = installation.apply("crash");
    assert!(!output.status.success());
    assert_eq!(installation.state()["active"]["version"], "0.5.12");
    assert!(installation.state().get("candidate").is_none());
    installation.await_start("active");
    assert_eq!(
        fs::read(installation.root.join("user-data.db")).unwrap(),
        b"user data must survive"
    );
}

#[test]
fn unresponsive_candidate_times_out_and_old_version_remains_usable() {
    let installation = Installation::new();
    let output = installation.apply("hang");
    assert!(!output.status.success());
    installation.await_event("trial-stopped");
    installation.await_start("active");
    assert_eq!(installation.state()["active"]["version"], "0.5.12");
}

#[test]
fn incorrect_health_token_does_not_commit_candidate() {
    let installation = Installation::new();
    assert!(!installation.apply("wrong-token").status.success());
    installation.await_start("active");
    assert_eq!(installation.state()["active"]["version"], "0.5.12");
}

#[test]
fn corrupt_files_are_rejected_before_publishing_candidate() {
    let installation = Installation::new();
    let candidate = installation.release(".updates/staging/new", "0.5.13", "healthy");
    fs::write(candidate.join("fixture-mode.txt"), b"tampered").unwrap();
    let request = installation.apply_request(&candidate, dead_parent());
    let output = installation
        .command()
        .arg("--apply")
        .arg(request)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("checksum or size mismatch"));
    assert!(candidate.exists());
    installation.await_start("active");
    assert_eq!(
        fs::read_dir(installation.root.join("versions"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn files_outside_release_manifest_are_rejected() {
    let installation = Installation::new();
    let candidate = installation.release(".updates/staging/new", "0.5.13", "healthy");
    fs::write(candidate.join("unexpected.dll"), b"undeclared").unwrap();
    let request = installation.apply_request(&candidate, dead_parent());
    let output = installation
        .command()
        .arg("--apply")
        .arg(request)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("outside its manifest"));
}

#[test]
fn data_schema_changes_are_refused_without_running_new_app() {
    let installation = Installation::new();
    let candidate = installation.release(".updates/staging/new", "0.5.13", "healthy");
    let mut manifest = read_json(&candidate.join("release.json"));
    manifest["dataSchemaVersion"] = json!(2);
    write_json(&candidate.join("release.json"), &manifest);
    let request = installation.apply_request(&candidate, dead_parent());
    let output = installation
        .command()
        .arg("--apply")
        .arg(request)
        .output()
        .unwrap();
    assert!(!output.status.success());
    installation.await_start("active");
    assert!(!installation
        .starts()
        .iter()
        .any(|start| start["mode"] == "healthy"));
}

#[test]
fn platform_and_architecture_must_match_real_native_host() {
    for field in ["platform", "arch"] {
        let installation = Installation::new();
        let candidate = installation.release(".updates/staging/new", "0.5.13", "healthy");
        let mut manifest = read_json(&candidate.join("release.json"));
        manifest[field] = json!("incompatible");
        write_json(&candidate.join("release.json"), &manifest);
        let request = installation.apply_request(&candidate, dead_parent());
        assert!(!installation
            .command()
            .arg("--apply")
            .arg(request)
            .status()
            .unwrap()
            .success());
        installation.await_start("active");
    }
}

#[test]
fn previously_interrupted_trial_is_discarded_even_if_its_directory_is_missing() {
    let installation = Installation::new();
    let mut state = installation.state();
    state["candidate"] = json!({"version":"0.5.13","path":"versions/missing", "transactionId":uuid::Uuid::new_v4().to_string(),"attempted":true});
    installation.write_state(state);
    let output = installation.command().args(APP_ARGUMENTS).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    installation.await_start("active");
    assert!(installation.state().get("candidate").is_none());
}

#[test]
fn pending_unattempted_release_is_verified_and_confirmed_on_launch() {
    let installation = Installation::new();
    installation.release("versions/prepared", "0.5.13", "healthy");
    let mut state = installation.state();
    state["candidate"] = json!({"version":"0.5.13","path":"versions/prepared", "transactionId":uuid::Uuid::new_v4().to_string(),"attempted":false});
    installation.write_state(state);
    assert!(installation
        .command()
        .args(APP_ARGUMENTS)
        .status()
        .unwrap()
        .success());
    assert_eq!(installation.state()["active"]["version"], "0.5.13");
}

#[test]
fn parent_process_must_exit_before_candidate_is_moved_or_started() {
    let installation = Installation::new();
    let mut parent = helper(&installation, "fixture_parent");
    wait_until(|| {
        installation
            .root
            .join(".updates/parent-ready")
            .exists()
            .then_some(())
    });
    let candidate = installation.release(".updates/staging/new", "0.5.13", "healthy");
    let request = installation.apply_request(&candidate, parent.id());
    let mut launcher = installation
        .command()
        .arg("--apply")
        .arg(request)
        .spawn()
        .unwrap();
    installation.await_event("waiting-for-parent");
    assert!(launcher.try_wait().unwrap().is_none());
    assert!(candidate.exists());
    assert_eq!(installation.state()["active"]["version"], "0.5.12");
    fs::write(installation.root.join(".updates/release-parent"), b"exit").unwrap();
    assert!(parent.wait().unwrap().success());
    assert!(launcher.wait().unwrap().success());
    assert_eq!(installation.state()["active"]["version"], "0.5.13");
}

#[test]
fn launch_preserves_unicode_quotes_and_trailing_backslash_arguments() {
    let installation = Installation::new();
    let value = "空格 path \"quoted\" C:\\workspace\\";
    let output = installation
        .command()
        .args(APP_ARGUMENTS)
        .args(["--skip", value])
        .env("WEWORK_UPDATE_TRANSACTION_ID", "must-not-leak")
        .env("WEWORK_UPDATE_HEALTH_TOKEN", "must-not-leak")
        .output()
        .unwrap();
    assert!(output.status.success());
    let start = installation.await_start("active");
    assert_eq!(start["args"].as_array().unwrap().last().unwrap(), value);
    assert!(start["transactionId"].is_null());
}

#[test]
fn staging_path_with_parent_traversal_is_rejected() {
    let installation = Installation::new();
    installation.release(".updates/staging/new", "0.5.13", "healthy");
    let candidate = installation.root.join(".updates/staging/new/../new");
    let request = installation.apply_request(&candidate, dead_parent());
    let output = installation
        .command()
        .arg("--apply")
        .arg(request)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("without traversal"));
    installation.await_start("active");
}

#[test]
fn already_open_old_runtime_file_is_not_overwritten_by_new_release() {
    let installation = Installation::new();
    let old = installation.root.join("versions/old/fixture-mode.txt");
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Omit delete/write sharing to reproduce an old runtime file Windows cannot replace.
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    let _locked_old_file = options.open(&old).unwrap();
    let output = installation.apply("healthy");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::read_to_string(old).unwrap(), "active");
    assert_eq!(installation.state()["active"]["version"], "0.5.13");
}

#[test]
fn os_file_lock_serializes_launches_without_deleting_lock_identity() {
    let installation = Installation::new();
    let mut holder = helper(&installation, "fixture_lock");
    wait_until(|| {
        installation
            .root
            .join(".updates/lock-ready")
            .exists()
            .then_some(())
    });
    let mut launcher = installation.command().args(APP_ARGUMENTS).spawn().unwrap();
    thread::sleep(Duration::from_millis(100));
    assert!(launcher.try_wait().unwrap().is_none());
    assert!(installation.starts().is_empty());
    fs::write(installation.root.join(".updates/release-lock"), b"exit").unwrap();
    assert!(holder.wait().unwrap().success());
    assert!(launcher.wait().unwrap().success());
    installation.await_start("active");
    assert!(installation.root.join(".updates/update.lock").is_file());
}

#[cfg(unix)]
#[test]
fn symbolic_link_payload_is_rejected() {
    use std::os::unix::fs::symlink;
    let installation = Installation::new();
    let candidate = installation.release(".updates/staging/new", "0.5.13", "healthy");
    fs::remove_file(candidate.join("fixture-mode.txt")).unwrap();
    symlink(
        installation.root.join("user-data.db"),
        candidate.join("fixture-mode.txt"),
    )
    .unwrap();
    let request = installation.apply_request(&candidate, dead_parent());
    let output = installation
        .command()
        .arg("--apply")
        .arg(request)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Symbolic links"));
}

fn install_launcher_resource(installation: &Installation) -> PathBuf {
    let directory = installation.root.join("versions/old");
    fs::create_dir_all(directory.join("resources/bin")).unwrap();
    let source = directory.join("resources/bin/wework-launcher.exe");
    fs::copy(env!("CARGO_BIN_EXE_wework-launcher"), &source).unwrap();
    let bytes = fs::read(&source).unwrap();
    let mut manifest = read_json(&directory.join("release.json"));
    manifest["files"].as_array_mut().unwrap().push(json!({
        "path":"resources/bin/wework-launcher.exe","size":bytes.len(),
        "sha256":format!("{:x}",Sha256::digest(&bytes))
    }));
    write_json(&directory.join("release.json"), &manifest);
    source
}

fn replacement_request(installation: &Installation, parent: u32) -> PathBuf {
    let path = installation.root.join(".updates/launcher-replacement.json");
    write_json(
        &path,
        &json!({
            "schemaVersion":2,"installRoot":installation.root,
            "release":installation.state()["active"],"parentPid":parent
        }),
    );
    path
}

fn installer_seed(installation: &Installation, mode: &str) -> PathBuf {
    installation.release("versions/installer", "0.5.13", mode);
    let path = installation.root.join("initial-update-state.json");
    write_json(
        &path,
        &json!({
            "schemaVersion":2,"active":{"version":"0.5.13","path":"versions/installer"},
            "dataSchemaVersion":1
        }),
    );
    path
}

#[test]
fn installer_adoption_preserves_old_active_until_normal_launch_confirms_health() {
    let installation = Installation::new();
    let seed = installer_seed(&installation, "healthy");
    let output = installation
        .command()
        .arg("--adopt-install")
        .arg(seed)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = installation.state();
    assert_eq!(state["active"]["version"], "0.5.12");
    assert_eq!(state["candidate"]["version"], "0.5.13");
    assert_eq!(state["candidate"]["attempted"], false);
    assert!(installation.starts().is_empty());
    assert!(installation
        .command()
        .args(APP_ARGUMENTS)
        .status()
        .unwrap()
        .success());
    assert_eq!(installation.state()["active"]["version"], "0.5.13");
    assert_eq!(installation.state()["previous"]["version"], "0.5.12");
}

#[test]
fn installer_adoption_new_app_crash_reopens_preserved_old_version() {
    let installation = Installation::new();
    let seed = installer_seed(&installation, "crash");
    assert!(installation
        .command()
        .arg("--adopt-install")
        .arg(seed)
        .status()
        .unwrap()
        .success());
    assert!(installation
        .command()
        .args(APP_ARGUMENTS)
        .status()
        .unwrap()
        .success());
    installation.await_start("active");
    assert_eq!(installation.state()["active"]["version"], "0.5.12");
    assert!(installation.state().get("candidate").is_none());
    assert_eq!(
        fs::read(installation.root.join("user-data.db")).unwrap(),
        b"user data must survive"
    );
}

#[test]
fn same_release_reinstallation_preserves_live_state() {
    let installation = Installation::new();
    installation.release("versions/previous", "0.5.11", "active");
    let mut previous = installation.state();
    previous["previous"] = json!({"version":"0.5.11","path":"versions/previous"});
    installation.write_state(previous.clone());
    let path = installation.root.join("initial-update-state.json");
    let mut seed = previous.clone();
    seed.as_object_mut().unwrap().remove("previous");
    write_json(&path, &seed);
    assert!(installation
        .command()
        .arg("--adopt-install")
        .arg(&path)
        .status()
        .unwrap()
        .success());
    assert_eq!(installation.state(), previous);
    assert!(installation.starts().is_empty());
}

#[test]
fn installer_adoption_rejects_unknown_schema_and_paths_outside_installation() {
    for invalid in ["schemaVersion", "dataSchemaVersion", "path"] {
        let installation = Installation::new();
        let path = installer_seed(&installation, "healthy");
        let mut previous = read_json(&path);
        if invalid == "path" {
            previous["active"]["path"] = json!("../outside");
        } else {
            previous[invalid] = json!(99);
        }
        write_json(&path, &previous);
        let seeded = installation.state();
        let output = installation
            .command()
            .arg("--adopt-install")
            .arg(&path)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(installation.state(), seeded);
        assert!(installation.starts().is_empty());
    }
}

#[test]
fn interrupted_or_invalid_installer_seed_never_replaces_live_state() {
    for broken in ["missing", "partial", "json"] {
        let installation = Installation::new();
        let live = installation.state();
        let path = installer_seed(&installation, "healthy");
        if broken == "missing" {
            fs::remove_dir_all(installation.root.join("versions/installer")).unwrap();
        } else if broken == "partial" {
            fs::remove_file(
                installation
                    .root
                    .join("versions/installer/fixture-mode.txt"),
            )
            .unwrap();
        } else {
            fs::write(&path, b"{partial json").unwrap();
        }
        let output = installation
            .command()
            .arg("--adopt-install")
            .arg(&path)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(installation.state(), live);
        // Simulate terminating the installer before adoption: ordinary launch ignores the seed.
        assert!(installation
            .command()
            .args(APP_ARGUMENTS)
            .status()
            .unwrap()
            .success());
        installation.await_start("active");
        assert_eq!(installation.state(), live);
    }
}

#[test]
fn first_install_initializes_live_state_only_from_complete_verified_seed() {
    for use_adoption in [false, true] {
        let installation = Installation::new();
        let path = installer_seed(&installation, "active");
        fs::remove_file(installation.root.join("update-state.json")).unwrap();
        let mut command = installation.command();
        if use_adoption {
            command.arg("--adopt-install").arg(&path);
        } else {
            command.args(APP_ARGUMENTS);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(installation.state()["active"]["version"], "0.5.13");
        assert!(installation.state().get("candidate").is_none());
        if use_adoption {
            assert!(installation.starts().is_empty());
        } else {
            installation.await_start("active");
        }
    }
}

#[test]
fn launcher_atomically_replaces_itself_from_verified_committed_release() {
    let installation = Installation::new();
    let source = install_launcher_resource(&installation);
    fs::copy(
        std::env::current_exe().unwrap(),
        installation.root.join("WeWork.exe"),
    )
    .unwrap();
    let previous = fs::read(installation.root.join("WeWork.exe")).unwrap();
    let request = replacement_request(&installation, dead_parent());
    let output = Command::new(&source)
        .arg("--replace-launcher")
        .arg(request)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(installation.root.join("WeWork.exe")).unwrap(),
        fs::read(source).unwrap()
    );
    assert_eq!(
        fs::read(installation.root.join(".updates/launcher-previous.exe")).unwrap(),
        previous
    );
    assert!(installation
        .command()
        .args(APP_ARGUMENTS)
        .status()
        .unwrap()
        .success());
    installation.await_start("active");
    assert_eq!(installation.state()["active"]["version"], "0.5.12");
}

#[test]
fn launcher_replacement_rejects_corrupt_source_without_touching_root_entry() {
    let installation = Installation::new();
    let source = install_launcher_resource(&installation);
    let previous = fs::read(installation.root.join("WeWork.exe")).unwrap();
    let manifest_path = installation.root.join("versions/old/release.json");
    let mut manifest = read_json(&manifest_path);
    manifest["files"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["sha256"] = json!("0".repeat(64));
    write_json(&manifest_path, &manifest);
    let request = replacement_request(&installation, dead_parent());
    let output = Command::new(&source)
        .arg("--replace-launcher")
        .arg(request)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("checksum or size mismatch"));
    assert_eq!(
        fs::read(installation.root.join("WeWork.exe")).unwrap(),
        previous
    );
    assert!(installation
        .command()
        .args(APP_ARGUMENTS)
        .status()
        .unwrap()
        .success());
    installation.await_start("active");
}

#[test]
fn launcher_replacement_cannot_replace_root_until_parent_exits() {
    let installation = Installation::new();
    let source = install_launcher_resource(&installation);
    fs::copy(
        std::env::current_exe().unwrap(),
        installation.root.join("WeWork.exe"),
    )
    .unwrap();
    let previous = fs::read(installation.root.join("WeWork.exe")).unwrap();
    let mut parent = helper(&installation, "fixture_parent");
    wait_until(|| {
        installation
            .root
            .join(".updates/parent-ready")
            .exists()
            .then_some(())
    });
    let request = replacement_request(&installation, parent.id());
    let mut replacement = Command::new(source)
        .arg("--replace-launcher")
        .arg(request)
        .spawn()
        .unwrap();
    installation.await_event("launcher-replacement-waiting");
    assert!(replacement.try_wait().unwrap().is_none());
    assert_eq!(
        fs::read(installation.root.join("WeWork.exe")).unwrap(),
        previous
    );
    fs::write(installation.root.join(".updates/release-parent"), b"exit").unwrap();
    assert!(parent.wait().unwrap().success());
    assert!(replacement.wait().unwrap().success());
    assert!(installation
        .command()
        .args(APP_ARGUMENTS)
        .status()
        .unwrap()
        .success());
    installation.await_start("active");
}

#[cfg(windows)]
#[test]
fn killed_launcher_terminates_trial_tree_and_next_launch_recovers_old_release() {
    let installation = Installation::new();
    let candidate = installation.release(".updates/staging/new", "0.5.13", "hang");
    let request = installation.apply_request(&candidate, dead_parent());
    let mut launcher = installation
        .command()
        .arg("--apply")
        .arg(request)
        .spawn()
        .unwrap();
    let trial = installation.await_start("hang");
    assert_eq!(installation.state()["candidate"]["attempted"], true);
    launcher.kill().unwrap();
    launcher.wait().unwrap();
    wait_until(|| (!fixture_running(trial["pid"].as_u64().unwrap() as u32)).then_some(()));
    assert!(installation
        .command()
        .args(APP_ARGUMENTS)
        .status()
        .unwrap()
        .success());
    installation.await_start("active");
    assert_eq!(installation.state()["active"]["version"], "0.5.12");
    assert!(installation.state().get("candidate").is_none());
}

#[cfg(windows)]
fn fixture_running(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let running = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        running
    }
}

fn helper(installation: &Installation, test: &str) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--ignored"])
        .env("WEWORK_LAUNCHER_FIXTURE_ROOT", &installation.root)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

#[test]
#[ignore = "Subprocess fixture invoked explicitly by the integration tests"]
fn fixture_noop() {}

#[test]
#[ignore = "Subprocess fixture invoked explicitly by the integration tests"]
fn fixture_parent() {
    let root = PathBuf::from(std::env::var_os("WEWORK_LAUNCHER_FIXTURE_ROOT").unwrap());
    fs::write(root.join(".updates/parent-ready"), b"ready").unwrap();
    wait_until(|| root.join(".updates/release-parent").exists().then_some(()));
}

#[test]
#[ignore = "Subprocess fixture invoked explicitly by the integration tests"]
fn fixture_lock() {
    let root = PathBuf::from(std::env::var_os("WEWORK_LAUNCHER_FIXTURE_ROOT").unwrap());
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(".updates/update.lock"))
        .unwrap();
    file.lock_exclusive().unwrap();
    fs::write(root.join(".updates/lock-ready"), b"ready").unwrap();
    wait_until(|| root.join(".updates/release-lock").exists().then_some(()));
}

#[test]
#[ignore = "Real child application fixture, not an Electron E2E substitute"]
fn fixture_app() {
    let executable = std::env::current_exe().unwrap();
    let mode = fs::read_to_string(executable.parent().unwrap().join("fixture-mode.txt")).unwrap();
    let root = PathBuf::from(std::env::var_os("WEWORK_UPDATE_INSTALL_ROOT").unwrap());
    let transaction = std::env::var("WEWORK_UPDATE_TRANSACTION_ID").ok();
    fs::create_dir_all(root.join(".updates/fixture-starts")).unwrap();
    let record = root.join(format!(
        ".updates/fixture-starts/{}.json",
        uuid::Uuid::new_v4()
    ));
    let temporary_record = root.join(format!(".updates/start-{}.tmp", uuid::Uuid::new_v4()));
    write_json(
        &temporary_record,
        &json!({
            "pid":std::process::id(),"mode":mode,"transactionId":transaction,
            "args":std::env::args().skip(1).collect::<Vec<_>>()
        }),
    );
    fs::rename(temporary_record, record).unwrap();
    if mode == "crash" {
        std::process::exit(9);
    }
    if mode == "active" {
        return;
    }
    if mode != "hang" {
        let id = transaction.unwrap();
        let token = if mode == "wrong-token" {
            "wrong".to_owned()
        } else {
            std::env::var("WEWORK_UPDATE_HEALTH_TOKEN").unwrap()
        };
        let path = root.join(format!(".updates/health/{id}.json"));
        let temporary = path.with_extension("tmp");
        write_json(
            &temporary,
            &json!({"schemaVersion":2,"transactionId":id,"token":token}),
        );
        fs::rename(temporary, path).unwrap();
    }
    thread::sleep(Duration::from_secs(20));
}

#[cfg(unix)]
fn stop_fixture(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn stop_fixture(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}
