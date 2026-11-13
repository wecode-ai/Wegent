// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real MySQL coverage for the connector discovery-state patch.
//!
//! The regression these tests guard is a read-modify-write: the MCP listing
//! reads the connection, `session_headers` may rotate the grant, and the
//! discovery result is written afterwards. Writing a document captured before
//! the rotation would restore the previous access/refresh token.

use std::time::{SystemTime, UNIX_EPOCH};

use brz_mysql::MysqlService;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use super::db::{self, UserRow};
use super::refresh::{self, DiscoveryState};
use super::service::{self, ConnectorApp};

const USER_ID: i64 = 4242;
const SLUG: &str = "mysql-refresh-fixture";

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; included by the existing Rust CI job"]
async fn old_account_discovery_cannot_update_a_reauthorized_connection() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS").unwrap();
    assert!(address.starts_with("127.0.0.1:"));
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            let old = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .unwrap();
            rotate_grant(&mysql, "2035-01-01T00:00:00").await;
            let tools = vec![json!({"name": format!("{SLUG}__private")})];

            refresh::write_discovery_state(
                &mysql,
                &old,
                "old-access",
                &DiscoveryState {
                    discovered_at: Some("2026-11-05T00:00:00+00:00"),
                    tool_summaries: Some(&tools),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            refresh::record_directory_error(
                &mysql,
                Some(&old),
                Some("old-access"),
                &super::mcp::McpError::Transport("old account failure".into()),
            )
            .await;

            let current = read_spec(&mysql).await;
            assert_eq!(current["accessTokenEncrypted"], "new-access");
            assert_eq!(current["toolSummaries"], json!([]));
            assert_eq!(current["toolsDiscoveredAt"], Value::Null);
            assert_eq!(current["lastError"], Value::Null);
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

async fn connect(address: &str) -> (MysqlService, MysqlService, String) {
    let url = |database: &str| format!("mysql://root@{address}/{database}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let name = format!(
        "connector_refresh_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    admin
        .execute(format!("CREATE DATABASE {name}"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect(&url(&name)).await.unwrap();
    mysql
        .execute(
            "CREATE TABLE kinds (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                kind VARCHAR(64) NOT NULL,
                name VARCHAR(128) NOT NULL,
                namespace VARCHAR(64) NOT NULL,
                json JSON NOT NULL,
                is_active TINYINT NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )",
            (),
        )
        .await
        .unwrap();
    (admin, mysql, name)
}

async fn disconnect(admin: MysqlService, mysql: MysqlService, name: &str) {
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE {name}"), ())
        .await
        .unwrap();
    admin.close().await;
}

/// Insert one connected grant with an expired token pair.
async fn seed_expired_grant(mysql: &MysqlService, expires_at: &str) {
    let document = json!({
        "apiVersion": "agent.wecode.io/v1",
        "kind": "ConnectorConnection",
        "metadata": {"name": SLUG, "namespace": "system"},
        "spec": {
            "connectorAppSlug": SLUG,
            "status": "connected",
            "grantedScopes": ["mcp.read"],
            "expiresAt": expires_at,
            "accessTokenEncrypted": "old-access",
            "refreshTokenEncrypted": "old-refresh",
            "tokenType": "bearer",
            "toolSummaries": [{"name": format!("{SLUG}__old"), "rawToolName": "old"}],
            "toolsDiscoveredAt": "2020-01-01T00:00:00",
            "lastError": null,
        }
    });
    mysql
        .execute(
            "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
             VALUES (?, 'ConnectorConnection', ?, 'system', CAST(? AS JSON), 1, NOW(), NOW())",
            (
                USER_ID,
                SLUG,
                crate::json_compat::python_json_value(&document),
            ),
        )
        .await
        .unwrap();
}

/// The grant `session_headers` writes after rotating the refresh token.
async fn rotate_grant(mysql: &MysqlService, expires_at: &str) {
    let document = json!({
        "apiVersion": "agent.wecode.io/v1",
        "kind": "ConnectorConnection",
        "metadata": {"name": SLUG, "namespace": "system"},
        "spec": {
            "connectorAppSlug": SLUG,
            "status": "connected",
            "grantedScopes": ["mcp.read"],
            "expiresAt": expires_at,
            "accessTokenEncrypted": "new-access",
            "refreshTokenEncrypted": "new-refresh",
            "tokenType": "bearer",
            "toolSummaries": [],
            "toolsDiscoveredAt": null,
            "lastError": null,
        }
    });
    mysql
        .execute(
            "UPDATE kinds SET json = CAST(? AS JSON) WHERE user_id = ? AND kind = 'ConnectorConnection'",
            (crate::json_compat::python_json_value(&document), USER_ID),
        )
        .await
        .unwrap();
}

async fn read_spec(mysql: &MysqlService) -> Value {
    let row = db::find_connector_connection(mysql, SLUG, USER_ID)
        .await
        .unwrap()
        .expect("the fixture connection exists");
    row.kinds_json.0.to_value()["spec"].clone()
}

fn oauth_app() -> ConnectorApp {
    oauth_app_at("https://mcp.example.test/mcp")
}

fn oauth_app_at(url: &str) -> ConnectorApp {
    service::row_to_app(&db::KindRow {
        kinds_id: 1,
        kinds_user_id: 0,
        kinds_kind: "ConnectorApp".to_string(),
        kinds_name: SLUG.to_string(),
        kinds_namespace: "system".to_string(),
        kinds_json: brz_mysql::Json(
            json!({
                "kind": "ConnectorApp",
                "spec": {
                    "name": SLUG,
                    "mcpUrl": url,
                    "authType": "oauth2",
                    "transport": "streamable-http",
                }
            })
            .into(),
        ),
        kinds_is_active: true,
        kinds_created_at: chrono::NaiveDateTime::default(),
        kinds_updated_at: chrono::NaiveDateTime::default(),
    })
}

fn user() -> UserRow {
    UserRow {
        users_id: USER_ID,
        users_user_name: "integration-user".to_string(),
        users_password_hash: String::new(),
        users_email: None,
        users_git_info: None,
        users_is_active: true,
        users_role: "user".to_string(),
        users_auth_source: "oidc".to_string(),
        users_preferences: String::new(),
        users_created_at: chrono::NaiveDateTime::default(),
        users_updated_at: chrono::NaiveDateTime::default(),
    }
}

async fn seed_current_grant(mysql: &MysqlService) {
    seed_expired_grant(mysql, "2035-01-01T00:00:00").await;
    crate::subscriptions_item::crypto::use_test_key();
    let access = crate::subscriptions_item::crypto::encrypt_sensitive_data("A0").unwrap();
    let refresh = crate::subscriptions_item::crypto::encrypt_sensitive_data("R0").unwrap();
    mysql
        .execute(
            "UPDATE kinds SET json = JSON_SET(json, '$.spec.accessTokenEncrypted', ?, \
             '$.spec.refreshTokenEncrypted', ?)",
            (access.as_str(), refresh.as_str()),
        )
        .await
        .unwrap();
}

/// Reject the initial MCP handshake and hold the first request until the test
/// has the exact access-token snapshot used by the directory entry.
async fn rejecting_mcp_server(
    status: u16,
) -> (
    String,
    tokio::sync::oneshot::Receiver<()>,
    tokio::sync::oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (attempted_tx, attempted_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let mut buffer = [0_u8; 8192];
        let _ = stream.read(&mut buffer).await.unwrap();
        let _ = attempted_tx.send(());
        let _ = release_rx.await;
        let response = format!(
            "HTTP/1.1 {status} Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        );
        let _ = stream.write_all(response.as_bytes()).await;
    });
    (format!("http://{address}/mcp"), attempted_rx, release_tx)
}

async fn rotate_to_a1(mysql: &MysqlService) {
    crate::subscriptions_item::crypto::use_test_key();
    let access = crate::subscriptions_item::crypto::encrypt_sensitive_data("A1").unwrap();
    let refresh = crate::subscriptions_item::crypto::encrypt_sensitive_data("R1").unwrap();
    mysql
        .execute(
            "UPDATE kinds SET json = JSON_SET(json, '$.spec.accessTokenEncrypted', ?, \
             '$.spec.refreshTokenEncrypted', ?, '$.spec.status', 'connected')",
            (access.as_str(), refresh.as_str()),
        )
        .await
        .unwrap();
}

/// The stale row a listing read before the grant rotation must not put the old
/// tokens back when it records the discovery result.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn discovery_does_not_overwrite_a_rotated_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            // The listing's pre-call snapshot.
            let stale = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");

            // `session_headers` refreshes the expired grant between the read and
            // the discovery write.
            rotate_grant(&mysql, "2035-01-01T00:00:00").await;

            let summaries = vec![json!({
                "name": format!("{SLUG}__fresh"),
                "rawToolName": "fresh",
                "description": "Fresh tool",
                "inputSchema": {"type": "object"},
            })];
            refresh::write_discovery_state(
                &mysql,
                &stale,
                "new-access",
                &DiscoveryState {
                    discovered_at: Some("2026-10-29T00:00:00+00:00"),
                    tool_summaries: Some(&summaries),
                    last_error: None,
                    expired: false,
                },
            )
            .await
            .unwrap();

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["accessTokenEncrypted"], json!("new-access"));
            assert_eq!(spec["refreshTokenEncrypted"], json!("new-refresh"));
            assert_eq!(spec["expiresAt"], json!("2035-01-01T00:00:00"));
            assert_eq!(spec["status"], json!("connected"));
            assert_eq!(
                spec["toolsDiscoveredAt"],
                json!("2026-10-29T00:00:00+00:00")
            );
            assert_eq!(spec["toolSummaries"][0]["rawToolName"], json!("fresh"));
            assert_eq!(spec["lastError"], json!(null));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// A concurrent rejection clears the refresh token and expires the connection;
/// a discovery write that started before it must not revive either.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn discovery_does_not_revive_a_rejected_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            let stale = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");

            // Another request's refresh was rejected in the meantime.
            refresh::reject_credential_if_current(&mysql, stale.kinds_id, "old-access", None)
                .await
                .unwrap();
            mysql
                .execute(
                    "UPDATE kinds SET json = JSON_SET(json, '$.spec.refreshTokenEncrypted', CAST('null' AS JSON))
                     WHERE user_id = ? AND kind = 'ConnectorConnection'",
                    (USER_ID,),
                )
                .await
                .unwrap();

            let summaries = vec![json!({
                "name": format!("{SLUG}__fresh"),
                "rawToolName": "fresh",
                "description": "Fresh tool",
                "inputSchema": {"type": "object"},
            })];
            refresh::write_discovery_state(
                &mysql,
                &stale,
                "old-access",
                &DiscoveryState {
                    discovered_at: Some("2026-10-29T00:00:00+00:00"),
                    tool_summaries: Some(&summaries),
                    last_error: None,
                    expired: false,
                },
            )
            .await
            .unwrap();

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["status"], json!("expired"));
            assert_eq!(spec["refreshTokenEncrypted"], json!(null));
            assert_eq!(spec["toolSummaries"][0]["rawToolName"], json!("fresh"));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// The concurrent-refresh race: two attempts read the same grant, the first
/// commits a rotation, and the second is then rejected by the provider. The
/// rejection must not clear the winner's refresh token.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn a_stale_rejection_keeps_a_newer_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            let stale = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");

            // Request A committed its rotation while request B was waiting.
            rotate_grant(&mysql, "2035-01-01T00:00:00").await;

            // Request B's refresh was rejected and tries to clear the grant.
            let updated = refresh::reject_if_grant(&mysql, stale.kinds_id, "old-refresh")
                .await
                .unwrap();
            assert_eq!(updated, 0, "the stale attempt must not touch the row");

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["status"], json!("connected"));
            assert_eq!(spec["accessTokenEncrypted"], json!("new-access"));
            assert_eq!(spec["refreshTokenEncrypted"], json!("new-refresh"));
            assert_eq!(spec["expiresAt"], json!("2035-01-01T00:00:00"));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// The same race on the success path: a slower attempt must not replace the
/// grant another attempt already committed.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn a_stale_renewal_keeps_a_newer_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            let stale = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");
            rotate_grant(&mysql, "2035-01-01T00:00:00").await;

            let stale_document = json!({
                "apiVersion": "agent.wecode.io/v1",
                "kind": "ConnectorConnection",
                "metadata": {"name": SLUG, "namespace": "system"},
                "spec": {
                    "connectorAppSlug": SLUG,
                    "status": "connected",
                    "expiresAt": "2035-01-01T00:00:00",
                    "accessTokenEncrypted": "attempt-access",
                    "refreshTokenEncrypted": "attempt-refresh",
                }
            });
            let updated = refresh::write_json_if_grant(
                &mysql,
                stale.kinds_id,
                &stale_document,
                "old-refresh",
                "",
            )
            .await
            .unwrap();
            assert_eq!(updated, 0, "the stale attempt must not overwrite the row");

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["accessTokenEncrypted"], json!("new-access"));
            assert_eq!(spec["refreshTokenEncrypted"], json!("new-refresh"));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// The rejection still applies when the credential it replaced is unchanged.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn a_rejection_clears_the_grant_it_replaced() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            let stale = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");

            let updated = refresh::reject_if_grant(&mysql, stale.kinds_id, "old-refresh")
                .await
                .unwrap();
            assert_eq!(updated, 1);

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["status"], json!("expired"));
            assert_eq!(spec["refreshTokenEncrypted"], json!(null));
            assert_eq!(spec["accessTokenEncrypted"], json!("old-access"));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// A disconnect during a refresh wins: the stale attempt cannot restore the
/// grant it was renewing.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn a_disconnect_during_refresh_is_not_revived() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            let stale = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");

            // The user disconnected while the refresh request was in flight.
            mysql
                .execute(
                    "UPDATE kinds SET json = JSON_SET(json, \
                     '$.spec.status', 'disconnected', \
                     '$.spec.refreshTokenEncrypted', CAST('null' AS JSON), \
                     '$.spec.accessTokenEncrypted', '') \
                     WHERE user_id = ? AND kind = 'ConnectorConnection'",
                    (USER_ID,),
                )
                .await
                .unwrap();

            let renewed = json!({
                "apiVersion": "agent.wecode.io/v1",
                "kind": "ConnectorConnection",
                "metadata": {"name": SLUG, "namespace": "system"},
                "spec": {
                    "connectorAppSlug": SLUG,
                    "status": "connected",
                    "accessTokenEncrypted": "attempt-access",
                    "refreshTokenEncrypted": "attempt-refresh",
                }
            });
            assert_eq!(
                refresh::write_json_if_grant(&mysql, stale.kinds_id, &renewed, "old-refresh", "",)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                refresh::reject_if_grant(&mysql, stale.kinds_id, "old-refresh")
                    .await
                    .unwrap(),
                0
            );

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["status"], json!("disconnected"));
            assert_eq!(spec["refreshTokenEncrypted"], json!(null));
            assert_eq!(spec["accessTokenEncrypted"], json!(""));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// A rejection for the started grant can commit before the rotation it lost.
///
/// The token endpoint rotates the refresh token on first use, so the losing
/// request is answered with `invalid_grant` for the same starting grant. If
/// that rejection commits first, the delayed successful rotation still has to
/// restore the grant instead of leaving the connection unusable.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn a_rejection_committed_first_still_keeps_the_rotation() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            let stale = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");

            // The competing request is rejected first for the same grant.
            assert_eq!(
                refresh::reject_if_grant(&mysql, stale.kinds_id, "old-refresh")
                    .await
                    .unwrap(),
                1
            );
            let rejected = read_spec(&mysql).await;
            assert_eq!(rejected["status"], json!("expired"));
            assert_eq!(rejected["refreshTokenEncrypted"], json!(null));
            assert_eq!(rejected["accessTokenEncrypted"], json!("old-access"));

            let rotated = json!({
                "apiVersion": "agent.wecode.io/v1",
                "kind": "ConnectorConnection",
                "metadata": {"name": SLUG, "namespace": "system"},
                "spec": {
                    "connectorAppSlug": SLUG,
                    "status": "connected",
                    "grantedScopes": ["mcp.read"],
                    "expiresAt": "2035-01-01T00:00:00",
                    "accessTokenEncrypted": "rotated-access",
                    "refreshTokenEncrypted": "rotated-refresh",
                    "tokenType": "bearer",
                }
            });
            assert_eq!(
                refresh::write_json_if_grant(
                    &mysql,
                    stale.kinds_id,
                    &rotated,
                    "old-refresh",
                    "old-access",
                )
                .await
                .unwrap(),
                1,
                "the delayed rotation restores the cleared grant"
            );

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["status"], json!("connected"));
            assert_eq!(spec["accessTokenEncrypted"], json!("rotated-access"));
            assert_eq!(spec["refreshTokenEncrypted"], json!("rotated-refresh"));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// The same delayed rotation must not reopen a grant the user replaced.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn a_delayed_rotation_does_not_replace_a_reauthorized_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            let stale = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");
            refresh::reject_if_grant(&mysql, stale.kinds_id, "old-refresh")
                .await
                .unwrap();
            rotate_grant(&mysql, "2035-01-01T00:00:00").await;

            let rotated = json!({
                "apiVersion": "agent.wecode.io/v1",
                "kind": "ConnectorConnection",
                "metadata": {"name": SLUG, "namespace": "system"},
                "spec": {
                    "connectorAppSlug": SLUG,
                    "status": "connected",
                    "accessTokenEncrypted": "stale-access",
                    "refreshTokenEncrypted": "stale-refresh",
                }
            });
            assert_eq!(
                refresh::write_json_if_grant(
                    &mysql,
                    stale.kinds_id,
                    &rotated,
                    "old-refresh",
                    "old-access",
                )
                .await
                .unwrap(),
                0,
                "the re-authorized grant is authoritative"
            );

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["accessTokenEncrypted"], json!("new-access"));
            assert_eq!(spec["refreshTokenEncrypted"], json!("new-refresh"));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// An upstream 401 for the old access token cannot invalidate a newer grant.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn a_late_tool_rejection_does_not_expire_a_newer_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_current_grant(&mysql).await;
            let attempted = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");
            crate::subscriptions_item::crypto::use_test_key();
            let old_access = crate::subscriptions_item::crypto::encrypt_sensitive_data("A0")
                .unwrap();
            mysql
                .execute(
                    "UPDATE kinds SET json = JSON_SET(json, '$.spec.accessTokenEncrypted', ?) WHERE id = ?",
                    (old_access.as_str(), attempted.kinds_id),
                )
                .await
                .unwrap();
            let (headers, attempted_access) =
                service::session_headers(&mysql, &oauth_app(), &user())
                    .await
                    .unwrap();
            assert!(headers.contains(&(
                "Authorization".to_string(),
                "Bearer A0".to_string(),
            )));
            assert_eq!(attempted_access.as_deref(), Some(old_access.as_str()));
            rotate_grant(&mysql, "2035-01-01T00:00:00").await;

            refresh::reject_credential_if_current(
                &mysql,
                attempted.kinds_id,
                attempted_access.as_deref().unwrap(),
                Some("upstream 401"),
            )
            .await
            .unwrap();

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["status"], json!("connected"));
            assert_eq!(spec["accessTokenEncrypted"], json!("new-access"));
            assert_eq!(spec["refreshTokenEncrypted"], json!("new-refresh"));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

/// A rejection of the access token still in use expires that grant, keeping
/// its refresh token available for a later renewal.
#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn a_current_tool_rejection_expires_only_the_used_grant() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let (admin, mysql, name) = connect(&address).await;
    let result = tokio::spawn({
        let mysql = mysql.clone();
        async move {
            seed_expired_grant(&mysql, "2020-01-01T00:00:00").await;
            let attempted = db::find_connector_connection(&mysql, SLUG, USER_ID)
                .await
                .unwrap()
                .expect("seeded row");

            refresh::reject_credential_if_current(
                &mysql,
                attempted.kinds_id,
                "old-access",
                Some("upstream 401"),
            )
            .await
            .unwrap();

            let spec = read_spec(&mysql).await;
            assert_eq!(spec["status"], json!("expired"));
            assert_eq!(spec["accessTokenEncrypted"], json!("old-access"));
            assert_eq!(spec["refreshTokenEncrypted"], json!("old-refresh"));
            assert_eq!(spec["lastError"]["message"], json!("upstream 401"));
        }
    })
    .await;
    disconnect(admin, mysql, &name).await;
    result.unwrap();
}

#[path = "refresh_directory_mysql_tests.rs"]
mod directories;
