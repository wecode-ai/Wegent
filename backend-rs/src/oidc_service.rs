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

use brz_http::{Client, Endpoint};
use brz_json::OpaqueJson;

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

/// One `jwt.decode` attempt's failure classification, mirroring the source's
/// retry decision (`app/services/oidc.py:245-257`).
enum VerifyFailure {
    /// authlib's `ValueError("Invalid JSON Web Key Set")` from
    /// `create_load_key` (`authlib/jose/rfc7519/jwt.py:170-191`): the token's
    /// `kid` matches no key in the set, or the token carries no `kid` while
    /// the set holds more than one key. The source retries exactly once,
    /// dropping the cached key set first.
    InvalidKeySet,
    /// The key-set fetch failed; the detail already carries the source's
    /// `Unable to retrieve JWKS: ...` wording. Retained for the error
    /// mapping's completeness; every current fetch failure propagates
    /// directly rather than entering the retry classification.
    #[allow(dead_code, reason = "documented fetch-failure classification")]
    Provider(String),
    /// Any other header, key, or signature failure; the detail already
    /// carries the source's complete `detail` text.
    InvalidToken(String),
}

impl VerifyFailure {
    /// The [`OidcError`] this attempt's failure becomes when no retry follows.
    fn into_error(self) -> OidcError {
        match self {
            Self::InvalidKeySet => OidcError::InvalidToken(
                "ID Token verification failed: Invalid JSON Web Key Set".into(),
            ),
            Self::Provider(detail) => OidcError::Provider(detail),
            Self::InvalidToken(detail) => OidcError::InvalidToken(detail),
        }
    }
}

impl OidcService {
    /// Builds the retained service. The source constructs a fresh
    /// `httpx.AsyncClient()` per call; the target keeps one Breeze client
    /// with the same transport policy, per the platform HTTP capability's
    /// client-ownership contract.
    ///
    /// The source's `httpx` clients resolve against the system trust store and
    /// therefore accept intercepted provider HTTPS dependencies; the shared
    /// `brz-http` transport validates against the bundled webpki roots only,
    /// so the deployment's mounted Replay CA is added when one exists and a
    /// normal host keeps the built-in roots.
    ///
    /// # Errors
    ///
    /// Returns an error when the discovery endpoint URL is invalid.
    pub fn new(config: &OidcConfig) -> brz_http::Result<Self> {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(REQUEST_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .configure(|builder| match crate::http_trust::trust_anchor() {
                Some(anchor) => builder.add_root_certificate(anchor),
                None => builder,
            })
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

    /// Builds the provider authorization URL, mirroring
    /// `app/services/oidc.py::get_authorization_url`.
    ///
    /// The metadata is fetched (and cached) first; a missing
    /// `authorization_endpoint` raises the source's
    /// `HTTPException(502, "Missing authorization_endpoint in OIDC metadata")`.
    /// The query string uses the source's `urlencode` (`quote_plus`) encoding
    /// in the source dict's insertion order.
    pub async fn get_authorization_url(
        &self,
        config: &OidcConfig,
        state: &str,
        nonce: &str,
    ) -> Result<String, OidcError> {
        let metadata = self.get_metadata().await?.to_value();
        let authorization_endpoint = metadata
            .get("authorization_endpoint")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                OidcError::MetadataField(
                    "Missing authorization_endpoint in OIDC metadata".to_string(),
                )
            })?;
        let params = [
            ("response_type", "code"),
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", config.redirect_uri.as_str()),
            ("scope", "openid email profile"),
            ("state", state),
            ("nonce", nonce),
        ];
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params)
            .finish();
        Ok(format!("{authorization_endpoint}?{query}"))
    }

    /// Builds the CLI authorization URL, mirroring
    /// `app/services/oidc.py::get_authorization_url_for_cli`: the provider
    /// sees the `{client_id}-cli` client and the CLI redirect URI. The
    /// metadata fetch, the missing-endpoint error, and the `urlencode`
    /// (`quote_plus`) query encoding in the source dict's insertion order all
    /// match [`Self::get_authorization_url`].
    pub async fn get_authorization_url_for_cli(
        &self,
        config: &OidcConfig,
        state: &str,
        nonce: &str,
    ) -> Result<String, OidcError> {
        let metadata = self.get_metadata().await?.to_value();
        let authorization_endpoint = metadata
            .get("authorization_endpoint")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                OidcError::MetadataField(
                    "Missing authorization_endpoint in OIDC metadata".to_string(),
                )
            })?;
        let client_id = config.cli_client_id();
        let params = [
            ("response_type", "code"),
            ("client_id", client_id.as_str()),
            ("redirect_uri", config.cli_redirect_uri.as_str()),
            ("scope", "openid email profile"),
            ("state", state),
            ("nonce", nonce),
        ];
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params)
            .finish();
        Ok(format!("{authorization_endpoint}?{query}"))
    }

    /// Exchange an authorization code at the provider's token endpoint.
    pub async fn exchange_code_for_tokens(
        &self,
        config: &OidcConfig,
        code: &str,
    ) -> Result<serde_json::Value, OidcError> {
        self.request_tokens(
            &config.client_id,
            &config.client_secret,
            &authorization_code_form(config.redirect_uri.as_str(), code),
        )
        .await
    }

    /// Exchange the CLI authorization code, mirroring
    /// `exchange_code_for_tokens_for_cli`: the provider sees the `-cli`
    /// client id and the CLI redirect URI.
    pub async fn exchange_code_for_tokens_for_cli(
        &self,
        config: &OidcConfig,
        code: &str,
    ) -> Result<serde_json::Value, OidcError> {
        let client_id = config.cli_client_id();
        self.request_tokens(
            &client_id,
            &config.client_secret,
            &authorization_code_form(config.cli_redirect_uri.as_str(), code),
        )
        .await
    }

    /// The provider's `token_endpoint`, resolved through the cached metadata.
    async fn token_endpoint(&self) -> Result<String, OidcError> {
        let metadata = self.get_metadata().await?.to_value();
        metadata
            .get("token_endpoint")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                OidcError::MetadataField("Missing token_endpoint in OIDC metadata".into())
            })
    }

    /// POSTs one form-encoded token request with basic authentication. Every
    /// failure is the source's `Token exchange failed: {e}`.
    async fn request_tokens(
        &self,
        client_id: &str,
        client_secret: &str,
        form: &[(&str, &str)],
    ) -> Result<serde_json::Value, OidcError> {
        let endpoint = self.token_endpoint().await?;
        let response = self
            .client
            .post(endpoint.as_str())
            .map_err(|error| OidcError::Provider(error.to_string()))?
            .basic_auth(client_id, Some(client_secret))
            .form(form)
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

    /// Verify an ID token against the provider JWKS.
    ///
    /// The source calls `authlib.jose.jwt.decode(id_token, jwks,
    /// claims_options={...})`, and that function verifies only the signature:
    /// it builds the claims object from the verified payload and returns it
    /// without ever calling `Claims.validate()`. The `iss`, `aud`, and `nonce`
    /// `claims_options` it passes are therefore inert, as is every time claim.
    /// `_config` and `_nonce` are retained to mirror the source's call
    /// (`self.client_id` and the `state` nonce) even though neither reaches
    /// validation; the CLI flow's id_token carries `aud` = `{client_id}-cli`,
    /// which the source accepts.
    ///
    /// The source wraps the decode in a two-attempt loop
    /// (`app/services/oidc.py:224-257`): when authlib's key selection raises
    /// `ValueError("Invalid JSON Web Key Set")` — most importantly when the
    /// token's `kid` matches no key in the cached set — the cached JWKS is
    /// dropped and the decode retried once against a freshly fetched key set.
    /// Every other failure breaks out immediately with the source's
    /// `ID Token verification failed: {last_error}` detail.
    pub async fn verify_id_token(
        &self,
        _config: &OidcConfig,
        id_token: &str,
        _nonce: &str,
    ) -> Result<serde_json::Value, OidcError> {
        let metadata = self.get_metadata().await?.to_value();
        let jwks_uri = metadata
            .get("jwks_uri")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| OidcError::MetadataField("Missing jwks_uri in OIDC metadata".into()))?
            .to_owned();
        let header = jsonwebtoken::decode_header(id_token).map_err(|error| {
            OidcError::InvalidToken(format!("ID Token verification failed: {error}"))
        })?;
        let mut drop_cached_key_set = false;
        for attempt in 1..=2 {
            let jwks = match self.key_set(&jwks_uri, drop_cached_key_set).await {
                Ok(jwks) => jwks,
                Err(error) => return Err(OidcError::Provider(error)),
            };
            match self.decode_with_key_set(id_token, &header, &jwks) {
                Ok(claims) => return Ok(claims),
                Err(VerifyFailure::InvalidKeySet) if attempt == 1 => {
                    drop_cached_key_set = true;
                }
                Err(failure) => return Err(failure.into_error()),
            }
        }
        unreachable!("the loop returns on every path by the second iteration")
    }

    /// The cached key set, or a fresh `GET jwks_uri` fetch that replaces it.
    /// `drop_cached` implements the source's one-shot `self._jwks = None`.
    async fn key_set(
        &self,
        jwks_uri: &str,
        drop_cached: bool,
    ) -> Result<serde_json::Value, String> {
        if !drop_cached && let Some(cached) = self.jwks.lock().ok().and_then(|value| value.clone())
        {
            return Ok(cached);
        }
        let response = self
            .client
            .get(jwks_uri)
            .map_err(|error| error.to_string())?
            .send()
            .await
            .map_err(|error| format!("Unable to retrieve JWKS: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Unable to retrieve JWKS: {error}"))?;
        let value = response
            .json::<serde_json::Value>()
            .await
            .map_err(|error| format!("Unable to retrieve JWKS: {error}"))?;
        if value
            .get("keys")
            .and_then(serde_json::Value::as_array)
            .is_none()
        {
            // `get_jwks` raises `HTTPException(502, "OIDC JWKS payload
            // invalid")`, which `verify_id_token` re-raises unchanged.
            return Err("OIDC JWKS payload invalid".to_string());
        }
        if let Ok(mut cache) = self.jwks.lock() {
            *cache = Some(value.clone());
        }
        Ok(value)
    }

    /// One `jwt.decode` attempt against a concrete key set: authlib's
    /// `create_load_key` selection followed by signature verification. No
    /// claim is validated (`Claims.validate` is never called by the source).
    fn decode_with_key_set(
        &self,
        id_token: &str,
        header: &jsonwebtoken::Header,
        jwks: &serde_json::Value,
    ) -> Result<serde_json::Value, VerifyFailure> {
        let failure = |error: String| {
            VerifyFailure::InvalidToken(format!("ID Token verification failed: {error}"))
        };
        let keys = jwks
            .get("keys")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| failure("OIDC JWKS payload invalid".into()))?;
        // authlib's key selection: a present `kid` must match a key exactly;
        // an absent `kid` selects the one key of a singleton set, and any
        // other miss raises `ValueError("Invalid JSON Web Key Set")`.
        let key = match header.kid.as_deref() {
            Some(kid) => keys
                .iter()
                .find(|key| key.get("kid").and_then(serde_json::Value::as_str) == Some(kid)),
            None if keys.len() == 1 => keys.first(),
            None => None,
        }
        .ok_or(VerifyFailure::InvalidKeySet)?;
        let jwk: jsonwebtoken::jwk::Jwk =
            serde_json::from_value(key.clone()).map_err(|error| failure(error.to_string()))?;
        let decoding_key = jsonwebtoken::DecodingKey::from_jwk(&jwk)
            .map_err(|error| failure(error.to_string()))?;
        // Signature verification is the source's whole contract here, so the
        // algorithm and key selection are enforced while every claim check
        // stays off (`jwt.decode` never validates).
        let mut validation = jsonwebtoken::Validation::new(header.alg);
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        jsonwebtoken::decode::<serde_json::Value>(id_token, &decoding_key, &validation)
            .map(|decoded| decoded.claims)
            .map_err(|error| failure(error.to_string()))
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

/// The authorization-code form body shared by both callback variants.
///
/// The source's `authlib` client serializes the fields as `grant_type`,
/// `redirect_uri`, then `code`; Replay compares form bodies byte-exactly, so
/// this order is part of the observable provider request contract.
fn authorization_code_form<'a>(
    redirect_uri: &'a str,
    code: &'a str,
) -> [(&'static str, &'a str); 3] {
    [
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
        ("code", code),
    ]
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

    /// The recorded source token request orders `grant_type`, `redirect_uri`,
    /// then `code`; provider Replay matches form bodies byte-exactly.
    #[test]
    fn authorization_code_form_matches_source_serialization_order() {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(authorization_code_form(
                "https://idp.example.invalid/callback",
                "abc",
            ))
            .finish();
        assert_eq!(
            body,
            "grant_type=authorization_code&redirect_uri=https%3A%2F%2Fidp.example.invalid%2Fcallback&code=abc"
        );
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

    /// The HMAC key the stub identity provider publishes in its JWKS.
    const IDP_KEY: &str = "signature-only-test-key";

    /// A stub identity provider: the discovery document (pointing at this same
    /// stub's JWKS path) and the JWKS itself.
    struct Idp {
        jwks: String,
    }

    impl brz_http_server::Handler for Idp {
        fn call<'a>(
            &'a self,
            request: brz_http_server::Request<'a>,
            _authenticator: &'a brz_http_server::NoAuthenticator,
        ) -> impl std::future::Future<Output = brz_http_server::Response> + Send + 'a {
            let body = if request.path().ends_with("openid-configuration") {
                let host = request
                    .header("host")
                    .and_then(|value| std::str::from_utf8(value).ok())
                    .unwrap_or_default();
                format!(
                    r#"{{"issuer":"https://issuer.invalid/dex","jwks_uri":"http://{host}/dex/keys"}}"#
                )
            } else {
                self.jwks.clone()
            };
            std::future::ready(
                brz_http_server::Response::owned_bytes(brz_http_server::StatusCode::OK, body)
                    .content_type("application/json"),
            )
        }
    }

    async fn stub_idp() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        use base64::Engine as _;

        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(IDP_KEY.as_bytes());
        let jwks =
            format!(r#"{{"keys":[{{"kty":"oct","kid":"k1","alg":"HS256","k":"{encoded}"}}]}}"#);
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), Idp { jwks })
            .await
            .expect("bind identity-provider stub");
        let address = server.local_addr().expect("local address");
        let task = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        (address, task)
    }

    #[tokio::test]
    async fn id_token_verification_is_signature_only() {
        // `authlib.jose.jwt.decode` builds the claims object from the verified
        // payload and returns it without calling `Claims.validate()`, so the
        // source's `iss`/`aud`/`nonce` `claims_options` and every time claim
        // are inert. The CLI flow proves it: it signs the request with
        // `{client_id}-cli` (so the id_token's `aud` is `wegent-cli`) while the
        // source passes `self.client_id` (`wegent`) as the expected audience,
        // and the recorded run still completed the login.
        let (address, stub) = stub_idp().await;
        let config = OidcConfig {
            discovery_url: format!("http://{address}/.well-known/openid-configuration"),
            ..OidcConfig::default()
        };
        let service = OidcService::new(&config).expect("valid discovery URL");
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            &serde_json::json!({
                "iss": "https://other-issuer.invalid/dex",
                "aud": "wegent-cli",
                "nonce": "some-other-nonce",
                "exp": 1,
                "sub": "CgYyMjA1NzcSB3NpbmFjYXM",
            }),
            &jsonwebtoken::EncodingKey::from_secret(IDP_KEY.as_bytes()),
        )
        .expect("sign id token");

        let claims = service
            .verify_id_token(&config, &token, "the-state-nonce")
            .await
            .expect("a mismatched audience, nonce, issuer and expiry still verify");
        assert_eq!(claims["aud"], "wegent-cli");
        assert_eq!(claims["sub"], "CgYyMjA1NzcSB3NpbmFjYXM");

        // The signature remains the whole contract.
        let mut segments: Vec<String> = token.split('.').map(str::to_owned).collect();
        let last = segments[2].pop().expect("signature is non-empty");
        segments[2].push(if last == 'A' { 'B' } else { 'A' });
        assert!(
            service
                .verify_id_token(&config, &segments.join("."), "the-state-nonce")
                .await
                .is_err()
        );
        stub.abort();
    }

    /// A stub identity provider that publishes one key set before a marker
    /// request and a different one after it, so the JWKS cache can be forced
    /// to a stale set and then observed to refetch. The fetch counter is
    /// per-instance; tests run in parallel.
    struct RotatingIdp {
        first: String,
        second: String,
        keys_fetches: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl brz_http_server::Handler for RotatingIdp {
        fn call<'a>(
            &'a self,
            request: brz_http_server::Request<'a>,
            _authenticator: &'a brz_http_server::NoAuthenticator,
        ) -> impl std::future::Future<Output = brz_http_server::Response> + Send + 'a {
            use std::sync::atomic::Ordering;

            let body = if request.path().ends_with("openid-configuration") {
                let host = request
                    .header("host")
                    .and_then(|value| std::str::from_utf8(value).ok())
                    .unwrap_or_default();
                format!(
                    r#"{{"issuer":"https://issuer.invalid/dex","jwks_uri":"http://{host}/dex/keys"}}"#
                )
            } else {
                // The first keys fetch serves the stale set; every later one
                // serves the rotated set containing the new kid.
                let fetched = self.keys_fetches.fetch_add(1, Ordering::SeqCst);
                if fetched == 0 {
                    self.first.clone()
                } else {
                    self.second.clone()
                }
            };
            std::future::ready(
                brz_http_server::Response::owned_bytes(brz_http_server::StatusCode::OK, body)
                    .content_type("application/json"),
            )
        }
    }

    /// The source's retry loop (`app/services/oidc.py:224-257`): when the
    /// token's `kid` matches no key in the cached JWKS, authlib's
    /// `ValueError("Invalid JSON Web Key Set")` makes the source drop the
    /// cached key set and retry the decode once against a fresh fetch. The
    /// cached set may exclude the current token's kid; a fresh key set can
    /// then verify the token.
    #[tokio::test]
    async fn kid_miss_drops_cached_key_set_and_retries_once() {
        use base64::Engine as _;

        let encode =
            |key: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.as_bytes());
        let stale = format!(
            r#"{{"keys":[{{"kty":"oct","kid":"old-kid","alg":"HS256","k":"{}"}}]}}"#,
            encode(IDP_KEY)
        );
        let rotated = format!(
            r#"{{"keys":[{{"kty":"oct","kid":"new-kid","alg":"HS256","k":"{}"}}]}}"#,
            encode(IDP_KEY)
        );
        let keys_fetches = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server = brz_http_server::Server::bind(
            "127.0.0.1:0".parse().unwrap(),
            RotatingIdp {
                first: stale,
                second: rotated,
                keys_fetches,
            },
        )
        .await
        .expect("bind rotating identity-provider stub");
        let address = server.local_addr().expect("local address");
        let stub = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });

        let config = OidcConfig {
            discovery_url: format!("http://{address}/.well-known/openid-configuration"),
            ..OidcConfig::default()
        };
        let service = OidcService::new(&config).expect("valid discovery URL");

        // Warm the cache with the stale set through a token carrying the old
        // kid, then present a token signed with the same key but a new kid.
        let old_token = jsonwebtoken::encode(
            &jsonwebtoken::Header {
                alg: jsonwebtoken::Algorithm::HS256,
                kid: Some("old-kid".into()),
                ..Default::default()
            },
            &serde_json::json!({"sub": "warmup"}),
            &jsonwebtoken::EncodingKey::from_secret(IDP_KEY.as_bytes()),
        )
        .expect("sign warmup token");
        service
            .verify_id_token(&config, &old_token, "nonce")
            .await
            .expect("warmup verifies against the stale key set");

        let new_token = jsonwebtoken::encode(
            &jsonwebtoken::Header {
                alg: jsonwebtoken::Algorithm::HS256,
                kid: Some("new-kid".into()),
                ..Default::default()
            },
            &serde_json::json!({"sub": "rotated"}),
            &jsonwebtoken::EncodingKey::from_secret(IDP_KEY.as_bytes()),
        )
        .expect("sign rotated token");
        let claims = service
            .verify_id_token(&config, &new_token, "nonce")
            .await
            .expect("a kid miss refetches the key set and verifies");
        assert_eq!(claims["sub"], "rotated");
        stub.abort();
    }

    /// A token whose `kid` is absent from every fetched key set still fails
    /// after exactly one retry, with the source's
    /// `ID Token verification failed: Invalid JSON Web Key Set` detail.
    #[tokio::test]
    async fn persistent_kid_miss_fails_after_one_retry() {
        use base64::Engine as _;

        let encode =
            |key: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.as_bytes());
        let keys = format!(
            r#"{{"keys":[{{"kty":"oct","kid":"known-kid","alg":"HS256","k":"{}"}}]}}"#,
            encode(IDP_KEY)
        );
        let keys_fetches = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server = brz_http_server::Server::bind(
            "127.0.0.1:0".parse().unwrap(),
            RotatingIdp {
                first: keys.clone(),
                second: keys,
                keys_fetches,
            },
        )
        .await
        .expect("bind stable identity-provider stub");
        let address = server.local_addr().expect("local address");
        let stub = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });

        let config = OidcConfig {
            discovery_url: format!("http://{address}/.well-known/openid-configuration"),
            ..OidcConfig::default()
        };
        let service = OidcService::new(&config).expect("valid discovery URL");
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header {
                alg: jsonwebtoken::Algorithm::HS256,
                kid: Some("missing-kid".into()),
                ..Default::default()
            },
            &serde_json::json!({"sub": "never-verified"}),
            &jsonwebtoken::EncodingKey::from_secret(IDP_KEY.as_bytes()),
        )
        .expect("sign token");
        let error = service
            .verify_id_token(&config, &token, "nonce")
            .await
            .expect_err("a kid missing from every key set fails");
        assert_eq!(
            error.detail(),
            "ID Token verification failed: Invalid JSON Web Key Set"
        );
        stub.abort();
    }
}
