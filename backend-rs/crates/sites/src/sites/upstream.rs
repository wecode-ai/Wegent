// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The retained HTTP client for the external Sites project API
//! (`app.services.sites.SitesService`).
//!
//! `SitesService._request` builds a fresh
//! `httpx.AsyncClient(timeout=timeout_seconds)` per call, adds
//! `Authorization: Bearer {SITES_API_TOKEN}` when the token is set, issues the
//! request against `SITES_API_BASE_URL.strip().rstrip("/")`, and maps the
//! outcome:
//!
//! * a missing base URL is `SitesNotAvailableError` (`503`);
//! * an `httpx.RequestError` is `SitesUpstreamUnavailableError` (`502`);
//! * an HTTP error status is `SitesUpstreamResponseError`, rendered with the
//!   upstream status and its parsed `detail`;
//! * a non-JSON success body (or an invalid one) is
//!   `SitesUpstreamUnavailableError` (`502`);
//! * `204 No Content` yields `None`.
//!
//! The source request carries no connection-local state, so one retained,
//! pooled client with the same connect/read budget serves every call.
use std::time::Duration;

use anyhow::Context as _;
use brz_http::Client;
use brz_http_server::StatusCode;
use serde_json::{Value, json};

use crate::config::env_or_dotenv;
use crate::http_compat::FastApiError;

/// `SitesService(timeout_seconds=10.0)`.
const DEFAULT_TIMEOUT_SECONDS: f64 = 10.0;

/// Stable metric profile for the fixed project-search route.
const PROJECT_SEARCH_PROFILE: &str = "http://sites/api/v1/projects/search";

/// The four source branches `app.api.endpoints.sites._raise_sites_error`
/// renders.
#[derive(Debug)]
pub enum SitesError {
    /// `SitesNotAvailableError` (`503 sites_not_available`).
    NotAvailable,
    /// `SitesUpstreamUnavailableError` (`502 sites_upstream_unavailable`).
    UpstreamUnavailable,
    /// `SitesUpstreamResponseError`: the upstream status and parsed `detail`.
    UpstreamResponse { status: u16, detail: Value },
    /// `httpx.InvalidURL`, which the source does not convert; it reaches the
    /// application `Exception` handler as a `500`.
    InvalidUrl,
}

impl SitesError {
    /// `_raise_sites_error`: the FastAPI error each branch renders.
    #[must_use]
    pub fn into_fastapi_error(self) -> FastApiError {
        match self {
            Self::NotAvailable => FastApiError::json_body(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({
                    "detail": {
                        "code": "sites_not_available",
                        "message": "Sites is not available yet",
                    }
                }),
            ),
            Self::UpstreamUnavailable => FastApiError::json_body(
                StatusCode::BAD_GATEWAY,
                json!({
                    "detail": {
                        "code": "sites_upstream_unavailable",
                        "message": "Sites service is unavailable",
                    }
                }),
            ),
            Self::UpstreamResponse { status, detail } => FastApiError::json_body(
                StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
                json!({ "detail": detail }),
            ),
            Self::InvalidUrl => FastApiError::unhandled(),
        }
    }
}

/// The retained client plus its resolved base URL and bearer token.
pub struct SitesClient {
    http: Client,
    base_url: String,
    token: String,
}

impl SitesClient {
    /// Build the client from `SITES_API_BASE_URL` / `SITES_API_TOKEN`.
    ///
    /// A missing base URL is not a startup failure: the source renders it per
    /// request as the `503 sites_not_available` body.
    ///
    /// # Errors
    ///
    /// Returns an error when the HTTP client backend cannot be built.
    pub fn from_env() -> anyhow::Result<Self> {
        Self::with_settings(
            env_or_dotenv("SITES_API_BASE_URL").unwrap_or_default(),
            env_or_dotenv("SITES_API_TOKEN").unwrap_or_default(),
            Duration::from_secs_f64(DEFAULT_TIMEOUT_SECONDS),
        )
    }

    /// Build the client from explicit settings (`SitesService.__init__` plus the
    /// resolved configuration).
    ///
    /// # Errors
    ///
    /// Returns an error when the HTTP client backend cannot be built.
    pub fn with_settings(
        base_url: impl Into<String>,
        token: impl Into<String>,
        timeout: Duration,
    ) -> anyhow::Result<Self> {
        let http = Client::builder()
            .connect_timeout(timeout)
            .read_timeout(timeout)
            .timeout(timeout)
            // httpx does not follow redirects; the transport mirrors that.
            .configure(|builder| builder.redirect(brz_http::reqwest::redirect::Policy::none()))
            .build()
            .context("failed to build the Sites HTTP client")?;
        Ok(Self {
            http,
            // `settings.SITES_API_BASE_URL.strip().rstrip("/")`.
            base_url: base_url.into().trim().trim_end_matches('/').to_owned(),
            // `settings.SITES_API_TOKEN.strip()`.
            token: token.into().trim().to_owned(),
        })
    }

    /// `SitesService._base_url`: the configured base URL, or the `503` branch.
    fn base_url(&self) -> Result<&str, SitesError> {
        if self.base_url.is_empty() {
            Err(SitesError::NotAvailable)
        } else {
            Ok(&self.base_url)
        }
    }

    /// `SitesService._request` for a JSON `GET`: `None` for `204`, the decoded
    /// JSON document otherwise.
    pub async fn get_json(
        &self,
        path: &str,
        query: &[(&str, String)],
        username: &str,
    ) -> Result<Option<Value>, SitesError> {
        let url = format!("{}{path}", self.base_url()?);
        let endpoint = self
            .http
            .endpoint_named(url, PROJECT_SEARCH_PROFILE)
            .map_err(|_| SitesError::InvalidUrl)?;
        let mut request = endpoint.get().query(query);
        if !self.token.is_empty() {
            request = request.header("authorization", format!("Bearer {}", self.token));
        }
        request = request.header("x-wegent-username", username.to_owned());
        let response = request
            .send()
            .await
            .map_err(|_| SitesError::UpstreamUnavailable)?;
        let status = response.status();
        if !status.is_success() {
            let detail = response_detail(response).await;
            return Err(SitesError::UpstreamResponse {
                status: status.as_u16(),
                detail,
            });
        }
        if status.as_u16() == 204 {
            return Ok(None);
        }
        // `response.json()`: a non-JSON body is `SitesUpstreamUnavailableError`.
        response
            .json::<Value>()
            .await
            .map(Some)
            .map_err(|_| SitesError::UpstreamUnavailable)
    }
}

/// `SitesService._response_detail`: the JSON `detail` / `error` key, the whole
/// document, or the response text when the body does not decode.
async fn response_detail(response: brz_http::Response) -> Value {
    let fallback = |status: u16| format!("Sites request failed: HTTP {status}");
    let status = response.status().as_u16();
    let Ok(text) = response.text().await else {
        return Value::String(fallback(status));
    };
    let Ok(payload) = serde_json::from_str::<Value>(&text) else {
        return Value::String(if text.is_empty() {
            fallback(status)
        } else {
            text
        });
    };
    if let Some(object) = payload.as_object() {
        if let Some(detail) = object.get("detail") {
            return detail.clone();
        }
        if let Some(error @ Value::Object(_)) = object.get("error") {
            return error.clone();
        }
    }
    payload
}
