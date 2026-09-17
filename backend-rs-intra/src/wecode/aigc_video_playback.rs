//! `GET /api/aigc-video/media/playback`: refresh the anti-hotlink signature
//! before browser-native video playback.
//!
//! Mirrors `wecode/video/api/router.py::aigc_video_playback`. The request
//! chain:
//!
//! 1. `_media_read_identity`: optional bearer authentication first (absent
//!    in the recorded traffic), then the `auth_token` cookie via
//!    `security.get_current_user_from_token` (JWT decode plus the labeled
//!    `users` lookup); an invalid cookie user resolves to `None` and falls
//!    through to `_shared_read_identity`, which raises 401 when no identity
//!    at all is available. A `share_token` query parameter would decrypt to
//!    a shared-task identity (AES-256-CBC); the source deployment leaves
//!    `SHARE_TOKEN_AES_KEY` unset, so every share token raises the 403
//!    `Invalid task share token`, reproduced without a cipher dependency.
//! 2. `validate_playback_url`: only `http`/`https` Weibo video CDN URLs
//!    (host `weibocdn.com` or `*.weibocdn.com`) without userinfo.
//! 3. `sign_urls` (`super::media_signing`): the TAuth2 token is fetched from
//!    the dedicated Redis (`HGET token_v2 <APPKEY_SOURCE>`, cached for three
//!    hours like the source module cache) and used to sign
//!    `GET {WEIBO_MEDIA_SSIG_URL}?source={appkey}&urls={url-without-query}`;
//!    the recorded signing response returns an `ssig_url`.
//! 4. `_stream_signed_video`: stream the signed URL (forwarding the request
//!    `Range` header). The recorded playback environment's TLS connection to
//!    `f.video.weibocdn.com` fails, so the source maps the transport error
//!    to `502 {"detail":"AIGC video playback is unavailable"}` — the
//!    behavior reproduced here for the recorded cases. Non-failing streams
//!    relay the upstream status, content type, `content-length`,
//!    `content-range`, and playback headers with 1 MiB chunks. Every
//!    failure in the signing phase (`httpx.HTTPError`, `ValueError`) maps
//!    to the same 502 body.
use brz_http_server::{Bytes, HttpResponse, IntoHttpError as _, IntoHttpResponse as _, StatusCode};
use serde::Deserialize;
use serde::de::IgnoredAny;

use brz_mysql::Mysql;
use brz_redis::Redis;
use wegent_backend_rs::config::AuthConfig;

use super::media_signing::{APPKEY_SOURCE, sign_urls, upload_settings};

/// Source `MEDIA_CHUNK_SIZE` (1 MiB): the source chunks its streaming relay
/// with `aiter_bytes`; the target relays upstream chunks directly, so the
/// constant documents the source framing contract only.
#[allow(dead_code, reason = "documents the source streaming chunk size")]
const MEDIA_CHUNK_SIZE: usize = 1024 * 1024;
/// Source `WEWORK_ACCESS_TOKEN_USE` (`app.core.session_token`).
const WEWORK_ACCESS_TOKEN_USE: &str = "wework_access";

/// The relayed upstream media stream: a pinned boxed byte stream.
type MediaStream =
    std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

/// One of the endpoint's failure shapes or the relayed media stream. The
/// stream variant keeps the `HttpResponse` builder and converts with the
/// request arena at response time.
enum PlaybackOutcome {
    Error(wegent_backend_rs::http_compat::FastApiError),
    Stream(HttpResponse<MediaStream>),
}

impl From<wegent_backend_rs::http_compat::FastApiError> for PlaybackOutcome {
    fn from(error: wegent_backend_rs::http_compat::FastApiError) -> Self {
        Self::Error(error)
    }
}

impl brz_http_server::IntoHttpError for PlaybackOutcome {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::Error(error) => error.into_http_error(arena),
            Self::Stream(response) => response.into_http_response(arena),
        }
    }
}

// A bare `Ok(PlaybackOutcome::Stream(..))` converts through the `Direct`
// category: the response is already built. The enum does not implement
// `Serialize`, so this impl is the only applicable conversion.
impl brz_http_server::IntoHttpResponse<brz_http_server::__private::kind::Direct>
    for PlaybackOutcome
{
    fn into_http_response(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::Error(error) => error.into_http_error(arena),
            Self::Stream(response) => response.into_http_response(arena),
        }
    }
}

/// Renders the source `HTTPException(502, "AIGC video playback is
/// unavailable")` response shared by every failure path of this endpoint.
fn playback_unavailable() -> wegent_backend_rs::http_compat::FastApiError {
    wegent_backend_rs::http_compat::FastApiError::detail(
        StatusCode::BAD_GATEWAY,
        "AIGC video playback is unavailable",
    )
}

/// Renders the source 401 `Not authenticated` (with
/// `WWW-Authenticate: Bearer`).
fn not_authenticated() -> wegent_backend_rs::http_compat::FastApiError {
    wegent_backend_rs::http_compat::FastApiError::unauthorized("Not authenticated")
}

#[derive(Debug, Deserialize)]
pub struct PlaybackQuery {
    pub video_url: String,
    #[serde(default)]
    pub share_token: Option<String>,
}

/// Parsed cookie value: one `name=value` pair from a `Cookie` header.
fn cookie_value<'a>(cookie: Option<&'a str>, name: &str) -> Option<&'a str> {
    let raw = cookie?;
    for pair in raw.split(';') {
        let pair = pair.trim();
        if let Some((key, val)) = pair.split_once('=')
            && key.trim() == name
        {
            return Some(val.trim());
        }
    }
    None
}

/// GET /api/aigc-video/media/playback: the AIGC video playback free function,
/// injecting the internal feature dependencies.
#[brz_http_server::get("/api/aigc-video/media/playback", group = crate::wecode::startup::wecode_apis)]
async fn aigc_video_playback(
    #[inject(wecode)] state: &super::startup::SharedWecodeAppState,
    video_url: String,
    share_token: Option<String>,
    #[header] authorization: Option<&str>,
    #[header] cookie: Option<&str>,
    #[header] range: Option<&str>,
) -> Result<PlaybackOutcome, wegent_backend_rs::http_compat::FastApiError> {
    let query = PlaybackQuery {
        video_url,
        share_token,
    };
    Ok(playback(
        &state.app,
        state.tauth_redis.as_ref(),
        &query,
        authorization,
        cookie,
        range,
    )
    .await)
}

/// Handler body for `GET /api/aigc-video/media/playback`.
async fn playback<R: Redis>(
    app: &wegent_backend_rs::AppState,
    redis: Option<&R>,
    query: &PlaybackQuery,
    authorization: Option<&str>,
    cookie: Option<&str>,
    range: Option<&str>,
) -> PlaybackOutcome {
    // `_media_read_identity`: bearer (optional dependency) first, then the
    // `auth_token` cookie. An invalid token (signature, expiry, unknown
    // user, inactive user) resolves to `None` and falls through, so the
    // observable error for a rejected credential is the terminal 401.
    let bearer = wegent_backend_rs::auth::extract_authorization_token(authorization);
    if !bearer.is_empty() {
        match resolve_user(&app.auth, &app.mysql, &bearer).await {
            Ok(_) => {}
            Err(IdentityError::Degraded) => {}
        }
    } else if let Some(token) = cookie_value(cookie, "auth_token") {
        match resolve_user(&app.auth, &app.mysql, token).await {
            Ok(_) => {}
            Err(IdentityError::Degraded) => {}
        }
    } else if query.share_token.is_some() {
        // `_shared_read_identity` with a share token: `decode_share_token`
        // needs `SHARE_TOKEN_AES_KEY`, which the deployed source does not
        // configure; every token decrypts to `None` and raises 403.
        return wegent_backend_rs::http_compat::FastApiError::detail(
            StatusCode::FORBIDDEN,
            "Invalid task share token",
        )
        .into();
    } else {
        return not_authenticated().into();
    }

    let range_header = range.map(str::to_string);

    let Some(validated_url) = validate_playback_url(&query.video_url) else {
        return playback_unavailable().into();
    };
    if let Err(error) = upload_settings() {
        // `validate_storage_config`/`get_upload_uid` raise ValueError before
        // any network call, which the handler maps to the 502.
        tracing::warn!(stage = error.stage(), "AIGC playback config invalid");
        return playback_unavailable().into();
    }
    // `auth_headers(uid)`: the playback traffic signs the TAuth2 `uid`
    // parameter with the multimedia appkey itself.
    let signed = match sign_urls(
        &app.attachment_http,
        redis,
        APPKEY_SOURCE,
        std::slice::from_ref(&validated_url),
    )
    .await
    {
        Ok(signed) => signed,
        Err(error) => {
            tracing::warn!(stage = error.stage(), "AIGC playback signing failed");
            return playback_unavailable().into();
        }
    };
    // A signing response that yielded no usable `ssig_url` for the URL keeps
    // its `None` entry.
    let Some(signed_url) = signed.get(&validated_url).cloned().flatten() else {
        return playback_unavailable().into();
    };
    // The second `validate_playback_url` on the signed URL: the recorded
    // signing service returns a `weibocdn.com` host, so this passes.
    let Some(signed_url) = validate_playback_url(&signed_url) else {
        return playback_unavailable().into();
    };

    stream_signed_video(&app.attachment_http, &signed_url, range_header.as_deref()).await
}

/// `validate_playback_url`: allow only `http`/`https` Weibo video CDN URLs
/// without userinfo.
fn validate_playback_url(video_url: &str) -> Option<String> {
    let url = url::Url::parse(video_url).ok()?;
    let scheme_ok = matches!(url.scheme(), "http" | "https");
    let userinfo_ok = url.username().is_empty() && url.password().is_none();
    let host = url.host_str()?.to_ascii_lowercase();
    if scheme_ok && userinfo_ok && (host == "weibocdn.com" || host.ends_with(".weibocdn.com")) {
        Some(video_url.to_string())
    } else {
        None
    }
}

/// Why an identity could not be established for the request.
enum IdentityError {
    /// `get_current_user_from_token` returns `None` for an invalid token
    /// (invalid signature, unknown user, inactive user): the playback
    /// endpoint treats the user as absent instead of failing.
    Degraded,
}

/// `get_current_user_from_token`: verify the JWT and load the user row.
///
/// Only the two outcomes the playback endpoint distinguishes are surfaced:
/// a resolved user or a degraded (None) result; database failures propagate
/// as degraded as well because the recorded server keeps serving.
async fn resolve_user<M: Mysql>(
    auth: &AuthConfig,
    mysql: &M,
    token: &str,
) -> Result<(), IdentityError> {
    let username = verify_user_session_token(auth, token).ok_or(IdentityError::Degraded)?;
    match crate::wecode::quota::users::find_user_by_name(mysql, &username).await {
        Ok(Some(row)) if row.users_is_active != 0 => Ok(()),
        _ => Err(IdentityError::Degraded),
    }
}

/// `verify_token` + `is_user_session_payload` for the cookie path: `sub`
/// must be present, `scope` absent, and `token_use` absent or
/// `wework_access`.
fn verify_user_session_token(
    config: &wegent_backend_rs::config::AuthConfig,
    token: &str,
) -> Option<String> {
    #[derive(Default, serde::Deserialize)]
    #[serde(default)]
    struct SessionClaims {
        sub: Option<String>,
        scope: Option<IgnoredAny>,
        token_use: Option<String>,
    }
    let mut validation = jsonwebtoken::Validation::new(match config.algorithm.as_str() {
        "HS384" => jsonwebtoken::Algorithm::HS384,
        "HS512" => jsonwebtoken::Algorithm::HS512,
        _ => jsonwebtoken::Algorithm::HS256,
    });
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    for key in std::iter::once(config.jwt_key.as_str())
        .chain(config.legacy_jwt_keys.iter().map(String::as_str))
    {
        if let Ok(claims) = jsonwebtoken::decode::<SessionClaims>(
            token,
            &jsonwebtoken::DecodingKey::from_secret(key.as_bytes()),
            &validation,
        ) {
            let payload = claims.claims;
            let session = !payload.scope.is_some()
                && matches!(
                    payload.token_use.as_deref(),
                    None | Some(WEWORK_ACCESS_TOKEN_USE)
                );
            if session {
                return payload.sub;
            }
            return None;
        }
    }
    None
}

/// `_stream_signed_video`: relay the upstream video stream with the
/// request's `Range` header. Any transport failure (including the recorded
/// TLS failure to the video CDN) maps to the endpoint's 502 body.
async fn stream_signed_video(
    client: &brz_http::Client,
    signed_url: &str,
    range_header: Option<&str>,
) -> PlaybackOutcome {
    let request = match client.get(signed_url) {
        Ok(request) => request,
        Err(_) => return playback_unavailable().into(),
    };
    let request = match range_header {
        Some(range) => request.header("range", range),
        None => request,
    };
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, %signed_url, "AIGC playback stream failed");
            return playback_unavailable().into();
        }
    };
    let status = response.status();
    if !status.is_success() {
        // `raise_for_status()`: the playback handler maps the HTTPError to
        // the 502 body.
        return playback_unavailable().into();
    }
    let headers = response.headers().clone();
    let media_type = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("video/mp4")
        .to_string();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let content_range = headers
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let accept_ranges = headers
        .get("accept-ranges")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("bytes")
        .to_string();

    // Relay the upstream body as a live stream, like the source's
    // 1 MiB-chunk `StreamingResponse`. The platform response exposes
    // `chunk()`; the chunk adapter preserves the incremental relay.
    let stream = futures_util::stream::unfold(response, |mut response| async move {
        match response.chunk().await {
            Ok(Some(chunk)) if !chunk.is_empty() => {
                Some((Ok::<Bytes, std::io::Error>(chunk), response))
            }
            Ok(_) => None,
            Err(error) => Some((Err(std::io::Error::other(error.to_string())), response)),
        }
    });
    let stream: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send>,
    > = Box::pin(stream);
    let reply = HttpResponse::new(stream).status(status);
    let attach = |reply: HttpResponse<_>, name: &str, value: &str| {
        reply
            .header(name, value)
            .map_err(|_| playback_unavailable())
    };
    let reply = match attach(reply, "accept-ranges", &accept_ranges) {
        Ok(reply) => reply,
        Err(error) => return error.into(),
    };
    let reply = match attach(reply, "referrer-policy", "no-referrer") {
        Ok(reply) => reply,
        Err(error) => return error.into(),
    };
    let reply = match attach(reply, "x-accel-buffering", "no") {
        Ok(reply) => reply,
        Err(error) => return error.into(),
    };
    let mut reply = match attach(reply, "content-type", &media_type) {
        Ok(reply) => reply,
        Err(error) => return error.into(),
    };
    if let Some(length) = content_length {
        reply = reply.content_length(length);
    }
    if let Some(range) = content_range {
        reply = match attach(reply, "content-range", &range) {
            Ok(reply) => reply,
            Err(error) => return error.into(),
        };
    }
    PlaybackOutcome::Stream(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wecode::media_signing::{force_https_url, tauth_authorization};

    #[test]
    fn playback_url_allows_only_weibo_cdn_hosts() {
        let ok = "https://f.video.weibocdn.com/o0/0042oww1lx08ABV8fLZK01041200RT8J0E010";
        assert_eq!(validate_playback_url(ok).as_deref(), Some(ok));
        assert_eq!(
            validate_playback_url("http://weibocdn.com/x.mp4").as_deref(),
            Some("http://weibocdn.com/x.mp4")
        );
        assert_eq!(validate_playback_url("https://evil.com/x.mp4"), None);
        assert_eq!(
            validate_playback_url("https://user:pw@f.video.weibocdn.com/x.mp4"),
            None
        );
        assert_eq!(
            validate_playback_url("ftp://f.video.weibocdn.com/x.mp4"),
            None
        );
        assert_eq!(validate_playback_url("not a url"), None);
    }

    #[test]
    fn force_https_rewrites_http_only() {
        assert_eq!(
            force_https_url("http://f.video.weibocdn.com/x?ssig=1"),
            "https://f.video.weibocdn.com/x?ssig=1"
        );
        assert_eq!(
            force_https_url("https://f.video.weibocdn.com/x"),
            "https://f.video.weibocdn.com/x"
        );
    }

    #[test]
    fn tauth_authorization_matches_source_format() {
        // Recorded Redis entry and the header the source produced for it.
        let header = tauth_authorization(
            "OXQNTOTQWUTPXNXON=OUPXOUVVWQRUPSXNXOXyHzRA4Cx3B",
            "27e1180d9530ce7e9c00",
            APPKEY_SOURCE,
        );
        assert_eq!(
            header,
            "TAuth2 token=\"OXQNTOTQWUTPXNXON%3DOUPXOUVVWQRUPSXNXOXyHzRA4Cx3B\",\
             param=\"uid%3D3061639762\",sign=\"mNBuIfvkZdM%2BRICLfSE85wLdhGk%3D\""
        );
    }

    #[test]
    fn cookie_value_reads_auth_token_pair() {
        assert_eq!(
            cookie_value(Some("a=1; auth_token=eyJx.y.z; b=2"), "auth_token"),
            Some("eyJx.y.z")
        );
        assert_eq!(
            cookie_value(Some("a=1; auth_token=eyJx.y.z; b=2"), "missing"),
            None
        );
        assert_eq!(cookie_value(None, "auth_token"), None);
    }

    #[test]
    fn unavailable_body_matches_source_detail() {
        let error = playback_unavailable();
        assert_eq!(error.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn not_authenticated_carries_www_authenticate() {
        let error = not_authenticated();
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
    }
}
