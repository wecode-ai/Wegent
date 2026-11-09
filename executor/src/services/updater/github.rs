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
        let release = self.latest_platform_release().await?;
        let latest_version = release.platform_version()?.to_owned();
        if !compare_versions(current_version, &latest_version).is_lt() {
            return None;
        }
        // Registry package identities omit the Windows executable extension.
        let asset_name = if binary_name.starts_with("wegent-executor-windows-") {
            format!("{binary_name}.exe")
        } else {
            binary_name.to_owned()
        };
        let download_url = release
            .assets
            .into_iter()
            .find_map(|asset| (asset.name == asset_name).then_some(asset.browser_download_url))?;

        Some(UpdateInfo {
            version: latest_version,
            download_url,
            checksum: None,
        })
    }

    async fn latest_platform_release(&self) -> Option<GithubRelease> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("wegent-executor/", env!("CARGO_PKG_VERSION")))
            .build()
            .ok()?;
        let mut page = 1;
        loop {
            let url = format!(
                "{}/repos/{}/releases?per_page=100&page={page}",
                self.api_base.trim_end_matches('/'),
                self.github_repo
            );
            let mut request = client
                .get(url)
                .header("Accept", "application/vnd.github+json");
            if let Some(token) = self.github_token() {
                request = request.header("Authorization", format!("Bearer {token}"));
            }
            let response = request.send().await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            let releases = response.json::<Vec<GithubRelease>>().await.ok()?;
            let has_more = releases.len() == 100;
            if let Some(release) = releases
                .into_iter()
                .find(|release| release.platform_version().is_some())
            {
                return Some(release);
            }
            if !has_more {
                return None;
            }
            page += 1;
        }
    }
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

impl GithubRelease {
    fn platform_version(&self) -> Option<&str> {
        if self.draft || self.prerelease {
            return None;
        }
        let version = self.tag_name.strip_prefix('v').unwrap_or(&self.tag_name);
        let parts: Vec<_> = version.split('.').collect();
        (parts.len() == 3
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())))
        .then_some(version)
    }
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
}
