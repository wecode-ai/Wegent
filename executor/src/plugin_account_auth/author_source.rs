//! Bind author credentials only when their current installed contract matches the release.
use super::{AuthError, PreparedPackage};
use serde_json::Value;
use std::path::Path;

pub(super) fn current_scope(
    connection: &crate::config::device::ConnectionConfig,
    native_user: Option<i64>,
) -> Option<Value> {
    use crate::local::plugin_import::PluginAccountScope;
    let profile_user = connection.authenticated_user_id.filter(|id| *id > 0);
    if profile_user
        .zip(native_user)
        .is_some_and(|(profile, native)| profile != native)
    {
        return None;
    }
    let scope =
        PluginAccountScope::new(&connection.backend_url, profile_user.or(native_user)?).ok()?;
    Some(serde_json::json!(scope))
}

pub(super) fn definition(root: &Path, slug: &str) -> Result<Value, AuthError> {
    let manifest = super::migration::read_package_json(
        &root.join(".codex-plugin/plugin.json"),
        "plugin_auth_package_sync_required",
    )?;
    let mut matches = manifest["connectors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|connector| connector["slug"] == slug);
    let connector = matches
        .next()
        .ok_or(AuthError("plugin_auth_definition_mismatch"))?;
    if matches.next().is_some() || !connector["accountAuth"].is_object() {
        return Err(AuthError("plugin_auth_definition_mismatch"));
    }
    Ok(connector["accountAuth"].clone())
}

pub(super) fn validate_current(
    manifest: &Path,
    codex_home: &Path,
    entry: &Value,
    package: &PreparedPackage,
    scope: Option<&Value>,
) -> Result<(), AuthError> {
    require_scope(entry, scope)?;
    let source =
        crate::local::capabilities::read_personal_author_source(manifest, codex_home, entry)
            .map_err(|_| AuthError("plugin_auth_invalid_package"))?
            .filter(|facts| facts["installed"] == true)
            .ok_or(AuthError("plugin_auth_package_sync_required"))?;
    let runtime = source["runtime_path"]
        .as_str()
        .ok_or(AuthError("plugin_auth_package_sync_required"))?;
    if definition(Path::new(runtime), &package.connector_slug)? != package.auth_definition {
        return Err(AuthError("plugin_auth_definition_mismatch"));
    }
    Ok(())
}

pub(super) fn require_scope(entry: &Value, scope: Option<&Value>) -> Result<(), AuthError> {
    use crate::local::plugin_import::PluginAccountScope;
    let normalize = |value: &Value| -> Result<PluginAccountScope, AuthError> {
        let value: PluginAccountScope = serde_json::from_value(value.clone())
            .map_err(|_| AuthError("plugin_auth_package_sync_required"))?;
        PluginAccountScope::new(value.backend_url, value.user_id)
            .map_err(|_| AuthError("plugin_auth_invalid_package"))
    };
    let current = normalize(scope.ok_or(AuthError("plugin_auth_package_sync_required"))?)?;
    if normalize(&entry["account_scope"])? != current {
        return Err(AuthError("plugin_auth_account_mismatch"));
    }
    Ok(())
}
