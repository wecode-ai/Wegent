// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.services.user_mcp_oauth.UserMcpOAuthService`'s request-building
//! surface: the OAuth access token a provider MCP server needs while a task
//! request is assembled (`_apply_user_mcp_oauth_header`,
//! `request_builder.py:2060-2135`).
//!
//! `ensure_access_token_sync` returns the stored access token while it is
//! still safe to use (`expires_at - 1800 > now`), otherwise refreshes it from
//! `mcps.<provider>.oauth.token_endpoint` with the stored refresh token and
//! persists the newly issued credentials into `users.preferences`. A missing
//! or rejected refresh yields an empty token, and the caller then omits the
//! `Authorization` header, exactly as the source does.
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use brz_json::adapters::python_truthy;
use chrono::Utc;
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::mcp_oauth_credentials::{
    clear_service_oauth_credentials, provider_oauth_client, save_service_oauth_credentials,
    service_oauth_credentials,
};

/// `REFRESH_SKEW_SECONDS`: a token this close to expiry is refreshed early.
const REFRESH_SKEW_SECONDS: i64 = 1800;
/// `DISCOVERY_TIMEOUT_SECONDS`: the source's `httpx` timeout for token calls.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
/// `INVALID_GRANT_ERROR`: the provider rejected the stored grant.
const INVALID_GRANT_ERROR: &str = "invalid_grant";
/// The source ORM flush of `db.merge(user); db.commit()` after rewriting
/// `user.preferences`: the changed column plus `onupdate=func.now()`.
const USER_PREFERENCES_UPDATE_SQL: &str =
    "UPDATE users SET preferences=?, updated_at=now() WHERE users.id = ?";

/// The request builder's OAuth access-token lookup.
///
/// Production uses [`McpOAuthTokenService`]; tests substitute a stub so the
/// header injection can be exercised without stored credentials or a network.
#[async_trait]
pub(crate) trait UserMcpAccessTokens: Send + Sync {
    /// `ensure_access_token_sync`: a usable access token, refreshed when it is
    /// missing or close to expiry, or `""` when none can be obtained.
    async fn ensure_access_token(
        &self,
        preferences: &str,
        provider_id: &str,
        service_id: &str,
    ) -> Result<String, FastApiError>;
}

/// `ensure_access_token_sync` against the request user's stored preferences.
pub(crate) struct McpOAuthTokenService<'a> {
    pub user_id: i64,
    pub mysql: &'a brz_mysql::MysqlService,
}

/// The create flow's token service for one request user.
pub(crate) fn token_service(
    user_id: i64,
    mysql: &brz_mysql::MysqlService,
) -> McpOAuthTokenService<'_> {
    McpOAuthTokenService { user_id, mysql }
}

#[async_trait]
impl UserMcpAccessTokens for McpOAuthTokenService<'_> {
    async fn ensure_access_token(
        &self,
        preferences: &str,
        provider_id: &str,
        service_id: &str,
    ) -> Result<String, FastApiError> {
        if let Some(token) = usable_token(preferences, provider_id, service_id)? {
            return Ok(token);
        }
        let Some(target) = refresh_target(preferences, provider_id, service_id)? else {
            return Ok(String::new());
        };
        let Some(client) = refresh_client() else {
            return Ok(String::new());
        };
        let Ok(request) = client.post(target.token_endpoint.as_str()) else {
            tracing::warn!(
                provider_id,
                service_id,
                "MCP OAuth token endpoint is not a valid URL"
            );
            return Ok(String::new());
        };
        let response = match request
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", target.client_id.as_str()),
                ("refresh_token", target.refresh_token.as_str()),
            ])
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(
                    provider_id,
                    service_id,
                    %error,
                    "MCP OAuth token refresh failed"
                );
                return Ok(String::new());
            }
        };
        let status = response.status();
        if !status.is_success() {
            let error = oauth_error_code(response).await;
            tracing::warn!(
                provider_id,
                service_id,
                %status,
                error = %error,
                "MCP OAuth token refresh failed"
            );
            // `_note_refresh_failure`: drop only the grants the provider
            // rejected, so the service must be authorized again.
            if error == INVALID_GRANT_ERROR {
                let document =
                    clear_service_oauth_credentials(preferences, provider_id, service_id)?;
                self.persist(&document).await?;
            }
            return Ok(String::new());
        }
        let payload: Value = match response.json().await {
            Ok(payload) => payload,
            Err(error) => {
                tracing::warn!(
                    provider_id,
                    service_id,
                    %error,
                    "MCP OAuth token refresh returned no JSON payload"
                );
                return Ok(String::new());
            }
        };
        if !token_payload_usable(&payload) {
            tracing::warn!(
                provider_id,
                service_id,
                "MCP OAuth token refresh returned no access token"
            );
            return Ok(String::new());
        }
        let access_token = string_value(payload.get("access_token"));
        let refresh_token = {
            let value = string_value(payload.get("refresh_token"));
            if value.is_empty() {
                target.refresh_token
            } else {
                value
            }
        };
        let scope = string_value(payload.get("scope"));
        let document = save_service_oauth_credentials(
            preferences,
            provider_id,
            service_id,
            &access_token,
            &refresh_token,
            expires_at(&payload),
            &scope,
        )?;
        self.persist(&document).await?;
        Ok(access_token)
    }
}

impl McpOAuthTokenService<'_> {
    /// `db.merge(user); persistent.preferences = preferences; db.commit()`:
    /// the rewritten document replaces `users.preferences`.
    async fn persist(&self, document: &str) -> Result<(), FastApiError> {
        self.mysql
            .execute(USER_PREFERENCES_UPDATE_SQL, (document, self.user_id))
            .await
            .map_err(|error| {
                tracing::warn!(%error, user_id = self.user_id, "failed to store MCP OAuth credentials");
                FastApiError::unhandled()
            })?;
        self.mysql
            .execute("COMMIT", ())
            .await
            .map(|_| ())
            .map_err(|error| {
                tracing::warn!(%error, user_id = self.user_id, "failed to commit MCP OAuth credentials");
                FastApiError::unhandled()
            })
    }
}

/// `is_secure_mcp_url`: only `https` (with a hostname) or `http` to a loopback
/// host may carry a bearer token.
///
/// `urlsplit(...).hostname` strips IPv6 brackets, so the source's `[::1]`
/// member can never equal a parsed hostname; the port keeps that behavior.
pub(crate) fn is_secure_mcp_url(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return false;
    }
    let Ok(parsed) = url::Url::parse(value) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("");
    if parsed.scheme() == "https" && !host.is_empty() {
        return true;
    }
    parsed.scheme() == "http" && matches!(host, "localhost" | "127.0.0.1")
}

/// `_usable_token`: the stored access token while it is still safe to use.
fn usable_token(
    preferences: &str,
    provider_id: &str,
    service_id: &str,
) -> Result<Option<String>, FastApiError> {
    let credentials = service_oauth_credentials(preferences, provider_id, service_id)?;
    if !credentials.access_token.is_empty()
        && (credentials.expires_at == 0
            || credentials.expires_at - REFRESH_SKEW_SECONDS > Utc::now().timestamp())
    {
        return Ok(Some(credentials.access_token));
    }
    Ok(None)
}

/// `_refresh_target`: the refresh inputs, or `None` when a refresh is
/// impossible.
fn refresh_target(
    preferences: &str,
    provider_id: &str,
    service_id: &str,
) -> Result<Option<RefreshTarget>, FastApiError> {
    let credentials = service_oauth_credentials(preferences, provider_id, service_id)?;
    let client = provider_oauth_client(preferences, provider_id);
    if credentials.refresh_token.is_empty()
        || client.token_endpoint.is_empty()
        || client.client_id.is_empty()
    {
        return Ok(None);
    }
    Ok(Some(RefreshTarget {
        token_endpoint: client.token_endpoint,
        client_id: client.client_id,
        refresh_token: credentials.refresh_token,
    }))
}

/// `_refresh_target`'s inputs.
struct RefreshTarget {
    token_endpoint: String,
    client_id: String,
    refresh_token: String,
}

/// The process-lifetime token client: the source's single 15-second `httpx`
/// timeout, no redirect following, and the mounted Replay trust anchor when
/// one exists.
fn refresh_client() -> Option<&'static brz_http::Client> {
    static CLIENT: OnceLock<Option<brz_http::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            brz_http::Client::builder()
                .timeout(DISCOVERY_TIMEOUT)
                .connect_timeout(DISCOVERY_TIMEOUT)
                .read_timeout(DISCOVERY_TIMEOUT)
                .configure(|inner| {
                    let inner = inner.redirect(brz_http::reqwest::redirect::Policy::none());
                    match crate::http_trust::trust_anchor() {
                        Some(anchor) => inner.add_root_certificate(anchor),
                        None => inner,
                    }
                })
                .build()
                .map_err(|error| {
                    tracing::warn!(%error, "failed to build the MCP OAuth token client");
                    error
                })
                .ok()
        })
        .as_ref()
}

/// `_require_token_payload`: an object without an `error` and with an
/// `access_token`.
fn token_payload_usable(payload: &Value) -> bool {
    payload.is_object()
        && !payload.get("error").is_some_and(python_truthy)
        && payload.get("access_token").is_some_and(python_truthy)
}

/// `_response_oauth_error`: the `error` code of a failed token response.
async fn oauth_error_code(response: brz_http::Response) -> String {
    match response.json::<Value>().await {
        Ok(Value::Object(object)) => object
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_owned(),
        _ => String::new(),
    }
}

/// `_expires_at(payload)`: `now + expires_in` when it is positive, else `0`.
fn expires_at(payload: &Value) -> i64 {
    let seconds = match payload.get("expires_in") {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|seconds| seconds as i64)),
        Some(Value::String(text)) => text.trim().parse::<i64>().ok(),
        Some(Value::Bool(flag)) => Some(i64::from(*flag)),
        _ => None,
    }
    .unwrap_or(0);
    if seconds > 0 {
        Utc::now().timestamp() + seconds
    } else {
        0
    }
}

/// `str(value or "")`: only a truthy value renders, everything else is empty.
fn string_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::Bool(flag)) if *flag => "True".to_owned(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
#[path = "user_mcp_oauth_tests.rs"]
mod tests;
