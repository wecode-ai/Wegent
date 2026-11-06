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
//! keeps the refresh token for a later retry. Only an explicit invalid-grant
//! error clears it, and an unreadable credential is a
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
    let refresh_token = previous.refresh_token().ok_or_else(|| {
        if previous.refresh_token_encrypted.is_some() {
            RefreshError::Crypto(CryptoError::Unreadable)
        } else {
            RefreshError::Unavailable
        }
    })?;
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
        return Err(RefreshError::Crypto(CryptoError::Unreadable));
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
/// Configuration errors and malformed responses do not revoke a grant.
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
    if !status.is_success() {
        if status.is_client_error()
            && status.as_u16() != 429
            && let Ok(payload) = response.json::<Value>().await
            && rejected_grant(&payload)
        {
            return Err(RefreshError::Rejected);
        }
        return Err(RefreshError::Provider(format!(
            "token endpoint answered {status}"
        )));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| RefreshError::Provider(error.to_string()))
}

fn rejected_grant(payload: &Value) -> bool {
    matches!(
        payload.get("error").and_then(Value::as_str),
        Some("invalid_grant" | "bad_refresh_token")
    )
}

/// Read a grant without mistaking protocol/configuration faults for revocation.
fn parse_grant(payload: &Value) -> Result<TokenGrant, RefreshError> {
    if rejected_grant(payload) {
        return Err(RefreshError::Rejected);
    }
    if payload.get("error").is_some_and(|error| !error.is_null()) {
        return Err(RefreshError::Provider("OAuth token endpoint error".into()));
    }
    let access_token = payload
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if access_token.is_empty() {
        return Err(RefreshError::Provider(
            "OAuth access token is missing".into(),
        ));
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
    expected_access: &str,
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
                     updated_at = NOW() WHERE id = ? AND is_active = 1 \
                     AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.accessTokenEncrypted')), '') = ?",
                    (discovered_at.to_string(), summaries.as_str(), row.kinds_id, expected_access),
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
                         updated_at = NOW() WHERE id = ? AND is_active = 1 \
                         AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.accessTokenEncrypted')), '') = ?",
                        (error.as_str(), row.kinds_id, expected_access),
                    )
                    .await
                    .map(|_| ())
                    .map_err(RefreshError::Database)
            } else {
                mysql
                    .execute(
                        "UPDATE kinds SET json = JSON_SET(json, \
                         '$.spec.lastError', CAST(? AS JSON)), \
                         updated_at = NOW() WHERE id = ? AND is_active = 1 \
                         AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.accessTokenEncrypted')), '') = ?",
                        (error.as_str(), row.kinds_id, expected_access),
                    )
                    .await
                    .map(|_| ())
                    .map_err(RefreshError::Database)
            }
        }
        _ => Err(RefreshError::Unavailable),
    }
}

/// Expire only the credential an in-flight request actually used. A late 401
/// for an older access token must not invalidate a grant committed meanwhile.
pub(crate) async fn reject_credential_if_current<M>(
    mysql: &M,
    kind_id: i64,
    expected_access: &str,
    last_error: Option<&str>,
) -> Result<(), RefreshError>
where
    M: Mysql,
{
    if let Some(message) = last_error {
        let error = discovery_error(message);
        mysql
            .execute(
                "UPDATE kinds SET json = JSON_SET(json, '$.spec.status', 'expired', \
                 '$.spec.lastError', CAST(? AS JSON)), updated_at = NOW() WHERE id = ? \
                 AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.accessTokenEncrypted')), '') = ?",
                (error.as_str(), kind_id, expected_access),
            )
            .await
            .map(|_| ())
            .map_err(RefreshError::Database)
    } else {
        mysql
            .execute(
                "UPDATE kinds SET json = JSON_SET(json, '$.spec.status', 'expired'), \
                 updated_at = NOW() WHERE id = ? \
                 AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.accessTokenEncrypted')), '') = ?",
                (kind_id, expected_access),
            )
            .await
            .map(|_| ())
            .map_err(RefreshError::Database)
    }
}

/// Preserve discovery failures at every Rust directory entry point. Only an
/// upstream 401/403 expires the exact credential presented by this request;
/// transport and other status failures leave the grant retryable.
pub(crate) async fn record_directory_error<M>(
    mysql: &M,
    row: Option<&crate::apps_installed::db::KindRow>,
    attempted_access: Option<&str>,
    error: &super::mcp::McpError,
) where
    M: Mysql,
{
    let Some(row) = row else {
        return;
    };
    let result = match error {
        super::mcp::McpError::Unauthorized(message) => {
            let Some(attempted_access) = attempted_access else {
                return;
            };
            reject_credential_if_current(mysql, row.kinds_id, attempted_access, Some(message)).await
        }
        super::mcp::McpError::Transport(message) => {
            let Some(attempted_access) = attempted_access else {
                return;
            };
            write_discovery_state(
                mysql,
                row,
                attempted_access,
                &DiscoveryState {
                    last_error: Some(message),
                    ..Default::default()
                },
            )
            .await
        }
    };
    if let Err(error) = result {
        tracing::warn!(%error, "connector directory error could not be recorded");
    }
}

/// Configuration/provider failures occur before an upstream request. Record
/// them against the directory's original grant, never a subsequent account.
pub(crate) async fn record_session_error<M>(
    mysql: &M,
    row: Option<&KindRow>,
    error: &super::service::SessionError,
) where
    M: Mysql,
{
    if matches!(error, super::service::SessionError::AuthorizationRequired) {
        return;
    }
    let Some(row) = row else {
        return;
    };
    let connection = ConnectorConnection::from_row(row);
    record_directory_error(
        mysql,
        Some(row),
        Some(&connection.access_token_encrypted),
        &super::mcp::McpError::Transport(error.to_string()),
    )
    .await;
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
#[path = "refresh_tests.rs"]
mod tests;
