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
use tokio::sync::{Mutex, RwLock};

use crate::{
    agents::CodexAppServerClient,
    connector_gateway::{
        clear_connector_gateway_config, persist_connector_gateway_config, ConnectorGatewayConfig,
    },
    local::app_ipc::AppIpcError,
    services::capability_activation,
};

use super::util::{now_ms, string_field};

const WEGENT_CONNECTOR_MCP_TOOL_APPROVAL_MODE: &str = "approve";

#[derive(Clone)]
pub(super) struct ConnectorRuntime {
    codex_app_server: CodexAppServerClient,
    cloud: Arc<RwLock<Option<ConnectorGatewayConfig>>>,
    synced_apps: Arc<RwLock<Vec<Value>>>,
    mutation: Arc<Mutex<()>>,
    revision: Arc<AtomicU64>,
}

impl ConnectorRuntime {
    pub(super) fn new(codex_app_server: CodexAppServerClient) -> Self {
        Self {
            codex_app_server,
            cloud: Arc::new(RwLock::new(
                crate::connector_gateway::load_connector_gateway_config().ok(),
            )),
            synced_apps: Arc::new(RwLock::new(Vec::new())),
            mutation: Arc::new(Mutex::new(())),
            revision: Arc::new(AtomicU64::new(0)),
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
                None => clear_connector_gateway_config().map(|_| ()),
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
            }));
        }
        self.cloud.write().await.take();
        self.synced_apps.write().await.clear();
        let authorization_removed = clear_connector_gateway_config()
            .map_err(|error| AppIpcError::new("connector_authorization_clear_failed", error))?;
        let mcp_was_configured = connector_mcp_is_configured();
        let config_result = self.write_mcp_config(false).await;
        drop(_mutation);
        let _activation = capability_activation::activate().await;
        let _mutation = self.mutation.lock().await;
        if self.revision.load(Ordering::Acquire) != sync_revision {
            config_result?;
            return Ok(json!({
                "configured": self.cloud.read().await.is_some(),
                "stale": true,
            }));
        }
        finish_connector_clear(
            &skills_root(),
            authorization_removed,
            mcp_was_configured,
            config_result,
        )?;
        Ok(json!({ "configured": false }))
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
        // Waiting for an idle turn must not prevent connector-token refresh.
        let _activation = capability_activation::activate().await;
        let _mutation = self.mutation.lock().await;
        if self.cloud.read().await.is_none() {
            return Err(AppIpcError::new(
                "connector_cloud_disconnected",
                "Connect Wework to Wegent cloud before synchronizing apps",
            ));
        }
        self.write_mcp_config(true).await?;
        let result = materialize_skills(&skills_root(), apps);
        capability_activation::mark_changed();
        let result = result?;
        *self.synced_apps.write().await = result
            .get("apps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(result)
    }

    async fn write_mcp_config(&self, enabled: bool) -> Result<(), AppIpcError> {
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
            .map(|_| ())
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

fn skills_root() -> PathBuf {
    env::var_os("WEGENT_CODEX_HOME")
        .or_else(|| env::var_os("CODEX_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(env::temp_dir)
                .join(".codex")
        })
        .join("skills")
}

fn advance_revision(revision: &AtomicU64, next: u64) -> bool {
    let current = revision.load(Ordering::Acquire);
    if next <= current {
        return false;
    }
    revision.store(next, Ordering::Release);
    true
}

fn connector_mcp_is_configured() -> Result<bool, AppIpcError> {
    let config_path = crate::agents::wework_codex_home().join("config.toml");
    let content = match fs::read_to_string(config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(AppIpcError::new(
                "connector_mcp_config_failed",
                error.to_string(),
            ))
        }
    };
    let config = content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| AppIpcError::new("connector_mcp_config_failed", error.to_string()))?;
    Ok(config
        .get("mcp_servers")
        .and_then(|servers| servers.get("wegent_apps"))
        .is_some())
}

fn finish_connector_clear(
    skills_root: &Path,
    authorization_removed: bool,
    mcp_was_configured: Result<bool, AppIpcError>,
    config_result: Result<(), AppIpcError>,
) -> Result<(), AppIpcError> {
    let mut changed = authorization_removed;
    let skills_result = materialize_skills_with_changes(skills_root, &[], &mut changed);
    // Keep the previous conservative invalidation if the persisted state cannot
    // be inspected, or if a failed config write may already have changed it.
    if config_result.is_err() || mcp_was_configured.unwrap_or(true) {
        changed = true;
    }
    if changed {
        capability_activation::mark_changed();
    }
    config_result?;
    skills_result?;
    Ok(())
}

fn materialize_skills(skills_root: &Path, apps: &[Value]) -> Result<Value, AppIpcError> {
    materialize_skills_with_changes(skills_root, apps, &mut false)
}

fn materialize_skills_with_changes(
    skills_root: &Path,
    apps: &[Value],
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
        let tool_names = app
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|tool| string_field(tool, "name"))
            .collect::<Vec<_>>();
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
        let body = format!(
            "---\nname: wegent-connector-{slug}\ndescription: Use the administrator-managed Wegent connector app {slug}.\n---\n\n# Wegent connector `{slug}`\n\n{description}\n\nUse the `wegent_apps` MCP server. Only call tools whose names start with `{slug}__`.\nAuthentication and credentials are managed by Wegent; never request or expose them.\n{tool_section}"
        );
        fs::write(&skill_path, body).map_err(|error| {
            AppIpcError::new(
                "connector_skill_sync_failed",
                format!("Failed to write {}: {error}", skill_path.display()),
            )
        })?;
        fs::write(skill_dir.join(".wegent-connector"), "managed\n")
            .map_err(|error| AppIpcError::new("connector_skill_sync_failed", error.to_string()))?;
        materialized.push(json!({
            "slug": slug,
            "skillPath": skill_path.display().to_string(),
        }));
    }
    remove_inactive_skills(skills_root, &active_dirs, changed)?;
    Ok(json!({ "apps": materialized }))
}

fn remove_inactive_skills(
    skills_root: &Path,
    active_dirs: &HashSet<String>,
    changed: &mut bool,
) -> Result<(), AppIpcError> {
    let Ok(entries) = fs::read_dir(skills_root) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("wegent-connector-")
            && !active_dirs.contains(&name)
            && entry.path().join(".wegent-connector").is_file()
        {
            // A recursive removal can fail after removing part of the skill.
            // Preserve invalidation on that error path as well.
            *changed = true;
            fs::remove_dir_all(entry.path()).map_err(|error| {
                AppIpcError::new("connector_skill_sync_failed", error.to_string())
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn connector_clear_does_not_retire_the_process_started_by_config_write() {
        use std::os::unix::fs::PermissionsExt;

        const FIXTURE_HOME: &str = "WEGENT_CONNECTOR_CLEAR_FIXTURE_HOME";
        if let Some(root) = env::var_os(FIXTURE_HOME) {
            let root = PathBuf::from(root);
            // The test binary's startup hook removes inherited executor homes.
            // This isolated single-test subprocess sets its own before Tokio starts.
            unsafe { env::set_var("WEGENT_EXECUTOR_HOME", root.join("executor")) };
            let runtime = tokio::runtime::Runtime::new().unwrap();
            runtime.block_on(async {
                let client = CodexAppServerClient::new(root.join("codex").to_string_lossy());
                let connectors = ConnectorRuntime::new(client.clone());
                let result = async {
                    connectors.clear(json!({"syncRevision":1})).await?;
                    client
                        .request("config/read", json!({}))
                        .await
                        .map_err(|error| AppIpcError::new("fixture_rpc", error))?;
                    connectors.clear(json!({"syncRevision":2})).await?;
                    client
                        .request("config/read", json!({}))
                        .await
                        .map_err(|error| AppIpcError::new("fixture_rpc", error))?;
                    Ok::<_, AppIpcError>(())
                }
                .await;
                client.restart().await.unwrap();
                result.unwrap();
                assert_eq!(
                    fs::read_to_string(root.join("codex.pids"))
                        .unwrap()
                        .lines()
                        .count(),
                    1
                );
            });
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("codex");
        fs::write(
            &binary,
            r#"#!/bin/sh
printf '%s\n' "$$" >> "$0.pids"
while IFS= read -r line; do
  request_id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  if [ -n "$request_id" ]; then printf '{"id":%s,"result":{}}\n' "$request_id"; fi
done
"#,
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let output = std::process::Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "runtime_work::connectors::tests::connector_clear_does_not_retire_the_process_started_by_config_write",
                "--nocapture",
            ])
            .env(FIXTURE_HOME, root.path())
            .env("WEGENT_CODEX_HOME", root.path().join("home"))
            .env("CODEX_HOME", root.path().join("home"))
            .env("WEGENT_EXECUTOR_HOME", root.path().join("executor"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn connector_clear_preserves_the_started_process_revision_when_disk_state_is_empty() {
        let _environment = crate::test_env::lock();
        let temp = tempfile::tempdir().unwrap();
        let skills = temp.path().join("skills");
        let process_revision = capability_activation::revision();
        finish_connector_clear(&skills, false, Ok(false), Ok(())).unwrap();
        assert_eq!(capability_activation::revision(), process_revision);
        finish_connector_clear(&skills, false, Ok(false), Ok(())).unwrap();
        assert_eq!(capability_activation::revision(), process_revision);
    }

    #[test]
    fn connector_clear_invalidates_real_persisted_state_and_is_then_idempotent() {
        let _environment = crate::test_env::lock();
        for (authorization_removed, mcp_was_configured, managed_skill) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let skills = temp.path().join("skills");
            let managed = skills.join("wegent-connector-tickets");
            if managed_skill {
                fs::create_dir_all(&managed).unwrap();
                fs::write(managed.join(".wegent-connector"), "managed\n").unwrap();
                fs::write(managed.join("SKILL.md"), "persisted skill").unwrap();
            }
            let previous = capability_activation::revision();
            finish_connector_clear(
                &skills,
                authorization_removed,
                Ok(mcp_was_configured),
                Ok(()),
            )
            .unwrap();
            assert!(!managed.exists());
            assert_eq!(capability_activation::revision(), previous + 1);
            finish_connector_clear(&skills, false, Ok(false), Ok(())).unwrap();
            assert_eq!(capability_activation::revision(), previous + 1);
        }
    }

    #[test]
    fn connector_clear_preserves_errors_and_invalidates_successful_partial_cleanup() {
        let _environment = crate::test_env::lock();
        let temp = tempfile::tempdir().unwrap();
        let skills = temp.path().join("skills");
        let managed = skills.join("wegent-connector-tickets");
        fs::create_dir_all(&managed).unwrap();
        fs::write(managed.join(".wegent-connector"), "managed\n").unwrap();
        let previous = capability_activation::revision();
        let error = finish_connector_clear(
            &skills,
            false,
            Ok(true),
            Err(AppIpcError::new(
                "original_config_error",
                "original failure",
            )),
        )
        .unwrap_err();
        assert_eq!(error.code, "original_config_error");
        assert_eq!(error.message, "original failure");
        assert!(!managed.exists());
        assert_eq!(capability_activation::revision(), previous + 1);
        let blocked = temp.path().join("blocked");
        fs::write(&blocked, "not a directory").unwrap();
        let error = finish_connector_clear(&blocked, false, Ok(false), Ok(())).unwrap_err();
        assert_eq!(error.code, "connector_skill_sync_failed");
        assert_eq!(capability_activation::revision(), previous + 1);
    }

    #[test]
    fn mcp_child_uses_the_executor_instance_home() {
        let config = connector_mcp_server_config(
            Path::new("/opt/wegent-executor"),
            Some(std::ffi::OsString::from("/private/runtime/instance")),
        );

        assert_eq!(
            config["env"]["WEGENT_EXECUTOR_HOME"],
            "/private/runtime/instance"
        );
        assert_eq!(
            config["default_tools_approval_mode"],
            WEGENT_CONNECTOR_MCP_TOOL_APPROVAL_MODE
        );
    }

    #[test]
    fn skill_materialization_is_scoped_and_removes_only_managed_stale_dirs() {
        let temp = tempfile::tempdir().expect("temporary directory should be created");
        let skills_root = temp.path().join("skills");
        let unrelated = skills_root.join("personal-skill");
        fs::create_dir_all(&unrelated).expect("unrelated skill should be created");
        fs::write(unrelated.join("SKILL.md"), "personal")
            .expect("unrelated skill should be written");

        let result = materialize_skills(
            &skills_root,
            &[json!({"slug": "tickets", "name": "Tickets"})],
        )
        .expect("connector skill should materialize");
        let skill_path = skills_root
            .join("wegent-connector-tickets")
            .join("SKILL.md");
        let content = fs::read_to_string(&skill_path).expect("skill should be readable");
        assert!(content.contains("tickets__"));
        assert_eq!(
            result["apps"][0]["skillPath"],
            skill_path.display().to_string()
        );

        materialize_skills(&skills_root, &[])
            .expect("stale managed connector skill should be removed");
        assert!(!skill_path.exists());
        assert!(unrelated.join("SKILL.md").exists());
    }

    #[test]
    fn skill_materialization_rejects_path_traversal_slugs() {
        let temp = tempfile::tempdir().expect("temporary directory should be created");
        let result = materialize_skills(
            temp.path(),
            &[json!({"slug": "../escape", "name": "Escape"})],
        );

        let error = result.expect_err("unsafe slug should be rejected");
        assert_eq!(error.code, "bad_request");
    }

    #[test]
    fn revision_rejects_stale_cloud_mutations() {
        let revision = AtomicU64::new(0);

        assert!(advance_revision(&revision, 10));
        assert!(!advance_revision(&revision, 10));
        assert!(!advance_revision(&revision, 9));
        assert!(advance_revision(&revision, 11));
    }

    #[tokio::test]
    async fn waiting_skill_activation_does_not_block_token_refresh() {
        let runtime = ConnectorRuntime {
            codex_app_server: CodexAppServerClient::new("unused-test-binary"),
            cloud: Arc::new(RwLock::new(None)),
            synced_apps: Arc::new(RwLock::new(Vec::new())),
            mutation: Arc::new(Mutex::new(())),
            revision: Arc::new(AtomicU64::new(0)),
        };
        let execution = capability_activation::begin_execution().await;
        let mut sync = Box::pin(runtime.sync_apps(json!({"apps": []})));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut sync)
                .await
                .is_err()
        );
        let token_refresh = runtime
            .mutation
            .try_lock()
            .expect("token refresh must remain available during an active turn");
        drop(token_refresh);
        drop(execution);
        assert_eq!(sync.await.unwrap_err().code, "connector_cloud_disconnected");
    }

    #[tokio::test]
    async fn gateway_forwards_scoped_token_and_tool_payload() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("gateway listener should bind");
        let addr = listener
            .local_addr()
            .expect("listener address should resolve");
        let gateway = tokio::spawn(async move {
            for expected_path in ["/connector-runtime/tools", "/connector-runtime/call"] {
                let (mut socket, _) = listener.accept().await.expect("request should connect");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let read = socket.read(&mut buffer).await.expect("request should read");
                    assert!(read > 0, "request closed before headers arrived");
                    request.extend_from_slice(&buffer[..read]);
                    let Some(header_end) = request.windows(4).position(|item| item == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&request[..header_end + 4]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
                let request_text = String::from_utf8(request).expect("request should be utf-8");
                assert!(request_text.contains(expected_path));
                assert!(request_text
                    .to_ascii_lowercase()
                    .contains("authorization: bearer scoped-token"));
                if expected_path.ends_with("/call") {
                    let body = request_text
                        .split_once("\r\n\r\n")
                        .expect("request body should exist")
                        .1;
                    let payload: Value =
                        serde_json::from_str(body).expect("tool payload should be json");
                    assert_eq!(payload["name"], "tickets__search");
                    assert_eq!(payload["arguments"]["query"], "connector");
                }
                let body = if expected_path.ends_with("/tools") {
                    r#"{"tools":[{"name":"tickets__search"}]}"#
                } else {
                    r#"{"content":[{"type":"text","text":"done"}],"is_error":false}"#
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("response should write");
            }
        });

        let runtime = ConnectorRuntime::new(CodexAppServerClient::new("/bin/false"));
        *runtime.cloud.write().await = Some(ConnectorGatewayConfig {
            api_base_url: format!("http://{addr}"),
            connector_token: "scoped-token".to_owned(),
            expires_at_ms: now_ms() + 60_000,
        });

        let tools = runtime.tools().await.expect("tools should load");
        let result = runtime
            .call(json!({
                "name": "tickets__search",
                "arguments": { "query": "connector" }
            }))
            .await
            .expect("tool should execute");

        assert_eq!(tools["tools"][0]["name"], "tickets__search");
        assert_eq!(result["content"][0]["text"], "done");
        gateway.await.expect("gateway task should finish");
    }
}
