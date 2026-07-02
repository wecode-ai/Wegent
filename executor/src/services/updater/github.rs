// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde::Deserialize;

use super::{compare_versions, UpdateInfo};

const DEFAULT_GITHUB_REPO: &str = "wecode-ai/Wegent";
const DEFAULT_API_BASE: &str = "https://api.github.com";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubVersionChecker {
    github_token: Option<String>,
    github_repo: String,
    api_base: String,
}

impl GithubVersionChecker {
    pub fn new(github_token: Option<&str>) -> Self {
        Self::with_api_base(github_token, DEFAULT_GITHUB_REPO, DEFAULT_API_BASE)
    }

    pub fn with_api_base(
        github_token: Option<&str>,
        github_repo: impl Into<String>,
        api_base: impl Into<String>,
    ) -> Self {
        Self {
            github_token: github_token
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            github_repo: github_repo.into(),
            api_base: api_base.into(),
        }
    }

    pub fn github_token(&self) -> Option<&str> {
        self.github_token.as_deref()
    }

    pub async fn check_for_updates_for_binary(
        &self,
        current_version: &str,
        binary_name: &str,
    ) -> Option<UpdateInfo> {
        let url = format!(
            "{}/repos/{}/releases/latest",
            self.api_base.trim_end_matches('/'),
            self.github_repo
        );
        let mut request = reqwest::Client::new()
            .get(url)
            .header("Accept", "application/vnd.github+json");
        if let Some(token) = self.github_token() {
            request = request.header("Authorization", format!("Bearer {token}"));
        }

        let response = request.send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let release = response.json::<GithubRelease>().await.ok()?;
        let latest_version = release.tag_name.trim_start_matches('v').to_owned();
        let download_url = release
            .assets
            .into_iter()
            .find_map(|asset| (asset.name == binary_name).then_some(asset.browser_download_url))?;

        if compare_versions(current_version, &latest_version).is_lt() {
            Some(UpdateInfo {
                version: latest_version,
                download_url,
                checksum: None,
            })
        } else {
            None
        }
    }
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
}
