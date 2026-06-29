// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::cmp::Ordering;

use wegent_executor::services::updater::{binary_name_for, compare_versions, UpdateInfo};

#[test]
fn update_info_stores_version_url_and_checksum() {
    let info = UpdateInfo {
        version: "1.2.3".to_owned(),
        download_url: "https://example.com/wegent-executor".to_owned(),
        checksum: Some("sha256:abc".to_owned()),
    };

    assert_eq!(info.version, "1.2.3");
    assert_eq!(info.download_url, "https://example.com/wegent-executor");
    assert_eq!(info.checksum.as_deref(), Some("sha256:abc"));
}

#[test]
fn compare_versions_equal() {
    assert_eq!(compare_versions("1.2.3", "1.2.3"), Ordering::Equal);
}

#[test]
fn compare_versions_current_less_than_latest() {
    assert_eq!(compare_versions("1.2.3", "1.2.4"), Ordering::Less);
}

#[test]
fn compare_versions_current_greater_than_latest() {
    assert_eq!(compare_versions("1.2.4", "1.2.3"), Ordering::Greater);
}

#[test]
fn compare_versions_pads_shorter_versions() {
    assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Equal);
    assert_eq!(compare_versions("1.2", "1.2.1"), Ordering::Less);
}

#[test]
fn compare_versions_falls_back_for_non_numeric_versions() {
    assert_eq!(compare_versions("1.2.beta", "1.2.alpha"), Ordering::Greater);
    assert_eq!(compare_versions("1.2.rc1", "1.2.rc1"), Ordering::Equal);
}

#[test]
fn binary_name_maps_macos_arm64() {
    assert_eq!(
        binary_name_for("Darwin", "arm64"),
        "wegent-executor-macos-arm64"
    );
}

#[test]
fn binary_name_maps_macos_x86_64_to_amd64() {
    assert_eq!(
        binary_name_for("Darwin", "x86_64"),
        "wegent-executor-macos-amd64"
    );
}

#[test]
fn binary_name_maps_linux_arm64() {
    assert_eq!(
        binary_name_for("Linux", "arm64"),
        "wegent-executor-linux-arm64"
    );
}

#[test]
fn binary_name_maps_linux_x86_64_to_amd64() {
    assert_eq!(
        binary_name_for("Linux", "x86_64"),
        "wegent-executor-linux-amd64"
    );
}

#[test]
fn binary_name_maps_windows_amd64() {
    assert_eq!(
        binary_name_for("Windows", "AMD64"),
        "wegent-executor-windows-amd64"
    );
}
