// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};

use crate::{
    agents::{wework_codex_home, CodexAppServerClient},
    connector_gateway::{
        clear_connector_gateway_config, persist_connector_gateway_config, ConnectorGatewayConfig,
    },
    connector_mcp::mcp_tools,
    local::app_ipc::AppIpcError,
    services::capability_activation,
};

use super::util::{now_ms, string_field};

const WEGENT_CONNECTOR_MCP_TOOL_APPROVAL_MODE: &str = "approve";

#[derive(Clone)]
pub(super) struct ConnectorRuntime {
    codex_app_server: CodexAppServerClient,
    codex_home: PathBuf,
    cloud: Arc<RwLock<Option<ConnectorGatewayConfig>>>,
    synced_apps: Arc<RwLock<Vec<Value>>>,
    mutation: Arc<Mutex<()>>,
    revision: Arc<AtomicU64>,
    sync_generation: Arc<AtomicU64>,
}

impl ConnectorRuntime {
    pub(super) fn new(codex_app_server: CodexAppServerClient) -> Self {
        Self {
            codex_app_server,
            codex_home: wework_codex_home(),
            cloud: Arc::new(RwLock::new(
                crate::connector_gateway::load_connector_gateway_config().ok(),
            )),
            synced_apps: Arc::new(RwLock::new(Vec::new())),
            mutation: Arc::new(Mutex::new(())),
            revision: Arc::new(AtomicU64::new(0)),
            sync_generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(super) async fn configure(&self, payload: Value) -> Result<Value, AppIpcError> {
        let api_base_url = string_field(&payload, "apiBaseUrl")
            .ok_or_else(|| AppIpcError::new("bad_request", "apiBaseUrl is required"))?;
        if !api_base_url.starts_with("http://") && !api_base_url.starts_with("https://") {
            return Err(AppIpcError::new(
                "bad_request",
                "apiBaseUrl must use http or https",
            ));
        }
        let connector_token = string_field(&payload, "connectorToken")
            .ok_or_else(|| AppIpcError::new("bad_request", "connectorToken is required"))?;
        let expires_at_ms = payload
            .get("expiresAtMs")
            .and_then(Value::as_i64)
            .ok_or_else(|| AppIpcError::new("bad_request", "expiresAtMs is required"))?;
        let sync_revision = payload
            .get("syncRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| AppIpcError::new("bad_request", "syncRevision is required"))?;
        if expires_at_ms <= now_ms() {
            return Err(AppIpcError::new(
                "connector_token_expired",
                "Connector token is already expired",
            ));
        }
        let next_config = ConnectorGatewayConfig {
            api_base_url: api_base_url.trim_end_matches('/').to_owned(),
            connector_token,
            expires_at_ms,
        };
        let _mutation = self.mutation.lock().await;
        if !advance_revision(&self.revision, sync_revision) {
            return Ok(json!({
                "configured": self.cloud.read().await.is_some(),
                "stale": true,
            }));
        }
        let previous = self.cloud.read().await.clone();
        persist_connector_gateway_config(&next_config)
            .map_err(|error| AppIpcError::new("connector_authorization_write_failed", error))?;
        *self.cloud.write().await = Some(next_config);
        if let Err(error) = self.write_mcp_config(true).await {
            let rollback_result = match &previous {
                Some(previous_config) => persist_connector_gateway_config(previous_config),
                None => clear_connector_gateway_config(),
            };
            match rollback_result {
                Ok(()) => {
                    *self.cloud.write().await = previous;
                }
                Err(rollback_error) => {
                    return Err(AppIpcError::new(
                        "connector_authorization_rollback_failed",
                        format!(
                            "Failed to write MCP config after updating connector authorization: {}; failed to roll back connector authorization on disk: {rollback_error}",
                            error.message
                        ),
                    ));
                }
            }
            return Err(error);
        }
        Ok(json!({ "configured": true, "expiresAtMs": expires_at_ms }))
    }

    pub(super) async fn clear(&self, payload: Value) -> Result<Value, AppIpcError> {
        let sync_revision = payload
            .get("syncRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| AppIpcError::new("bad_request", "syncRevision is required"))?;
        let _mutation = self.mutation.lock().await;
        if !advance_revision(&self.revision, sync_revision) {
            return Ok(json!({
                "configured": self.cloud.read().await.is_some(),
                "stale": true,
                "changed": false,
            }));
        }
        let mut changed = self.cloud.write().await.take().is_some();
        self.synced_apps.write().await.clear();
        clear_connector_gateway_config()
            .map_err(|error| AppIpcError::new("connector_authorization_clear_failed", error))?;
        let config_result = self.write_mcp_config(false).await;
        changed |= !matches!(&config_result, Ok(false));
        drop(_mutation);
        let _activation = capability_activation::activate().await;
        let _mutation = self.mutation.lock().await;
        if self.revision.load(Ordering::Acquire) != sync_revision {
            config_result?;
            return Ok(json!({
                "configured": self.cloud.read().await.is_some(),
                "stale": true,
                "changed": false,
            }));
        }
        let skills_result =
            materialize_skills(&self.codex_home.join("skills"), &[], &[], &mut changed);
        if changed {
            capability_activation::mark_changed();
        }
        config_result?;
        skills_result?;
        Ok(json!({ "configured": false, "changed": changed }))
    }

    pub(super) async fn tools(&self) -> Result<Value, AppIpcError> {
        self.request(reqwest::Method::GET, "tools", None).await
    }

    pub(super) async fn call(&self, payload: Value) -> Result<Value, AppIpcError> {
        let name = string_field(&payload, "name")
            .ok_or_else(|| AppIpcError::new("bad_request", "name is required"))?;
        let arguments = payload
            .get("arguments")
            .cloned()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        self.request(
            reqwest::Method::POST,
            "call",
            Some(json!({ "name": name, "arguments": arguments })),
        )
        .await
    }

    pub(super) async fn status(&self) -> Result<Value, AppIpcError> {
        let cloud = self.cloud.read().await.clone();
        Ok(json!({
            "configured": cloud.is_some(),
            "expiresAtMs": cloud.as_ref().map(|config| config.expires_at_ms),
            "apps": self.synced_apps.read().await.clone(),
        }))
    }

    pub(super) async fn sync_apps(&self, payload: Value) -> Result<Value, AppIpcError> {
        let apps = payload
            .get("apps")
            .and_then(Value::as_array)
            .ok_or_else(|| AppIpcError::new("bad_request", "apps must be an array"))?;
        let (tools, revision, generation) = self.discover_tools(apps).await?;
        // Waiting for an idle turn must not prevent connector-token refresh.
        let _activation = capability_activation::activate().await;
        let _mutation = self.mutation.lock().await;
        if self.revision.load(Ordering::Acquire) != revision
            || self.sync_generation.load(Ordering::Acquire) != generation
        {
            return Err(AppIpcError::new(
                "connector_sync_superseded",
                "Connector state changed during discovery; synchronize apps again",
            ));
        }
        let mut changed = self.write_mcp_config(true).await?;
        let result =
            materialize_skills(&self.codex_home.join("skills"), apps, &tools, &mut changed);
        // A failed sync may already have published part of the new capabilities.
        if changed {
            capability_activation::mark_changed();
        }
        let mut result = result?;
        result["changed"] = json!(changed);
        *self.synced_apps.write().await = result
            .get("apps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        crate::logging::log_executor_event(
            "runtime connector skills synchronized",
            &[
                ("app_count", apps.len().to_string()),
                ("changed", changed.to_string()),
            ],
        );
        Ok(result)
    }

    async fn discover_tools(&self, apps: &[Value]) -> Result<(Vec<Value>, u64, u64), AppIpcError> {
        let (cloud, revision, generation) = {
            let _mutation = self.mutation.lock().await;
            let cloud = self.cloud.read().await.clone().ok_or_else(|| {
                AppIpcError::new(
                    "connector_cloud_disconnected",
                    "Connect Wework to Wegent cloud before synchronizing apps",
                )
            })?;
            // Allocate under mutation so a newer request cannot race an active publication.
            let generation = self.sync_generation.fetch_add(1, Ordering::AcqRel) + 1;
            (cloud, self.revision.load(Ordering::Acquire), generation)
        };
        // Discover outside both locks so slow upstreams cannot block token renewal.
        let catalog = cloud
            .request(reqwest::Method::GET, "tools", None)
            .await
            .map_err(|error| AppIpcError::new(error.code, error.message))?;
        if !catalog.get("tools").is_some_and(Value::is_array) {
            return Err(AppIpcError::new(
                "connector_tool_catalog_incomplete",
                "Connector tool discovery did not return a tools array",
            ));
        }
        let tools = mcp_tools(&catalog);
        validate_tool_catalog(apps, &tools)?;
        Ok((tools, revision, generation))
    }

    async fn write_mcp_config(&self, enabled: bool) -> Result<bool, AppIpcError> {
        let value = if enabled {
            let command = env::current_exe().map_err(|error| {
                AppIpcError::new(
                    "connector_mcp_config_failed",
                    format!("Failed to locate executor binary: {error}"),
                )
            })?;
            connector_mcp_server_config(&command, env::var_os("WEGENT_EXECUTOR_HOME"))
        } else {
            Value::Null
        };
        if connector_mcp_config_matches(&self.codex_home.join("config.toml"), &value)? {
            return Ok(false);
        }
        self.codex_app_server
            .request(
                "config/batchWrite",
                json!({
                    "edits": [{
                        "keyPath": "mcp_servers.wegent_apps",
                        "value": value,
                        "mergeStrategy": "replace",
                    }],
                    "filePath": Value::Null,
                    "expectedVersion": Value::Null,
                    "reloadUserConfig": true,
                }),
            )
            .await
            .map(|_| true)
            .map_err(|error| AppIpcError::new("connector_mcp_config_failed", error))
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, AppIpcError> {
        let config = self.cloud.read().await.clone().ok_or_else(|| {
            AppIpcError::new(
                "connector_cloud_disconnected",
                "Connect Wework to Wegent cloud before using apps",
            )
        })?;
        config
            .request(method, path, body)
            .await
            .map_err(|error| AppIpcError::new(error.code, error.message))
    }
}

fn connector_mcp_server_config(command: &Path, executor_home: Option<std::ffi::OsString>) -> Value {
    let mut config = json!({
        "command": command.display().to_string(),
        "args": ["connector-mcp-server"],
        "startup_timeout_sec": 15,
        "tool_timeout_sec": 180,
        "default_tools_approval_mode": WEGENT_CONNECTOR_MCP_TOOL_APPROVAL_MODE,
    });
    if let Some(executor_home) = executor_home {
        config["env"] = json!({
            "WEGENT_EXECUTOR_HOME": executor_home.to_string_lossy(),
        });
    }
    config
}

fn is_valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_'))
        && value
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
}

fn connector_mcp_config_matches(path: &Path, expected: &Value) -> Result<bool, AppIpcError> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(AppIpcError::new(
                "connector_mcp_config_failed",
                error.to_string(),
            ));
        }
    };
    let config: Value = toml_edit::de::from_str(&content).map_err(|_| {
        AppIpcError::new("connector_mcp_config_failed", "Invalid Codex config TOML")
    })?;
    Ok(config
        .pointer("/mcp_servers/wegent_apps")
        .unwrap_or(&Value::Null)
        == expected)
}

fn advance_revision(revision: &AtomicU64, next: u64) -> bool {
    let current = revision.load(Ordering::Acquire);
    if next <= current {
        return false;
    }
    revision.store(next, Ordering::Release);
    true
}

fn materialize_skills(
    skills_root: &Path,
    apps: &[Value],
    tools: &[Value],
    changed: &mut bool,
) -> Result<Value, AppIpcError> {
    fs::create_dir_all(skills_root).map_err(|error| {
        AppIpcError::new(
            "connector_skill_sync_failed",
            format!("Failed to create {}: {error}", skills_root.display()),
        )
    })?;
    let mut active_dirs = HashSet::new();
    let mut materialized = Vec::new();
    for app in apps {
        let slug = string_field(app, "slug")
            .filter(|value| is_valid_slug(value))
            .ok_or_else(|| AppIpcError::new("bad_request", "Invalid connector app slug"))?;
        string_field(app, "name")
            .ok_or_else(|| AppIpcError::new("bad_request", "Connector app name is required"))?;
        let description = string_field(app, "description").unwrap_or_default();
        let dir_name = format!("wegent-connector-{slug}");
        active_dirs.insert(dir_name.clone());
        let skill_dir = skills_root.join(&dir_name);
        fs::create_dir_all(&skill_dir).map_err(|error| {
            AppIpcError::new(
                "connector_skill_sync_failed",
                format!("Failed to create {}: {error}", skill_dir.display()),
            )
        })?;
        let skill_path = skill_dir.join("SKILL.md");
        let mut tool_names = app
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|tool| string_field(tool, "name"))
            .collect::<Vec<_>>();
        tool_names.sort();
        tool_names.dedup();
        let tool_section = if tool_names.is_empty() {
            String::new()
        } else {
            format!(
                "\nAvailable synced tools:\n{}\n",
                tool_names
                    .iter()
                    .map(|name| format!("- `{name}`"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let authorization_section = if app
            .get("authorizationRequired")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            format!(
                "\nThis app is not authorized for the current user yet, so its tools are unavailable.\n\
                 When the user's request needs it, say briefly that authorization is required and end the turn with\n\
                 `connector_auth_required` and `connectorSlug={slug}` so Wework shows its authorization card.\n\
                 Do not claim the app does not exist and do not guess credentials.\n"
            )
        } else {
            String::new()
        };
        let body = format!(
            "---\nname: wegent-connector-{slug}\ndescription: Use the administrator-managed Wegent connector app {slug}.\n---\n\n# Wegent connector `{slug}`\n\n{description}\n\nUse the `wegent_apps` MCP server. Only call tools whose names start with `{slug}__`.\nAuthentication and credentials are managed by Wegent; never request or expose them.\n{authorization_section}{tool_section}"
        );
        write_skill_if_changed(&skill_path, &body, changed)?;
        let marker = tool_definitions_marker(tools.iter().filter(|tool| {
            tool.pointer("/_meta/connectorId").and_then(Value::as_str) == Some(slug.as_str())
        }));
        write_skill_if_changed(&skill_dir.join(".wegent-connector"), &marker, changed)?;
        materialized.push(json!({
            "slug": slug,
            "skillPath": skill_path.display().to_string(),
        }));
    }
    remove_inactive_skills(skills_root, &active_dirs, changed)?;
    Ok(json!({ "apps": materialized }))
}

fn validate_tool_catalog(apps: &[Value], tools: &[Value]) -> Result<(), AppIpcError> {
    let expected: HashSet<_> = apps
        .iter()
        .flat_map(|app| {
            app.get("tools")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(move |tool| {
                    Some((app.get("slug")?.as_str()?, tool.get("name")?.as_str()?))
                })
        })
        .collect();
    let discovered = tools
        .iter()
        .map(|tool| {
            Some((
                tool.pointer("/_meta/connectorId")?.as_str()?,
                tool.get("name")?.as_str()?,
            ))
        })
        .collect::<Option<HashSet<_>>>();
    if discovered.as_ref() != Some(&expected) {
        return Err(AppIpcError::new(
            "connector_tool_catalog_incomplete",
            "Installed apps and discovered tools differ; synchronize apps again",
        ));
    }
    Ok(())
}

fn tool_definitions_marker<'a>(tools: impl Iterator<Item = &'a Value>) -> String {
    let mut definitions = tools.cloned().collect::<Vec<_>>();
    definitions.iter_mut().for_each(canonicalize_json);
    definitions.sort_by_cached_key(Value::to_string);
    definitions.dedup();
    format!(
        "managed\nsha256:{:x}\n",
        Sha256::digest(json!(definitions).to_string())
    )
}

fn canonicalize_json(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.sort_keys();
            fields.values_mut().for_each(canonicalize_json);
        }
        Value::Array(items) => items.iter_mut().for_each(canonicalize_json),
        _ => {}
    }
}

fn write_skill_if_changed(path: &Path, body: &str, changed: &mut bool) -> Result<(), AppIpcError> {
    match fs::read(path) {
        Ok(current) if current == body.as_bytes() => return Ok(()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppIpcError::new(
                "connector_skill_sync_failed",
                error.to_string(),
            ))
        }
    }
    *changed = true;
    fs::write(path, body)
        .map_err(|error| AppIpcError::new("connector_skill_sync_failed", error.to_string()))
}

fn remove_inactive_skills(
    skills_root: &Path,
    active_dirs: &HashSet<String>,
    changed: &mut bool,
) -> Result<(), AppIpcError> {
    let entries = fs::read_dir(skills_root)
        .map_err(|error| AppIpcError::new("connector_skill_sync_failed", error.to_string()))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| AppIpcError::new("connector_skill_sync_failed", error.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("wegent-connector-")
            && !active_dirs.contains(&name)
            && entry.path().join(".wegent-connector").is_file()
        {
            *changed = true;
            fs::remove_dir_all(entry.path()).map_err(|error| {
                AppIpcError::new("connector_skill_sync_failed", error.to_string())
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "connectors_tests.rs"]
mod tests;
