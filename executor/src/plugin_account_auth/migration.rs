// SPDX-License-Identifier: Apache-2.0
//! Metadata-only migration entry point used by the native desktop host.

use super::{AuthError, ConnectionMetadata, NativeAdapter, NativeAuthGateway, OAuthOperation};
use crate::local::backend::LocalBackendTransport;
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedPackage {
    pub installed_plugin_id: u64,
    pub connector_slug: String,
    pub checksum: String,
    pub auth_definition: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnrollmentOperation {
    Export,
    Authorize,
    Transfer,
}

pub struct PreparedEnrollment {
    pub package: PreparedPackage,
    pub operation: EnrollmentOperation,
}

pub async fn migrate<T: LocalBackendTransport>(
    transport: T,
    executor_home: &Path,
    migration_id: &str,
) -> Result<ConnectionMetadata, AuthError> {
    if migration_id.len() != 64
        || !migration_id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(AuthError("plugin_auth_invalid_request"));
    }
    let gateway = NativeAuthGateway::new(transport);
    let prepared = gateway.prepare(migration_id).await?;
    let package = prepared.package;
    let root = resolve_managed_package(executor_home, &package)?;
    let adapter = NativeAdapter::load(&root, &package.connector_slug, &package.auth_definition)?;
    let interpreter = interpreter_for(&package.auth_definition)?;
    if matches!(prepared.operation, EnrollmentOperation::Transfer) {
        return finish_transfer(&gateway, &adapter, &interpreter, migration_id, &package).await;
    }
    let exclusive_export = adapter.requires_exclusive_transfer()
        && matches!(prepared.operation, EnrollmentOperation::Export);
    let exported = match prepared.operation {
        EnrollmentOperation::Export => {
            adapter
                .export(&interpreter, Duration::from_secs(40))
                .await?
        }
        EnrollmentOperation::Authorize => adapter
            .oauth_operation(
                &interpreter,
                OAuthOperation::Authorize,
                None,
                Duration::from_secs(240),
            )
            .await?
            .ok_or(AuthError("plugin_auth_invalid_response"))?,
        EnrollmentOperation::Transfer => unreachable!(),
    };
    if exclusive_export {
        gateway.stage_transfer(migration_id, exported).await?;
        return finish_transfer(&gateway, &adapter, &interpreter, migration_id, &package).await;
    }
    gateway.enroll(migration_id, exported).await
}

async fn finish_transfer<T: LocalBackendTransport>(
    gateway: &NativeAuthGateway<T>,
    adapter: &NativeAdapter,
    interpreter: &Path,
    migration_id: &str,
    expected: &PreparedPackage,
) -> Result<ConnectionMetadata, AuthError> {
    if let Some((package, credential)) = gateway.prepare_transfer(migration_id).await? {
        // The backend pins the same authoritative definition before every phase.
        if package.auth_definition != expected.auth_definition
            || package.checksum != expected.checksum
            || package.installed_plugin_id != expected.installed_plugin_id
            || package.connector_slug != expected.connector_slug
        {
            return Err(AuthError("plugin_auth_definition_mismatch"));
        }
        let detached = adapter
            .detach(
                interpreter,
                migration_id,
                credential,
                Duration::from_secs(40),
            )
            .await;
        if detached == Err(AuthError("plugin_auth_source_changed")) {
            gateway.abort_transfer(migration_id).await?;
        }
        detached?;
    }
    gateway.finish_transfer(migration_id).await
}

pub fn resolve_managed_package(
    executor_home: &Path,
    package: &PreparedPackage,
) -> Result<PathBuf, AuthError> {
    let capabilities = executor_home.join("capabilities");
    let manifest_path = capabilities.join("manifest.json");
    let metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|_| AuthError("plugin_auth_package_sync_required"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 8 * 1024 * 1024
    {
        return Err(AuthError("plugin_auth_invalid_package"));
    }
    let manifest: Value = serde_json::from_slice(
        &fs::read(manifest_path).map_err(|_| AuthError("plugin_auth_invalid_package"))?,
    )
    .map_err(|_| AuthError("plugin_auth_invalid_package"))?;
    let entries = manifest["plugins"]
        .as_object()
        .ok_or(AuthError("plugin_auth_invalid_package"))?;
    let matches: Vec<_> = entries
        .values()
        .filter(|entry| entry["installed_plugin_id"].as_u64() == Some(package.installed_plugin_id))
        .collect();
    if matches.len() != 1 {
        return Err(AuthError("plugin_auth_package_sync_required"));
    }
    let entry = matches[0];
    if entry["managed"] != true || entry["enabled"] != true || entry["checksum"] != package.checksum
    {
        return Err(AuthError("plugin_auth_package_sync_required"));
    }
    let path = PathBuf::from(
        entry["store_path"]
            .as_str()
            .ok_or(AuthError("plugin_auth_invalid_package"))?,
    );
    let root = if path.is_absolute() {
        path
    } else {
        capabilities.join(path)
    };
    let root = root
        .canonicalize()
        .map_err(|_| AuthError("plugin_auth_package_sync_required"))?;
    let store = capabilities
        .join("store/plugins")
        .canonicalize()
        .map_err(|_| AuthError("plugin_auth_package_sync_required"))?;
    if !root.starts_with(&store) || !root.is_dir() || root == store {
        return Err(AuthError("plugin_auth_invalid_package"));
    }
    Ok(root)
}

pub(super) fn interpreter_for(definition: &Value) -> Result<PathBuf, AuthError> {
    let adapter = definition["adapter"]
        .as_str()
        .ok_or(AuthError("plugin_auth_invalid_adapter"))?;
    let extension = Path::new(adapter)
        .extension()
        .and_then(|value| value.to_str());
    match extension {
        Some("py") => Ok(std::env::var_os("WEGENT_PYTHON_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "python" } else { "python3" }))),
        Some("mjs") => Ok(PathBuf::from("node")),
        Some("sh") if cfg!(unix) => Ok(PathBuf::from("sh")),
        // PowerShell needs invocation flags; unsupported runtimes fail explicitly.
        _ => Err(AuthError("plugin_auth_runtime_unsupported")),
    }
}
