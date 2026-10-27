// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn revoked_or_changed_request_cannot_activate_when_desktop_eventually_exits() {
    for change in ["removed", "modified"] {
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
        let original = installation.state();
        let mut launcher = installation
            .command()
            .arg("--apply")
            .arg(&request)
            .spawn()
            .unwrap();
        installation.await_event("waiting-for-parent");
        if change == "removed" {
            fs::remove_file(&request).unwrap();
        } else {
            let mut changed = read_json(&request);
            changed["launchArgs"] = json!(["modified after handoff"]);
            write_json(&request, &changed);
        }
        // Even if cancellation could not terminate the waiting updater, a later normal quit
        // must not install a cancelled release or unexpectedly reopen the old application.
        fs::write(installation.root.join(".updates/release-parent"), b"exit").unwrap();
        assert!(parent.wait().unwrap().success());
        assert!(!launcher.wait().unwrap().success(), "{change}");
        assert_eq!(installation.state(), original);
        assert!(candidate.exists());
        assert!(installation.starts().is_empty());
        installation.await_event("update-cancelled");
    }
}
