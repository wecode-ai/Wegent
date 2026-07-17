// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    future::Future,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::atomic::{AtomicU64, Ordering},
};

use reqwest::Url;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::local::capabilities::{
    default_manifest_path, CapabilityPackageProvider, CapabilitySyncError, CapabilitySyncHandler,
    GlobalCapabilityReporter, GlobalCapabilityStore, ManagedCapabilityManifest, SkillSyncSpec,
};

use super::LocalBackendConfig;

static STAGING_COUNTER: AtomicU64 = AtomicU64::new(1);

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
        let home = home_dir();
        let codex_home = codex_home_dir(&home);
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
    let home = home_dir();
    let codex_home = codex_home_dir(&home);
    let store =
        GlobalCapabilityStore::new(default_manifest_path(), home.join(".claude").join("skills"))
            .with_codex_skills_dir(codex_home.join("skills"))
            .with_codex_plugins_dir(codex_home.join("plugins"));
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
        let mut request = self.client.get(url);
        let auth_token = self.auth_token.trim();
        if !auth_token.is_empty() {
            request = request.bearer_auth(auth_token);
        }
        let response = request.send().await.map_err(|error| {
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
        if !same_origin(&backend, &url) {
            return Err(CapabilitySyncError::invalid_payload(
                "Capability package URL must match backend origin",
            ));
        }
        Ok(url)
    }
}

impl CapabilityPackageProvider for HttpPackageProvider {
    fn stage_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
        target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            let package = self.get_bytes(&skill_download_path(spec)?).await?;
            extract_skill_zip(&package, target)
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

fn extract_skill_zip(package: &[u8], target: &Path) -> Result<(), CapabilitySyncError> {
    let mut archive = ZipArchive::new(Cursor::new(package))?;
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if file.is_dir() {
            continue;
        }
        let Some(path) = file.enclosed_name().map(Path::to_path_buf) else {
            continue;
        };
        if is_macos_metadata_path(&path) {
            continue;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        entries.push((path, bytes));
    }

    let skill_prefix = entries
        .iter()
        .filter(|(path, _)| path.ends_with("SKILL.md"))
        .map(|(path, _)| path.parent().map(Path::to_path_buf).unwrap_or_default())
        .min_by_key(|path| path.components().count())
        .ok_or_else(|| CapabilitySyncError::invalid_payload("Skill package is missing SKILL.md"))?;
    let temp_path = target.with_file_name(format!(
        ".{}.staged-{}-{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill"),
        std::process::id(),
        STAGING_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    remove_existing_path(&temp_path)?;
    fs::create_dir_all(&temp_path)?;

    let extraction = (|| -> Result<(), CapabilitySyncError> {
        for (path, bytes) in &entries {
            if !skill_prefix.as_os_str().is_empty() && !path.starts_with(&skill_prefix) {
                continue;
            }
            let relative = path.strip_prefix(&skill_prefix).unwrap_or(path);
            if relative.as_os_str().is_empty() {
                continue;
            }
            let output = temp_path.join(relative);
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(output, bytes)?;
        }
        if !temp_path.join("SKILL.md").is_file() {
            return Err(CapabilitySyncError::invalid_payload(
                "Skill package is missing SKILL.md",
            ));
        }
        Ok(())
    })();
    if let Err(error) = extraction {
        let _ = remove_existing_path(&temp_path);
        return Err(error);
    }

    remove_existing_path(target)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&temp_path, target)?;
    Ok(())
}

fn is_macos_metadata_path(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => value
            .to_str()
            .is_some_and(|value| value == "__MACOSX" || value.starts_with("._")),
        _ => false,
    })
}

fn remove_existing_path(path: &Path) -> Result<(), CapabilitySyncError> {
    if path.is_symlink() || path.is_file() {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    } else if path.is_dir() {
        match fs::remove_dir_all(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    } else {
        Ok(())
    }
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

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn codex_home_dir(home: &Path) -> PathBuf {
    env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn restore_env(key: &str, value: Option<std::ffi::OsString>) {
        if let Some(value) = value {
            env::set_var(key, value);
        } else {
            env::remove_var(key);
        }
    }

    #[test]
    fn codex_home_dir_prefers_codex_home_env() {
        let _lock = crate::test_env::lock();
        let old_codex_home = env::var_os("CODEX_HOME");
        let home = PathBuf::from("/tmp/user-home");
        let codex_home = PathBuf::from("/tmp/wework-codex-home");

        env::set_var("CODEX_HOME", &codex_home);

        assert_eq!(codex_home_dir(&home), codex_home);

        restore_env("CODEX_HOME", old_codex_home);
    }

    #[test]
    fn codex_home_dir_defaults_to_user_codex_home() {
        let _lock = crate::test_env::lock();
        let old_codex_home = env::var_os("CODEX_HOME");
        let home = PathBuf::from("/tmp/user-home");

        env::remove_var("CODEX_HOME");

        assert_eq!(codex_home_dir(&home), home.join(".codex"));

        restore_env("CODEX_HOME", old_codex_home);
    }
}
