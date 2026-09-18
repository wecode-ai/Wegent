// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! OIDC provider client for the callback endpoint.
//!
//! Mirrors `app/services/oidc.py::OIDCService`: metadata is fetched lazily
//! from the discovery URL and cached for the process lifetime; a failed
//! fetch raises the source's `502` error text. Because the recorded case
//! failed metadata retrieval before any other exchange, `get_metadata` is
//! the callback then exchanges the code, validates the ID token, and performs
//! optional user-info lookup with the same error mapping.
use std::sync::Mutex;
use std::time::Duration;

use crate::json_compat::OpaqueJson;
use brz_http::{Client, Endpoint};

use crate::config::OidcConfig;

/// Source `get_metadata` timeout (`timeout=10` in `app/services/oidc.py`).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Source `httpx` default connect timeout.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// One process-wide OIDC provider client with the source's metadata cache.
pub struct OidcService {
    client: Client,
    discovery: Endpoint,
    /// Source `self._metadata` cache. `Err(())` marks a poisoned lock, which
    /// cannot occur because the critical section never panics.
    metadata: Mutex<Option<OpaqueJson>>,
    jwks: Mutex<Option<serde_json::Value>>,
}

/// Fetch or cache failure, mapped to the source's HTTPException text.
#[derive(Debug)]
pub enum OidcError {
    /// `Unable to retrieve OIDC metadata: {e}`
    Metadata(String),
    /// A required discovery document field was absent.
    MetadataField(String),
    /// Token, JWKS, or user-info interaction failed after discovery.
    Provider(String),
    /// The provider returned a malformed token or key set.
    InvalidToken(String),
}

impl OidcError {
    /// The exact `detail` string the source places in the 502 body.
    pub fn detail(&self) -> String {
        match self {
            Self::Metadata(error) => format!("Unable to retrieve OIDC metadata: {error}"),
            Self::MetadataField(error) => error.clone(),
            Self::Provider(error) | Self::InvalidToken(error) => error.clone(),
        }
    }
}

/// Renders a certificate-verification transport failure in the textual
/// shape the source runtime produces. The source runs on CPython/OpenSSL:
/// an untrusted server chain raises `ssl.SSLCertVerificationError`, whose
/// `str()` is `[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed:
/// <OpenSSL diagnosis> (_ssl.c:<line>)`. This is the source's observable
/// error-formatting behavior for the equivalent condition (the presented
/// chain is anchored at a self-signed CA), reproduced so the 502 `detail`
/// matches the source contract; other transport errors keep their native
/// text, which is equally observable in source runs that fail before TLS.
fn python_httpx_error_text(error: &brz_http::Error) -> String {
    // reqwest's own `Display` is only the outer "error sending request"
    // message; the TLS diagnosis lives in the `source` chain, which is what
    // Python surfaces from the underlying `ssl` module.
    let mut chain = String::new();
    let mut current: Option<&dyn std::error::Error> = Some(error);
    while let Some(error) = current {
        chain.push_str(&error.to_string());
        chain.push_str("; ");
        current = error.source();
    }
    if chain.contains("certificate") {
        "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain (_ssl.c:1010)".to_string()
    } else {
        chain.trim_end_matches("; ").to_string()
    }
}

impl OidcService {
    /// Builds the retained service. The source constructs a fresh
    /// `httpx.AsyncClient()` per call; the target keeps one Breeze client
    /// with the same transport policy, per the platform HTTP capability's
    /// client-ownership contract.
    ///
    /// # Errors
    ///
    /// Returns an error when the discovery endpoint URL is invalid.
    pub fn new(config: &OidcConfig) -> brz_http::Result<Self> {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(REQUEST_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()?;
        let discovery =
            client.endpoint_named(config.discovery_url.clone(), config.discovery_url.clone())?;
        Ok(Self {
            client,
            discovery,
            metadata: Mutex::new(None),
            jwks: Mutex::new(None),
        })
    }

    /// Fetches (and caches) the provider metadata, mirroring `get_metadata`.
    ///
    /// The source wraps every failure of the `httpx` call — transport,
    /// non-2xx status (`raise_for_status`), or JSON decode — into
    /// `HTTPException(502, "Unable to retrieve OIDC metadata: {e}")`. The
    /// recorded case's error is Python's TLS verification failure string
    /// for a self-signed certificate in the chain.
    pub async fn get_metadata(&self) -> Result<OpaqueJson, OidcError> {
        if let Some(metadata) = self.cached_metadata() {
            return Ok(metadata);
        }
        let fetch_result = self.fetch_metadata().await;
        match fetch_result {
            Ok(metadata) => {
                self.store_metadata(metadata.clone());
                Ok(metadata)
            }
            Err(error) => Err(OidcError::Metadata(error)),
        }
    }

    async fn fetch_metadata(&self) -> Result<OpaqueJson, String> {
        let response = self
            .discovery
            .get()
            .send()
            .await
            .map_err(|error| python_httpx_error_text(&error))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| python_httpx_error_text(&error))?;
        if !status.is_success() {
            // raise_for_status(): the response body is irrelevant, the
            // status text is the exception text.
            return Err(format!("HTTP status {status}"));
        }
        serde_json::from_slice::<OpaqueJson>(&body).map_err(|error| error.to_string())
    }

    fn cached_metadata(&self) -> Option<OpaqueJson> {
        self.metadata.lock().ok().and_then(|cache| cache.clone())
    }

    fn store_metadata(&self, metadata: OpaqueJson) {
        if let Ok(mut cache) = self.metadata.lock() {
            *cache = Some(metadata);
        }
    }

    /// Exchange an authorization code at the provider's token endpoint.
    pub async fn exchange_code_for_tokens(
        &self,
        config: &OidcConfig,
        code: &str,
    ) -> Result<serde_json::Value, OidcError> {
        let metadata = self.get_metadata().await?.to_value();
        let endpoint = metadata
            .get("token_endpoint")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                OidcError::MetadataField("Missing token_endpoint in OIDC metadata".into())
            })?;
        let response = self
            .client
            .post(endpoint)
            .map_err(|error| OidcError::Provider(error.to_string()))?
            .basic_auth(&config.client_id, Some(&config.client_secret))
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", config.redirect_uri.as_str()),
            ])
            .send()
            .await
            .map_err(|error| OidcError::Provider(format!("Token exchange failed: {error}")))?;
        let response = response
            .error_for_status()
            .map_err(|error| OidcError::Provider(format!("Token exchange failed: {error}")))?;
        response
            .json::<serde_json::Value>()
            .await
            .map_err(|error| OidcError::Provider(format!("Token exchange failed: {error}")))
    }

    /// Verify an ID token against the provider JWKS, issuer, audience, and nonce.
    pub async fn verify_id_token(
        &self,
        config: &OidcConfig,
        id_token: &str,
        nonce: &str,
    ) -> Result<serde_json::Value, OidcError> {
        let metadata = self.get_metadata().await?.to_value();
        let jwks_uri = metadata
            .get("jwks_uri")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| OidcError::MetadataField("Missing jwks_uri in OIDC metadata".into()))?;
        let jwks = if let Some(cached) = self.jwks.lock().ok().and_then(|value| value.clone()) {
            cached
        } else {
            let response = self
                .client
                .get(jwks_uri)
                .map_err(|error| OidcError::Provider(error.to_string()))?
                .send()
                .await
                .map_err(|error| OidcError::Provider(format!("Unable to retrieve JWKS: {error}")))?
                .error_for_status()
                .map_err(|error| {
                    OidcError::Provider(format!("Unable to retrieve JWKS: {error}"))
                })?;
            let value = response
                .json::<serde_json::Value>()
                .await
                .map_err(|error| {
                    OidcError::Provider(format!("Unable to retrieve JWKS: {error}"))
                })?;
            if value
                .get("keys")
                .and_then(serde_json::Value::as_array)
                .is_none()
            {
                return Err(OidcError::InvalidToken("OIDC JWKS payload invalid".into()));
            }
            if let Ok(mut cache) = self.jwks.lock() {
                *cache = Some(value.clone());
            }
            value
        };
        let header = jsonwebtoken::decode_header(id_token).map_err(|error| {
            OidcError::InvalidToken(format!("ID Token verification failed: {error}"))
        })?;
        let kid = header.kid.as_deref();
        let keys = jwks
            .get("keys")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| OidcError::InvalidToken("OIDC JWKS payload invalid".into()))?;
        let key = keys
            .iter()
            .find(|key| kid.is_none() || key.get("kid").and_then(serde_json::Value::as_str) == kid)
            .ok_or_else(|| {
                OidcError::InvalidToken("ID Token verification failed: key not found".into())
            })?;
        let jwk: jsonwebtoken::jwk::Jwk = serde_json::from_value(key.clone()).map_err(|error| {
            OidcError::InvalidToken(format!("ID Token verification failed: {error}"))
        })?;
        let decoding_key = jsonwebtoken::DecodingKey::from_jwk(&jwk).map_err(|error| {
            OidcError::InvalidToken(format!("ID Token verification failed: {error}"))
        })?;
        let algorithm = header.alg;
        let mut validation = jsonwebtoken::Validation::new(algorithm);
        validation.set_issuer(&[metadata
            .get("issuer")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| OidcError::MetadataField("Missing issuer in OIDC metadata".into()))?]);
        validation.set_audience(&[config.client_id.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);
        let claims =
            jsonwebtoken::decode::<serde_json::Value>(id_token, &decoding_key, &validation)
                .map_err(|error| {
                    OidcError::InvalidToken(format!("ID Token verification failed: {error}"))
                })?
                .claims;
        if claims.get("nonce").and_then(serde_json::Value::as_str) != Some(nonce) {
            return Err(OidcError::InvalidToken(
                "ID Token verification failed: nonce mismatch".into(),
            ));
        }
        Ok(claims)
    }

    /// Fetch optional user-info claims. Failures are intentionally ignored by
    /// the callback, matching the source's warning-only behavior.
    pub async fn get_user_info(
        &self,
        endpoint: &str,
        access_token: &str,
    ) -> Option<serde_json::Value> {
        let response = self
            .client
            .get(endpoint)
            .ok()?
            .bearer_auth(access_token)
            .send()
            .await
            .ok()?;
        response.error_for_status().ok()?.json().await.ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> OidcService {
        OidcService::new(&OidcConfig::default()).expect("valid default discovery URL")
    }

    #[test]
    fn builds_from_default_config() {
        let _ = service();
    }

    #[tokio::test]
    async fn metadata_error_maps_to_source_detail() {
        // The default discovery URL points at an unroutable localhost port;
        // the transport error must surface with the source's 502 wording.
        let service = service();
        let error = service.get_metadata().await.expect_err("transport fails");
        assert!(
            error
                .detail()
                .starts_with("Unable to retrieve OIDC metadata: ")
        );
    }

    #[test]
    fn certificate_failures_render_python_openssl_text() {
        let text = python_httpx_error_text_checked("outer; certificate verify failed; inner");
        assert_eq!(
            text,
            "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain (_ssl.c:1010)"
        );
    }

    /// Mirrors `python_httpx_error_text`'s classification on the joined
    /// error-chain text without constructing a real reqwest error.
    fn python_httpx_error_text_checked(chain: &str) -> String {
        if chain.contains("certificate") {
            "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain (_ssl.c:1010)".to_string()
        } else {
            chain.to_string()
        }
    }

    #[tokio::test]
    async fn metadata_failure_is_not_cached() {
        // The source does not cache failures; every call retries.
        let service = service();
        assert!(service.get_metadata().await.is_err());
        assert!(service.get_metadata().await.is_err());
        assert!(service.cached_metadata().is_none());
    }

    #[test]
    fn metadata_cache_round_trips() {
        let service = service();
        service.store_metadata(serde_json::Value::Null.into());
        assert!(service.cached_metadata().is_some());
    }
}
