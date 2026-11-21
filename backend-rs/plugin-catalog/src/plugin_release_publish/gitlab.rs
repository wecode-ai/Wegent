// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Protected-pipeline provenance verification
//! (`app.services.plugin_publication_gitlab_service.verify_release_provenance`
//! and `app.services.plugin_build_attestation`).
//!
//! A release is only authorized when the configured GitLab project's protected
//! branch ran a push pipeline for the exact commit, the pipeline's plugin tree
//! equals the uploaded source tree, and — for declaratively built plugins —
//! the pipeline's build artifact matches the uploaded package.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use super::artifact::{CanonicalPluginFile, canonical_source_tree_sha256_from_files};
use super::settings;

/// `MAX_BUILD_BYTES`
const MAX_BUILD_BYTES: usize = 50 * 1024 * 1024;

/// One release provenance tuple to verify.
pub(crate) struct ReleaseProvenance<'a> {
    pub project_id: &'a str,
    pub git_ref: &'a str,
    pub commit_sha: &'a str,
    pub pipeline_id: i64,
    pub pipeline_url: &'a str,
    pub slug: &'a str,
    pub artifact_tree_sha256: &'a str,
    pub build_artifact_sha256: &'a str,
    pub merge_request_iid: i64,
    pub source_branch: &'a str,
}

/// `PluginPublicationGitLabVerificationError` maps to `409`;
/// `PluginPublicationGitLabError` maps to `502`.
pub(crate) enum ProvenanceFailure {
    Verification(String),
    GitLab(String),
    Unexpected(String),
}

impl ProvenanceFailure {
    fn verification(message: impl Into<String>) -> Self {
        Self::Verification(message.into())
    }

    fn gitlab(message: impl Into<String>) -> Self {
        Self::GitLab(message.into())
    }
}

struct GitlabConfig {
    api_url: String,
    project_id: String,
    token: String,
    materializer_user_id: i64,
    target_branch: String,
    timeout: Duration,
    max_files: usize,
}

impl GitlabConfig {
    fn from_settings() -> Self {
        Self {
            api_url: settings::gitlab_api_url(),
            project_id: settings::gitlab_project_id(),
            token: settings::gitlab_token(),
            materializer_user_id: settings::gitlab_materializer_user_id(),
            target_branch: settings::gitlab_target_branch(),
            timeout: Duration::from_secs(settings::repository_read_timeout_seconds()),
            max_files: settings::gitlab_max_files(),
        }
    }

    /// `_ensure_configured`.
    fn ensure_configured(&self) -> Result<(), ProvenanceFailure> {
        if self.api_url.is_empty() || self.project_id.is_empty() || self.token.is_empty() {
            return Err(ProvenanceFailure::gitlab(
                "Plugin publication GitLab integration is not configured",
            ));
        }
        if self.materializer_user_id <= 0 {
            return Err(ProvenanceFailure::gitlab(
                "Plugin publication GitLab materializer identity is not configured",
            ));
        }
        if self.target_branch.is_empty() {
            return Err(ProvenanceFailure::gitlab(
                "Plugin publication target branch is not configured",
            ));
        }
        Ok(())
    }

    fn project_api(&self) -> String {
        format!("{}/projects/{}", self.api_url, quote(&self.project_id))
    }
}

/// `verify_release_provenance`.
pub(crate) async fn verify_release_provenance(
    provenance: ReleaseProvenance<'_>,
) -> Result<(), ProvenanceFailure> {
    let config = GitlabConfig::from_settings();
    config.ensure_configured()?;
    let normalized_ref = provenance
        .git_ref
        .strip_prefix("refs/heads/")
        .unwrap_or(provenance.git_ref);
    if provenance.project_id != config.project_id || normalized_ref != config.target_branch {
        return Err(ProvenanceFailure::verification(
            "Release provenance does not target the configured project branch",
        ));
    }
    let client = brz_http::Client::new();
    let branch = get_json(
        &client,
        &config,
        &format!("/repository/branches/{}", quote(&config.target_branch)),
        &[],
    )
    .await?;
    if branch.get("protected") != Some(&Value::Bool(true)) {
        return Err(ProvenanceFailure::verification(
            "Configured plugin release branch is not protected",
        ));
    }
    let pipeline = get_json(
        &client,
        &config,
        &format!("/pipelines/{}", provenance.pipeline_id),
        &[],
    )
    .await?;
    let pipeline_ref = pipeline["ref"].as_str().unwrap_or("");
    let pipeline_sha = pipeline["sha"].as_str().unwrap_or("").to_lowercase();
    let pipeline_source = pipeline["source"].as_str().unwrap_or("");
    let pipeline_status = pipeline["status"].as_str().unwrap_or("");
    if pipeline_ref != config.target_branch
        || pipeline_sha != provenance.commit_sha.to_lowercase()
        || pipeline_source != "push"
        || !matches!(pipeline_status, "running" | "success")
    {
        return Err(ProvenanceFailure::verification(
            "GitLab pipeline does not authorize this release provenance",
        ));
    }
    if pipeline["web_url"].as_str().unwrap_or("") != provenance.pipeline_url {
        return Err(ProvenanceFailure::verification(
            "GitLab pipeline URL does not match release provenance",
        ));
    }
    let repository_tree_sha256 =
        repository_plugin_tree_sha256(&client, &config, provenance.slug, provenance.commit_sha)
            .await?;
    if repository_tree_sha256 != provenance.artifact_tree_sha256 {
        return Err(ProvenanceFailure::verification(
            "Release artifact source tree does not match the GitLab commit",
        ));
    }
    if !provenance.build_artifact_sha256.is_empty() {
        verify_build_artifact(
            &client,
            &config,
            provenance.pipeline_id,
            provenance.commit_sha,
            provenance.build_artifact_sha256,
        )
        .await?;
    }
    if provenance.merge_request_iid != 0 {
        let merge_request = get_json(
            &client,
            &config,
            &format!("/merge_requests/{}", provenance.merge_request_iid),
            &[],
        )
        .await?;
        verify_merged_request(
            &merge_request,
            &config.target_branch,
            provenance.source_branch,
            provenance.commit_sha,
        )?;
    }
    Ok(())
}

/// `_verify_merged_request`.
fn verify_merged_request(
    merge_request: &Value,
    target_branch: &str,
    source_branch: &str,
    commit_sha: &str,
) -> Result<(), ProvenanceFailure> {
    let mut candidates = BTreeSet::new();
    for key in ["merge_commit_sha", "squash_commit_sha", "sha"] {
        let value = merge_request[key].as_str().unwrap_or("").to_lowercase();
        if !value.is_empty() {
            candidates.insert(value);
        }
    }
    if let Some(head) = merge_request["diff_refs"]["head_sha"].as_str() {
        let head = head.to_lowercase();
        if !head.is_empty() {
            candidates.insert(head);
        }
    }
    if merge_request["state"].as_str().unwrap_or("") != "merged"
        || merge_request["target_branch"].as_str().unwrap_or("") != target_branch
        || merge_request["source_branch"].as_str().unwrap_or("") != source_branch
        || !candidates.contains(&commit_sha.to_lowercase())
    {
        return Err(ProvenanceFailure::verification(
            "Controlled merge request does not authorize this release commit",
        ));
    }
    Ok(())
}

/// `_repository_plugin_tree_sha256`.
async fn repository_plugin_tree_sha256(
    client: &brz_http::Client,
    config: &GitlabConfig,
    slug: &str,
    commit_sha: &str,
) -> Result<String, ProvenanceFailure> {
    let root = format!("plugins/{slug}");
    let prefix = format!("{root}/");
    let mut files: BTreeMap<String, CanonicalPluginFile> = BTreeMap::new();
    let mut normalized_paths: BTreeSet<Vec<u8>> = BTreeSet::new();
    let mut page = 1;
    loop {
        let items = get_json(
            client,
            config,
            "/repository/tree",
            &[
                ("path", root.as_str()),
                ("ref", commit_sha),
                ("recursive", "true"),
                ("per_page", "100"),
                ("page", &page.to_string()),
            ],
        )
        .await?;
        let Some(items) = items.as_array() else {
            return Err(ProvenanceFailure::verification(
                "GitLab plugin tree response is invalid",
            ));
        };
        for item in items {
            let Some(item) = item.as_object() else {
                return Err(ProvenanceFailure::verification(
                    "GitLab plugin tree entry is invalid",
                ));
            };
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            if item_type == "tree" {
                continue;
            }
            if item_type != "blob" {
                return Err(ProvenanceFailure::verification(
                    "GitLab plugin tree contains a non-regular file",
                ));
            }
            let path = item.get("path").and_then(Value::as_str).unwrap_or_default();
            let Some(relative) = path.strip_prefix(&prefix) else {
                return Err(ProvenanceFailure::verification(
                    "GitLab plugin tree contains a path outside the plugin root",
                ));
            };
            let relative = relative.nfc().collect::<String>();
            let unsafe_path = relative.is_empty()
                || relative.starts_with('/')
                || relative.contains('\\')
                || relative.contains('\0')
                || relative
                    .split('/')
                    .any(|part| matches!(part, "" | "." | ".."));
            if unsafe_path {
                return Err(ProvenanceFailure::verification(
                    "GitLab plugin tree contains an unsafe source path",
                ));
            }
            let path_bytes = relative.as_bytes().to_vec();
            if !normalized_paths.insert(path_bytes) {
                return Err(ProvenanceFailure::verification(
                    "GitLab plugin source paths collide after normalization",
                ));
            }
            let mode = item.get("mode").and_then(Value::as_str).unwrap_or_default();
            if !matches!(mode, "100644" | "100755") {
                return Err(ProvenanceFailure::verification(
                    "GitLab plugin tree contains an unsupported file mode",
                ));
            }
            let blob_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            if blob_id.is_empty() {
                return Err(ProvenanceFailure::verification(
                    "GitLab plugin tree entry has no blob identity",
                ));
            }
            let blob = get_json(
                client,
                config,
                &format!("/repository/blobs/{}", quote(blob_id)),
                &[],
            )
            .await?;
            if blob.get("encoding").and_then(Value::as_str) != Some("base64") {
                return Err(ProvenanceFailure::verification(
                    "GitLab plugin blob has unsupported encoding",
                ));
            }
            let content = STANDARD
                .decode(
                    blob.get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                .map_err(|_| {
                    ProvenanceFailure::verification("GitLab plugin blob is not valid base64")
                })?;
            files.insert(
                relative,
                CanonicalPluginFile {
                    content,
                    mode: if mode == "100755" { 0o755 } else { 0o644 },
                },
            );
            if files.len() > config.max_files {
                return Err(ProvenanceFailure::verification(
                    "GitLab plugin tree exceeds the configured file limit",
                ));
            }
        }
        if items.len() < 100 {
            break;
        }
        page += 1;
    }
    if files.is_empty() {
        return Err(ProvenanceFailure::verification(
            "GitLab commit contains no plugin source files",
        ));
    }
    Ok(canonical_source_tree_sha256_from_files(&files))
}

/// `plugin_build_attestation.verify_build_artifact`.
async fn verify_build_artifact(
    client: &brz_http::Client,
    config: &GitlabConfig,
    pipeline_id: i64,
    commit_sha: &str,
    expected_sha256: &str,
) -> Result<(), ProvenanceFailure> {
    let mut jobs = Vec::new();
    for page in 1..=100 {
        let batch = get_json(
            client,
            config,
            &format!("/pipelines/{pipeline_id}/jobs"),
            &[
                ("per_page", "100"),
                ("page", &page.to_string()),
                ("include_retried", "false"),
            ],
        )
        .await?;
        let Some(batch) = batch.as_array() else {
            return Err(ProvenanceFailure::verification(
                "Invalid build job inventory",
            ));
        };
        jobs.extend(batch.iter().cloned());
        if batch.len() < 100 {
            break;
        }
        if page == 100 {
            return Err(ProvenanceFailure::verification(
                "Build job inventory is too large",
            ));
        }
    }
    let mut selected = BTreeMap::new();
    for name in ["package_plugin", "unit_linux"] {
        let matching = jobs
            .iter()
            .filter(|job| job["name"].as_str() == Some(name))
            .collect::<Vec<_>>();
        if matching.len() != 1 {
            return Err(ProvenanceFailure::verification(format!(
                "Missing unique {name} job"
            )));
        }
        let job = matching[0];
        let job_id = job["id"].as_i64();
        if job["status"].as_str() != Some("success")
            || job["pipeline"]["id"].as_i64() != Some(pipeline_id)
            || job["commit"]["id"].as_str().unwrap_or("").to_lowercase()
                != commit_sha.to_lowercase()
            || job_id.is_none_or(|job_id| job_id <= 0)
        {
            return Err(ProvenanceFailure::verification(format!(
                "{name} did not pass for the published commit and pipeline"
            )));
        }
        selected.insert(name, job_id.expect("checked above"));
    }
    let test_job_id = selected["unit_linux"];
    let receipt_url = format!(
        "{}/jobs/{test_job_id}/artifacts/.ci-artifacts/tested-plugin.sha256",
        config.project_api()
    );
    let receipt = get_bytes(client, config, &receipt_url, Duration::from_secs(30)).await?;
    if receipt != format!("{expected_sha256}\n").into_bytes() {
        return Err(ProvenanceFailure::verification(
            "Test job did not verify this build artifact",
        ));
    }
    let job_id = selected["package_plugin"];
    let artifact_url = format!(
        "{}/jobs/{job_id}/artifacts/.ci-artifacts/plugin.zip",
        config.project_api()
    );
    let artifact = get_bytes(client, config, &artifact_url, Duration::from_secs(120)).await?;
    let digest = wegent_storage::s3_signing::hex_sha256(&artifact);
    if artifact.is_empty() || digest != expected_sha256 {
        return Err(ProvenanceFailure::verification(
            "Published plugin differs from the successful GitLab build artifact",
        ));
    }
    Ok(())
}

/// `_request`: `GET <project API><path>` and decode JSON.
async fn get_json(
    client: &brz_http::Client,
    config: &GitlabConfig,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Value, ProvenanceFailure> {
    let url = request_url(&format!("{}{path}", config.project_api()), query)?;
    let response = client
        .get(&url)
        .map_err(|error| {
            ProvenanceFailure::gitlab(format!("GitLab request failed for GET {path}: {error}"))
        })?
        .header("PRIVATE-TOKEN", config.token.as_str())
        .header("Accept", "application/json")
        .timeout(config.timeout)
        .send()
        .await
        .map_err(|_| ProvenanceFailure::gitlab(format!("GitLab request failed for GET {path}")))?;
    if !response.status().is_success() {
        return Err(ProvenanceFailure::gitlab(format!(
            "GitLab request failed for GET {path}"
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| ProvenanceFailure::gitlab(format!("GitLab request failed for GET {path}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| ProvenanceFailure::Unexpected(format!("invalid GitLab JSON: {error}")))
}

/// A bounded artifact download that never forwards the GitLab token elsewhere.
async fn get_bytes(
    client: &brz_http::Client,
    config: &GitlabConfig,
    url: &str,
    timeout: Duration,
) -> Result<Vec<u8>, ProvenanceFailure> {
    let response = client
        .get(url)
        .map_err(|_| ProvenanceFailure::gitlab("Unable to verify the GitLab build artifact"))?
        .header("PRIVATE-TOKEN", config.token.as_str())
        .header("Accept", "application/json")
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| ProvenanceFailure::gitlab("Unable to verify the GitLab build artifact"))?;
    if !response.status().is_success() {
        return Err(ProvenanceFailure::gitlab(
            "Unable to verify the GitLab build artifact",
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BUILD_BYTES as u64)
    {
        return Err(ProvenanceFailure::verification(
            "Build artifact is too large",
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| ProvenanceFailure::gitlab("Unable to verify the GitLab build artifact"))?;
    if bytes.len() > MAX_BUILD_BYTES {
        return Err(ProvenanceFailure::verification(
            "Build artifact is too large",
        ));
    }
    Ok(bytes.to_vec())
}

fn request_url(base: &str, query: &[(&str, &str)]) -> Result<String, ProvenanceFailure> {
    if query.is_empty() {
        return Ok(base.to_owned());
    }
    let mut url = url::Url::parse(base)
        .map_err(|_| ProvenanceFailure::gitlab("GitLab request URL is invalid"))?;
    url.query_pairs_mut()
        .extend_pairs(query.iter().map(|(key, value)| (*key, *value)));
    Ok(url.to_string())
}

/// Python's `urllib.parse.quote(value, safe="")`.
fn quote(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_paths_are_percent_encoded_like_urllib() {
        assert_eq!(quote("42"), "42");
        assert_eq!(quote("group/plugin"), "group%2Fplugin");
    }

    #[test]
    fn merged_requests_require_the_controlled_branch_and_commit() {
        let merge_request = serde_json::json!({
            "state": "merged",
            "target_branch": "master",
            "source_branch": "wework/publication-12-r3",
            "squash_commit_sha": "A".repeat(40),
        });
        assert!(
            verify_merged_request(
                &merge_request,
                "master",
                "wework/publication-12-r3",
                &"a".repeat(40)
            )
            .is_ok()
        );
        assert!(verify_merged_request(&merge_request, "master", "other", &"a".repeat(40)).is_err());
    }
}
