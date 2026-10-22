// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
};

use reqwest::Url;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    agents::wework_codex_home,
    local::capabilities::{
        default_manifest_path, CapabilityPackageProvider, CapabilitySyncError,
        CapabilitySyncHandler, GlobalCapabilityReporter, GlobalCapabilityStore,
        ManagedCapabilityManifest, SkillSyncSpec,
    },
    services::workbench::stage_skill_archive,
};

use super::LocalBackendConfig;

pub trait CapabilityReportProvider: Send + Sync + 'static {
    fn build_report(&self) -> Value;
}

pub trait CapabilitySyncRpcHandler: Send + Sync + 'static {
    fn handle_sync_capabilities<'a>(
        &'a self,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>>;
}

pub(super) struct DefaultCapabilityReporter {
    reporter: GlobalCapabilityReporter,
}

impl DefaultCapabilityReporter {
    pub(super) fn new() -> Self {
        let codex_home = wework_codex_home();
        Self {
            reporter: GlobalCapabilityReporter::new(
                codex_home.join("skills"),
                codex_home.join("plugins"),
                ManagedCapabilityManifest::new(default_manifest_path()),
            ),
        }
    }
}

impl CapabilityReportProvider for DefaultCapabilityReporter {
    fn build_report(&self) -> Value {
        self.reporter
            .build_report(true)
            .unwrap_or_else(|_| empty_capability_report())
    }
}

impl<P> CapabilitySyncRpcHandler for CapabilitySyncHandler<P>
where
    P: CapabilityPackageProvider + Send + Sync + 'static,
{
    fn handle_sync_capabilities<'a>(
        &'a self,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>> {
        Box::pin(async move {
            self.apply_sync(payload).await.unwrap_or_else(|error| {
                json!({
                    "success": false,
                    "error": error.to_string(),
                })
            })
        })
    }
}

pub(super) fn default_capability_sync_handler(
    config: &LocalBackendConfig,
) -> CapabilitySyncHandler<HttpPackageProvider> {
    let codex_home = wework_codex_home();
    let claude_home = std::env::var_os("WEGENT_CLAUDE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            codex_home
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("claude")
        });
    let store = GlobalCapabilityStore::new(default_manifest_path(), claude_home.join("skills"))
        .with_plugins_dir(claude_home.join("plugins"))
        .with_codex_skills_dir(codex_home.join("skills"))
        .with_codex_plugins_dir(codex_home.join("plugins"))
        .with_shared_packages();
    CapabilitySyncHandler::with_package_provider(
        config.auth_token.clone(),
        store,
        HttpPackageProvider::new(config.backend_url.clone(), config.auth_token.clone()),
    )
}

#[derive(Clone)]
pub struct HttpPackageProvider {
    backend_url: String,
    auth_token: String,
    client: reqwest::Client,
}

impl HttpPackageProvider {
    pub fn new(backend_url: impl Into<String>, auth_token: impl Into<String>) -> Self {
        Self {
            backend_url: backend_url.into().trim_end_matches('/').to_owned(),
            auth_token: auth_token.into(),
            client: reqwest::Client::new(),
        }
    }

    async fn get_bytes(&self, path: &str) -> Result<Vec<u8>, CapabilitySyncError> {
        let url = self.resolve_backend_url(path)?;
        let backend = parse_url_with_trailing_slash(&self.backend_url)?;
        let should_send_backend_auth = same_origin(&backend, &url);
        let mut request = self.client.get(url);
        let auth_token = self.auth_token.trim();
        if should_send_backend_auth && !auth_token.is_empty() {
            request = request.bearer_auth(auth_token);
        }
        let response = request.send().await.map_err(|error| {
            let error = error.without_url();
            CapabilitySyncError::invalid_payload(format!(
                "Capability package download failed: {error}"
            ))
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(CapabilitySyncError::invalid_payload(format!(
                "Capability package download failed with HTTP {status}"
            )));
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| {
                CapabilitySyncError::invalid_payload(format!(
                    "Capability package read failed: {error}"
                ))
            })
    }

    fn resolve_backend_url(&self, path: &str) -> Result<Url, CapabilitySyncError> {
        let backend = parse_url_with_trailing_slash(&self.backend_url)?;
        let url = if path.starts_with("http://") || path.starts_with("https://") {
            Url::parse(path).map_err(|error| {
                CapabilitySyncError::invalid_payload(format!("Invalid capability URL: {error}"))
            })?
        } else {
            backend
                .join(path.trim_start_matches('/'))
                .map_err(|error| {
                    CapabilitySyncError::invalid_payload(format!(
                        "Invalid capability path: {error}"
                    ))
                })?
        };
        Ok(url)
    }
}

impl CapabilityPackageProvider for HttpPackageProvider {
    fn download_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move { self.get_bytes(&skill_download_path(spec)?).await })
    }

    fn stage_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
        target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            let package = self.get_bytes(&skill_download_path(spec)?).await?;
            stage_skill_archive(&package, target, spec.content_hash.as_deref())
                .map_err(CapabilitySyncError::invalid_payload)
        })
    }

    fn download_plugin<'a>(
        &'a self,
        download_path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move { self.get_bytes(download_path).await })
    }
}

fn parse_url_with_trailing_slash(value: &str) -> Result<Url, CapabilitySyncError> {
    let value = format!("{}/", value.trim_end_matches('/'));
    Url::parse(&value).map_err(|error| {
        CapabilitySyncError::invalid_payload(format!("Invalid backend URL: {error}"))
    })
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn skill_download_path(spec: &SkillSyncSpec) -> Result<String, CapabilitySyncError> {
    let mut url = Url::parse("http://wegent.local").map_err(|error| {
        CapabilitySyncError::invalid_payload(format!("Invalid skill download URL: {error}"))
    })?;
    url.set_path(&format!("/api/v1/kinds/skills/{}/download", spec.skill_id));
    url.query_pairs_mut()
        .append_pair("namespace", &spec.namespace);
    let mut path = url.path().to_owned();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    Ok(path)
}

fn empty_capability_report() -> Value {
    let details = json!({
        "skills": [],
        "plugins": [],
        "mcps": [],
    });
    json!({
        "revision": 0,
        "digest": canonical_digest(&details),
        "full": true,
        "skills": [],
        "plugins": [],
        "mcps": [],
        "last_sync_at": null,
    })
}

fn canonical_digest(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity("sha256:".len() + digest.len() * 2);
    output.push_str("sha256:");
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}
