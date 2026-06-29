// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryVersionChecker {
    registry_url: String,
    auth_token: Option<String>,
}

impl RegistryVersionChecker {
    pub fn new(registry_url: impl Into<String>, auth_token: Option<&str>) -> Self {
        Self {
            registry_url: registry_url.into(),
            auth_token: auth_token
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
        }
    }

    pub fn registry_url(&self) -> &str {
        &self.registry_url
    }

    pub fn auth_token(&self) -> Option<&str> {
        self.auth_token.as_deref()
    }

    pub fn build_api_url_for(&self, binary_name: &str) -> String {
        let base_url = self.registry_url.trim_end_matches('/');
        if base_url.ends_with("/update.json") || base_url.contains("wegent-executor-") {
            return base_url.to_owned();
        }
        format!("{base_url}/{binary_name}/update.json")
    }

    pub async fn check_for_updates_for_binary(
        &self,
        current_version: &str,
        binary_name: &str,
    ) -> Option<UpdateInfo> {
        let mut request = reqwest::Client::new().get(self.build_api_url_for(binary_name));
        if let Some(auth_token) = self.auth_token() {
            request = request.header("PRIVATE-TOKEN", auth_token);
        }
        let response = request.send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let update = response.json::<RegistryUpdateResponse>().await.ok()?;
        let version = update.version?;
        let download_url = update.url?;
        if compare_versions(current_version, &version).is_lt() {
            Some(UpdateInfo {
                version,
                download_url,
                checksum: update.checksum,
            })
        } else {
            None
        }
    }
}

#[derive(Debug, Deserialize)]
struct RegistryUpdateResponse {
    version: Option<String>,
    url: Option<String>,
    checksum: Option<String>,
}
use serde::Deserialize;

use super::{compare_versions, UpdateInfo};
