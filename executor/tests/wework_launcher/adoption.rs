// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn complete_installer_repairs_missing_or_corrupt_old_release_after_health_confirmation() {
    for damage in ["directory", "asar-missing", "asar-checksum"] {
        let installation = Installation::new();
        let seed = installer_seed(&installation, "healthy");
        let old = installation.root.join("versions/old");
        match damage {
            "directory" => fs::remove_dir_all(&old).unwrap(),
            "asar-missing" => fs::remove_file(old.join("resources/app.asar")).unwrap(),
            _ => fs::write(old.join("resources/app.asar"), b"antivirus damaged payload").unwrap(),
        }
        let original = installation.state();
        let output = installation
            .command()
            .arg("--adopt-install")
            .arg(seed)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{damage}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(installation.state()["active"], original["active"]);
        assert_eq!(installation.state()["candidate"]["attempted"], false);
        assert!(installation.starts().is_empty());
        installation.await_event("previous-installation-unavailable");
        let output = installation.command().args(APP_ARGUMENTS).output().unwrap();
        assert!(
            output.status.success(),
            "{damage}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(installation.state()["active"]["version"], "0.5.13");
        assert_eq!(installation.state()["previous"], original["active"]);
        assert!(installation.state().get("candidate").is_none());
        installation.await_start("healthy");
        assert_eq!(
            fs::read(installation.root.join("user-data.db")).unwrap(),
            b"user data must survive"
        );
    }
}

#[test]
fn failed_repair_trial_reports_unavailable_old_release_without_repeating_trial() {
    let installation = Installation::new();
    let seed = installer_seed(&installation, "crash");
    fs::remove_dir_all(installation.root.join("versions/old")).unwrap();
    let output = installation
        .command()
        .arg("--adopt-install")
        .arg(seed)
        .output()
        .unwrap();
    assert!(output.status.success());
    let output = installation.command().args(APP_ARGUMENTS).output().unwrap();
    assert!(!output.status.success());
    installation.await_event("trial-failed");
    installation.await_event("active-unavailable");
    assert_eq!(installation.starts().len(), 1);
    assert_eq!(installation.starts()[0]["mode"], "crash");
    assert_eq!(installation.state()["active"]["version"], "0.5.12");
    assert!(installation.state().get("candidate").is_none());
    assert!(!installation
        .command()
        .args(APP_ARGUMENTS)
        .status()
        .unwrap()
        .success());
    assert_eq!(installation.starts().len(), 1);
}

#[test]
fn failed_repair_trial_never_reports_corrupt_old_payload_as_successful_recovery() {
    for missing_asar in [false, true] {
        let installation = Installation::new();
        let seed = installer_seed(&installation, "crash");
        let asar = installation.root.join("versions/old/resources/app.asar");
        if missing_asar {
            fs::remove_file(asar).unwrap();
        } else {
            fs::write(asar, b"corrupted old archive").unwrap();
        }
        assert!(installation
            .command()
            .arg("--adopt-install")
            .arg(seed)
            .status()
            .unwrap()
            .success());
        let output = installation.command().args(APP_ARGUMENTS).output().unwrap();
        assert!(!output.status.success());
        installation.await_event("active-unavailable");
        assert_eq!(installation.starts().len(), 1);
        assert_eq!(installation.starts()[0]["mode"], "crash");
        let log = fs::read_to_string(installation.root.join(".updates/launcher.log")).unwrap();
        assert!(!log
            .lines()
            .any(|line| read_line(line)["event"] == "active-started"));
        assert!(installation.state().get("candidate").is_none());
    }
}

#[test]
fn repair_adoption_rejects_invalid_live_state_without_replacing_it() {
    for invalid in ["json", "schemaVersion", "dataSchemaVersion", "path"] {
        let installation = Installation::new();
        let seed = installer_seed(&installation, "healthy");
        let live = installation.root.join("update-state.json");
        if invalid == "json" {
            fs::write(&live, b"{unfinished state").unwrap();
        } else {
            let mut state = installation.state();
            if invalid == "path" {
                state["active"]["path"] = json!("versions/../outside");
            } else {
                state[invalid] = json!(99);
            }
            installation.write_state(state);
        }
        let original = fs::read(&live).unwrap();
        let output = installation
            .command()
            .arg("--adopt-install")
            .arg(seed)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{invalid}");
        assert_eq!(fs::read(&live).unwrap(), original);
        assert!(installation.starts().is_empty());
    }
}
