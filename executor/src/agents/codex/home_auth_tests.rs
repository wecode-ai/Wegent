// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use super::*;
#[cfg(unix)]
use crate::agents::codex::{spawn_codex_app_server, CodexLaunchConfig, CodexTurnProcess};
use crate::agents::codex::{CodexAuthMode, EnvRestore};

#[test]
fn named_home_readers_share_ownership_without_migrating_live_writers_or_auth() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    fs::write(home.join("auth.json"), "synthetic-private-auth").unwrap();
    let first = auth::acquire_named_home(home).unwrap();
    let directory = home.join("thread-writer-locks");
    let writer =
        fs::File::create(directory.join("00000000-0000-4000-8000-000000000001.lock")).unwrap();
    fs2::FileExt::try_lock_exclusive(&writer).unwrap();
    let second = auth::acquire_named_home(home).unwrap();
    assert!(auth::prepare_provider_migration(home).is_err());
    assert_eq!(
        fs::read_to_string(home.join("auth.json")).unwrap(),
        "synthetic-private-auth"
    );
    assert!(!home.join("config.toml").exists());
    drop((first, second, writer));
    auth::prepare_provider_migration(home).unwrap();
}

#[tokio::test]
#[cfg(unix)]
#[allow(clippy::await_holding_lock)] // The fixture changes process-wide Home variables.
async fn standalone_router_launch_preserves_a_live_subscription_process_auth() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _native_home = EnvRestore::capture(CODEX_HOME_ENV);
    let _shared_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
    let native_home = root.path().join("native");
    let shared_home = root.path().join("shared");
    fs::create_dir_all(&native_home).unwrap();
    fs::write(native_home.join("auth.json"), br#"{"auth_mode":"chatgpt"}"#).unwrap();
    env::set_var(CODEX_HOME_ENV, &native_home);
    env::set_var(WEGENT_CODEX_HOME_ENV, &shared_home);
    let binary = root.path().join("idle-codex");
    fs::write(&binary, "#!/bin/sh\nexec sleep 60\n").unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    let launch = CodexLaunchConfig::default();
    let _subscription = CodexTurnProcess {
        child: spawn_codex_app_server(
            binary.to_str().unwrap(),
            &launch,
            Some(CodexAuthMode::LocalSubscription),
        )
        .unwrap(),
    };
    assert!(shared_home.join("auth.json").is_file());

    let router = spawn_codex_app_server(binary.to_str().unwrap(), &launch, None);
    let router = router.map(|child| CodexTurnProcess { child });

    assert!(
        shared_home.join("auth.json").is_file(),
        "a standalone router launch removed authentication used by a live subscription process"
    );
    assert!(
        router.is_ok(),
        "an unspecified mode must reuse the active authentication mode"
    );
}

#[test]
fn shared_auth_rejects_incompatible_mode_until_the_last_owner_releases() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _native_home = EnvRestore::capture(CODEX_HOME_ENV);
    let native_home = root.path().join("native");
    let shared_home = root.path().join("shared");
    fs::create_dir_all(&native_home).unwrap();
    fs::write(native_home.join("auth.json"), br#"{"auth_mode":"chatgpt"}"#).unwrap();
    env::set_var(CODEX_HOME_ENV, &native_home);
    let subscription = Some(CodexAuthMode::LocalSubscription);
    let router = Some(CodexAuthMode::WeworkRouter);
    let first = acquire_shared_auth(&shared_home, subscription).unwrap();
    let marker = shared_home.join(MANAGED_AUTH_MARKER);
    fs::write(&marker, b"owned by the first process").unwrap();

    let second = acquire_shared_auth(&shared_home, subscription).unwrap();
    assert_eq!(fs::read(&marker).unwrap(), b"owned by the first process");
    assert!(acquire_shared_auth(&shared_home, router).is_err());
    drop(first);
    assert!(acquire_shared_auth(&shared_home, router).is_err());
    assert!(shared_home.join("auth.json").is_file());
    drop(second);

    let _router = acquire_shared_auth(&shared_home, router).unwrap();
    assert!(!shared_home.join("auth.json").exists());
    assert!(native_home.join("auth.json").is_file());
}

#[test]
fn desktop_subscription_auth_recovers_after_router_degradation() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _codex_home = EnvRestore::capture(CODEX_HOME_ENV);
    let _native_home = EnvRestore::capture(WEGENT_NATIVE_CODEX_HOME_ENV);
    let native_home = root.path().join("native");
    let shared_home = root.path().join("shared");
    let native_auth = native_home.join("auth.json");
    let managed_auth = shared_home.join("auth.json");
    let marker = shared_home.join(MANAGED_AUTH_MARKER);
    fs::create_dir_all(&native_home).unwrap();
    fs::write(&native_auth, br#"{"auth_mode":"chatgpt"}"#).unwrap();
    env::set_var(CODEX_HOME_ENV, &native_home);
    env::set_var(WEGENT_NATIVE_CODEX_HOME_ENV, &native_home);
    let subscription = Some(CodexAuthMode::LocalSubscription);
    drop(acquire_shared_auth(&shared_home, subscription).unwrap());
    assert!(managed_auth.is_file());
    assert!(marker.is_file());

    // Electron imports native authentication before isolating the executor Home.
    env::set_var(CODEX_HOME_ENV, &shared_home);
    drop(acquire_shared_auth(&shared_home, Some(CodexAuthMode::WeworkRouter)).unwrap());
    assert!(!managed_auth.exists());
    assert!(!marker.exists());
    assert!(native_auth.is_file());

    let _official = acquire_shared_auth(&shared_home, subscription).unwrap();
    assert!(
        managed_auth.is_file(),
        "official authentication must be restored from the native Home after degradation"
    );
    assert!(marker.is_file());
    assert!(native_auth.is_file());
    #[cfg(unix)]
    assert_eq!(fs::read_link(&managed_auth).unwrap(), native_auth);
}

#[test]
fn unscoped_standalone_reuses_router_mode_and_official_auth_recovers_when_idle() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _native_home = EnvRestore::capture(CODEX_HOME_ENV);
    let native_home = root.path().join("native");
    let shared_home = root.path().join("shared");
    fs::create_dir_all(&native_home).unwrap();
    fs::write(native_home.join("auth.json"), br#"{"auth_mode":"chatgpt"}"#).unwrap();
    env::set_var(CODEX_HOME_ENV, &native_home);
    let subscription = Some(CodexAuthMode::LocalSubscription);
    let first = acquire_shared_auth(&shared_home, None).unwrap();
    let second = acquire_shared_auth(&shared_home, None).unwrap();
    assert!(!shared_home.join("auth.json").exists());
    let blocked = acquire_shared_auth(&shared_home, subscription).unwrap_err();
    assert!(blocked.contains("authentication mode is busy"));
    drop(first);
    drop(second);

    let _official = acquire_shared_auth(&shared_home, subscription).unwrap();
    assert!(shared_home.join("auth.json").is_file());
}

#[test]
#[cfg(unix)]
fn failed_spawn_releases_authentication_ownership() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _shared_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
    let _native_home = EnvRestore::capture(CODEX_HOME_ENV);
    let shared_home = root.path().join("shared");
    env::set_var(WEGENT_CODEX_HOME_ENV, &shared_home);
    env::set_var(CODEX_HOME_ENV, root.path().join("native"));
    let binary = root.path().join("not-executable");
    fs::write(&binary, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o644)).unwrap();

    assert!(spawn_codex_app_server(
        binary.to_str().unwrap(),
        &CodexLaunchConfig::default(),
        None
    )
    .is_err());

    let _official =
        acquire_shared_auth(&shared_home, Some(CodexAuthMode::LocalSubscription)).unwrap();
}

#[cfg(unix)]
#[tokio::test]
#[allow(clippy::await_holding_lock)] // The fixture changes process-wide Home variables.
async fn cancelled_startup_releases_auth_ownership_only_after_native_process_exit() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _shared_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
    let _native_home = EnvRestore::capture(CODEX_HOME_ENV);
    let shared_home = root.path().join("shared");
    env::set_var(WEGENT_CODEX_HOME_ENV, &shared_home);
    env::set_var(CODEX_HOME_ENV, root.path().join("native"));
    let binary = root.path().join("idle-codex");
    fs::write(&binary, "#!/bin/sh\nexec sleep 60\n").unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let startup = tokio::spawn(async move {
        let child = spawn_codex_app_server(
            binary.to_str().unwrap(),
            &CodexLaunchConfig::default(),
            None,
        )
        .unwrap();
        started_tx.send(child.id().unwrap()).unwrap();
        std::future::pending::<()>().await;
        drop(child);
    });
    let process_id = started_rx.await.unwrap() as libc::pid_t;

    startup.abort();
    assert!(startup.await.unwrap_err().is_cancelled());

    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            match acquire_shared_auth(&shared_home, Some(CodexAuthMode::LocalSubscription)) {
                Ok(_lease) => {
                    assert_eq!(
                        unsafe { libc::kill(process_id, 0) },
                        -1,
                        "authentication ownership was released while the old process was alive"
                    );
                    break;
                }
                Err(error) => {
                    assert!(error.contains("authentication mode is busy"), "{error}");
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            }
        }
    })
    .await
    .expect("cancelled startup must release authentication after its native process exits");
}
