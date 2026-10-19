// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/method.callAnon/*` — third-party Zimbra scanner probes (the
//! `method.callAnon` SOAP JSON-RPC family).
//!
//! The recorded requests ask for the PasswordPolicy method through an
//! anonymous method call with a regex-matched token (the Zimbra
//! CVE-2022-27925 probe shape) and for `sendForgotPasswordEmail` through a
//! JSON-RPC-ish `method` envelope.
//!
//! The Wegent backend registers no `/api/v1/method.callAnon/...` route (there
//! is no matching router entry in the source), so FastAPI
//! answers the probes with its default `404 {"detail":"Not Found"}` rendered as
//! `application/json`. Routing them to Rust reproduces that not-found response
//! instead of proxying to Python, which answers `502 "fallback upstream
//! unavailable"` whenever the fallback upstream is unavailable. The handlers
//! are public and ignore the request body, exactly like FastAPI's
//! unmatched-route response: no authentication or validation runs before the
//! 404.

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// `POST /api/v1/method.callAnon/getPasswordPolicy`: return FastAPI's
/// default not-found body for the scanner-probe path.
#[brz_http_server::post(
    "/api/v1/method.callAnon/getPasswordPolicy",
    access = public
)]
async fn get_policy() -> Result<(), FastApiError> {
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

/// `POST /api/v1/method.callAnon/sendForgotPasswordEmail`: return
/// FastAPI's default not-found body for the scanner-probe path.
#[brz_http_server::post(
    "/api/v1/method.callAnon/sendForgotPasswordEmail",
    access = public
)]
async fn send_forgot_email_post() -> Result<(), FastApiError> {
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    mod get_policy_probe {
        brz_http_server::registry!(group = method_call_anon_get_policy_probe, dependencies());
    }

    #[brz_http_server::post(
        "/api/v1/method.callAnon/getPasswordPolicy",
        group = get_policy_probe::method_call_anon_get_policy_probe,
        access = public
    )]
    async fn probe_get_policy() -> Result<(), FastApiError> {
        get_policy().await
    }

    #[test]
    fn get_policy_route_is_registered_once_with_post_only() {
        let routes: Vec<_> = brz_http_server::__private::inventory::iter::<
            get_policy_probe::__http_registry_method_call_anon_get_policy_probe::Entry,
        >
            .into_iter()
            .flat_map(|entry| (entry.0.routes)())
            .copied()
            .collect();
        assert_eq!(routes.len(), 1, "exactly one probe route");
        assert_eq!(routes[0].path, "/api/v1/method.callAnon/getPasswordPolicy");
        // POST is bit 5 of the DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT order.
        assert_eq!(routes[0].methods, 1 << 5, "only POST is selected");
    }

    #[tokio::test]
    async fn get_policy_probe_returns_fastapi_default_404_json() {
        let handler = brz_http_server::handlers!(; group = get_policy_probe::method_call_anon_get_policy_probe)
            .expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve =
            tokio::spawn(async move { server.serve_until(std::future::pending::<()>()).await });
        let client = brz_http::Client::builder().build().expect("HTTP client");
        // The request sends
        // exactly this probe body: the anonymous getPasswordPolicy method call
        // with a regex-matched token.
        let response = client
            .post(format!(
                "http://{address}/api/v1/method.callAnon/getPasswordPolicy"
            ))
            .expect("request")
            .header("content-type", "application/json")
            .body(
                r#"{"message": "{\"msg\":\"method\", \"method\": \"getPasswordPolicy\", \"params\": [{\"token\": {\"$regex\": \"^3Kl6zEI2voStaDUHwESz3kxw9XU\"}}] }"}"#,
            )
            .send()
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()["content-type"], "application/json");
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({"detail": "Not Found"})
        );
        serve.abort();
    }

    mod send_forgot_probe {
        brz_http_server::registry!(group = method_call_anon_send_forgot_probe, dependencies());
    }

    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    #[brz_http_server::post(
        "/api/v1/method.callAnon/sendForgotPasswordEmail",
        group = send_forgot_probe::method_call_anon_send_forgot_probe,
        access = public
    )]
    async fn probe_send_forgot_email_post() -> Result<(), FastApiError> {
        send_forgot_email_post().await
    }

    /// Serves the probe route on a real socket so status, headers, and body
    /// are asserted exactly as the runtime renders them.
    async fn serve_probe(body: &'static str) -> String {
        let handler = brz_http_server::handlers!(; group = send_forgot_probe::method_call_anon_send_forgot_probe)
            .expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        let request = format!(
            concat!(
                "POST /api/v1/method.callAnon/sendForgotPasswordEmail HTTP/1.1\r\n",
                "Host: localhost\r\ncontent-type: application/json\r\n",
                "content-length: {}\r\nConnection: close\r\n\r\n",
            ),
            body.len()
        );
        client.write_all(request.as_bytes()).await.expect("send");
        client.write_all(body.as_bytes()).await.expect("send body");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read response");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[tokio::test]
    async fn send_forgot_probe_returns_fastapi_default_404_json() {
        let raw = serve_probe(
            r#"{"message":"{\"msg\":\"method\",\"method\":\"sendForgotPasswordEmail\",\"params\":[\"user@example.invalid\"],\"id\":\"3\"}"}"#,
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 404"), "{raw}");
        let content_type = raw
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-type:"))
            .expect("content-type header");
        assert_eq!(
            content_type["content-type:".len()..].trim(),
            "application/json",
            "{raw}"
        );
        let body = raw.split_once("\r\n\r\n").map_or("", |(_, body)| body);
        assert_eq!(body, r#"{"detail":"Not Found"}"#, "{raw}");
    }
}
