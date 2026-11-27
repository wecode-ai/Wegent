//! Resolve authentication from the active installation, never retained caches.
use super::*;
use crate::{agents::CodexAppServerClient, local::plugin_cache::native_cache_segment};

pub(super) fn resolve_request(
    payload: &Value,
) -> futures_util::future::BoxFuture<'_, Result<(PathBuf, LocalAuthSpec), AppIpcError>> {
    // Erase the app-server startup/Runtime RPC future cycle, as tool discovery does.
    Box::pin(async move {
        let (plugin_key, marketplace) = request_identity(payload)?;
        if marketplace.is_none() {
            if let Some(explicit) =
                string_field(payload, "pluginRoot").or_else(|| string_field(payload, "plugin_root"))
            {
                return selected_auth(
                    &PathBuf::from(explicit),
                    &plugin_key,
                    payload,
                    "explicit_root",
                    None,
                );
            }
        }
        let client = CodexAppServerClient::new(crate::agents::resolve_codex_binary());
        let configuration = client
            .request("config/read", json!({"includeLayers": false}))
            .await
            .map_err(|_| unavailable("Cannot read the active Codex plugin installation"))?;
        resolve_registered_request(payload, &configuration, &crate::agents::wework_codex_home())
    })
}

fn request_identity(payload: &Value) -> Result<(String, Option<String>), AppIpcError> {
    let plugin_key = string_field(payload, "pluginKey")
        .or_else(|| string_field(payload, "plugin_key"))
        .filter(|key| native_cache_segment(key))
        .ok_or_else(|| AppIpcError::new("bad_request", "Invalid or missing pluginKey"))?;
    let marketplace = string_field(payload, "marketplaceId");
    if marketplace
        .as_ref()
        .is_some_and(|id| !native_cache_segment(id))
    {
        return Err(AppIpcError::new(
            "bad_request",
            "Invalid plugin marketplace identity",
        ));
    }
    Ok((plugin_key, marketplace))
}

pub(super) fn resolve_registered_request(
    payload: &Value,
    configuration: &Value,
    codex_home: &Path,
) -> Result<(PathBuf, LocalAuthSpec), AppIpcError> {
    let (plugin_key, marketplace) = request_identity(payload)?;
    let mut selected = None;
    for (id, entry) in configuration["config"]["plugins"]
        .as_object()
        .into_iter()
        .flatten()
    {
        let Some((name, market)) = id.rsplit_once('@') else {
            continue;
        };
        if name != plugin_key
            || !entry.is_object()
            || !native_cache_segment(market)
            || marketplace
                .as_ref()
                .is_some_and(|requested| market != requested)
        {
            continue;
        }
        let Some(root) = crate::local::plugin_cache::read_active_codex_plugin_root(
            codex_home,
            market,
            &plugin_key,
        )
        .map_err(|_| unavailable("Cannot read the active Codex plugin installation"))?
        else {
            continue;
        };
        if selected.replace((root, market)).is_some() {
            return Err(unavailable(
                "The plugin installation is ambiguous; select its marketplace",
            ));
        }
    }
    let (root, market) =
        selected.ok_or_else(|| unavailable("The requested plugin is not currently installed"))?;
    selected_auth(
        &root,
        &plugin_key,
        payload,
        "installed_configuration",
        Some(market),
    )
}

fn selected_auth(
    root: &Path,
    plugin_key: &str,
    payload: &Value,
    source: &str,
    marketplace: Option<&str>,
) -> Result<(PathBuf, LocalAuthSpec), AppIpcError> {
    let root = canonical_plugin_root(root)?;
    let result = (|| {
        let manifest = read_plugin_manifest(&root)?;
        if marketplace == Some("wework-personal")
            && !manifest["name"].as_str().is_some_and(|name| {
                crate::local::capabilities::personal_manifest_name_matches_slug(name, plugin_key)
            })
        {
            return Err(unavailable(
                "The installed plugin manifest identity does not match",
            ));
        }
        let slug = string_field(payload, "connectorSlug")
            .or_else(|| string_field(payload, "connector_slug"))
            .or_else(|| string_field(payload, "slug"));
        parse_local_auth_spec(&manifest, slug.as_deref())
    })();
    diagnostics::log_event(json!({
        "stage": "package_selection", "status": if result.is_ok() { "ok" } else { "failed" },
        "plugin": plugin_key, "root": root, "source": source,
        "marketplace": marketplace,
        "error_code": result.as_ref().err().map(|error| error.code.as_str()),
    }));
    result.map(|spec| (root, spec))
}

fn unavailable(message: &str) -> AppIpcError {
    AppIpcError::new("plugin_not_installed", message)
}
