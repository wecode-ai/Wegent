// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/// Synthetic MCP endpoint used by the parser tests.
const TEST_MCP_URL: &str = "http://mcp.example.invalid/mcp";

use serde_json::Value;

use super::*;

#[test]
fn refresh_failures_require_authorization_only_for_missing_or_rejected_grants() {
    use super::super::refresh::RefreshError;

    assert!(matches!(
        SessionError::from_refresh(RefreshError::Provider("invalid_client".into())),
        SessionError::Provider(_)
    ));
    assert!(matches!(
        SessionError::from_refresh(RefreshError::Crypto(
            crate::subscriptions_item::crypto::CryptoError::Unreadable
        )),
        SessionError::Crypto
    ));
    for error in [RefreshError::Unavailable, RefreshError::Rejected] {
        assert!(matches!(
            SessionError::from_refresh(error),
            SessionError::AuthorizationRequired
        ));
    }
}

fn app_row(id: i64, slug: &str, spec: Value) -> KindRow {
    KindRow {
        kinds_id: id,
        kinds_user_id: 0,
        kinds_kind: "ConnectorApp".to_string(),
        kinds_name: slug.to_string(),
        kinds_namespace: "system".to_string(),
        kinds_json: brz_mysql::Json(
            Value::Object(
                [
                    (
                        "kind".to_string(),
                        Value::String("ConnectorApp".to_string()),
                    ),
                    ("spec".to_string(), spec),
                ]
                .into_iter()
                .collect(),
            )
            .into(),
        ),
        kinds_is_active: true,
        kinds_created_at: chrono::NaiveDateTime::default(),
        kinds_updated_at: chrono::NaiveDateTime::default(),
    }
}

fn user() -> UserRow {
    UserRow {
        users_id: 128,
        users_user_name: "xiangji".to_string(),
        users_password_hash: String::new(),
        users_email: None,
        users_git_info: brz_mysql::Json(Value::Null.into()),
        users_is_active: true,
        users_role: "user".to_string(),
        users_auth_source: "oidc".to_string(),
        users_preferences: String::new(),
        users_created_at: chrono::NaiveDateTime::default(),
        users_updated_at: chrono::NaiveDateTime::default(),
    }
}

#[test]
fn row_to_app_reads_spec_defaults() {
    let row = app_row(
        266184,
        "wegent-sites",
        serde_json::json!({
            "name": "Wegent Sites",
            "mcpUrl": TEST_MCP_URL,
            "enabled": true,
            "iconUrl": null,
            "authType": "none",
            "transport": "streamable-http",
            "visibility": "all",
            "description": "d",
            "allowedRoles": [],
            "toolAllowlist": []
        }),
    );
    let app = row_to_app(&row);
    assert_eq!(app.slug, "wegent-sites");
    assert_eq!(app.name, "Wegent Sites");
    assert_eq!(app.auth_type, "none");
    assert_eq!(app.transport, "streamable-http");
    assert_eq!(app.mcp_url, TEST_MCP_URL);
    assert_eq!(app.tool_loading_mode, "static");
    assert_eq!(app.visibility, "all");
    assert!(app.enabled);
    assert_eq!(app.icon_url, None);
}

#[test]
fn row_to_app_defaults_missing_spec_fields() {
    let row = app_row(1, "bare", serde_json::json!({}));
    let app = row_to_app(&row);
    assert_eq!(app.auth_type, "none");
    assert_eq!(app.transport, "streamable-http");
    assert_eq!(app.visibility, "all");
    assert_eq!(app.name, "bare");
    assert_eq!(app.description, "");
    assert_eq!(app.mcp_url, "");
    assert_eq!(app.tool_loading_mode, "static");
    assert!(app.enabled);
}

#[test]
fn row_to_app_reads_lazy_loading_mode_and_legacy_values() {
    let row = app_row(
        1,
        "lazy",
        serde_json::json!({"toolLoadingMode": "lazy", "authType": "none"}),
    );
    let app = row_to_app(&row);
    assert_eq!(app.tool_loading_mode, "lazy");

    let legacy = app_row(
        2,
        "legacy",
        serde_json::json!({"toolLoadingMode": "skill", "authType": "none"}),
    );
    assert_eq!(row_to_app(&legacy).tool_loading_mode, "lazy");

    let legacy_static = app_row(
        3,
        "legacy-static",
        serde_json::json!({"toolLoadingMode": "direct", "authType": "none"}),
    );
    assert_eq!(row_to_app(&legacy_static).tool_loading_mode, "static");
}

#[test]
fn visible_apps_filter_disabled_and_role_visibility() {
    let rows = [
        app_row(
            1,
            "on",
            serde_json::json!({"enabled": true, "visibility": "all"}),
        ),
        app_row(
            2,
            "off",
            serde_json::json!({"enabled": false, "visibility": "all"}),
        ),
        app_row(
            3,
            "admin-only",
            serde_json::json!({"enabled": true, "visibility": "roles", "allowedRoles": ["admin"]}),
        ),
    ];
    let apps: Vec<ConnectorApp> = rows.iter().map(row_to_app).collect();
    let visible = list_visible_apps(&apps, &user());
    let slugs: Vec<&str> = visible.iter().map(|app| app.slug.as_str()).collect();
    assert_eq!(slugs, vec!["on"]);
}

#[test]
fn expired_connection_stays_visible_with_cached_tools() {
    let app = row_to_app(&app_row(
        9,
        "dingtalk",
        serde_json::json!({"authType": "oauth2", "transport": "streamable-http"}),
    ));
    let stored = ConnectorConnection {
        status: "connected".to_string(),
        external_account_name: None,
        granted_scopes: Vec::new(),
        // A past expiry turns the stored "connected" view into "expired".
        expires_at: Some(chrono::NaiveDateTime::default()),
        access_token_encrypted: String::new(),
        refresh_token_encrypted: None,
        token_type: "bearer".to_string(),
        tool_summaries: vec![ToolSummary {
            name: "dingtalk__list_bases".to_string(),
            title: None,
            description: String::new(),
            raw_tool_name: Some("list_bases".to_string()),
            input_schema: None,
        }],
        tools_discovered_at: None,
        last_error: None,
    };

    let item = installed_app_projection(&app, Some(&stored), None).unwrap();

    assert_eq!(item.connection.status, "expired");
    assert!(!item.callable);
    assert_eq!(item.connection.tool_count, 1);
    assert_eq!(item.runtime_name.as_deref(), Some("dingtalk"));
    assert_eq!(item.tool_summaries.len(), 1);
    assert_eq!(
        item.tool_summaries[0].raw_tool_name.as_deref(),
        Some("list_bases")
    );
}

#[test]
fn cached_tools_respect_the_current_allowlist_for_connected_and_expired_grants() {
    let app = row_to_app(&app_row(
        9,
        "dingtalk",
        serde_json::json!({"authType": "oauth2", "toolAllowlist": ["read_doc"]}),
    ));
    for status in ["connected", "expired"] {
        let stored = ConnectorConnection::from_row(&app_row(
            10,
            "dingtalk",
            serde_json::json!({
                "status": status,
                "toolSummaries": [
                    {"name": "dingtalk__read_doc", "rawToolName": "read_doc"},
                    {"name": "dingtalk__delete_doc", "rawToolName": "delete_doc"},
                    {"name": "dingtalk__unidentified"}
                ]
            }),
        ));
        let item = installed_app_projection(&app, Some(&stored), None).unwrap();
        assert_eq!(item.connection.status, status);
        assert_eq!(item.tool_summaries.len(), 1);
        assert_eq!(item.tool_summaries[0].name, "dingtalk__read_doc");
        assert_eq!(item.callable, status == "connected");
    }
}

#[test]
fn a_removed_cached_tool_cannot_keep_an_app_callable() {
    let app = row_to_app(&app_row(
        9,
        "dingtalk",
        serde_json::json!({"authType": "oauth2", "toolAllowlist": ["new_tool"]}),
    ));
    let stored = ConnectorConnection::from_row(&app_row(
        10,
        "dingtalk",
        serde_json::json!({
            "status": "connected",
            "toolSummaries": [{"name": "dingtalk__old_tool", "rawToolName": "old_tool"}]
        }),
    ));
    let item = installed_app_projection(&app, Some(&stored), None).unwrap();
    assert!(!item.callable);
    assert!(item.tool_summaries.is_empty());
    assert!(item.runtime_name.is_none());
}

#[test]
fn a_successful_empty_discovery_does_not_restore_cached_tools() {
    let app = row_to_app(&app_row(
        9,
        "dingtalk",
        serde_json::json!({"authType": "oauth2"}),
    ));
    let stored = ConnectorConnection::from_row(&app_row(
        10,
        "dingtalk",
        serde_json::json!({
            "status": "connected",
            "toolSummaries": [{"name": "dingtalk__removed", "rawToolName": "removed"}]
        }),
    ));
    let item = installed_app_projection(&app, Some(&stored), Some(&[])).unwrap();
    assert!(item.tool_summaries.is_empty());
    assert!(!item.callable);
}

#[test]
fn live_tools_win_over_the_connection_cache() {
    let app = row_to_app(&app_row(
        9,
        "dingtalk",
        serde_json::json!({"authType": "oauth2", "transport": "streamable-http"}),
    ));
    let stored = ConnectorConnection {
        status: "connected".to_string(),
        external_account_name: None,
        granted_scopes: Vec::new(),
        expires_at: None,
        access_token_encrypted: String::new(),
        refresh_token_encrypted: None,
        token_type: "bearer".to_string(),
        tool_summaries: vec![ToolSummary {
            name: "dingtalk__cached".to_string(),
            title: None,
            description: String::new(),
            raw_tool_name: Some("cached".to_string()),
            input_schema: None,
        }],
        tools_discovered_at: None,
        last_error: None,
    };
    let live = vec![ToolSummary {
        name: "dingtalk__live".to_string(),
        title: None,
        description: String::new(),
        raw_tool_name: Some("live".to_string()),
        input_schema: None,
    }];

    let item = installed_app_projection(&app, Some(&stored), Some(&live)).unwrap();

    assert!(item.callable);
    assert_eq!(
        item.tool_summaries[0].raw_tool_name.as_deref(),
        Some("live")
    );
}

#[test]
fn disconnected_apps_are_not_projected() {
    let app = row_to_app(&app_row(
        9,
        "dingtalk",
        serde_json::json!({"authType": "oauth2", "transport": "streamable-http"}),
    ));

    assert!(installed_app_projection(&app, None, None).is_none());
}

#[tokio::test]
async fn app_connected_looks_up_the_stored_authorization() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let none = app_row(1, "a", serde_json::json!({"authType": "none"}));
    let oauth = app_row(2, "b", serde_json::json!({"authType": "oauth2"}));
    assert!(app_connected(&mysql, &row_to_app(&none), 83).await.unwrap());
    // The capture returns no connection row, so the OAuth app is not
    // connected.
    assert!(
        !app_connected(&mysql, &row_to_app(&oauth), 83)
            .await
            .unwrap()
    );
    // Only the authorized app needs a stored connection lookup.
    assert_eq!(mysql.queries().len(), 1);
    assert!(mysql.queries()[0].sql.contains("ConnectorConnection"));
    assert_eq!(mysql.queries()[0].args, 2);
}

#[tokio::test]
async fn session_headers_carry_the_user_context() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let app = row_to_app(&app_row(1, "a", serde_json::json!({"authType": "none"})));
    let user = UserRow {
        users_id: 83,
        users_user_name: "junshu".to_string(),
        ..user()
    };
    assert_eq!(
        session_headers(&mysql, &app, &user).await.unwrap(),
        (
            vec![
                ("X-Wegent-Username".to_string(), "junshu".to_string()),
                ("X-Wegent-User-Id".to_string(), "83".to_string()),
            ],
            None,
        )
    );
    assert!(mysql.queries().is_empty());
}

/// A legacy HTTP+SSE MCP server that answers with one tool.
async fn spawn_sse_server() -> String {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut chunk = [0_u8; 2048];
                let head = loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&buffer).to_string();
                    if text.contains("\r\n\r\n") {
                        break text;
                    }
                };
                if head.starts_with("GET ") {
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n\
                              event: endpoint\r\ndata: /messages\r\n\r\n",
                        )
                        .await;
                    let _ = stream.flush().await;
                    // Serve the JSON-RPC replies on this same stream.
                    let replies = [
                        "{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"protocolVersion\":\"2024-11-05\"}}",
                        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"read_doc\"}]}}",
                    ]
                    .into_iter();
                    for reply in replies {
                        let frame = format!("event: message\r\ndata: {reply}\r\n\r\n");
                        if stream.write_all(frame.as_bytes()).await.is_err() {
                            return;
                        }
                        let _ = stream.flush().await;
                        // Wait for the next posted message before replying.
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                    return;
                }
                let _ = stream
                    .write_all(b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\n\r\n")
                    .await;
            });
        }
    });
    format!("http://{address}/sse")
}

/// A `transport = "sse"` app must publish the same tool surface the public
/// MCP entry lists; discovery used to assume streamable HTTP and reported
/// no tools for a legacy SSE server.
#[tokio::test]
async fn sse_transport_apps_publish_the_same_tools_as_the_mcp_entry() {
    let url = spawn_sse_server().await;
    let row = app_row(
        11,
        "legacy_sse",
        serde_json::json!({
            "name": "Legacy SSE",
            "mcpUrl": url,
            "enabled": true,
            "authType": "none",
            "transport": "sse",
            "visibility": "all",
            "description": "d",
            "allowedRoles": [],
            "toolAllowlist": [],
        }),
    );
    let app = row_to_app(&row);
    let capture = crate::sql_test_support::KindQueryCapture::default();

    let listed = list_tools(&capture, std::slice::from_ref(&app), &user())
        .await
        .unwrap();

    assert_eq!(listed.len(), 1, "{listed:?}");
    let app_tools = &listed["legacy_sse"];
    assert_eq!(app_tools.len(), 1);
    assert_eq!(app_tools[0].name, "legacy_sse__read_doc");
    assert_eq!(app_tools[0].raw_tool_name, "read_doc");

    // The public MCP entry projects the same upstream tool.
    let entry = mcp::list_tools_for_transport("sse", &app.mcp_url, &[])
        .await
        .unwrap();
    assert_eq!(
        entry
            .iter()
            .map(|tool| tool.name.clone())
            .collect::<Vec<_>>(),
        vec!["read_doc".to_string()]
    );
}

/// HTTP-transport apps contribute their configured operations to the
/// catalog, matching the public MCP entry.
#[tokio::test]
async fn http_transport_apps_publish_their_configured_tools() {
    let row = app_row(
        12,
        "erp",
        serde_json::json!({
            "name": "ERP",
            "mcpUrl": "https://api.example.invalid/v1",
            "enabled": true,
            "authType": "none",
            "transport": "http",
            "visibility": "all",
            "description": "d",
            "allowedRoles": [],
            "toolAllowlist": [],
            "httpTools": [{"name": "lookup", "description": "Lookup", "method": "GET", "path": "/records/{id}"}],
        }),
    );
    let app = row_to_app(&row);
    let capture = crate::sql_test_support::KindQueryCapture::default();

    let listed = list_tools(&capture, std::slice::from_ref(&app), &user())
        .await
        .unwrap();

    assert_eq!(listed.len(), 1, "{listed:?}");
    let app_tools = &listed["erp"];
    assert_eq!(app_tools.len(), 1);
    assert_eq!(app_tools[0].name, "erp__lookup");
    assert_eq!(app_tools[0].raw_tool_name, "lookup");
}

#[tokio::test]
async fn successful_discovery_keeps_an_explicit_empty_app_entry() {
    let url = spawn_sse_server().await;
    let app = row_to_app(&app_row(
        12,
        "erp",
        serde_json::json!({
            "authType": "none",
            "transport": "sse",
            "mcpUrl": url,
            "toolAllowlist": ["not_visible"],
        }),
    ));
    let capture = crate::sql_test_support::KindQueryCapture::default();
    let listed = list_tools(&capture, std::slice::from_ref(&app), &user())
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed["erp"].is_empty());
}
