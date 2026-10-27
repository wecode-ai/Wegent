// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! OAuth grant refresh for an expired connector connection.
//!
//! Ports `ConnectorOAuthService.refresh_connection` together with the
//! `save_oauth_connection`, `clear_refresh_token`, and `set_status` writes it
//! performs, so `session_headers` renews an expired grant before tool
//! discovery exactly like the Python runtime does.
//!
//! Failure classes follow the source: a transport failure or a 5xx answer
//! keeps the refresh token for a later retry, a 4xx answer or a payload
//! carrying `error` clears it, and an unreadable credential is a
//! configuration fault rather than a rejected grant.

use std::time::Duration;

use brz_http::Client as HttpClient;
use brz_mysql::{Mysql, MysqlError};
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use super::connection::{ConnectorConnection, render_datetime};
use super::db::{self, KindRow};
use super::service::ConnectorApp;
use crate::subscriptions_item::crypto::{
    CryptoError, decrypt_sensitive_data, encrypt_sensitive_data,
};

/// `DISCOVERY_TIMEOUT_SECONDS`: the source bounds the token exchange with it.
const REFRESH_TIMEOUT: Duration = Duration::from_secs(30);

/// `CONNECTOR_CONNECTION_NAMESPACE` used by `save_oauth_connection`.
const CONNECTION_NAMESPACE: &str = "system";

/// One reason a stored grant could not be renewed.
#[derive(Debug)]
pub(crate) enum RefreshError {
    /// No stored connection, no readable refresh token, or no stored client
    /// registration to refresh against.
    Unavailable,
    /// `GIT_TOKEN_AES_KEY`/`GIT_TOKEN_AES_IV` cannot read the stored values.
    Crypto(CryptoError),
    /// A transport failure or a 5xx answer: the grant is kept for a retry.
    Provider(String),
    /// The token endpoint rejected the grant: the refresh token is cleared.
    Rejected,
    Database(MysqlError),
}

impl std::fmt::Display for RefreshError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("no renewable grant is stored"),
            Self::Crypto(error) => write!(formatter, "sensitive-data key unavailable: {error}"),
            Self::Provider(message) => write!(formatter, "token endpoint failed: {message}"),
            Self::Rejected => formatter.write_str("token endpoint rejected the refresh token"),
            Self::Database(error) => write!(formatter, "connection write failed: {error}"),
        }
    }
}

/// `_stored_dynamic_client(app)`: the dynamically registered OAuth client.
#[derive(Debug, Deserialize)]
struct StoredClient {
    token_endpoint: String,
    client_id: String,
    #[serde(default)]
    resource: Option<String>,
}

/// The fields of one token response the source reads.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct TokenGrant {
    access_token: String,
    refresh_token: Option<String>,
    token_type: Option<String>,
    granted_scopes: Option<Vec<String>>,
    expires_in: Option<i64>,
}

/// Refresh the stored grant for `app` and `user_id`, returning the renewed
/// connection. Every write mirrors the source so the Python runtime and this
/// path stay interchangeable.
pub(crate) async fn refresh<M>(
    mysql: &M,
    app: &ConnectorApp,
    user_id: i64,
) -> Result<ConnectorConnection, RefreshError>
where
    M: Mysql,
{
    let row = db::find_connector_connection(mysql, &app.slug, user_id)
        .await
        .map_err(RefreshError::Database)?
        .ok_or(RefreshError::Unavailable)?;
    let previous = ConnectorConnection::from_row(&row);
    let refresh_token = previous.refresh_token().ok_or(RefreshError::Unavailable)?;
    let client = stored_client(app)?;
    let form = refresh_form(&client, &refresh_token);
    // A rejected request and a rejected payload both mean the stored grant is
    // unusable, so both must clear it before reporting the rejection.
    let payload = match request_tokens(&client.token_endpoint, &form).await {
        Ok(payload) => payload,
        Err(RefreshError::Rejected) => {
            reject(mysql, &row).await?;
            return Err(RefreshError::Rejected);
        }
        Err(error) => return Err(error),
    };

    match parse_grant(&payload) {
        Ok(grant) => {
            let document = connection_payload(&app.slug, &previous, &grant, &refresh_token)?;
            write_json(mysql, row.kinds_id, &document).await?;
            reload(mysql, &app.slug, user_id).await
        }
        Err(RefreshError::Rejected) => {
            reject(mysql, &row).await?;
            Err(RefreshError::Rejected)
        }
        Err(error) => Err(error),
    }
}

/// `_stored_dynamic_client`: decrypt and decode the stored client.
fn stored_client(app: &ConnectorApp) -> Result<StoredClient, RefreshError> {
    let encrypted = app
        .oauth_client_encrypted
        .as_deref()
        .ok_or(RefreshError::Unavailable)?;
    let plain = decrypt_sensitive_data(encrypted).map_err(RefreshError::Crypto)?;
    if plain == encrypted {
        // The ciphertext came back unchanged: the configured key is wrong.
        return Err(RefreshError::Unavailable);
    }
    serde_json::from_str::<StoredClient>(&plain).map_err(|_| RefreshError::Unavailable)
}

/// The refresh request body, in the order the source sends it.
fn refresh_form<'a>(client: &'a StoredClient, refresh_token: &'a str) -> Vec<(&'a str, &'a str)> {
    let mut form = vec![
        ("client_id", client.client_id.as_str()),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ];
    if let Some(resource) = client.resource.as_deref().filter(|value| !value.is_empty()) {
        form.push(("resource", resource));
    }
    form
}

/// POST the form to the token endpoint.
///
/// `raise_for_status()` runs before the body is read in the source, so a 4xx
/// answer is a rejected grant even when its body is not JSON.
async fn request_tokens(endpoint: &str, form: &[(&str, &str)]) -> Result<Value, RefreshError> {
    let client = HttpClient::builder()
        .connect_timeout(REFRESH_TIMEOUT)
        .read_timeout(REFRESH_TIMEOUT)
        .build()
        .map_err(|error| RefreshError::Provider(error.to_string()))?;
    let response = client
        .post(endpoint)
        .map_err(|error| RefreshError::Provider(error.to_string()))?
        .header("accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|error| RefreshError::Provider(error.to_string()))?;
    let status = response.status();
    if status.is_client_error() {
        return Err(RefreshError::Rejected);
    }
    if !status.is_success() {
        return Err(RefreshError::Provider(format!(
            "token endpoint answered {status}"
        )));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| RefreshError::Provider(error.to_string()))
}

/// Read the token response: an `error` member or a missing `access_token` is
/// the source's `ValueError` rejection.
fn parse_grant(payload: &Value) -> Result<TokenGrant, RefreshError> {
    if payload.get("error").is_some_and(|error| !error.is_null()) {
        return Err(RefreshError::Rejected);
    }
    let access_token = payload
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if access_token.is_empty() {
        return Err(RefreshError::Rejected);
    }
    Ok(TokenGrant {
        access_token: access_token.to_string(),
        refresh_token: payload
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        token_type: payload
            .get("token_type")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        granted_scopes: payload
            .get("scope")
            .and_then(Value::as_str)
            .map(parse_scope),
        expires_in: payload
            .get("expires_in")
            .and_then(Value::as_i64)
            .filter(|seconds| *seconds >= 0),
    })
}

/// `scope.replace(",", " ").split()` with empties dropped.
fn parse_scope(value: &str) -> Vec<String> {
    value
        .replace(',', " ")
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// `save_oauth_connection`: the replacement `kinds.json` document.
fn connection_payload(
    slug: &str,
    previous: &ConnectorConnection,
    grant: &TokenGrant,
    previous_refresh_token: &str,
) -> Result<Value, RefreshError> {
    let mut scopes = grant
        .granted_scopes
        .clone()
        .unwrap_or_else(|| previous.granted_scopes.clone());
    scopes.sort();
    scopes.dedup();
    let expires_at = grant
        .expires_in
        .map(|seconds| render_datetime(Utc::now().naive_utc() + ChronoDuration::seconds(seconds)));
    let refresh_token = grant
        .refresh_token
        .as_deref()
        .unwrap_or(previous_refresh_token);
    Ok(json!({
        "apiVersion": "agent.wecode.io/v1",
        "kind": "ConnectorConnection",
        "metadata": {"name": slug, "namespace": CONNECTION_NAMESPACE},
        "spec": {
            "connectorAppSlug": slug,
            "status": "connected",
            "externalAccountName": previous.external_account_name,
            "grantedScopes": scopes,
            "expiresAt": expires_at,
            "accessTokenEncrypted": encrypt_sensitive_data(&grant.access_token)
                .map_err(RefreshError::Crypto)?,
            "refreshTokenEncrypted": encrypt_sensitive_data(refresh_token)
                .map_err(RefreshError::Crypto)?,
            "tokenType": grant.token_type.clone().unwrap_or_else(|| previous.token_type.clone()),
        }
    }))
}

/// `clear_refresh_token` followed by `set_status("expired")`.
async fn reject<M>(mysql: &M, row: &KindRow) -> Result<(), RefreshError>
where
    M: Mysql,
{
    let mut document = row.kinds_json.0.to_value();
    mark_rejected(&mut document)?;
    write_json(mysql, row.kinds_id, &document).await
}

/// Clear the stored grant so the app asks for authorization again.
fn mark_rejected(document: &mut Value) -> Result<(), RefreshError> {
    let spec = document
        .get_mut("spec")
        .and_then(Value::as_object_mut)
        .ok_or(RefreshError::Unavailable)?;
    spec.insert("refreshTokenEncrypted".to_string(), Value::Null);
    spec.insert("status".to_string(), json!("expired"));
    Ok(())
}

async fn write_json<M>(mysql: &M, id: i64, document: &Value) -> Result<(), RefreshError>
where
    M: Mysql,
{
    let payload = crate::json_compat::python_json_value(document);
    mysql
        .execute(
            "UPDATE kinds SET json = ?, updated_at = NOW() WHERE kinds.id = ?",
            (payload.as_str(), id),
        )
        .await
        .map(|_| ())
        .map_err(RefreshError::Database)
}

/// Persist the discovery outcome on a stored connection without touching the
/// stored grant.
pub(crate) async fn write_discovery_state<M>(
    mysql: &M,
    row: &KindRow,
    discovered_at: Option<&str>,
    last_error: Option<&str>,
) -> Result<(), RefreshError>
where
    M: Mysql,
{
    let mut document = row.kinds_json.0.to_value();
    let spec = document
        .get_mut("spec")
        .and_then(Value::as_object_mut)
        .ok_or(RefreshError::Unavailable)?;
    if let Some(discovered_at) = discovered_at {
        spec.insert(
            "toolsDiscoveredAt".to_string(),
            Value::String(discovered_at.to_string()),
        );
    }
    spec.insert(
        "lastError".to_string(),
        match last_error {
            Some(message) => json!({
                "message": message.chars().take(500).collect::<String>(),
                "at": Utc::now().to_rfc3339(),
            }),
            None => Value::Null,
        },
    );
    write_json(mysql, row.kinds_id, &document).await
}

/// `db.refresh(connection.row)` after the commit.
async fn reload<M>(mysql: &M, slug: &str, user_id: i64) -> Result<ConnectorConnection, RefreshError>
where
    M: Mysql,
{
    db::find_connector_connection(mysql, slug, user_id)
        .await
        .map_err(RefreshError::Database)?
        .as_ref()
        .map(ConnectorConnection::from_row)
        .ok_or(RefreshError::Unavailable)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    /// Serve one HTTP response so the token request hits a real socket.
    async fn serve_response(response: &'static str) -> String {
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
    async fn token_endpoint_4xx_answers_are_rejections() {
        let endpoint = serve_response(
            "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .await;
        let error = request_tokens(&endpoint, &[("grant_type", "refresh_token")])
            .await
            .unwrap_err();
        assert!(matches!(error, RefreshError::Rejected));
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

    /// A rejected grant must stop looking usable.
    #[test]
    fn marking_a_rejection_clears_the_refresh_token() {
        let mut document = json!({
            "spec": {
                "status": "connected",
                "refreshTokenEncrypted": "ciphertext",
                "accessTokenEncrypted": "ciphertext",
            }
        });

        mark_rejected(&mut document).unwrap();

        assert_eq!(document["spec"]["refreshTokenEncrypted"], json!(null));
        assert_eq!(document["spec"]["status"], json!("expired"));
        assert_eq!(document["spec"]["accessTokenEncrypted"], json!("ciphertext"));
    }

    fn client() -> StoredClient {
        StoredClient {
            token_endpoint: "https://provider.example.invalid/oauth/token".to_string(),
            client_id: "client-1".to_string(),
            resource: Some("https://mcp.example.invalid/doc".to_string()),
        }
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

    /// A payload without an access token is rejected as well.
    #[test]
    fn grant_without_access_token_is_rejected() {
        assert!(matches!(
            parse_grant(&json!({"token_type": "bearer"})),
            Err(RefreshError::Rejected)
        ));
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
}
