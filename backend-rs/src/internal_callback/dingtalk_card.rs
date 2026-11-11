// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! DingTalk AI-card OpenAPI transport.
//!
//! Source: `app/services/channels/dingtalk/card_transport.py` and
//! `card_adapter.py`'s `TemplateChatCardAdapter._stream`. The channel emitter
//! streams the card body with `PUT {api_base}/v1.0/card/streaming`, the
//! `x-acs-dingtalk-access-token` header, and a JSON body carrying the
//! out-track id, a fresh uuid4-hex guid, the configured content key, the
//! rendered content, and the `isFull`/`isFinalize`/`isError` flags.
//!
//! The Source transport is created per channel: `DingTalkCallbackService`
//! resolves the running channel's Stream client and reuses that channel's
//! credential and access-token cache. This port resolves the same active
//! Messager CRD per request, validates its DingTalk metadata, decrypts its
//! `client_id`/`client secret`, and exchanges them for the card request
//! token. Credentials stay channel-scoped: there is no process-global
//! credential and no cache shared across channels.
//!
//! Requests are bounded: the whole call has a 15-second deadline, the token
//! exchange has its own 5-second cap, PUT retries at most three times on
//! transport/429/5xx errors with exponential backoff, and any other failure is
//! final.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::background_jobs::project::notifications::{
    DingTalkAccessToken, active_dingtalk_channel_config, dingtalk_access_token,
    dingtalk_credentials,
};
use crate::state::AppState;

/// `CARD_REQUEST_TIMEOUT`: the deadline for one card request.
const CARD_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// `httpx.Timeout(10, connect=5)`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// `card_transport._access_token`'s `fail_after(5)` for the token exchange.
const TOKEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// `stop_after_attempt(3)` for PUT requests; other methods try once.
const PUT_ATTEMPTS: u32 = 3;
/// `card_transport.request`'s fixed OpenAPI origin.
const CARD_API_BASE: &str = "https://api.dingtalk.com";

/// One card the writer chain streams to (`TemplateChatCardAdapter`).
pub(crate) struct CardRef<'a> {
    /// The callback's channel, used to resolve that channel's credential.
    pub(crate) channel_id: i64,
    pub(crate) out_track_id: &'a str,
    pub(crate) content_key: &'a str,
}

/// One channel's effective access token.
#[derive(Clone)]
pub(crate) struct CardChannelConfig {
    pub(crate) access_token: String,
}

/// The card transport used by the DingTalk writer chain.
pub(crate) trait CardStream {
    async fn update(&self, card: &CardRef<'_>, content: &str) -> Result<(), String>;
    async fn finish(&self, card: &CardRef<'_>, content: &str) -> Result<(), String>;
    async fn fail(&self, card: &CardRef<'_>, content: &str) -> Result<(), String>;
}

/// The production card streaming transport.
pub(crate) struct DingTalkCardTransport<'a> {
    state: &'a AppState,
    http: Option<brz_http::Client>,
}

impl<'a> DingTalkCardTransport<'a> {
    /// Build the transport for this process. Channel credentials are resolved
    /// per request from the callback's channel id.
    pub(crate) fn from_process(state: &'a AppState) -> Self {
        Self {
            state,
            http: http_client(),
        }
    }

    /// The channel's access token.
    ///
    /// `DingTalkCallbackService._create_emitter` obtains the credential from
    /// the running channel's Stream client. This validates the active Messager
    /// metadata, decrypts the credential, and exchanges it for the card request
    /// token, reusing the channel's still-valid token when one is cached.
    async fn channel_config(&self, channel_id: i64) -> Result<CardChannelConfig, String> {
        let config = active_dingtalk_channel_config(self.state, channel_id)
            .await
            .map_err(|error| format!("DingTalk channel {channel_id}: {error}"))?;
        let (client_id, client_secret) = dingtalk_credentials(&config)
            .ok_or_else(|| format!("DingTalk channel {channel_id}: missing channel credentials"))?;
        if let Some(access_token) = cached_token(channel_id, client_id) {
            return Ok(CardChannelConfig { access_token });
        }
        let Some(http) = self.http.as_ref() else {
            return Err("DingTalk card HTTP client unavailable".to_string());
        };
        let access = tokio::time::timeout(
            TOKEN_REQUEST_TIMEOUT,
            dingtalk_access_token(http, client_id, client_secret),
        )
        .await
        .map_err(|_| format!("DingTalk channel {channel_id}: access token deadline exceeded"))?
        .map_err(|error| format!("DingTalk channel {channel_id}: {error}"))?;
        store_token(channel_id, client_id, &access);
        Ok(CardChannelConfig {
            access_token: access.token,
        })
    }

    /// `DingTalkCardTransport.request`: one bounded, retried card request.
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: &Value,
        channel_id: i64,
    ) -> Result<(), String> {
        match tokio::time::timeout(
            CARD_REQUEST_TIMEOUT,
            self.request_before_deadline(method, path, body, channel_id),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(format!("DingTalk card {path}: request deadline exceeded")),
        }
    }

    async fn request_before_deadline(
        &self,
        method: &str,
        path: &str,
        body: &Value,
        channel_id: i64,
    ) -> Result<(), String> {
        let config = self.channel_config(channel_id).await?;
        let attempts = if method == "PUT" { PUT_ATTEMPTS } else { 1 };
        let started = Instant::now();
        let mut last_error = String::new();
        for attempt in 1..=attempts {
            match self.send_once(method, path, body, &config).await {
                Ok(()) => return Ok(()),
                Err(AttemptError::Fatal(message)) => return Err(message),
                Err(AttemptError::Retryable(message)) => {
                    last_error = message;
                    if attempt == attempts {
                        break;
                    }
                    let backoff = Duration::from_millis(500 * 2u64.pow(attempt - 1));
                    if started.elapsed() + backoff >= CARD_REQUEST_TIMEOUT {
                        break;
                    }
                    tokio::time::sleep(backoff).await;
                }
            }
        }
        Err(last_error)
    }

    /// One HTTP attempt; classifies failures the way `_retryable` does.
    async fn send_once(
        &self,
        method: &str,
        path: &str,
        body: &Value,
        config: &CardChannelConfig,
    ) -> Result<(), AttemptError> {
        let Some(http) = self.http.as_ref() else {
            return Err(AttemptError::Fatal(
                "DingTalk card HTTP client unavailable".to_string(),
            ));
        };
        let url = format!("{CARD_API_BASE}/v1.0/card/{path}");
        let builder = match method {
            "PUT" => http.put(&url),
            "POST" => http.post(&url),
            other => {
                return Err(AttemptError::Fatal(format!(
                    "DingTalk card {path}: unsupported method {other}"
                )));
            }
        }
        .map_err(|error| {
            AttemptError::Fatal(format!("DingTalk card {path}: invalid request: {error}"))
        })?;
        let response = builder
            .header("x-acs-dingtalk-access-token", config.access_token.as_str())
            .json(body)
            .timeout(CARD_REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                AttemptError::Retryable(format!("DingTalk card {path}: transport failure: {error}"))
            })?;
        let status = response.status();
        if status.as_u16() == 429 || status.is_server_error() {
            return Err(AttemptError::Retryable(format!(
                "DingTalk card {path}: HTTP {}",
                status.as_u16()
            )));
        }
        if !status.is_success() {
            return Err(AttemptError::Fatal(format!(
                "DingTalk card {path}: HTTP {}",
                status.as_u16()
            )));
        }
        let data: Value = response.json().await.unwrap_or_else(|_| json!({}));
        if data.get("success") != Some(&Value::Bool(true)) {
            return Err(AttemptError::Fatal(format!(
                "DingTalk card {path}: request was not accepted"
            )));
        }
        Ok(())
    }
}

impl CardStream for DingTalkCardTransport<'_> {
    async fn update(&self, card: &CardRef<'_>, content: &str) -> Result<(), String> {
        self.request(
            "PUT",
            "streaming",
            &stream_body(card, content, false, false),
            card.channel_id,
        )
        .await
    }

    async fn finish(&self, card: &CardRef<'_>, content: &str) -> Result<(), String> {
        self.request(
            "PUT",
            "streaming",
            &stream_body(card, content, true, false),
            card.channel_id,
        )
        .await
    }

    async fn fail(&self, card: &CardRef<'_>, content: &str) -> Result<(), String> {
        self.request(
            "PUT",
            "streaming",
            &stream_body(card, content, true, true),
            card.channel_id,
        )
        .await
    }
}

/// `TemplateChatCardAdapter._stream`'s JSON body. Every call carries an
/// independently generated `uuid4().hex` guid.
pub(crate) fn stream_body(card: &CardRef<'_>, content: &str, finalize: bool, error: bool) -> Value {
    json!({
        "outTrackId": card.out_track_id,
        "guid": random_hex_32(),
        "key": card.content_key,
        "content": content,
        "isFull": true,
        "isFinalize": finalize,
        "isError": error,
    })
}

/// `uuid.uuid4().hex`: 16 random bytes as 32 lowercase hex characters.
pub(crate) fn random_hex_32() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// One failure classified like `_retryable`.
enum AttemptError {
    Retryable(String),
    Fatal(String),
}

/// A channel credential's cached access token and its monotonic expiry.
struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// At most one token per `(channel, client)` pair.
///
/// Source reuses `self._client._access_token` for that channel's Stream client,
/// expiring at `expireIn - 300` seconds. Keying by channel keeps tokens
/// channel-scoped; the capacity bounds the map.
const TOKEN_CACHE_CAPACITY: usize = 1024;
/// `max(0, int(data["expireIn"]) - 300)` from `_access_token`.
const TOKEN_EXPIRY_MARGIN_SECONDS: i64 = 300;

fn token_cache() -> &'static Mutex<HashMap<(i64, String), CachedToken>> {
    static CACHE: OnceLock<Mutex<HashMap<(i64, String), CachedToken>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A still-valid token for this channel credential, if one is cached.
fn cached_token(channel_id: i64, client_id: &str) -> Option<String> {
    let now = Instant::now();
    let mut cache = token_cache().lock().ok()?;
    let key = (channel_id, client_id.to_owned());
    match cache.get(&key) {
        Some(entry) if entry.expires_at > now => Some(entry.token.clone()),
        Some(_) => {
            cache.remove(&key);
            None
        }
        None => None,
    }
}

/// Cache the token until `expireIn - 300` seconds, matching the Source.
fn store_token(channel_id: i64, client_id: &str, access: &DingTalkAccessToken) {
    let Some(lifetime) = access
        .expires_in
        .checked_sub(TOKEN_EXPIRY_MARGIN_SECONDS)
        .filter(|seconds| *seconds > 0)
    else {
        return;
    };
    let Ok(mut cache) = token_cache().lock() else {
        return;
    };
    let now = Instant::now();
    let key = (channel_id, client_id.to_owned());
    if cache.len() >= TOKEN_CACHE_CAPACITY && !cache.contains_key(&key) {
        let stale = cache
            .iter()
            .find(|(_, entry)| entry.expires_at <= now)
            .map(|(candidate, _)| candidate.clone());
        let stale = match stale {
            Some(stale) => Some(stale),
            None => cache
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(candidate, _)| candidate.clone()),
        };
        if let Some(stale) = stale {
            cache.remove(&stale);
        }
    }
    cache.insert(
        key,
        CachedToken {
            token: access.token.clone(),
            expires_at: now + Duration::from_secs(lifetime as u64),
        },
    );
}

/// The process-lifetime card HTTP client. The deployment trust anchor joins the
/// built-in roots so an intercepted HTTPS endpoint validates.
fn http_client() -> Option<brz_http::Client> {
    static CLIENT: OnceLock<Option<brz_http::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let builder = brz_http::Client::builder()
                .timeout(CARD_REQUEST_TIMEOUT)
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(CARD_REQUEST_TIMEOUT)
                .configure(|inner| match crate::http_trust::trust_anchor() {
                    Some(anchor) => inner.add_root_certificate(anchor),
                    None => inner,
                });
            match builder.build() {
                Ok(client) => Some(client),
                Err(error) => {
                    tracing::error!(%error, "failed to build the DingTalk card HTTP client");
                    None
                }
            }
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card() -> CardRef<'static> {
        CardRef {
            channel_id: 1000,
            out_track_id: "card-out-track-1",
            content_key: "content",
        }
    }

    #[test]
    fn the_stream_body_matches_the_source_shape_and_uses_a_fresh_guid() {
        let first = stream_body(&card(), "streamed content", false, false);
        let second = stream_body(&card(), "streamed content", true, false);
        assert_eq!(first["outTrackId"], "card-out-track-1");
        assert_eq!(first["key"], "content");
        assert_eq!(first["content"], "streamed content");
        assert_eq!(first["isFull"], true);
        assert_eq!(first["isFinalize"], false);
        assert_eq!(first["isError"], false);
        assert_eq!(second["isFinalize"], true);

        let first_guid = first["guid"].as_str().unwrap();
        let second_guid = second["guid"].as_str().unwrap();
        assert_eq!(first_guid.len(), 32);
        assert!(first_guid.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first_guid, second_guid);
    }

    #[test]
    fn the_push_error_body_sets_both_terminal_flags() {
        let body = stream_body(&card(), "boom", true, true);
        assert_eq!(body["isFinalize"], true);
        assert_eq!(body["isError"], true);
    }

    #[test]
    fn the_token_cache_is_channel_scoped_and_honours_the_expiry_margin() {
        let access = |token: &str, expires_in| DingTalkAccessToken {
            token: token.to_owned(),
            expires_in,
        };
        store_token(9001, "client-a", &access("tok-a", 900));
        assert_eq!(cached_token(9001, "client-a"), Some("tok-a".to_owned()));
        // Another channel or a rotated credential never reuses this token.
        assert_eq!(cached_token(9002, "client-a"), None);
        assert_eq!(cached_token(9001, "client-b"), None);
        // A lifetime entirely inside the 300-second safety margin is not cached.
        store_token(9003, "client-a", &access("tok-b", 300));
        assert_eq!(cached_token(9003, "client-a"), None);
    }
}
