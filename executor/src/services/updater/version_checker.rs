// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
    pub checksum: Option<String>,
}

pub fn compare_versions(current: &str, latest: &str) -> Ordering {
    let current_parts = version_parts(current);
    let latest_parts = version_parts(latest);
    let max_len = current_parts.len().max(latest_parts.len());

    for index in 0..max_len {
        let current = current_parts.get(index).unwrap_or(&VersionPart::Number(0));
        let latest = latest_parts.get(index).unwrap_or(&VersionPart::Number(0));
        match current.cmp(latest) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }

    Ordering::Equal
}

pub fn binary_name_for(os: &str, arch: &str) -> String {
    format!(
        "wegent-executor-{}-{}",
        normalize_os(os),
        normalize_arch(arch)
    )
}

fn version_parts(version: &str) -> Vec<VersionPart> {
    version
        .trim()
        .trim_start_matches('v')
        .split(['.', '-', '_'])
        .map(|part| {
            part.parse::<u64>()
                .map(VersionPart::Number)
                .unwrap_or_else(|_| VersionPart::Text(part.to_owned()))
        })
        .collect()
}

fn normalize_os(os: &str) -> String {
    match os.trim().to_ascii_lowercase().as_str() {
        "darwin" | "macos" => "macos".to_owned(),
        "windows" => "windows".to_owned(),
        "linux" => "linux".to_owned(),
        "" => "unknown".to_owned(),
        value => value.to_owned(),
    }
}

fn normalize_arch(arch: &str) -> String {
    match arch.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" => "amd64".to_owned(),
        "aarch64" | "arm64" => "arm64".to_owned(),
        "" => "unknown".to_owned(),
        value => value.to_owned(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum VersionPart {
    Number(u64),
    Text(String),
}

impl Ord for VersionPart {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Number(left), Self::Number(right)) => left.cmp(right),
            (Self::Text(left), Self::Text(right)) => left.cmp(right),
            (Self::Number(_), Self::Text(_)) => Ordering::Greater,
            (Self::Text(_), Self::Number(_)) => Ordering::Less,
        }
    }
}

impl PartialOrd for VersionPart {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
