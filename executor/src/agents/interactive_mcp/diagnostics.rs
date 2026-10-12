use std::error::Error;

use reqwest::header::{HeaderName, HeaderValue, InvalidHeaderName, InvalidHeaderValue};
use serde_json::{json, Value};

use super::{header_map, DeferredMcpProxyRequest};

pub(super) fn log_failure(
    request: &DeferredMcpProxyRequest,
    method: &str,
    phase: &str,
    details: Value,
) {
    crate::logging::log_executor_event(
        "deferred mcp proxy diagnostic",
        &[(
            "diagnostic",
            json!({
                "tool_use_id": request.tool_use_id,
                "server_name": request.server_name,
                "tool_name": request.tool_name,
                "method": method,
                "phase": phase,
                "details": details,
            })
            .to_string(),
        )],
    );
}

pub(super) fn log_http_error(
    request: &DeferredMcpProxyRequest,
    method: &str,
    phase: &str,
    error: &reqwest::Error,
) {
    log_failure(
        request,
        method,
        phase,
        http_error_details(error, &request.headers),
    );
}

fn http_error_details(error: &reqwest::Error, headers: &Value) -> Value {
    let invalid_headers: Vec<Value> = header_map(headers)
        .iter()
        .filter_map(|(name, value)| {
            let invalid_name = HeaderName::from_bytes(name.as_bytes()).is_err();
            let invalid_value = HeaderValue::from_str(value).is_err();
            (invalid_name || invalid_value).then(|| {
                json!({"name": name, "invalid_name": invalid_name, "invalid_value": invalid_value})
            })
        })
        .collect();
    let mut causes = Vec::new();
    let mut source = error.source();
    // Error strings can contain URLs, credentials or response bodies. Only emit typed causes.
    while let Some(cause) = source.filter(|_| causes.len() < 8) {
        let cause = cause
            .downcast_ref::<axum::http::Error>()
            .map(|error| error.get_ref())
            .unwrap_or(cause);
        let safe = if cause.is::<InvalidHeaderValue>() {
            "invalid_header_value".to_owned()
        } else if cause.is::<InvalidHeaderName>() {
            "invalid_header_name".to_owned()
        } else if let Some(parse) = cause.downcast_ref::<url::ParseError>() {
            format!("url_parse: {parse}")
        } else if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            format!("io: {:?} (os_code={:?})", io.kind(), io.raw_os_error())
        } else {
            "unclassified_cause_redacted".to_owned()
        };
        causes.push(safe);
        source = cause.source();
    }
    json!({
        "builder": error.is_builder(),
        "timeout": error.is_timeout(),
        "connect": error.is_connect(),
        "request": error.is_request(),
        "body": error.is_body(),
        "decode": error.is_decode(),
        "status": error.status().map(|status| status.as_u16()),
        "causes": causes,
        "invalid_headers": invalid_headers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_invalid_header_without_credentials_or_url() {
        let secret = "Bearer private-token\r\nprivate-form-content";
        let error = reqwest::Client::new()
            .post("https://user:password@example.invalid/form?token=query-secret")
            .header("Authorization", secret)
            .build()
            .unwrap_err();
        let details = http_error_details(&error, &json!({"Authorization": secret}));
        assert_eq!(details["builder"], true);
        assert_eq!(details["invalid_headers"][0]["name"], "Authorization");
        assert_eq!(details["invalid_headers"][0]["invalid_value"], true);
        assert!(details["causes"]
            .as_array()
            .unwrap()
            .contains(&json!("invalid_header_value")));
        let text = details.to_string();
        for secret in [
            "private-token",
            "private-form-content",
            "password",
            "query-secret",
            "example.invalid",
        ] {
            assert!(!text.contains(secret));
        }
    }

    #[test]
    fn reports_invalid_url_without_printing_input() {
        let error = reqwest::Client::new()
            .post("private-url-secret")
            .build()
            .unwrap_err();
        let details = http_error_details(&error, &json!({}));
        assert_eq!(details["builder"], true);
        assert!(details["causes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cause| cause.as_str().unwrap().starts_with("url_parse:")));
        assert!(!details.to_string().contains("private-url-secret"));
    }
}
