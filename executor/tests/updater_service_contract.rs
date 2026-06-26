// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use futures_util::future::BoxFuture;
use wegent_executor::{
    config::device::UpdateConfig,
    services::updater::{
        has_sufficient_update_space, parse_update_confirmation, BinaryInstaller, UpdateChecker,
        UpdateInfo, UpdateResult, UpdateRuntime, UpdaterService,
    },
};

#[test]
fn updater_service_initializes_with_config_and_auto_confirm() {
    let service = test_service(None, Ok(()), FakeRuntime::default(), true);

    assert!(service.auto_confirm());
    assert!(service.update_config().is_registry());
}

#[tokio::test]
async fn check_and_update_reports_already_latest_when_checker_returns_none() {
    let service = test_service(None, Ok(()), FakeRuntime::default(), false);

    let result = service.check_and_update().await;

    assert!(result.success);
    assert!(result.already_latest);
    assert_eq!(result.old_version.as_deref(), Some("1.0.0"));
}

#[tokio::test]
async fn check_and_update_installs_confirmed_update() {
    let runtime = FakeRuntime::default();
    let installer = FakeInstaller::new(Ok(()));
    let service = UpdaterService::with_components(
        registry_config(),
        FakeChecker::new(Some(update_info())),
        installer.clone(),
        runtime,
        false,
    );

    let result = service.check_and_update().await;

    assert!(result.success);
    assert!(!result.already_latest);
    assert_eq!(result.old_version.as_deref(), Some("1.0.0"));
    assert_eq!(result.new_version.as_deref(), Some("1.6.6"));
    assert_eq!(
        installer.calls.lock().unwrap().as_slice(),
        [InstallCall {
            download_url: "https://example.com/download".to_owned(),
            current_binary: PathBuf::from("/bin/wegent-executor"),
            auth_token: Some("registry-token".to_owned()),
        }]
    );
}

#[tokio::test]
async fn auto_confirm_skips_user_confirmation() {
    let runtime = FakeRuntime {
        confirm: false,
        ..FakeRuntime::default()
    };
    let confirm_calls = runtime.confirm_calls.clone();
    let service = test_service(Some(update_info()), Ok(()), runtime, true);

    let result = service.check_and_update().await;

    assert!(result.success);
    assert_eq!(confirm_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn user_decline_returns_cancelled_result_without_installing() {
    let runtime = FakeRuntime {
        confirm: false,
        ..FakeRuntime::default()
    };
    let installer = FakeInstaller::new(Ok(()));
    let service = UpdaterService::with_components(
        registry_config(),
        FakeChecker::new(Some(update_info())),
        installer.clone(),
        runtime,
        false,
    );

    let result = service.check_and_update().await;

    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Update cancelled by user"));
    assert!(installer.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn insufficient_disk_space_blocks_update_before_installing() {
    let runtime = FakeRuntime {
        enough_space: false,
        ..FakeRuntime::default()
    };
    let installer = FakeInstaller::new(Ok(()));
    let service = UpdaterService::with_components(
        registry_config(),
        FakeChecker::new(Some(update_info())),
        installer.clone(),
        runtime,
        true,
    );

    let result = service.check_and_update().await;

    assert!(!result.success);
    assert!(result.error.unwrap().contains("Insufficient disk space"));
    assert!(installer.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn install_error_is_returned_to_caller() {
    let service = test_service(
        Some(update_info()),
        Err("Network error".to_owned()),
        FakeRuntime::default(),
        true,
    );

    let result = service.check_and_update().await;

    assert!(!result.success);
    assert_eq!(result.error.as_deref(), Some("Network error"));
    assert_eq!(result.new_version.as_deref(), Some("1.6.6"));
}

#[test]
fn confirmation_parser_accepts_legacy_default_yes_semantics() {
    assert!(parse_update_confirmation(""));
    assert!(parse_update_confirmation("y"));
    assert!(parse_update_confirmation("Y"));
    assert!(parse_update_confirmation("yes"));
    assert!(!parse_update_confirmation("n"));
}

#[test]
fn disk_space_helper_uses_legacy_150mb_threshold() {
    assert!(has_sufficient_update_space(200 * 1024 * 1024));
    assert!(!has_sufficient_update_space(50 * 1024 * 1024));
}

#[test]
fn update_result_defaults_and_custom_values_match_old_dataclass() {
    let default = UpdateResult::default();
    assert!(!default.success);
    assert!(!default.already_latest);
    assert!(default.old_version.is_none());
    assert!(default.new_version.is_none());
    assert!(default.error.is_none());

    let custom = UpdateResult {
        success: true,
        already_latest: true,
        old_version: Some("1.0.0".to_owned()),
        new_version: Some("1.6.6".to_owned()),
        error: None,
    };
    assert!(custom.success);
    assert!(custom.already_latest);
    assert_eq!(custom.old_version.as_deref(), Some("1.0.0"));
    assert_eq!(custom.new_version.as_deref(), Some("1.6.6"));
}

#[derive(Clone)]
struct FakeChecker {
    update: Option<UpdateInfo>,
}

impl FakeChecker {
    fn new(update: Option<UpdateInfo>) -> Self {
        Self { update }
    }
}

impl UpdateChecker for FakeChecker {
    fn check_for_updates<'a>(
        &'a self,
        _current_version: &'a str,
    ) -> BoxFuture<'a, Option<UpdateInfo>> {
        Box::pin(async move { self.update.clone() })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InstallCall {
    download_url: String,
    current_binary: PathBuf,
    auth_token: Option<String>,
}

#[derive(Clone)]
struct FakeInstaller {
    result: Result<(), String>,
    calls: Arc<Mutex<Vec<InstallCall>>>,
}

impl FakeInstaller {
    fn new(result: Result<(), String>) -> Self {
        Self {
            result,
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl BinaryInstaller for FakeInstaller {
    fn install<'a>(
        &'a self,
        update: &'a UpdateInfo,
        current_binary: &'a Path,
        auth_token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(InstallCall {
                download_url: update.download_url.clone(),
                current_binary: current_binary.to_owned(),
                auth_token: auth_token.map(ToOwned::to_owned),
            });
            self.result.clone()
        })
    }
}

#[derive(Clone)]
struct FakeRuntime {
    version: String,
    current_binary: PathBuf,
    enough_space: bool,
    confirm: bool,
    confirm_calls: Arc<AtomicUsize>,
}

impl Default for FakeRuntime {
    fn default() -> Self {
        Self {
            version: "1.0.0".to_owned(),
            current_binary: PathBuf::from("/bin/wegent-executor"),
            enough_space: true,
            confirm: true,
            confirm_calls: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl UpdateRuntime for FakeRuntime {
    fn current_version(&self) -> String {
        self.version.clone()
    }

    fn current_binary_path(&self) -> PathBuf {
        self.current_binary.clone()
    }

    fn has_sufficient_disk_space(&self) -> bool {
        self.enough_space
    }

    fn confirm_update(&self) -> bool {
        self.confirm_calls.fetch_add(1, Ordering::SeqCst);
        self.confirm
    }
}

fn test_service(
    update: Option<UpdateInfo>,
    install_result: Result<(), String>,
    runtime: FakeRuntime,
    auto_confirm: bool,
) -> UpdaterService<FakeChecker, FakeInstaller, FakeRuntime> {
    UpdaterService::with_components(
        registry_config(),
        FakeChecker::new(update),
        FakeInstaller::new(install_result),
        runtime,
        auto_confirm,
    )
}

fn registry_config() -> UpdateConfig {
    UpdateConfig {
        registry: "https://example.com/ai-tool-box".to_owned(),
        registry_token: "registry-token".to_owned(),
    }
}

fn update_info() -> UpdateInfo {
    UpdateInfo {
        version: "1.6.6".to_owned(),
        download_url: "https://example.com/download".to_owned(),
        checksum: None,
    }
}
