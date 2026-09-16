//! The AIGC quota service client and response transform.
//!
//! Ported from the reference implementation's `src/wecode/quota.rs`
//! (`mod quota_service`), which mirrors `wecode/api/quota_endpoint_patch.py`:
//! one POST per request with a 10-second total timeout carrying
//! `{"user_name": ...}`, followed by the `_transform_aigc_response` mapping.
//! Every transport failure, non-2xx status, non-object body, or body without
//! `user_quota` returns `None`, which the caller renders as the open-source
//! empty quota response.
//!
//! The transform reads the upstream body as a JSON object rather than through
//! a typed struct, because the source uses `dict.get(key, default)`: the
//! default applies only when the key is **absent**, so an explicit upstream
//! `null` is echoed as `null`. A typed `Option` field cannot express that
//! distinction.

use std::time::Duration;

use brz_http::{Client, Endpoint, Response as HttpResponse};
use serde::Serialize;
use serde_json::{Map, Number, Value};
use wegent_backend_rs::json_compat::OpaqueJson;

/// `AIGC_QUOTA_URL` in `wecode/api/quota_endpoint_patch.py`.
pub(super) const AIGC_QUOTA_URL: &str =
    "https://copilot.weibo.com/v1/wecode_quota/user_aigc_model_quota_detail";

/// Source `_wrap_quota_endpoint`: `timeout=10` seconds for the whole call.
const AIGC_QUOTA_TIMEOUT: Duration = Duration::from_secs(10);

/// The POST body the source sends (`{"user_name": current_user.user_name}`).
#[derive(Serialize)]
struct QuotaRequest<'a> {
    user_name: &'a str,
}

/// The transformed payload consumed by the frontend.
#[derive(Serialize)]
pub(super) struct QuotaDetails {
    data: QuotaData,
    quota_source: &'static str,
    status: &'static str,
}

#[derive(Serialize)]
struct QuotaData {
    // `quota`, `usage_rate`, and `user` are passed through exactly as the
    // upstream sent them, including an explicit null and any shape at all.
    quota: OpaqueJson,
    usage: Number,
    remaining: Number,
    usage_rate: OpaqueJson,
    user: OpaqueJson,
}

/// Builds the retained AIGC quota endpoint for the process lifetime.
///
/// The source creates a fresh `httpx.AsyncClient()` per request; the target
/// keeps one Breeze client with the same transport policy (one connect+read
/// window bounded by the request timeout) and one stable endpoint, which is
/// the client-ownership contract of the platform HTTP capability.
///
/// # Errors
///
/// Returns an error when the client cannot be built or `quota_url` is not a
/// valid URL.
pub(super) fn build_endpoint(quota_url: &str) -> brz_http::Result<Endpoint> {
    let client = Client::builder()
        // httpx `timeout=10` applies the same deadline to every phase
        // (connect, read, write, pool), so the connect phase gets the full
        // 10s rather than httpx's 5s default. A shorter connect timeout would
        // abort slow connects the source accepts.
        .connect_timeout(AIGC_QUOTA_TIMEOUT)
        .read_timeout(AIGC_QUOTA_TIMEOUT)
        .timeout(AIGC_QUOTA_TIMEOUT)
        .build()?;
    client.endpoint_named(quota_url, AIGC_QUOTA_URL)
}

/// Fetches and transforms the user's AIGC quota.
///
/// Returns `None` for every condition the source patch answers with the
/// open-source empty response.
pub(super) async fn fetch_aigc_quota(endpoint: &Endpoint, user_name: &str) -> Option<QuotaDetails> {
    let response: HttpResponse = endpoint
        .post()
        .json(&QuotaRequest { user_name })
        .send()
        .await
        .map_err(|error| {
            tracing::error!(%error, user_name, "AIGC quota service request failed");
        })
        .ok()?;

    // `resp.raise_for_status()`: an HTTP error status is a fallback path,
    // checked before the body is read.
    let status = response.status();
    if !status.is_success() {
        tracing::error!(%status, user_name, "AIGC quota service returned error status");
        return None;
    }

    let body = response
        .bytes()
        .await
        .map_err(|error| {
            tracing::error!(%error, user_name, "AIGC quota response body read failed");
        })
        .ok()?;
    parse_aigc_quota_response(&body, user_name)
}

/// Applies the patch's response checks and transform.
///
/// The body must decode to a JSON object that carries `user_quota`, and that
/// value must be usable in the subtraction the source performs. Anything else
/// takes the fallback path, matching the wrapper's `except Exception`.
fn parse_aigc_quota_response(body: &[u8], user_name: &str) -> Option<QuotaDetails> {
    let raw: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(%error, user_name, "AIGC quota response body decode failed");
            return None;
        }
    };
    // `isinstance(raw, dict)`
    let Value::Object(raw) = raw else {
        tracing::warn!(user_name, "Unexpected AIGC quota response");
        return None;
    };
    // `"user_quota" not in raw`
    let Some(user_quota) = raw.get("user_quota") else {
        tracing::warn!(user_name, "Unexpected AIGC quota response");
        return None;
    };
    transform_aigc_response(&raw, user_quota)
}

/// Applies `_transform_aigc_response` to a validated upstream object.
fn transform_aigc_response(raw: &Map<String, Value>, user_quota: &Value) -> Option<QuotaDetails> {
    // `user_quota - user_usage` runs inside the wrapper's `try`, so a
    // non-numeric operand is a fallback rather than an error response.
    let quota_number = python_number(user_quota)?;
    let usage_number = match raw.get("user_usage") {
        Some(value) => python_number(value)?,
        // `raw.get("user_usage", 0)`: an absent key defaults to the int 0.
        None => Number::from(0),
    };

    // Python `round(user_usage, 2)` returns an int for an int input, and the
    // quota-minus-usage subtraction preserves int operands, so integer
    // upstream values render as `0`, never `0.0`.
    let usage = round2_like_python(usage_number.clone());
    let remaining = round2_like_python(sub_like_python(&quota_number, &usage_number));
    Some(QuotaDetails {
        data: QuotaData {
            quota: OpaqueJson::from_serializable(user_quota),
            usage,
            remaining,
            usage_rate: passthrough(raw.get("user_usage_rate"), 0),
            user: passthrough(raw.get("username"), ""),
        },
        quota_source: "AIGC",
        status: "success",
    })
}

/// `dict.get(key, default)`: the default applies only when the key is absent,
/// so a present `null` is echoed as `null` rather than replaced.
fn passthrough(value: Option<&Value>, default: impl serde::Serialize) -> OpaqueJson {
    match value {
        Some(value) => OpaqueJson::from_serializable(value),
        None => OpaqueJson::from_serializable(default),
    }
}

/// The number Python arithmetic would use for this operand.
///
/// A JSON number is used as-is, keeping its int or float representation. A
/// `bool` is an `int` subclass in Python, so `True - 0` is `1` and
/// `round(True, 2)` is `1`; it maps to `1`/`0` accordingly. Every other JSON
/// type raises `TypeError` in the source, which falls back.
fn python_number(value: &Value) -> Option<Number> {
    match value {
        Value::Number(number) => Some(number.clone()),
        Value::Bool(flag) => Some(Number::from(u8::from(*flag))),
        _ => None,
    }
}

/// Python `round(x, 2)` on an int returns the same int; on a float it returns a
/// float correctly rounded (half-even on the exact binary value) to two
/// decimals. Rust's float formatting implements the same correct rounding, so
/// format and parse back. `Number::as_i64` is representation-based, so an
/// integral float such as `1.0` still takes the float path, matching
/// `json.loads("1.0")` yielding a Python float.
fn round2_like_python(number: Number) -> Number {
    if let Some(int) = number.as_i64() {
        return Number::from(int);
    }
    let Some(float) = number.as_f64() else {
        return number;
    };
    format!("{float:.2}")
        .parse::<f64>()
        .ok()
        .and_then(Number::from_f64)
        .unwrap_or_else(|| Number::from(0))
}

/// Python `user_quota - user_usage`: int operands stay int; any float operand
/// promotes the result to float.
fn sub_like_python(a: &Number, b: &Number) -> Number {
    if let (Some(a_int), Some(b_int)) = (a.as_i64(), b.as_i64())
        && let Some(diff) = a_int.checked_sub(b_int)
    {
        return Number::from(diff);
    }
    let diff = a.as_f64().unwrap_or(0.0) - b.as_f64().unwrap_or(0.0);
    Number::from_f64(diff).unwrap_or_else(|| Number::from(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The serialized transform output for a raw upstream body.
    fn transformed(body: &str) -> Value {
        serde_json::to_value(
            parse_aigc_quota_response(body.as_bytes(), "test").expect("valid upstream response"),
        )
        .expect("transform serializes")
    }

    /// The serialized representation of one field of the transform output.
    fn rendered(body: &str, pointer: &str) -> String {
        let value = transformed(body)
            .pointer(pointer)
            .expect("field is present")
            .clone();
        serde_json::to_string(&value).expect("serializable")
    }

    /// A full HTTP/1.1 response with the given status line and JSON body.
    fn http_response(status_line: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// Serves exactly one HTTP request on a loopback port and records it.
    ///
    /// Returns the base URL to point an `Endpoint` at and a receiver that
    /// yields the raw request bytes once the client has sent them. This is a
    /// real socket and a real HTTP exchange; only the response is canned.
    fn serve_once(response: String) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("read local address");
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept the request");
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            // Read until the header block is complete, then the declared body.
            let head_end = loop {
                let read = stream.read(&mut buffer).expect("read the request");
                request.extend_from_slice(&buffer[..read]);
                if let Some(position) = head_end(&request) {
                    break position;
                }
                assert!(read > 0, "connection closed before the headers ended");
            };
            let head = String::from_utf8_lossy(&request[..head_end]).into_owned();
            let body_end = head_end + content_length(&head);
            while request.len() < body_end {
                let read = stream.read(&mut buffer).expect("read the request body");
                assert!(read > 0, "connection closed before the body ended");
                request.extend_from_slice(&buffer[..read]);
            }
            sender
                .send(String::from_utf8_lossy(&request).into_owned())
                .ok();
            stream
                .write_all(response.as_bytes())
                .expect("write the response");
            stream.flush().ok();
        });
        (format!("http://{address}"), receiver)
    }

    /// The byte offset just past the request's header block.
    fn head_end(request: &[u8]) -> Option<usize> {
        request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| position + 4)
    }

    /// The request's declared body length (absent means none).
    fn content_length(head: &str) -> usize {
        for line in head.lines() {
            if let Some((name, value)) = line.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                return value.trim().parse().unwrap_or(0);
            }
        }
        0
    }

    /// The upstream path `AIGC_QUOTA_URL` resolves to.
    const AIGC_QUOTA_PATH: &str = "/v1/wecode_quota/user_aigc_model_quota_detail";

    /// Builds an endpoint pointed at a test server.
    fn test_endpoint(base: &str) -> Endpoint {
        build_endpoint(&format!("{base}{AIGC_QUOTA_PATH}")).expect("valid quota URL")
    }

    #[tokio::test]
    async fn posts_the_source_request_and_transforms_the_response() {
        let (base, requests) = serve_once(http_response(
            "200 OK",
            r#"{"user_quota": 100, "user_usage": 33.336,
                "user_usage_rate": 0.33, "username": "liting9"}"#,
        ));

        let details = fetch_aigc_quota(&test_endpoint(&base), "liting9")
            .await
            .expect("a well-formed upstream response transforms");

        let request = requests
            .recv_timeout(Duration::from_secs(5))
            .expect("the server received a request");
        assert!(
            request.starts_with(&format!("POST {AIGC_QUOTA_PATH} HTTP/1.1\r\n")),
            "unexpected request line: {request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("content-type: application/json"),
            "missing JSON content type: {request}"
        );
        // The source sends `{"user_name": current_user.user_name}`.
        assert!(
            request.ends_with(r#"{"user_name":"liting9"}"#),
            "unexpected request body: {request}"
        );

        let body = serde_json::to_value(details).expect("transform serializes");
        assert_eq!(body["quota_source"], "AIGC");
        assert_eq!(body["status"], "success");
        assert_eq!(body["data"]["quota"], 100);
        assert_eq!(body["data"]["usage"], 33.34);
        assert_eq!(body["data"]["remaining"], 66.66);
    }

    #[tokio::test]
    async fn falls_back_when_the_service_returns_an_error_status() {
        let (base, _requests) = serve_once(http_response("500 Internal Server Error", "boom"));
        assert!(
            fetch_aigc_quota(&test_endpoint(&base), "liting9")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn falls_back_when_the_service_returns_a_non_object_body() {
        let (base, _requests) = serve_once(http_response("200 OK", "[]"));
        assert!(
            fetch_aigc_quota(&test_endpoint(&base), "liting9")
                .await
                .is_none()
        );
    }

    #[test]
    fn transforms_aigc_response_fields() {
        let transformed = transformed(
            r#"{"user_quota": 100, "user_usage": 33.336,
                "user_usage_rate": 0.33, "username": "liting9"}"#,
        );
        assert_eq!(transformed["quota_source"], "AIGC");
        assert_eq!(transformed["status"], "success");
        assert_eq!(transformed["data"]["quota"], 100);
        assert_eq!(transformed["data"]["usage"], 33.34);
        assert_eq!(transformed["data"]["remaining"], 66.66);
        assert_eq!(transformed["data"]["usage_rate"], 0.33);
        assert_eq!(transformed["data"]["user"], "liting9");
    }

    #[test]
    fn applies_source_defaults_for_absent_fields() {
        let body = r#"{"user_quota": 5}"#;
        assert_eq!(rendered(body, "/data/quota"), "5");
        // An absent `user_usage` defaults to the int `0`, so round/subtract
        // keep ints.
        assert_eq!(rendered(body, "/data/usage"), "0");
        assert_eq!(rendered(body, "/data/remaining"), "5");
        assert_eq!(rendered(body, "/data/usage_rate"), "0");
        assert_eq!(rendered(body, "/data/user"), "\"\"");
    }

    #[test]
    fn echoes_an_explicit_upstream_null() {
        // `dict.get(key, default)` returns the stored `None`, not the default,
        // when the key exists; the source therefore emits `null`.
        let body = r#"{"user_quota": 5, "user_usage_rate": null, "username": null}"#;
        assert_eq!(rendered(body, "/data/usage_rate"), "null");
        assert_eq!(rendered(body, "/data/user"), "null");
    }

    #[test]
    fn integer_quota_stays_integer_like_python_passthrough() {
        let body = r#"{"user_quota": 286, "user_usage": 277.47}"#;
        assert_eq!(rendered(body, "/data/quota"), "286");
        assert_eq!(transformed(body)["data"]["usage"], 277.47);
        assert_eq!(transformed(body)["data"]["remaining"], 8.53);
    }

    #[test]
    fn float_quota_stays_float() {
        let body = r#"{"user_quota": 286.5, "user_usage": 1.0}"#;
        assert_eq!(rendered(body, "/data/quota"), "286.5");
        // Float upstream values keep float output for usage/remaining.
        assert_eq!(rendered(body, "/data/usage"), "1.0");
        assert_eq!(rendered(body, "/data/remaining"), "285.5");
    }

    #[test]
    fn integer_usage_and_remaining_stay_integers_like_python() {
        let zero = r#"{"user_quota": 0, "user_usage": 0}"#;
        assert_eq!(rendered(zero, "/data/usage"), "0");
        assert_eq!(rendered(zero, "/data/remaining"), "0");

        let ints = r#"{"user_quota": 5, "user_usage": 2}"#;
        assert_eq!(rendered(ints, "/data/remaining"), "3");

        // A mixed int quota / float usage promotes remaining to float.
        let mixed = r#"{"user_quota": 5, "user_usage": 2.25}"#;
        assert_eq!(rendered(mixed, "/data/remaining"), "2.75");
    }

    #[test]
    fn boolean_operands_keep_python_int_arithmetic() {
        // A Python `bool` is an `int` subclass, so these are valid operands
        // and the passthrough still emits the original `true`.
        let body = r#"{"user_quota": true, "user_usage": false}"#;
        assert_eq!(rendered(body, "/data/quota"), "true");
        assert_eq!(rendered(body, "/data/usage"), "0");
        assert_eq!(rendered(body, "/data/remaining"), "1");
    }

    #[test]
    fn opaque_fields_echo_arbitrary_upstream_json() {
        let body = r#"{"user_quota": 1, "user_usage_rate": {"b": 1, "a": [1, 2]}}"#;
        assert_eq!(rendered(body, "/data/usage_rate"), "{\"b\":1,\"a\":[1,2]}");
    }

    #[test]
    fn falls_back_for_bodies_without_user_quota() {
        // A non-object, an empty object, and an object missing the key all
        // take the source's fallback path.
        for body in [
            "[]",
            "\"x\"",
            "5",
            "true",
            "null",
            "{}",
            r#"{"user_usage": 1}"#,
        ] {
            assert!(
                parse_aigc_quota_response(body.as_bytes(), "test").is_none(),
                "body {body} must fall back"
            );
        }
    }

    #[test]
    fn falls_back_for_invalid_json() {
        assert!(parse_aigc_quota_response(b"not json", "test").is_none());
        assert!(parse_aigc_quota_response(b"", "test").is_none());
    }

    #[test]
    fn falls_back_when_an_operand_is_not_arithmetic() {
        // Python raises inside the transform and the wrapper then falls back.
        for body in [
            r#"{"user_quota": "abc"}"#,
            r#"{"user_quota": 1, "user_usage": "abc"}"#,
            r#"{"user_quota": null}"#,
            r#"{"user_quota": []}"#,
        ] {
            assert!(
                parse_aigc_quota_response(body.as_bytes(), "test").is_none(),
                "body {body} must fall back"
            );
        }
    }

    #[test]
    fn round2_matches_python_rounding() {
        // Compare the serialized representation, which is what the response
        // carries, rather than raw floats.
        let round_of = |value: f64| {
            round2_like_python(Number::from_f64(value).expect("finite float")).to_string()
        };
        assert_eq!(round_of(33.336), "33.34");
        assert_eq!(round_of(2.675), "2.67");
        assert_eq!(round_of(2.5), "2.5");
        assert_eq!(round_of(3.5), "3.5");
        assert_eq!(round_of(0.125), "0.12");
        assert_eq!(round_of(0.135), "0.14");
        assert_eq!(round_of(0.0), "0.0");
        assert_eq!(round_of(-1.005), "-1.0");
    }
}
