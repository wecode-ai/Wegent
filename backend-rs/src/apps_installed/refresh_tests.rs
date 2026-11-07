// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

/// Serve one HTTP response so the token request hits a real socket.
async fn serve_response(response: &'static str) -> String {
    serve_owned_response(response.to_string()).await
}

/// [`serve_response`] for a response assembled at runtime.
async fn serve_owned_response(response: String) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buffer = [0_u8; 2048];
            let _ = stream.read(&mut buffer).await;
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    format!("http://{address}/oauth/token")
}

#[tokio::test]
async fn token_endpoint_unstructured_4xx_keeps_the_grant() {
    let endpoint = serve_response(
        "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    )
    .await;
    let error = request_tokens(&endpoint, &[("grant_type", "refresh_token")])
        .await
        .unwrap_err();
    assert!(matches!(error, RefreshError::Provider(_)));
}

#[tokio::test]
async fn token_endpoint_invalid_client_keeps_the_grant() {
    let body = r#"{"error":"invalid_client"}"#;
    let endpoint = serve_owned_response(format!(
        "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )).await;
    let error = request_tokens(&endpoint, &[("grant_type", "refresh_token")])
        .await
        .unwrap_err();
    assert!(matches!(error, RefreshError::Provider(_)));
}

#[tokio::test]
async fn token_endpoint_5xx_answers_keep_the_grant() {
    let endpoint = serve_response(
        "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    )
    .await;
    let error = request_tokens(&endpoint, &[("grant_type", "refresh_token")])
        .await
        .unwrap_err();
    assert!(matches!(error, RefreshError::Provider(_)));
}

#[tokio::test]
async fn token_endpoint_rate_limits_keep_the_grant() {
    let endpoint = serve_response(
        "HTTP/1.1 429 Too Many Requests\r\nretry-after: 1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    )
    .await;
    let error = request_tokens(&endpoint, &[("grant_type", "refresh_token")])
        .await
        .unwrap_err();
    assert!(matches!(error, RefreshError::Provider(_)));
}

#[tokio::test]
async fn a_rate_limited_grant_is_reused_for_a_successful_retry() {
    let limited = serve_response(
        "HTTP/1.1 429 Too Many Requests\r\nretry-after: 1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    )
    .await;
    let error = request_tokens(&limited, &[("grant_type", "refresh_token")])
        .await
        .unwrap_err();
    assert!(matches!(error, RefreshError::Provider(_)));

    let body =
        r#"{"access_token":"renewed-access","refresh_token":"renewed-refresh","expires_in":3600}"#;
    let endpoint = serve_owned_response(format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    ))
    .await;
    let payload = request_tokens(
        &endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", "original-refresh"),
        ],
    )
    .await
    .expect("the original grant can refresh after throttling clears");
    let grant = parse_grant(&payload).expect("the renewed grant decodes");
    assert_eq!(grant.access_token, "renewed-access");
    assert_eq!(grant.refresh_token.as_deref(), Some("renewed-refresh"));
}

/// A rejection clears exactly the grant it replaced, and only while that
/// grant is still stored.
#[tokio::test]
async fn rejection_is_conditional_on_the_replaced_grant() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();

    let updated = reject_if_grant(&mysql, 42, "refresh-ciphertext")
        .await
        .unwrap();
    assert_eq!(updated, 0, "the capture reports no affected rows");

    let writes = mysql.writes();
    assert_eq!(writes.len(), 1);
    let sql = &writes[0].sql;
    assert!(sql.contains("JSON_SET"), "{sql}");
    assert!(
        sql.contains("'$.spec.refreshTokenEncrypted', CAST('null' AS JSON)"),
        "{sql}"
    );
    assert!(sql.contains("'$.spec.status', 'expired'"), "{sql}");
    assert!(
        sql.contains("JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.refreshTokenEncrypted')) = ?"),
        "{sql}"
    );
    // The old access token is left for the runtime to reject, exactly like
    // `clear_refresh_token` does.
    assert!(!sql.contains("accessTokenEncrypted"), "{sql}");
}

/// A renewed grant is written while the credential it replaces is still the
/// stored one, or when a competing rejection already cleared that same
/// credential for this attempt's access token.
#[tokio::test]
async fn renewal_is_conditional_on_the_replaced_grant() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let document = json!({"spec": {"status": "connected"}});

    write_json_if_grant(
        &mysql,
        42,
        &document,
        "refresh-ciphertext",
        "access-ciphertext",
    )
    .await
    .unwrap();

    let writes = mysql.writes();
    assert_eq!(writes.len(), 1);
    let sql = &writes[0].sql;
    assert!(sql.contains("CAST(? AS JSON)"), "{sql}");
    assert!(
        sql.contains("JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.refreshTokenEncrypted')) = ?"),
        "{sql}"
    );
    // The delayed rotation still applies after a competing `invalid_grant`
    // cleared this attempt's grant.
    assert!(sql.contains("'$.spec.status')) = 'expired'"), "{sql}");
    assert!(
        sql.contains("JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.accessTokenEncrypted'))"),
        "{sql}"
    );
}

fn client() -> StoredClient {
    StoredClient {
        token_endpoint: "https://provider.example.invalid/oauth/token".to_string(),
        client_id: "client-1".to_string(),
        resource: Some("https://mcp.example.invalid/doc".to_string()),
    }
}

fn app_row(slug: &str, spec: Value) -> ConnectorApp {
    let row = KindRow {
        kinds_id: 7,
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
    };
    super::super::service::row_to_app(&row)
}

fn github_app() -> ConnectorApp {
    app_row(
        GITHUB_SLUG,
        json!({
            "name": "GitHub",
            "mcpUrl": "https://api.githubcopilot.com/mcp/",
            "enabled": true,
            "authType": "oauth2",
            "transport": "streamable-http",
            "visibility": "all",
            "description": "GitHub",
            "allowedRoles": [],
            "toolAllowlist": []
        }),
    )
}

fn github_config() -> OAuthConfig {
    OAuthConfig {
        github_client_id: "gh-client".to_string(),
        github_client_key: "gh-secret".to_string(),
        github_token_endpoint: GITHUB_TOKEN_URL.to_string(),
    }
}

/// GitHub refreshes through the first-party OAuth app: it stores no
/// dynamic registration, so the DCR lookup must not be attempted.
#[test]
fn github_uses_the_first_party_client() {
    let config = github_config();
    let request = token_request(&github_app(), &config).expect("GitHub is configured");
    assert_eq!(request.endpoint(&config), GITHUB_TOKEN_URL);
    assert_eq!(
        request.form("ghr_token"),
        vec![
            ("client_id", "gh-client"),
            (GITHUB_CLIENT_KEY_FIELD, "gh-secret"),
            ("grant_type", "refresh_token"),
            ("refresh_token", "ghr_token"),
        ]
    );
}

/// `_require_github_config`: an unconfigured deployment cannot refresh.
#[test]
fn github_without_configuration_is_unavailable() {
    let config = OAuthConfig {
        github_client_id: String::new(),
        github_client_key: "gh-secret".to_string(),
        github_token_endpoint: GITHUB_TOKEN_URL.to_string(),
    };
    assert!(matches!(
        token_request(&github_app(), &config),
        Err(RefreshError::Unavailable)
    ));
}

/// The dedicated GitHub branch renews a live grant over a real socket: the
/// first-party form goes to the configured endpoint and the token response
/// decodes into a usable grant.
#[tokio::test]
async fn github_exchanges_a_valid_grant_over_http() {
    let body = r#"{"access_token":"gh-access","refresh_token":"gh-refresh-new","token_type":"bearer","expires_in":28800,"scope":"repo read:org"}"#;
    let endpoint = serve_owned_response(format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    ))
    .await;
    let config = OAuthConfig {
        github_client_id: "gh-client".to_string(),
        github_client_key: "gh-secret".to_string(),
        github_token_endpoint: endpoint,
    };
    let request = token_request(&github_app(), &config).expect("GitHub is configured");

    let payload = request_tokens(request.endpoint(&config), &request.form("ghr-old"))
        .await
        .expect("the GitHub endpoint issued a grant");
    let grant = parse_grant(&payload).expect("the grant decodes");

    assert_eq!(grant.access_token, "gh-access");
    assert_eq!(grant.refresh_token.as_deref(), Some("gh-refresh-new"));
    assert_eq!(grant.expires_in, Some(28800));
    assert_eq!(
        grant.granted_scopes,
        Some(vec!["repo".into(), "read:org".into()])
    );
}

/// The same exchange surfaces a revoked GitHub grant as a rejection.
#[tokio::test]
async fn github_reports_a_revoked_grant_as_rejected() {
    let body = r#"{"error":"bad_refresh_token"}"#;
    let endpoint = serve_owned_response(format!(
        "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    ))
    .await;
    let config = OAuthConfig {
        github_client_id: "gh-client".to_string(),
        github_client_key: "gh-secret".to_string(),
        github_token_endpoint: endpoint,
    };
    let request = token_request(&github_app(), &config).expect("GitHub is configured");

    let error = request_tokens(request.endpoint(&config), &request.form("ghr-old"))
        .await
        .unwrap_err();

    assert!(matches!(error, RefreshError::Rejected));
}

/// Every other app still requires its stored dynamic registration.
#[test]
fn other_apps_require_a_stored_registration() {
    let app = app_row(
        "dingtalk_docs",
        json!({
            "name": "DingTalk Docs",
            "mcpUrl": "https://mcp.example.invalid/doc",
            "enabled": true,
            "authType": "oauth2",
            "transport": "streamable-http",
            "visibility": "all",
            "description": "d",
            "allowedRoles": [],
            "toolAllowlist": []
        }),
    );
    assert!(matches!(
        token_request(&app, &github_config()),
        Err(RefreshError::Unavailable)
    ));
}

fn kind_row(document: Value) -> KindRow {
    KindRow {
        kinds_id: 42,
        kinds_user_id: 128,
        kinds_kind: "ConnectorConnection".to_string(),
        kinds_name: "dingtalk_docs".to_string(),
        kinds_namespace: "system".to_string(),
        kinds_json: brz_mysql::Json(document.into()),
        kinds_is_active: true,
        kinds_created_at: chrono::NaiveDateTime::default(),
        kinds_updated_at: chrono::NaiveDateTime::default(),
    }
}

fn connection_document() -> Value {
    json!({
        "spec": {
            "status": "connected",
            "accessTokenEncrypted": "access",
            "refreshTokenEncrypted": "refresh",
            "toolSummaries": [{"name": "old__tool", "rawToolName": "tool"}],
            "toolsDiscoveredAt": "2026-01-01T00:00:00+00:00",
            "lastError": null,
        }
    })
}

/// A rejected credential flips the status while the same statement leaves
/// every credential member untouched.
#[tokio::test]
async fn a_rejected_credential_marks_the_connection_expired() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let row = kind_row(connection_document());

    write_discovery_state(
        &mysql,
        &row,
        "access",
        &DiscoveryState {
            last_error: Some("MCP server returned status 401"),
            expired: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let writes = mysql.writes();
    assert_eq!(writes.len(), 1);
    let sql = &writes[0].sql;
    assert!(sql.contains("JSON_SET"), "{sql}");
    assert!(sql.contains("'$.spec.lastError'"), "{sql}");
    assert!(sql.contains("'$.spec.status', 'expired'"), "{sql}");
    // The grant and the cached surface survive the patch.
    assert!(
        !sql.split("WHERE")
            .next()
            .unwrap()
            .contains("accessTokenEncrypted"),
        "{sql}"
    );
    assert!(sql.contains("AND is_active = 1"), "{sql}");
    assert_eq!(writes[0].args, 3);
    assert!(!sql.contains("refreshTokenEncrypted"), "{sql}");
    assert!(!sql.contains("toolSummaries"), "{sql}");
    assert!(!sql.contains("json = ?"), "{sql}");
}

/// A successful pass replaces the cached surface through the same partial
/// patch, so a rotated grant written meanwhile stays in place.
#[tokio::test]
async fn a_recovered_upstream_replaces_the_cached_surface() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let row = kind_row(connection_document());
    let summaries = vec![json!({
        "name": "dingtalk_docs__new_tool",
        "title": null,
        "description": "d",
        "rawToolName": "new_tool",
        "inputSchema": {"type": "object"},
    })];

    write_discovery_state(
        &mysql,
        &row,
        "access",
        &DiscoveryState {
            discovered_at: Some("2026-10-28T10:00:00+00:00"),
            tool_summaries: Some(&summaries),
            last_error: None,
            expired: false,
        },
    )
    .await
    .unwrap();

    let writes = mysql.writes();
    assert_eq!(writes.len(), 1);
    let sql = &writes[0].sql;
    assert!(sql.contains("JSON_SET"), "{sql}");
    assert!(sql.contains("'$.spec.toolsDiscoveredAt'"), "{sql}");
    assert!(sql.contains("'$.spec.toolSummaries'"), "{sql}");
    assert!(
        sql.contains("'$.spec.lastError', CAST('null' AS JSON)"),
        "{sql}"
    );
    assert!(
        !sql.split("WHERE")
            .next()
            .unwrap()
            .contains("accessTokenEncrypted"),
        "{sql}"
    );
    assert!(sql.contains("AND is_active = 1"), "{sql}");
    assert!(!sql.contains("refreshTokenEncrypted"), "{sql}");
    assert!(!sql.contains("expiresAt"), "{sql}");
    assert!(!sql.contains("json = ?"), "{sql}");
}

/// `mark_expired` patches only the status member.
#[tokio::test]
async fn marking_a_connection_expired_keeps_the_grant() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();

    reject_credential_if_current(&mysql, 42, "access-ciphertext", None)
        .await
        .unwrap();

    let writes = mysql.writes();
    assert_eq!(writes.len(), 1);
    let sql = &writes[0].sql;
    assert!(sql.contains("'$.spec.status', 'expired'"), "{sql}");
    assert!(!sql.contains("refreshTokenEncrypted"), "{sql}");
    assert_eq!(writes[0].first_integer, Some(42));
}

/// A late upstream 401 only expires the access token that produced it.
#[tokio::test]
async fn a_rejected_credential_update_is_conditional_on_its_grant() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();

    reject_credential_if_current(&mysql, 42, "access-ciphertext", None)
        .await
        .unwrap();

    let writes = mysql.writes();
    assert_eq!(writes.len(), 1);
    let sql = &writes[0].sql;
    assert!(sql.contains("'$.spec.status', 'expired'"), "{sql}");
    assert!(sql.contains("accessTokenEncrypted"), "{sql}");
    assert!(sql.contains("= ?"), "{sql}");
}

fn connection(refresh_token_encrypted: Option<&str>) -> ConnectorConnection {
    ConnectorConnection {
        status: "connected".to_string(),
        external_account_name: Some("chenbo".to_string()),
        granted_scopes: vec!["b".to_string(), "a".to_string()],
        expires_at: None,
        access_token_encrypted: String::new(),
        refresh_token_encrypted: refresh_token_encrypted.map(str::to_owned),
        token_type: "Bearer".to_string(),
        tool_summaries: Vec::new(),
        tools_discovered_at: None,
        last_error: None,
    }
}

/// `client_id`, `grant_type`, `refresh_token`, then `resource`.
#[test]
fn refresh_form_matches_the_source_field_order() {
    assert_eq!(
        refresh_form(&client(), "mcpr_token"),
        vec![
            ("client_id", "client-1"),
            ("grant_type", "refresh_token"),
            ("refresh_token", "mcpr_token"),
            ("resource", "https://mcp.example.invalid/doc"),
        ]
    );
}

/// A registration without a resource omits the member entirely.
#[test]
fn refresh_form_omits_an_empty_resource() {
    let mut client = client();
    client.resource = Some(String::new());
    assert_eq!(refresh_form(&client, "t").len(), 3);
}

/// `scope.replace(",", " ").split()`.
#[test]
fn grant_scopes_split_on_commas_and_whitespace() {
    let grant = parse_grant(&json!({
        "access_token": "a",
        "scope": "doc.read, doc.write  openid",
    }))
    .unwrap();
    assert_eq!(
        grant.granted_scopes.unwrap(),
        vec!["doc.read", "doc.write", "openid"]
    );
}

/// A payload carrying `error` is the source's rejected grant.
#[test]
fn grant_with_error_member_is_rejected() {
    assert!(matches!(
        parse_grant(&json!({"error": "invalid_grant"})),
        Err(RefreshError::Rejected)
    ));
}

/// A malformed response must not destroy a renewable grant.
#[test]
fn grant_without_access_token_keeps_the_grant() {
    assert!(matches!(
        parse_grant(&json!({"token_type": "bearer"})),
        Err(RefreshError::Provider(_))
    ));
}

#[test]
fn transient_or_configuration_oauth_errors_keep_the_grant() {
    for error in [
        "invalid_client",
        "invalid_request",
        "temporarily_unavailable",
        "server_error",
    ] {
        assert!(matches!(
            parse_grant(&json!({"error": error})),
            Err(RefreshError::Provider(_))
        ));
    }
}

/// The rewritten document keeps the account and scopes, sorts them, and
/// carries the new tokens plus a future expiry.
#[test]
fn payload_rewrites_tokens_and_sorts_scopes() {
    crate::subscriptions_item::crypto::use_test_key();
    let grant = parse_grant(&json!({
        "access_token": "new-access",
        "refresh_token": "new-refresh",
        "token_type": "Bearer",
        "expires_in": 7200,
    }))
    .unwrap();
    let document =
        connection_payload("dingtalk_docs", &connection(Some("old")), &grant, "old").unwrap();
    let spec = &document["spec"];

    assert_eq!(spec["status"], json!("connected"));
    assert_eq!(spec["externalAccountName"], json!("chenbo"));
    assert_eq!(spec["grantedScopes"], json!(["a", "b"]));
    assert_eq!(spec["tokenType"], json!("Bearer"));
    assert!(
        spec["expiresAt"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(
        decrypt_sensitive_data(spec["accessTokenEncrypted"].as_str().unwrap()).unwrap(),
        "new-access"
    );
    assert_eq!(
        decrypt_sensitive_data(spec["refreshTokenEncrypted"].as_str().unwrap()).unwrap(),
        "new-refresh"
    );
}

/// A response without a new refresh token keeps the one that was sent.
#[test]
fn payload_keeps_the_sent_refresh_token_when_the_response_omits_it() {
    crate::subscriptions_item::crypto::use_test_key();
    let grant = parse_grant(&json!({"access_token": "new-access"})).unwrap();
    let document =
        connection_payload("dingtalk_docs", &connection(Some("old")), &grant, "sent").unwrap();
    assert_eq!(
        decrypt_sensitive_data(document["spec"]["refreshTokenEncrypted"].as_str().unwrap())
            .unwrap(),
        "sent"
    );
}
