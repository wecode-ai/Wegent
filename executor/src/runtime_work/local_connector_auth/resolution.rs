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
        let installed = client
            .request("plugin/installed", json!({"cwds": []}))
            .await
            .map_err(|_| unavailable("Cannot read the active Codex plugin installation"))?;
        resolve_installed_request(payload, &installed, &crate::agents::wework_codex_home())
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

pub(super) fn resolve_installed_request(
    payload: &Value,
    installed: &Value,
    codex_home: &Path,
) -> Result<(PathBuf, LocalAuthSpec), AppIpcError> {
    let (plugin_key, marketplace) = request_identity(payload)?;
    let marketplaces = installed["marketplaces"]
        .as_array()
        .ok_or_else(|| unavailable("Invalid Codex plugin installation inventory"))?;
    let mut matches = marketplaces
        .iter()
        .filter(|market| {
            marketplace
                .as_ref()
                .map_or(true, |id| market["name"] == *id)
        })
        .flat_map(|market| {
            market["plugins"]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |plugin| (market, plugin))
        })
        .filter(|(_, plugin)| plugin["name"] == plugin_key && plugin["installed"] == true);
    let (market, plugin) = matches
        .next()
        .ok_or_else(|| unavailable("The requested plugin is not currently installed"))?;
    if matches.next().is_some() {
        return Err(unavailable(
            "The plugin installation is ambiguous; select its marketplace",
        ));
    }
    let source = json!({"marketplaceId": market["name"]});
    let root = super::super::connection_cli::dependency_root(plugin, &source, codex_home)?;
    selected_auth(
        &root,
        &plugin_key,
        payload,
        "installed_inventory",
        market["name"].as_str(),
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
