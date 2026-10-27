// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use axum::{routing::get, Json, Router};
use tokio::{net::TcpListener, task::JoinHandle};

struct ToolsGateway {
    api_base_url: String,
    response: Arc<RwLock<Value>>,
    task: JoinHandle<()>,
}

impl Drop for ToolsGateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn tools_gateway(response: Value) -> ToolsGateway {
    let response = Arc::new(RwLock::new(response));
    let current = Arc::clone(&response);
    let app = Router::new().route(
        "/connector-runtime/tools",
        get(move || {
            let current = Arc::clone(&current);
            async move {
                let response = current.read().await.clone();
                Json(response)
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    ToolsGateway {
        api_base_url: format!("http://{address}"),
        response,
        task,
    }
}

struct ConnectorRuntimeFixture {
    runtime: ConnectorRuntime,
    _environment: std::sync::MutexGuard<'static, ()>,
}

impl std::ops::Deref for ConnectorRuntimeFixture {
    type Target = ConnectorRuntime;

    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

fn isolated_runtime(home: PathBuf, api_base_url: String) -> ConnectorRuntimeFixture {
    // Keep environment-derived MCP config stable for the fixture's full lifetime.
    let environment = crate::test_env::lock();
    fs::create_dir_all(&home).unwrap();
    let config = connector_mcp_server_config(
        &env::current_exe().unwrap(),
        env::var_os("WEGENT_EXECUTOR_HOME"),
    );
    fs::write(
        home.join("config.toml"),
        toml_edit::ser::to_string(&json!({"mcp_servers": {"wegent_apps": config}})).unwrap(),
    )
    .unwrap();
    let runtime = ConnectorRuntime {
        codex_app_server: CodexAppServerClient::isolated_for_test(
            "unused-test-binary",
            home.clone(),
        ),
        codex_home: home,
        cloud: Arc::new(RwLock::new(Some(ConnectorGatewayConfig {
            api_base_url,
            connector_token: "fixture-token".to_owned(),
            expires_at_ms: now_ms() + 900_000,
        }))),
        synced_apps: Arc::new(RwLock::new(Vec::new())),
        mutation: Arc::new(Mutex::new(())),
        revision: Arc::new(AtomicU64::new(0)),
        sync_generation: Arc::new(AtomicU64::new(0)),
    };
    ConnectorRuntimeFixture {
        runtime,
        _environment: environment,
    }
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
    fs::write(unrelated.join("SKILL.md"), "personal").expect("unrelated skill should be written");

    let result = materialize_skills(
        &skills_root,
        &[json!({"slug": "tickets", "name": "Tickets"})],
        &[],
        &mut false,
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

    materialize_skills(&skills_root, &[], &[], &mut false)
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
        &[],
        &mut false,
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

#[test]
fn unchanged_skills_preserve_files_even_when_tool_order_changes() {
    let temp = tempfile::tempdir().unwrap();
    let apps = [json!({
        "slug": "tickets", "name": "Tickets", "description": "Search tickets",
        "tools": [{"name": "tickets__search"}, {"name": "tickets__read"}],
    })];
    let tools = mcp_tools(&json!({"tools": [
        {"name": "tickets__search", "connector_id": "tickets"},
        {"name": "tickets__read", "connector_id": "tickets"},
    ]}));
    let mut changed = false;
    materialize_skills(temp.path(), &apps, &tools, &mut changed).unwrap();
    assert!(changed);
    let skill = temp.path().join("wegent-connector-tickets/SKILL.md");
    let marker = skill.parent().unwrap().join(".wegent-connector");
    let sentinel = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000);
    for path in [&skill, &marker] {
        fs::File::open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(sentinel))
            .unwrap();
    }
    let mut reordered = apps;
    reordered[0]["tools"] = json!([
        {"name": "tickets__read"}, {"name": "tickets__search"}, {"name": "tickets__read"}
    ]);
    changed = false;

    materialize_skills(temp.path(), &reordered, &tools, &mut changed).unwrap();

    assert!(!changed);
    for path in [&skill, &marker] {
        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), sentinel);
    }
}

#[test]
fn skill_updates_repairs_and_removals_report_changes() {
    let temp = tempfile::tempdir().unwrap();
    let mut apps = [json!({"slug": "tickets", "name": "Tickets"})];
    materialize_skills(temp.path(), &apps, &[], &mut false).unwrap();
    let skill = temp.path().join("wegent-connector-tickets/SKILL.md");
    apps[0]["description"] = json!("Updated description");
    let mut changed = false;
    materialize_skills(temp.path(), &apps, &[], &mut changed).unwrap();
    assert!(changed);
    assert!(fs::read_to_string(&skill)
        .unwrap()
        .contains("Updated description"));

    fs::remove_file(&skill).unwrap();
    changed = false;
    materialize_skills(temp.path(), &apps, &[], &mut changed).unwrap();
    assert!(changed);
    assert!(skill.is_file());

    changed = false;
    materialize_skills(temp.path(), &[], &[], &mut changed).unwrap();
    assert!(changed);
    assert!(!skill.exists());
    changed = false;
    materialize_skills(temp.path(), &[], &[], &mut changed).unwrap();
    assert!(!changed);
}

#[test]
fn partial_skill_publication_preserves_change_tracking_on_failure() {
    let temp = tempfile::tempdir().unwrap();
    let mut changed = false;

    let error = materialize_skills(
        temp.path(),
        &[
            json!({"slug": "tickets", "name": "Tickets"}),
            json!({"slug": "../escape", "name": "Invalid"}),
        ],
        &[],
        &mut changed,
    )
    .unwrap_err();

    assert_eq!(error.code, "bad_request");
    assert!(changed);
    assert!(temp
        .path()
        .join("wegent-connector-tickets/SKILL.md")
        .is_file());
}

#[test]
fn same_named_tool_definition_updates_change_only_the_capability_marker() {
    let temp = tempfile::tempdir().unwrap();
    let apps = [json!({
        "slug": "tickets", "name": "Tickets", "tools": [{"name": "tickets__search"}]
    })];
    let mut catalog = json!({"tools": [{
        "name": "tickets__search",
        "connector_id": "tickets",
        "description": "Search tickets",
        "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}}
    }]});
    materialize_skills(temp.path(), &apps, &mcp_tools(&catalog), &mut false).unwrap();
    let skill = temp.path().join("wegent-connector-tickets/SKILL.md");
    let marker = skill.parent().unwrap().join(".wegent-connector");
    let original_skill = fs::read(&skill).unwrap();

    for (field, value) in [
        ("description", json!("Search open tickets")),
        (
            "input_schema",
            json!({"type": "object", "properties": {"query": {"type": "integer"}}}),
        ),
        ("title", json!("Find tickets")),
        ("annotations", json!({"readOnlyHint": true})),
    ] {
        let previous_marker = fs::read(&marker).unwrap();
        catalog["tools"][0][field] = value;
        let tools = mcp_tools(&catalog);
        let mut changed = false;

        materialize_skills(temp.path(), &apps, &tools, &mut changed).unwrap();

        assert!(changed, "Changes to {field} must invalidate capabilities");
        assert_ne!(fs::read(&marker).unwrap(), previous_marker);
        assert_eq!(fs::read(&skill).unwrap(), original_skill);
        changed = false;
        materialize_skills(temp.path(), &apps, &tools, &mut changed).unwrap();
        assert!(
            !changed,
            "Repeated {field} definitions must remain unchanged"
        );
    }

    fs::write(&marker, "managed\n").unwrap();
    let mut changed = false;
    materialize_skills(temp.path(), &apps, &mcp_tools(&catalog), &mut changed).unwrap();
    assert!(changed);
    assert!(fs::read_to_string(&marker)
        .unwrap()
        .starts_with("managed\nsha256:"));
    changed = false;
    materialize_skills(temp.path(), &apps, &mcp_tools(&catalog), &mut changed).unwrap();
    assert!(!changed);
}

#[test]
fn full_tool_catalog_and_nested_object_order_do_not_change_markers() {
    let temp = tempfile::tempdir().unwrap();
    let apps = [json!({
        "slug": "tickets", "name": "Tickets",
        "tools": [{"name": "tickets__search"}, {"name": "tickets__read"}]
    })];
    let catalog: Value = serde_json::from_str(
        r#"{"tools":[
        {"name":"tickets__search","connector_id":"tickets","input_schema":{
            "type":"object","properties":{"query":{"type":"string","description":"Query"}}
        }},
        {"name":"tickets__read","connector_id":"tickets"}
    ]}"#,
    )
    .unwrap();
    let reordered: Value = serde_json::from_str(
        r#"{"tools":[
        {"connector_id":"tickets","name":"tickets__read"},
        {"input_schema":{"properties":{"query":{"description":"Query","type":"string"}},
            "type":"object"},"connector_id":"tickets","name":"tickets__search"}
    ]}"#,
    )
    .unwrap();
    materialize_skills(temp.path(), &apps, &mcp_tools(&catalog), &mut false).unwrap();
    let marker = temp
        .path()
        .join("wegent-connector-tickets/.wegent-connector");
    let original = fs::read(&marker).unwrap();
    let mut changed = false;

    materialize_skills(temp.path(), &apps, &mcp_tools(&reordered), &mut changed).unwrap();

    assert!(!changed);
    assert_eq!(fs::read(marker).unwrap(), original);
}

#[test]
fn mcp_comparison_uses_raw_config_and_preserves_invalid_config_errors() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.toml");
    let expected = json!({"command": "fixture-executor", "args": ["connector-mcp-server"]});
    assert!(!connector_mcp_config_matches(&path, &expected).unwrap());
    assert!(connector_mcp_config_matches(&path, &Value::Null).unwrap());
    fs::write(&path, "[mcp_servers.wegent_apps]\nargs = ['connector-mcp-server']\ncommand = 'fixture-executor'\n").unwrap();
    assert!(connector_mcp_config_matches(&path, &expected).unwrap());
    assert!(!connector_mcp_config_matches(&path, &Value::Null).unwrap());
    fs::write(&path, "[invalid").unwrap();
    assert_eq!(
        connector_mcp_config_matches(&path, &expected)
            .unwrap_err()
            .code,
        "connector_mcp_config_failed"
    );
}

#[tokio::test]
async fn repeated_sync_does_not_reload_codex_and_reports_real_skill_changes() {
    let temp = tempfile::tempdir().unwrap();
    let gateway = tools_gateway(json!({"tools": []})).await;
    let runtime = isolated_runtime(temp.path().join("codex"), gateway.api_base_url.clone());
    let mut payload = json!({"apps": [{"slug": "tickets", "name": "Tickets"}]});

    assert_eq!(
        runtime.sync_apps(payload.clone()).await.unwrap()["changed"],
        true
    );
    assert_eq!(
        runtime.sync_apps(payload.clone()).await.unwrap()["changed"],
        false
    );
    payload["apps"][0]["tools"] = json!([{"name": "tickets__search"}]);
    *gateway.response.write().await = json!({"tools": [{
        "name": "tickets__search", "connector_id": "tickets"
    }]});
    assert_eq!(
        runtime.sync_apps(payload.clone()).await.unwrap()["changed"],
        true
    );
    assert_eq!(runtime.sync_apps(payload).await.unwrap()["changed"], false);
    assert_eq!(
        runtime.status().await.unwrap()["apps"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn incomplete_catalog_does_not_publish_skills_or_markers() {
    let temp = tempfile::tempdir().unwrap();
    let gateway = tools_gateway(json!({"tools": [{
        "name": "tickets__search", "connector_id": "tickets"
    }]}))
    .await;
    let home = temp.path().join("codex");
    let runtime = isolated_runtime(home.clone(), gateway.api_base_url.clone());
    let mut payload = json!({"apps": [{
        "slug": "tickets", "name": "Tickets", "tools": [{"name": "tickets__search"}]
    }]});
    runtime.sync_apps(payload.clone()).await.unwrap();
    let skill = home.join("skills/wegent-connector-tickets/SKILL.md");
    let marker = skill.parent().unwrap().join(".wegent-connector");
    let original_skill = fs::read(&skill).unwrap();
    let original_marker = fs::read(&marker).unwrap();
    payload["apps"][0]["description"] = json!("Must not be published");
    payload["apps"].as_array_mut().unwrap().push(json!({
        "slug": "docs", "name": "Docs", "tools": [{"name": "docs__read"}]
    }));

    for response in [
        json!({"tools": []}),
        json!({"tools": [{"name": "tickets__search"}]}),
        json!({"tools": "invalid"}),
    ] {
        *gateway.response.write().await = response;

        let error = runtime.sync_apps(payload.clone()).await.unwrap_err();

        assert_eq!(error.code, "connector_tool_catalog_incomplete");
        assert_eq!(fs::read(&skill).unwrap(), original_skill);
        assert_eq!(fs::read(&marker).unwrap(), original_marker);
        assert!(!home.join("skills/wegent-connector-docs").exists());
    }
}

#[tokio::test]
async fn first_empty_catalog_does_not_change_capabilities() {
    let temp = tempfile::tempdir().unwrap();
    let gateway = tools_gateway(json!({"tools": []})).await;
    let runtime = isolated_runtime(temp.path().join("codex"), gateway.api_base_url.clone());

    let result = runtime.sync_apps(json!({"apps": []})).await.unwrap();

    assert_eq!(result["changed"], false);
    assert!(result["apps"].as_array().unwrap().is_empty());
    assert_eq!(
        fs::read_dir(runtime.codex_home.join("skills"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn superseded_network_response_cannot_publish_or_block_token_renewal() {
    let temp = tempfile::tempdir().unwrap();
    let requested = Arc::new(tokio::sync::Notify::new());
    let respond = Arc::new(tokio::sync::Notify::new());
    let started = Arc::clone(&requested);
    let release = Arc::clone(&respond);
    let app = Router::new().route(
        "/connector-runtime/tools",
        get(move || {
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            async move {
                started.notify_one();
                release.notified().await;
                Json(json!({"tools": [{
                    "name": "tickets__search", "connector_id": "tickets"
                }]}))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let gateway = ToolsGateway {
        api_base_url: format!("http://{address}"),
        response: Arc::new(RwLock::new(Value::Null)),
        task: tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
    };
    let runtime = isolated_runtime(temp.path().join("codex"), gateway.api_base_url.clone());
    let pending_runtime = runtime.clone();
    let pending = tokio::spawn(async move {
        pending_runtime
            .sync_apps(json!({"apps": [{
                "slug": "tickets", "name": "Tickets", "tools": [{"name": "tickets__search"}]
            }]}))
            .await
    });
    let timeout = std::time::Duration::from_secs(2);
    tokio::time::timeout(timeout, requested.notified())
        .await
        .unwrap();
    let execution = tokio::time::timeout(timeout, capability_activation::begin_execution())
        .await
        .expect("Slow discovery must not hold the capability activation writer");

    tokio::time::timeout(timeout, async {
        let _mutation = runtime.mutation.lock().await;
        let mut cloud = runtime.cloud.write().await;
        let cloud = cloud.as_mut().unwrap();
        cloud.connector_token = "renewed-fixture-token".to_owned();
        cloud.expires_at_ms = now_ms() + 900_000;
        assert!(advance_revision(&runtime.revision, 1));
    })
    .await
    .expect("Slow discovery must leave the token renewal mutation lock available");

    respond.notify_one();
    drop(execution);
    let error = tokio::time::timeout(timeout, pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();

    assert_eq!(error.code, "connector_sync_superseded");
    assert!(!runtime.codex_home.join("skills").exists());
    assert!(runtime.status().await.unwrap()["apps"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn reversed_discovery_responses_cannot_overwrite_newer_capabilities() {
    assert_reversed_discovery(false).await;
}

#[tokio::test]
async fn failed_newer_discovery_still_rejects_an_older_response() {
    assert_reversed_discovery(true).await;
}

async fn assert_reversed_discovery(latest_discovery_fails: bool) {
    let temp = tempfile::tempdir().unwrap();
    let requested = Arc::new(tokio::sync::Notify::new());
    let respond = Arc::new(tokio::sync::Notify::new());
    let started = Arc::clone(&requested);
    let release = Arc::clone(&respond);
    let requests = Arc::new(AtomicU64::new(0));
    let app = Router::new().route(
        "/connector-runtime/tools",
        get(move || {
            let sequence = requests.fetch_add(1, Ordering::AcqRel);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            async move {
                if sequence == 1 {
                    started.notify_one();
                    release.notified().await;
                }
                if sequence == 2 && latest_discovery_fails {
                    return Json(json!({"tools": "incomplete"}));
                }
                Json(json!({"tools": [{
                    "name": "tickets__search", "connector_id": "tickets",
                    "description": "Search tickets",
                    "input_schema": {"type": "object", "properties": {
                        "query": {"type": match sequence {
                            0 => "string",
                            1 => "boolean",
                            _ => "integer",
                        }}
                    }}
                }]}))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let gateway = ToolsGateway {
        api_base_url: format!("http://{address}"),
        response: Arc::new(RwLock::new(Value::Null)),
        task: tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
    };
    let runtime = isolated_runtime(temp.path().join("codex"), gateway.api_base_url.clone());
    let old_payload = json!({"apps": [{
        "slug": "tickets", "name": "Tickets", "description": "Search tickets",
        "tools": [{"name": "tickets__search"}]
    }]});
    runtime.sync_apps(old_payload.clone()).await.unwrap();
    let skill = runtime
        .codex_home
        .join("skills/wegent-connector-tickets/SKILL.md");
    let marker = skill.parent().unwrap().join(".wegent-connector");
    let original_skill = fs::read(&skill).unwrap();
    let original_marker = fs::read(&marker).unwrap();
    let original_status = runtime.status().await.unwrap();
    let new_payload = old_payload.clone();
    let pending_runtime = runtime.clone();
    let pending = tokio::spawn(async move { pending_runtime.sync_apps(old_payload).await });
    let timeout = std::time::Duration::from_secs(2);
    tokio::time::timeout(timeout, requested.notified())
        .await
        .unwrap();
    let latest = runtime.sync_apps(new_payload.clone()).await;

    if latest_discovery_fails {
        assert_eq!(
            latest.unwrap_err().code,
            "connector_tool_catalog_incomplete"
        );
        assert_eq!(fs::read(&marker).unwrap(), original_marker);
    } else {
        assert_eq!(latest.unwrap()["changed"], true);
        assert_ne!(fs::read(&marker).unwrap(), original_marker);
    }
    let latest_skill = fs::read(&skill).unwrap();
    let latest_marker = fs::read(&marker).unwrap();
    assert_eq!(latest_skill, original_skill);
    respond.notify_one();
    let error = tokio::time::timeout(timeout, pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();

    assert_eq!(error.code, "connector_sync_superseded");
    assert_eq!(runtime.revision.load(Ordering::Acquire), 0);
    assert_eq!(fs::read(skill).unwrap(), latest_skill);
    assert_eq!(fs::read(marker).unwrap(), latest_marker);
    assert_eq!(runtime.status().await.unwrap(), original_status);
    assert_eq!(
        runtime.sync_apps(new_payload).await.unwrap()["changed"],
        latest_discovery_fails
    );
}

#[tokio::test]
async fn waiting_skill_activation_does_not_block_token_refresh() {
    let temp = tempfile::tempdir().unwrap();
    let gateway = tools_gateway(json!({"tools": []})).await;
    let runtime = isolated_runtime(temp.path().join("codex"), gateway.api_base_url.clone());
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
    assert_eq!(sync.await.unwrap()["changed"], false);
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

    let temp = tempfile::tempdir().unwrap();
    let runtime = isolated_runtime(temp.path().join("codex"), format!("http://{addr}"));
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
