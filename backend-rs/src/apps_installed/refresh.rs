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

/// The app slug that refreshes through the first-party GitHub OAuth app.
const GITHUB_SLUG: &str = "github";

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

/// `GITHUB_TOKEN_URL`: the dedicated GitHub grant endpoint
/// (`ConnectorOAuthService.refresh_connection`).
pub(crate) const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

/// `settings.GITHUB_OAUTH_CLIENT_ID`.
const GITHUB_CLIENT_ID_ENV: &str = "GITHUB_OAUTH_CLIENT_ID";
/// The first-party OAuth app key setting (`settings.GITHUB_OAUTH_CLIENT_*`).
const GITHUB_CLIENT_KEY_ENV: &str = "GITHUB_OAUTH_CLIENT_SECRET";
/// The token-request field carrying [`GITHUB_CLIENT_KEY_ENV`].
const GITHUB_CLIENT_KEY_FIELD: &str = "client_secret";
/// `_stored_dynamic_client(app)`: the dynamically registered OAuth client.
#[derive(Debug, Deserialize)]
struct StoredClient {
    token_endpoint: String,
    client_id: String,
    #[serde(default)]
    resource: Option<String>,
}

/// `settings.GITHUB_OAUTH_CLIENT_ID` and `settings.GITHUB_OAUTH_CLIENT_KEY`.
///
/// GitHub is the one app authorized by a fixed first-party OAuth app instead of
/// dynamic client registration, so no `oauthClientEncrypted` record is stored
/// for it. Every other app refreshes through its stored registration.
pub(crate) struct OAuthConfig {
    pub(crate) github_client_id: String,
    pub(crate) github_client_key: String,
    pub(crate) github_token_endpoint: String,
}

impl OAuthConfig {
    /// Read the source-compatible environment.
    pub(crate) fn from_env() -> Self {
        let read = |name: &str| crate::config::env_or_dotenv(name).unwrap_or_default();
        Self {
            github_client_id: read(GITHUB_CLIENT_ID_ENV),
            github_client_key: read(GITHUB_CLIENT_KEY_ENV),
            github_token_endpoint: GITHUB_TOKEN_URL.to_string(),
        }
    }
}

/// The token request for one app: the dedicated GitHub app or the stored DCR
/// registration.
enum TokenRequest {
    Dynamic(StoredClient),
    GitHub {
        client_id: String,
        client_key: String,
    },
}

impl TokenRequest {
    fn endpoint<'a>(&'a self, config: &'a OAuthConfig) -> &'a str {
        match self {
            Self::Dynamic(client) => client.token_endpoint.as_str(),
            Self::GitHub { .. } => config.github_token_endpoint.as_str(),
        }
    }

    /// The refresh body, in the order the source sends it.
    fn form<'a>(&'a self, refresh_token: &'a str) -> Vec<(&'a str, &'a str)> {
        match self {
            Self::Dynamic(client) => refresh_form(client, refresh_token),
            Self::GitHub {
                client_id,
                client_key,
            } => vec![
                ("client_id", client_id.as_str()),
                (GITHUB_CLIENT_KEY_FIELD, client_key.as_str()),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ],
        }
    }
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
    let config = OAuthConfig::from_env();
    refresh_with(mysql, app, user_id, &config).await
}

/// [`refresh`] with the OAuth application configuration supplied by the
/// caller, so tests exercise the real exchanges without touching the process
/// environment.
pub(crate) async fn refresh_with<M>(
    mysql: &M,
    app: &ConnectorApp,
    user_id: i64,
    config: &OAuthConfig,
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
    // The stored ciphertext identifies the credential this attempt replaces.
    // Every write below is conditional on it, so a slower request cannot
    // overwrite a grant that another request (or a disconnect) already
    // committed.
    let expected = previous
        .refresh_token_encrypted
        .as_deref()
        .ok_or(RefreshError::Unavailable)?;
    let request = token_request(app, config)?;
    let form = request.form(&refresh_token);
    // A rejected request and a rejected payload both mean the stored grant is
    // unusable, so both must clear it before reporting the rejection.
    let payload = match request_tokens(request.endpoint(config), &form).await {
        Ok(payload) => payload,
        Err(RefreshError::Rejected) => {
            return reject_grant(mysql, &row, expected, app, user_id).await;
        }
        Err(error) => return Err(error),
    };

    match parse_grant(&payload) {
        Ok(grant) => {
            let document = connection_payload(&app.slug, &previous, &grant, &refresh_token)?;
            if write_json_if_grant(
                mysql,
                row.kinds_id,
                &document,
                expected,
                &previous.access_token_encrypted,
            )
            .await?
                == 0
            {
                // Another attempt already rotated or revoked this grant; its
                // result is authoritative and ours is dropped.
                return reload(mysql, &app.slug, user_id).await;
            }
            reload(mysql, &app.slug, user_id).await
        }
        Err(RefreshError::Rejected) => reject_grant(mysql, &row, expected, app, user_id).await,
        Err(error) => Err(error),
    }
}

/// Clear the stored grant, but only while it is still the one this attempt
/// used. A concurrent rotation wins and is reported instead.
async fn reject_grant<M>(
    mysql: &M,
    row: &KindRow,
    expected: &str,
    app: &ConnectorApp,
    user_id: i64,
) -> Result<ConnectorConnection, RefreshError>
where
    M: Mysql,
{
    if reject_if_grant(mysql, row.kinds_id, expected).await? == 0 {
        let current = reload(mysql, app.slug.as_str(), user_id).await?;
        return if super::connection::is_usable(Some(&current)) {
            Ok(current)
        } else {
            Err(RefreshError::Rejected)
        };
    }
    Err(RefreshError::Rejected)
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

/// `_require_github_config` and the source's branch on `connection.slug`:
/// GitHub refreshes through the first-party OAuth app, every other app through
/// its stored dynamic registration.
fn token_request(app: &ConnectorApp, config: &OAuthConfig) -> Result<TokenRequest, RefreshError> {
    if app.slug == GITHUB_SLUG {
        if config.github_client_id.is_empty() || config.github_client_key.is_empty() {
            return Err(RefreshError::Unavailable);
        }
        return Ok(TokenRequest::GitHub {
            client_id: config.github_client_id.clone(),
            client_key: config.github_client_key.clone(),
        });
    }
    stored_client(app).map(TokenRequest::Dynamic)
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

/// `clear_refresh_token` followed by `set_status("expired")`, applied only
/// while `expected` is still the stored credential.
pub(crate) async fn reject_if_grant<M>(
    mysql: &M,
    id: i64,
    expected: &str,
) -> Result<u64, RefreshError>
where
    M: Mysql,
{
    let outcome = mysql
        .execute(
            "UPDATE kinds SET json = JSON_SET(json, \
             '$.spec.refreshTokenEncrypted', CAST('null' AS JSON), \
             '$.spec.status', 'expired'), \
             updated_at = NOW() \
             WHERE id = ? \
             AND JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.refreshTokenEncrypted')) = ?",
            (id, expected),
        )
        .await
        .map_err(RefreshError::Database)?;
    Ok(outcome.rows_affected)
}

/// Write a renewed grant only while it still belongs on this connection.
///
/// The write applies while `expected` is the stored refresh credential, or
/// while a competing refresh already committed its `invalid_grant` for that
/// same credential: the token endpoint rotates the refresh token on first use,
/// so the losing request is rejected and the delayed successful rotation must
/// still be able to restore the grant. That recovery is limited to an expired
/// connection that still carries the access token this attempt started from,
/// which keeps disconnects and re-authorizations authoritative.
pub(crate) async fn write_json_if_grant<M>(
    mysql: &M,
    id: i64,
    document: &Value,
    expected: &str,
    expected_access: &str,
) -> Result<u64, RefreshError>
where
    M: Mysql,
{
    let payload = crate::json_compat::python_json_value(document);
    let outcome = mysql
        .execute(
            "UPDATE kinds SET json = CAST(? AS JSON), updated_at = NOW() \
             WHERE id = ? \
             AND ( \
               JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.refreshTokenEncrypted')) = ? \
               OR ( \
                 COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.refreshTokenEncrypted')), '') \
                   IN ('', 'null') \
                 AND JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.status')) = 'expired' \
                 AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.accessTokenEncrypted')), '') = ? \
               ) \
             )",
            (payload.as_str(), id, expected, expected_access),
        )
        .await
        .map_err(RefreshError::Database)?;
    Ok(outcome.rows_affected)
}

/// The discovery outcome to persist on a stored connection.
///
/// A successful pass mirrors `ConnectorConnectionService.save_tool_summaries`
/// and replaces the cached surface; a failed pass keeps the cached surface and
/// records the error, and a rejected credential additionally flips the
/// connection to `expired` so the desktop offers re-authorization.
#[derive(Debug, Default)]
pub(crate) struct DiscoveryState<'a> {
    pub(crate) discovered_at: Option<&'a str>,
    pub(crate) tool_summaries: Option<&'a [Value]>,
    pub(crate) last_error: Option<&'a str>,
    pub(crate) expired: bool,
}

/// Persist the discovery outcome on a stored connection without touching the
/// stored grant.
///
/// The write patches only the discovery members on the row as it exists now.
/// Rewriting a document captured before the upstream call would put a
/// pre-refresh `accessTokenEncrypted`/`refreshTokenEncrypted`/`expiresAt` back,
/// undoing the grant rotation `session_headers` just performed.
pub(crate) async fn write_discovery_state<M>(
    mysql: &M,
    row: &KindRow,
    state: &DiscoveryState<'_>,
) -> Result<(), RefreshError>
where
    M: Mysql,
{
    match (state.discovered_at, state.tool_summaries, state.last_error) {
        (Some(discovered_at), Some(tool_summaries), None) => {
            let summaries =
                crate::json_compat::python_json_value(&Value::Array(tool_summaries.to_vec()));
            mysql
                .execute(
                    "UPDATE kinds SET json = JSON_SET(json, \
                     '$.spec.toolsDiscoveredAt', ?, \
                     '$.spec.toolSummaries', CAST(? AS JSON), \
                     '$.spec.lastError', CAST('null' AS JSON)), \
                     updated_at = NOW() WHERE id = ?",
                    (discovered_at.to_string(), summaries.as_str(), row.kinds_id),
                )
                .await
                .map(|_| ())
                .map_err(RefreshError::Database)
        }
        (None, None, Some(message)) => {
            let error = discovery_error(message);
            if state.expired {
                mysql
                    .execute(
                        "UPDATE kinds SET json = JSON_SET(json, \
                         '$.spec.lastError', CAST(? AS JSON), \
                         '$.spec.status', 'expired'), \
                         updated_at = NOW() WHERE id = ?",
                        (error.as_str(), row.kinds_id),
                    )
                    .await
                    .map(|_| ())
                    .map_err(RefreshError::Database)
            } else {
                mysql
                    .execute(
                        "UPDATE kinds SET json = JSON_SET(json, \
                         '$.spec.lastError', CAST(? AS JSON)), \
                         updated_at = NOW() WHERE id = ?",
                        (error.as_str(), row.kinds_id),
                    )
                    .await
                    .map(|_| ())
                    .map_err(RefreshError::Database)
            }
        }
        _ => Err(RefreshError::Unavailable),
    }
}

/// `set_status("expired")` for a credential the upstream rejected.
///
/// The grant is kept (`refreshTokenEncrypted` untouched) so a later retry can
/// still renew it, and only the status member is patched.
pub(crate) async fn mark_expired<M>(mysql: &M, kind_id: i64) -> Result<(), RefreshError>
where
    M: Mysql,
{
    mysql
        .execute(
            "UPDATE kinds SET json = JSON_SET(json, '$.spec.status', 'expired'), \
             updated_at = NOW() WHERE id = ?",
            (kind_id,),
        )
        .await
        .map(|_| ())
        .map_err(RefreshError::Database)
}

/// The `record_tool_error` payload (`{"message": ..., "at": ...}`).
fn discovery_error(message: &str) -> String {
    crate::json_compat::python_json_value(&json!({
        "message": message.chars().take(500).collect::<String>(),
        "at": Utc::now().to_rfc3339(),
    }))
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

        write_json_if_grant(&mysql, 42, &document, "refresh-ciphertext", "access-ciphertext")
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
        assert!(!sql.contains("accessTokenEncrypted"), "{sql}");
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
        assert!(!sql.contains("accessTokenEncrypted"), "{sql}");
        assert!(!sql.contains("refreshTokenEncrypted"), "{sql}");
        assert!(!sql.contains("expiresAt"), "{sql}");
        assert!(!sql.contains("json = ?"), "{sql}");
    }

    /// `mark_expired` patches only the status member.
    #[tokio::test]
    async fn marking_a_connection_expired_keeps_the_grant() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();

        mark_expired(&mysql, 42).await.unwrap();

        let writes = mysql.writes();
        assert_eq!(writes.len(), 1);
        let sql = &writes[0].sql;
        assert!(sql.contains("'$.spec.status', 'expired'"), "{sql}");
        assert!(!sql.contains("refreshTokenEncrypted"), "{sql}");
        assert_eq!(writes[0].first_integer, Some(42));
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
