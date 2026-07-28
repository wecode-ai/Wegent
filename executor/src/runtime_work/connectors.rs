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
};

use super::util::{now_ms, string_field};

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
        if previous.is_none() {
            if let Err(error) = self.write_mcp_config(true).await {
                *self.cloud.write().await = previous;
                let _ = clear_connector_gateway_config();
                return Err(error);
            }
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
        clear_connector_gateway_config()
            .map_err(|error| AppIpcError::new("connector_authorization_clear_failed", error))?;
        let config_result = self.write_mcp_config(false).await;
        let skills_result = materialize_skills(&skills_root(), &[]);
        config_result?;
        skills_result?;
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
        let _mutation = self.mutation.lock().await;
        if self.cloud.read().await.is_none() {
            return Err(AppIpcError::new(
                "connector_cloud_disconnected",
                "Connect Wework to Wegent cloud before synchronizing apps",
            ));
        }
        let result = materialize_skills(&skills_root(), apps)?;
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

fn materialize_skills(skills_root: &Path, apps: &[Value]) -> Result<Value, AppIpcError> {
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
    remove_inactive_skills(skills_root, &active_dirs)?;
    Ok(json!({ "apps": materialized }))
}

fn remove_inactive_skills(
    skills_root: &Path,
    active_dirs: &HashSet<String>,
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
        let skill_path = skills_root.join("wegent-connector-tickets/SKILL.md");
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
