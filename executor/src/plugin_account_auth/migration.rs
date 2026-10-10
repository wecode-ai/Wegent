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
    let manifest_path = manifest_path_for_home(executor_home);
    let shared_plugins = if is_current_executor_home(executor_home) {
        crate::services::workbench::workbench_root()
            .map_err(|_| AuthError("plugin_auth_invalid_package"))?
            .join("shared/plugins")
    } else {
        executor_home.join("workbench/shared/plugins")
    };
    resolve_managed_package_at(&manifest_path, &shared_plugins, package)
}

// Explicit homes are also used by isolated executor fixtures and enrollment callers.
// Only the current executor may consume process-wide path overrides.
fn is_current_executor_home(home: &Path) -> bool {
    let configured = crate::config::paths::executor_home();
    home == configured
        || matches!((home.canonicalize(), configured.canonicalize()), (Ok(left), Ok(right)) if left == right)
}

pub(super) fn manifest_path_for_home(home: &Path) -> PathBuf {
    if is_current_executor_home(home) {
        crate::local::capabilities::default_manifest_path()
    } else {
        home.join("capabilities/manifest.json")
    }
}

fn resolve_managed_package_at(
    manifest_path: &Path,
    shared_plugins: &Path,
    package: &PreparedPackage,
) -> Result<PathBuf, AuthError> {
    let capabilities = manifest_path
        .parent()
        .ok_or(AuthError("plugin_auth_invalid_package"))?;
    let metadata = fs::symlink_metadata(manifest_path)
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
    let store_path = entry["store_path"]
        .as_str()
        .ok_or(AuthError("plugin_auth_invalid_package"))?;
    capabilities
        .join(store_path)
        .canonicalize()
        .map_err(|_| AuthError("plugin_auth_package_sync_required"))?;
    crate::local::plugin_catalog::managed_plugin_root(capabilities, shared_plugins, entry)
        .map_err(|_| AuthError("plugin_auth_invalid_package"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(root: &Path) -> (PathBuf, PathBuf, PathBuf, PreparedPackage) {
        let capabilities = root.join("workbench/wework/test/capabilities");
        let shared = root.join("workbench/shared/plugins");
        let package_root = shared.join("a".repeat(64));
        fs::create_dir_all(&package_root).unwrap();
        fs::create_dir_all(&capabilities).unwrap();
        let package = PreparedPackage {
            installed_plugin_id: 42,
            connector_slug: "mail".into(),
            checksum: format!("sha256:{}", "a".repeat(64)),
            auth_definition: json!({}),
        };
        let manifest = capabilities.join("manifest.json");
        fs::write(
            &manifest,
            json!({"plugins":{"mail":{
                "installed_plugin_id":42,"managed":true,"enabled":true,
                "checksum":package.checksum,"store_path":package_root
            }}})
            .to_string(),
        )
        .unwrap();
        (manifest, shared, package_root, package)
    }

    #[test]
    fn enrollment_resolves_the_exact_shared_digest_from_relocated_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let (manifest, shared, root, mut package) = fixture(temp.path());
        assert_eq!(
            resolve_managed_package_at(&manifest, &shared, &package).unwrap(),
            root.canonicalize().unwrap()
        );
        package.checksum = format!("sha256:{}", "b".repeat(64));
        assert_eq!(
            resolve_managed_package_at(&manifest, &shared, &package),
            Err(AuthError("plugin_auth_package_sync_required"))
        );
        // Matching server and local metadata must not authorize a different hash directory.
        let mut data: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        data["plugins"]["mail"]["checksum"] = json!(package.checksum);
        fs::write(&manifest, data.to_string()).unwrap();
        assert_eq!(
            resolve_managed_package_at(&manifest, &shared, &package),
            Err(AuthError("plugin_auth_invalid_package"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn enrollment_accepts_legacy_capabilities_bridge_not_manifest_or_package_symlinks() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let (manifest, shared, root, package) = fixture(temp.path());
        let bridge = temp.path().join("legacy-capabilities");
        symlink(manifest.parent().unwrap(), &bridge).unwrap();
        assert!(
            resolve_managed_package_at(&bridge.join("manifest.json"), &shared, &package).is_ok()
        );
        let alias = temp.path().join("manifest.json");
        symlink(&manifest, &alias).unwrap();
        assert_eq!(
            resolve_managed_package_at(&alias, &shared, &package),
            Err(AuthError("plugin_auth_invalid_package"))
        );
        let outside = temp.path().join("outside");
        fs::rename(&root, &outside).unwrap();
        symlink(&outside, &root).unwrap();
        assert_eq!(
            resolve_managed_package_at(&manifest, &shared, &package),
            Err(AuthError("plugin_auth_invalid_package"))
        );
    }

    #[test]
    fn explicitly_supplied_home_keeps_its_manifest_isolated() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            manifest_path_for_home(temp.path()),
            temp.path().join("capabilities/manifest.json")
        );
    }

    #[test]
    fn missing_shared_package_still_requests_sync() {
        let temp = tempfile::tempdir().unwrap();
        let (manifest, shared, root, package) = fixture(temp.path());
        fs::remove_dir(&root).unwrap();
        assert_eq!(
            resolve_managed_package_at(&manifest, &shared, &package),
            Err(AuthError("plugin_auth_package_sync_required"))
        );
    }
}
