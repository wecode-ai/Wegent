// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Refreshing HTTP connectors caches their current inline definitions without
/// calling an MCP endpoint or invoking a potentially mutating HTTP operation.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL; included by the existing Rust CI job"]
async fn http_refresh_replaces_cached_definitions_and_preserves_the_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS").unwrap();
    assert!(address.starts_with("127.0.0.1:"));
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_current_grant(&mysql).await;
            mysql
                .execute(
                    "UPDATE kinds SET json = JSON_SET(json, '$.spec.lastError', \
                     JSON_OBJECT('message', 'previous discovery failed'))",
                    (),
                )
                .await
                .unwrap();
            let before = read_spec(&mysql).await;
            let mut app = oauth_app_at("http://127.0.0.1:1");
            app.transport = "http".into();
            app.tool_allowlist = vec!["lookup".into()];
            app.http_tools = vec![
                json!({
                    "name": "lookup", "description": "Current operation",
                    "method": "GET", "path": "/records",
                    "input_schema": {"type": "object", "properties": {"id": {"type": "string"}}}
                }).into(),
                json!({"name": "delete_record", "method": "DELETE", "path": "/records"}).into(),
            ];
            let document = json!({
                "kind": "ConnectorApp",
                "metadata": {"name": SLUG, "namespace": "system"},
                "spec": {
                    "authType": "oauth2", "transport": app.transport,
                    "mcpUrl": app.mcp_url, "toolAllowlist": app.tool_allowlist,
                    "httpTools": app.http_tools.iter().map(|tool| tool.to_value()).collect::<Vec<_>>()
                }
            });
            mysql.execute(
                "INSERT INTO kinds \
                 (user_id, kind, name, namespace, json, is_active, created_at, updated_at) \
                 VALUES (0, 'ConnectorApp', ?, 'system', CAST(? AS JSON), 1, NOW(), NOW())",
                (SLUG, crate::json_compat::python_json_value(&document)),
            ).await.unwrap();

            let response = super::super::refresh_endpoint::refresh_for(&mysql, &user(), SLUG)
                .await.unwrap();
            assert_eq!(response.status, "connected");
            assert_eq!(response.tool_count, 1);
            assert!(response.last_error.is_none());
            assert!(response.last_discovered_at.is_some());
            let current = read_spec(&mysql).await;
            assert_eq!(current["accessTokenEncrypted"], before["accessTokenEncrypted"]);
            assert_eq!(current["refreshTokenEncrypted"], before["refreshTokenEncrypted"]);
            assert_eq!(current["toolSummaries"][0]["rawToolName"], "lookup");
            assert_eq!(
                current["toolSummaries"][0]["inputSchema"],
                json!({"type": "object", "properties": {"id": {"type": "string"}}})
            );
        }
    }).await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; included by the existing Rust CI job"]
async fn connector_catalog_only_selects_active_system_owned_apps() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS").unwrap();
    assert!(address.starts_with("127.0.0.1:"));
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            for (owner, namespace, kind, active) in [
                (USER_ID, "system", "ConnectorApp", 1),
                (0, "personal", "ConnectorApp", 1),
                (0, "system", "ConnectorConnection", 1),
                (0, "system", "ConnectorApp", 0),
                (0, "system", "ConnectorApp", 1),
            ] {
                mysql
                    .execute(
                        "INSERT INTO kinds \
                         (user_id, kind, name, namespace, json, is_active, created_at, updated_at) \
                         VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, NOW(), NOW())",
                        (
                            owner,
                            kind,
                            SLUG,
                            namespace,
                            "{\"spec\":{\"authType\":\"none\"}}",
                            active,
                        ),
                    )
                    .await
                    .unwrap();
            }
            let rows = db::list_connector_app_kinds(&mysql).await.unwrap();
            assert_eq!(
                rows.len(),
                1,
                "Foreign owners and namespaces must not enter the catalog"
            );
            assert_eq!(rows[0].kinds_user_id, 0);
            assert_eq!(rows[0].kinds_namespace, "system");
            assert_eq!(rows[0].kinds_kind, "ConnectorApp");
            assert!(rows[0].kinds_is_active);
            assert_eq!(rows[0].kinds_name, SLUG);
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; included by the existing Rust CI job"]
async fn unreadable_credentials_are_configuration_faults_not_missing_authorization() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS").unwrap();
    assert!(address.starts_with("127.0.0.1:"));
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            for field in ["accessTokenEncrypted", "refreshTokenEncrypted"] {
                mysql.execute("DELETE FROM kinds", ()).await.unwrap();
                seed_current_grant(&mysql).await;
                mysql
                    .execute(
                        "UPDATE kinds SET json = JSON_SET(json, ?, 'unreadable', \
                     '$.spec.expiresAt', '2020-01-01T00:00:00')",
                        (format!("$.spec.{field}"),),
                    )
                    .await
                    .unwrap();
                let before = read_spec(&mysql).await;
                assert!(matches!(
                    service::session_headers(&mysql, &oauth_app(), &user()).await,
                    Err(service::SessionError::Crypto)
                ));
                assert_eq!(read_spec(&mysql).await, before);
                assert!(
                    crate::connector_runtime::list_tools_for_test(&mysql, &[oauth_app()], &user())
                        .await
                        .unwrap()
                        .is_empty()
                );
                let after = read_spec(&mysql).await;
                assert_eq!(
                    after["accessTokenEncrypted"],
                    before["accessTokenEncrypted"]
                );
                assert_eq!(
                    after["refreshTokenEncrypted"],
                    before["refreshTokenEncrypted"]
                );
                assert_eq!(after["status"], "connected");
                assert_eq!(
                    after["lastError"]["message"],
                    "connector credential cannot be decrypted"
                );
            }
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// Wework uses this gateway directory, not the installed-app or public MCP
/// directory. Exercise rejection, transient failure and an account switch here.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL; included by the existing Rust CI job"]
async fn gateway_directory_errors_are_bound_to_the_requested_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS").unwrap();
    assert!(address.starts_with("127.0.0.1:"));
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            for (status, reauthorize) in [(401, false), (500, false), (403, true)] {
                mysql.execute("DELETE FROM kinds", ()).await.unwrap();
                seed_current_grant(&mysql).await;
                let (url, attempted, release) = rejecting_mcp_server(status).await;
                let apps = [oauth_app_at(&url)];
                let listing = tokio::spawn({
                    let mysql = mysql.clone();
                    async move {
                        crate::connector_runtime::list_tools_for_test(&mysql, &apps, &user()).await
                    }
                });
                tokio::time::timeout(std::time::Duration::from_secs(10), attempted)
                    .await
                    .unwrap()
                    .unwrap();
                if reauthorize {
                    rotate_to_a1(&mysql).await;
                }
                release.send(()).unwrap();
                assert!(listing.await.unwrap().unwrap().is_empty());
                let spec = read_spec(&mysql).await;
                assert_eq!(
                    spec["status"],
                    if status == 401 {
                        "expired"
                    } else {
                        "connected"
                    }
                );
                if reauthorize {
                    assert_eq!(spec["lastError"], Value::Null);
                } else {
                    assert_eq!(
                        spec["lastError"]["message"],
                        format!("MCP server returned status {status}")
                    );
                }
                let row = db::find_connector_connection(&mysql, SLUG, USER_ID)
                    .await
                    .unwrap()
                    .unwrap();
                let connection =
                    crate::apps_installed::connection::ConnectorConnection::from_row(&row);
                assert_eq!(
                    connection.access_token().unwrap(),
                    if reauthorize { "A1" } else { "A0" }
                );
                assert_eq!(
                    connection.refresh_token().as_deref(),
                    Some(if reauthorize { "R1" } else { "R0" })
                );
            }
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// The installed-app directory must preserve the authorization error instead
/// of silently removing a rejected app while leaving its status connected.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn installed_directory_rejection_expires_the_used_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_current_grant(&mysql).await;
            let (url, attempted, release) = rejecting_mcp_server(401).await;
            let apps = [oauth_app_at(&url)];
            let listing = tokio::spawn({
                let mysql = mysql.clone();
                async move { service::installed_apps(&mysql, &apps, &user(), false).await }
            });
            attempted.await.unwrap();
            release.send(()).unwrap();
            let response = listing.await.unwrap().unwrap();
            assert_eq!(response.apps.len(), 1);
            assert_eq!(response.apps[0].connection.status, "expired");

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["status"], json!("expired"));
            assert_eq!(
                spec["lastError"]["message"],
                json!("MCP server returned status 401")
            );
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// The MCP directory must apply the same conditional rejection. A delayed
/// response for A0 must not expire the A1 grant committed while it was in flight.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn mcp_directory_late_rejection_keeps_a_newer_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result =
        tokio::spawn({
            let mysql = mysql.clone();
            async move {
                seed_current_grant(&mysql).await;
                let (url, attempted, release) = rejecting_mcp_server(403).await;
                let apps = [oauth_app_at(&url)];
                let listing = tokio::spawn({
                    let mysql = mysql.clone();
                    async move {
                        crate::mcp::connectors::list_tools_for_user(&mysql, &apps, &user()).await
                    }
                });
                attempted.await.unwrap();
                rotate_to_a1(&mysql).await;
                release.send(()).unwrap();
                assert!(listing.await.unwrap().is_empty());

                let spec = read_spec(&mysql).await;
                assert_eq!(spec["status"], json!("connected"));
                assert_eq!(spec["lastError"], json!(null));
                let current = db::find_connector_connection(&mysql, SLUG, USER_ID)
                    .await
                    .unwrap()
                    .expect("the fixture connection exists");
                let current =
                    crate::apps_installed::connection::ConnectorConnection::from_row(&current);
                assert_eq!(current.access_token().unwrap(), "A1");
                assert_eq!(current.refresh_token().as_deref(), Some("R1"));
            }
        })
        .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// A non-auth discovery failure records its diagnostic without invalidating
/// a credential that the upstream did not reject.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn directory_transport_failure_keeps_the_grant_connected() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_current_grant(&mysql).await;
            let (url, attempted, release) = rejecting_mcp_server(500).await;
            let apps = [oauth_app_at(&url)];
            let listing = tokio::spawn({
                let mysql = mysql.clone();
                async move { service::installed_apps(&mysql, &apps, &user(), false).await }
            });
            attempted.await.unwrap();
            release.send(()).unwrap();
            let response = listing.await.unwrap().unwrap();
            assert_eq!(response.apps[0].connection.status, "connected");

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["status"], json!("connected"));
            assert_eq!(
                spec["lastError"]["message"],
                json!("MCP server returned status 500")
            );
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}
