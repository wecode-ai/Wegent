//! Weibo multimedia signing shared by the internal video integrations:
//! the TAuth2 authorization header (`app/services/tauth.py`) and the
//! anti-hotlink signature call (`wecode/video/services/media_platform.py`).
use std::collections::HashMap;

use brz_redis::Redis;
use wegent_backend_rs::config::env_or_dotenv;

/// Source default `WEIBO_MEDIA_SSIG_URL`.
const DEFAULT_SSIG_URL: &str =
    "http://i.mediaplay.api.weibo.com/2/multimedia/get_ssig_url_batch.json";
/// Source `APPKEY_SOURCE` (`app/services/tauth.py`) — Multimedia unified
/// storage; also the Redis hash field of the TAuth2 token.
pub(crate) const APPKEY_SOURCE: &str = "3061639762";
/// Redis hash holding the TAuth2 token (`token_v2`).
const TAUTH_TOKEN_HASH: &str = "token_v2";
/// Source `_TOKEN_VALID_DURATION_MS` (three hours).
const TOKEN_VALID_DURATION_MS: u128 = 3 * 60 * 60 * 1000;
/// Failure mode of `sign_urls`.
#[derive(Debug)]
pub(crate) enum SignError {
    /// `validate_storage_config`/`get_upload_uid`: missing configuration
    /// (source `ValueError`).
    Config(&'static str),
    /// TAuth2 token unavailable, transport failure, or a non-2xx response
    /// (`httpx.HTTPError`). The discriminant keeps the failure stage for
    /// log correlation even though every variant maps to the same 502.
    Http(&'static str),
}

impl SignError {
    /// Every signing failure is logged with its stage and handled by the
    /// caller (a 502 response, or an unmodified response body).
    pub(crate) fn stage(&self) -> &'static str {
        match self {
            Self::Config(stage) | Self::Http(stage) => stage,
        }
    }
}

/// The media-signing settings resolved like `VideoMediaSettings`
/// (`WEIBO_TAUTH2_APPKEY`, `WEIBO_MEDIA_UPLOAD_DEFAULT_UID`,
/// `WEIBO_IMAGE_HOSTING_ENABLED`, `WEIBO_FILEPLATFORM_URL`,
/// `WEIBO_MEDIA_SSIG_URL`), validating the playback subset of
/// `validate_storage_config`.
pub(crate) struct MediaSettings {
    ssig_url: String,
    appkey: String,
}

/// `VideoMediaSettings.validate_storage_config` + `get_upload_uid`: the
/// playback chain requires storage enabled, the TAuth2 appkey, and the
/// upload uid to be configured.
pub(crate) fn upload_settings() -> Result<MediaSettings, SignError> {
    let enabled = env_or_dotenv("WEIBO_IMAGE_HOSTING_ENABLED")
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "true" | "1" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    let fileplatform = env_or_dotenv("WEIBO_FILEPLATFORM_URL").unwrap_or_default();
    if enabled && !fileplatform.trim().is_empty() {
        // storage_enabled: the image-hosting gate passes.
    } else if !enabled {
        return Err(SignError::Config(
            "WEIBO_IMAGE_HOSTING_ENABLED must be enabled",
        ));
    }
    let appkey = env_or_dotenv("WEIBO_TAUTH2_APPKEY").unwrap_or_default();
    if appkey.trim().is_empty() {
        return Err(SignError::Config(
            "WEIBO_TAUTH2_APPKEY is required for media playback",
        ));
    }
    media_uid()?;
    let ssig_url =
        env_or_dotenv("WEIBO_MEDIA_SSIG_URL").unwrap_or_else(|| DEFAULT_SSIG_URL.to_string());
    Ok(MediaSettings { ssig_url, appkey })
}

/// `_media_uid`/`get_upload_uid`: the fixed internal account used to sign
/// media requests (`WEIBO_MEDIA_UPLOAD_DEFAULT_UID`).
pub(crate) fn media_uid() -> Result<String, SignError> {
    let uid = env_or_dotenv("WEIBO_MEDIA_UPLOAD_DEFAULT_UID").unwrap_or_default();
    if uid.trim().is_empty() {
        return Err(SignError::Config(
            "WEIBO_MEDIA_UPLOAD_DEFAULT_UID is required for media uploads",
        ));
    }
    Ok(uid)
}

/// The TAuth2 token entry fetched from Redis (`HGET token_v2 <appkey>`).
#[derive(Debug, Clone)]
struct TauthToken {
    tauth_token: String,
    tauth_token_secret: String,
    timestamp: u128,
}

impl TauthToken {
    /// `_is_token_valid`: within the three-hour window.
    fn is_valid(&self) -> bool {
        now_millis().saturating_sub(self.timestamp) < TOKEN_VALID_DURATION_MS
    }
}

/// The source's module-local token cache (`_cached_token` in
/// `app/services/tauth.py`): once fetched, the token serves later requests
/// for three hours without another Redis read.
static CACHED_TOKEN: std::sync::Mutex<Option<TauthToken>> = std::sync::Mutex::new(None);

/// `time.time() * 1000` (milliseconds since the epoch).
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

/// `_get_token`: prefer the module-local three-hour cache, then fetch from
/// the dedicated TAuth Redis endpoint (`TAUTH_REDIS_HOST`/`TAUTH_REDIS_PORT`,
/// a separate client from the shared `REDIS_URL` service).
async fn get_tauth_token<R: brz_redis::Redis>(redis: Option<&R>) -> Result<TauthToken, SignError> {
    if let Some(cached) = CACHED_TOKEN.lock().expect("tauth token lock").clone()
        && cached.is_valid()
    {
        return Ok(cached);
    }
    let service = redis.ok_or(SignError::Http("tauth redis unavailable"))?;
    let raw: Option<String> = service
        .hget(TAUTH_TOKEN_HASH, APPKEY_SOURCE)
        .await
        .map_err(|_| SignError::Http("redis hget failed"))?;
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Err(SignError::Http("no tauth token"));
    };
    let token = parse_tauth_token(&raw)?;
    *CACHED_TOKEN.lock().expect("tauth token lock") = Some(token.clone());
    Ok(token)
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TauthInput {
    tauth_token: Option<String>,
    tauth_token_secret: Option<String>,
    // A malformed timestamp must not discard valid token fields because the
    // endpoint reports the missing timestamp as the more specific failure.
    timestamp: Option<u64>,
}

fn parse_tauth_token(raw: &str) -> Result<TauthToken, SignError> {
    let payload: Option<TauthInput> =
        serde_json::from_str(raw).map_err(|_| SignError::Http("tauth token decode failed"))?;
    let payload = payload.unwrap_or_default();
    let token = payload
        .tauth_token
        .filter(|value| !value.is_empty())
        .ok_or(SignError::Http("tauth token missing"))?;
    let secret = payload
        .tauth_token_secret
        .filter(|value| !value.is_empty())
        .ok_or(SignError::Http("tauth token secret missing"))?;
    let timestamp = payload
        .timestamp
        .ok_or(SignError::Http("tauth token timestamp missing"))? as u128;
    Ok(TauthToken {
        tauth_token: token,
        tauth_token_secret: secret,
        timestamp,
    })
}

/// Percent-encodes a TAuth2 header component
/// (`urllib.parse.quote(value, encoding="utf-8")`).
fn quote_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'.' | b'_'
                    | b'-'
                    | b'~'
                    | b'/'
                    | b'@'
                    | b'!'
                    | b'*'
                    | b'('
                    | b')'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b':'
                    | b','
                    | b';'
            );
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `auth_headers(uid)`: the `TAuth2 token="...",param="uid=...",sign="..."`
/// header with the HMAC-SHA1 signature over `uid=<uid>`.
pub(crate) fn tauth_authorization(tauth_token: &str, secret: &str, uid: &str) -> String {
    type HmacSha1 = hmac::Hmac<sha1::Sha1>;
    use base64::Engine as _;
    use hmac::Mac as _;
    let params_str = format!("uid={uid}");
    let mut mac =
        HmacSha1::new_from_slice(secret.as_bytes()).expect("HMAC-SHA1 accepts any key length");
    mac.update(params_str.as_bytes());
    let digest = mac.finalize().into_bytes();
    let sign = base64::engine::general_purpose::STANDARD.encode(digest);
    format!(
        "TAuth2 token=\"{}\",param=\"{}\",sign=\"{}\"",
        quote_component(tauth_token),
        quote_component(&params_str),
        quote_component(&sign)
    )
}

/// `_force_https_url` (`_https` in the generation extension): rewrite an
/// `http` signed URL to `https`.
pub(crate) fn force_https_url(url: &str) -> String {
    match url.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    }
}

/// `sign_urls` for the single playback URL: fetch the TAuth2 token from
/// Redis, then `GET {ssig_url}?source={appkey}&urls={url-without-query}`
/// with the TAuth2 authorization header. `Ok(None)` mirrors a signing
/// `sign_urls`: current anti-hotlink URLs for raw playback URLs, keyed by the
/// raw URL. The signing service answers one result per submitted URL in
/// order, so a URL that was not signed keeps its `None` entry.
pub(crate) async fn sign_urls<R: Redis>(
    client: &brz_http::Client,
    redis: Option<&R>,
    uid: &str,
    urls: &[String],
) -> Result<HashMap<String, Option<String>>, SignError> {
    let unique_urls = unique_urls(urls);
    if unique_urls.is_empty() {
        return Ok(HashMap::new());
    }
    let settings = upload_settings()?;
    let token = get_tauth_token(redis).await?;
    let authorization = tauth_authorization(&token.tauth_token, &token.tauth_token_secret, uid);
    let urls_param = unique_urls
        .iter()
        .map(|url| url.split('?').next().unwrap_or(url).to_owned())
        .collect::<Vec<_>>()
        .join(",");

    let request = client
        .get(&settings.ssig_url)
        .map_err(|_| SignError::Http("ssig request build failed"))?
        .query(&[
            ("source", settings.appkey.as_str()),
            ("urls", urls_param.as_str()),
        ])
        .header("authorization", authorization);
    let response = request
        .send()
        .await
        .map_err(|_| SignError::Http("ssig request failed"))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|_| SignError::Http("ssig response body failed"))?;
    if !status.is_success() {
        // `raise_for_status()`.
        return Err(SignError::Http("ssig service error status"));
    }
    signed_urls_from_body(&body, &unique_urls)
}

/// `dict.fromkeys(url for url in urls if url)`: non-empty URLs in first
/// occurrence order.
fn unique_urls(urls: &[String]) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for url in urls.iter().filter(|url| !url.is_empty()) {
        if !unique.contains(url) {
            unique.push(url.clone());
        }
    }
    unique
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SigningResponse {
    results: Option<Vec<Option<SigningResult>>>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SigningResult {
    result: Option<i64>,
    result_data: Option<SigningData>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SigningData {
    ssig_url: Option<String>,
}

fn signed_urls_from_body(
    body: &[u8],
    unique_urls: &[String],
) -> Result<HashMap<String, Option<String>>, SignError> {
    let mut signed: HashMap<String, Option<String>> =
        unique_urls.iter().map(|url| (url.clone(), None)).collect();
    let payload: Option<SigningResponse> =
        serde_json::from_slice(body).map_err(|_| SignError::Http("ssig json decode failed"))?;
    let Some(results) = payload.and_then(|payload| payload.results) else {
        return Ok(signed);
    };
    for (index, item) in results.into_iter().take(unique_urls.len()).enumerate() {
        // A non-object terminates the legacy loop; an object with invalid
        // fields merely fails to provide a signed URL and permits the next item.
        let Some(item) = item else { break };
        if item.result == Some(0)
            && let Some(url) = item.result_data.and_then(|data| data.ssig_url)
        {
            signed.insert(unique_urls[index].clone(), Some(force_https_url(&url)));
        }
    }
    Ok(signed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_urls_keep_first_occurrence_order() {
        let urls = vec![
            String::new(),
            "http://cdn.example.invalid/a.mp4".to_owned(),
            "http://cdn.example.invalid/a.mp4".to_owned(),
            "http://cdn.example.invalid/b.mp4".to_owned(),
        ];
        assert_eq!(
            unique_urls(&urls),
            vec![
                "http://cdn.example.invalid/a.mp4".to_owned(),
                "http://cdn.example.invalid/b.mp4".to_owned()
            ]
        );
    }

    #[test]
    fn signed_urls_follow_result_order_and_force_https() {
        let unique = vec![
            "http://cdn.example.invalid/a.mp4".to_owned(),
            "http://cdn.example.invalid/b.mp4".to_owned(),
        ];
        let body = br#"{"results":[
            {"result":0,"result_data":{"ssig_url":"http://cdn.example.invalid/a.mp4?Expires=1&ssig=x","ssig_type":"unistore"},"ttl":3600},
            {"result":1,"result_data":{}}
        ]}"#;
        let signed = signed_urls_from_body(body, &unique).unwrap();
        assert_eq!(
            signed.get(&unique[0]),
            Some(&Some(
                "https://cdn.example.invalid/a.mp4?Expires=1&ssig=x".to_owned()
            ))
        );
        assert_eq!(signed.get(&unique[1]), Some(&None));
    }

    #[test]
    fn non_object_result_stops_the_legacy_loop() {
        let unique = vec!["a".to_owned(), "b".to_owned()];
        let body =
            br#"{"results":[null,{"result":0,"result_data":{"ssig_url":"http://x.invalid/b"}}]}"#;
        let signed = signed_urls_from_body(body, &unique).unwrap();
        assert_eq!(signed.get("a"), Some(&None));
        assert_eq!(signed.get("b"), Some(&None));
    }

    #[test]
    fn missing_results_and_malformed_body_match_source_failures() {
        let unique = vec!["a".to_owned()];
        let signed = signed_urls_from_body(br#"{}"#, &unique).unwrap();
        assert_eq!(signed.get("a"), Some(&None));
        assert!(signed_urls_from_body(b"not json", &unique).is_err());
    }

    /// The signing service answers `content-encoding: gzip` (the source client
    /// is `httpx`, which advertises and transparently decodes gzip), so the
    /// signing client must decode that transport encoding before parsing.
    #[tokio::test]
    async fn gzip_encoded_signing_response_is_decoded() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        let payload = br#"{"results":[{"result":0,"result_data":{"ssig_url":"http://cdn.example.invalid/a.mp4?Expires=1&ssig=x","ssig_type":"unistore"},"ttl":3600}]}"#;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(payload).expect("gzip encode");
        let body = encoder.finish().expect("gzip finish");

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind signing stub");
        let address = listener.local_addr().expect("stub address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept signing request");
            // Consume the request head before answering so the client cannot
            // observe a reset while it is still writing the request.
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json;charset=UTF-8\r\ncontent-encoding: gzip\r\ncontent-length: {}\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).expect("write head");
            stream.write_all(&body).expect("write body");
            stream.flush().expect("flush response");
        });

        let client = brz_http::Client::builder().build().expect("signing client");
        let response = client
            .get(format!("http://{address}/sign"))
            .expect("build signing request")
            .send()
            .await
            .expect("send signing request");
        let raw = response.bytes().await.expect("signing response body");
        let unique = vec!["http://cdn.example.invalid/a.mp4".to_owned()];
        let signed = signed_urls_from_body(&raw, &unique).expect("signing response decodes");
        server.join().expect("signing stub joins");

        assert_eq!(
            signed.get(&unique[0]),
            Some(&Some(
                "https://cdn.example.invalid/a.mp4?Expires=1&ssig=x".to_owned()
            ))
        );
    }
}
